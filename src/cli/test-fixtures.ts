import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeClaimId,
  makeChunkId,
  makeNodeId,
  makeRelationshipId,
  makeSourceId,
  type ClaimId,
  type ChunkId,
  type NodeId,
  type RelationshipId,
  type SourceId,
} from '../domain/ids.js';

export interface FixtureCliResult {
  code: number;
  json: {
    ok: boolean;
    data: unknown;
    issues?: Array<{ code: string; message: string }>;
  };
}

/** A JSON-mode wrapper around the real runCli dispatcher. */
export type FixtureCliRun = (args: string[]) => Promise<FixtureCliResult>;

export interface CrossSourceFixture {
  kbDir: string;
  sourceA: SourceId;
  sourceB: SourceId;
  c1: ClaimId;
  c2: ClaimId;
  r1: RelationshipId;
  headingChunkId: ChunkId;
  supersededClaimId: ClaimId;
  supersedingClaimId: ClaimId;
  conflictedClaimIds: [ClaimId, ClaimId];
  nodeIds: {
    root: NodeId;
    topic: NodeId;
    leaf: NodeId;
  };
}

/**
 * Build the shared Phase-A cross-source scenario through supported CLI commands.
 * The supplied runner must invoke runCli in JSON mode; this helper owns the temp KB
 * and passes its absolute path through --kb on every post-init command.
 */
export async function seedCrossSourceKb(run: FixtureCliRun): Promise<CrossSourceFixture> {
  const kbDir = mkdtempSync(join(tmpdir(), 'kb-cross-source-'));
  let payloadIndex = 0;

  const invoke = async (args: string[], label: string): Promise<unknown> => {
    const response = await run([...args, '--kb', kbDir]);
    if (response.code !== 0 || !response.json.ok) {
      throw new Error(
        `${label} failed with exit ${response.code}: ${JSON.stringify(response.json.issues ?? response.json)}`,
      );
    }
    return response.json.data;
  };

  const writePayload = (name: string, payload: unknown): string => {
    const path = join(kbDir, `${String(payloadIndex++).padStart(2, '0')}-${name}.json`);
    writeFileSync(path, JSON.stringify(payload));
    return path;
  };

  const createNode = async (title: string, kind: 'root' | 'topic' | 'leaf', parent?: NodeId): Promise<NodeId> => {
    const args = ['node', 'create', '--title', title, '--kind', kind];
    if (parent) args.push('--parent', parent);
    const data = (await invoke(args, `create ${kind} node ${title}`)) as { nodeId: string };
    return makeNodeId(data.nodeId);
  };

  try {
    const initialized = await run(['init', kbDir]);
    if (initialized.code !== 0 || !initialized.json.ok) {
      throw new Error(`init failed with exit ${initialized.code}: ${JSON.stringify(initialized.json)}`);
    }

    const sourceAPath = join(kbDir, 'source-a.md');
    writeFileSync(
      sourceAPath,
      [
        '# Source A',
        '',
        'Billing calls Auth for token validation.',
        'Billing records token validation outcomes.',
      ].join('\n'),
    );
    const sourceAData = (await invoke(['ingest', sourceAPath], 'ingest source A')) as { sourceId: string };
    const sourceA = makeSourceId(sourceAData.sourceId);
    const sourceAChunks = (await invoke(['source', 'chunks', sourceA], 'list source A chunks')) as {
      chunks: Array<{ id: string; text: string }>;
    };
    const sourceAChunk = sourceAChunks.chunks.find((chunk) =>
      chunk.text.includes('Billing calls Auth for token validation.'),
    );
    if (!sourceAChunk) throw new Error('source A evidence chunk was not created');

    const root = await createNode('Knowledge Base', 'root');
    const topic = await createNode('Services', 'topic', root);
    const leaf = await createNode('Billing Authentication', 'leaf', topic);

    const claimAPath = writePayload('source-a-claims', {
      source_id: sourceA,
      claims: [
        {
          node_id: leaf,
          text: 'Billing calls Auth for token validation.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceAChunk.id,
              quote: 'Billing calls Auth for token validation.',
            },
          ],
        },
      ],
    });
    const claimAData = (await invoke(['claim', 'apply', '--file', claimAPath], 'apply source A claim')) as {
      claims: Array<{ claimId: string }>;
    };
    const c1 = makeClaimId(claimAData.claims[0]!.claimId);

    const graphAPath = writePayload('source-a-graph', {
      source_id: sourceA,
      entities: [
        { type: 'Service', name: 'Billing' },
        { type: 'Service', name: 'Auth' },
      ],
      relationships: [
        {
          type: 'depends_on',
          subject: { type: 'Service', name: 'Billing' },
          object: { type: 'Service', name: 'Auth' },
          evidence: [
            {
              chunk_id: sourceAChunk.id,
              quote: 'Billing calls Auth for token validation.',
            },
          ],
        },
      ],
    });
    const graphAData = (await invoke(['graph', 'apply', '--file', graphAPath], 'apply source A graph')) as {
      relationships: Array<{ relationshipId: string }>;
    };
    const r1 = makeRelationshipId(graphAData.relationships[0]!.relationshipId);

    for (const [name, nodeId] of [
      ['leaf', leaf],
      ['topic', topic],
      ['root', root],
    ] as const) {
      const synthesisPath = writePayload(`synthesize-${name}`, {
        node_id: nodeId,
        expected_body_hash: '',
        body_md: `Billing uses Auth for token validation.[^${c1}]`,
      });
      await invoke(['synthesize', '--file', synthesisPath], `synthesize ${name} node`);
    }

    const sourceBPath = join(kbDir, 'source-b.md');
    writeFileSync(
      sourceBPath,
      [
        '# Source B',
        '',
        'Billing calls Auth for token validation.',
        'Billing logs cross-source audit events.',
        'Billing retries failed requests three times.',
        'Billing retries failed requests five times.',
        'Auth tokens expire after five minutes.',
        'Auth tokens expire after ten minutes.',
        '',
        '# Structural Appendix',
        '## Index',
      ].join('\n'),
    );
    const sourceBData = (await invoke(['ingest', sourceBPath], 'ingest source B')) as { sourceId: string };
    const sourceB = makeSourceId(sourceBData.sourceId);
    const sourceBChunks = (await invoke(['source', 'chunks', sourceB], 'list source B chunks')) as {
      chunks: Array<{ id: string; text: string; contentKind: string }>;
    };
    const sourceBContentChunk = sourceBChunks.chunks.find((chunk) =>
      chunk.text.includes('Billing logs cross-source audit events.'),
    );
    const headingChunk = sourceBChunks.chunks.find(
      (chunk) => chunk.text.trim() === '# Structural Appendix' && chunk.contentKind === 'structural',
    );
    if (!sourceBContentChunk || !headingChunk) throw new Error('source B content/heading chunks were not created');
    const headingChunkId = makeChunkId(headingChunk.id);

    const claimBPath = writePayload('source-b-claims', {
      source_id: sourceB,
      claims: [
        {
          node_id: leaf,
          text: 'Billing calls Auth for token validation.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBContentChunk.id,
              quote: 'Billing calls Auth for token validation.',
            },
          ],
        },
        {
          node_id: leaf,
          text: 'Billing logs cross-source audit events.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBContentChunk.id,
              quote: 'Billing logs cross-source audit events.',
            },
          ],
        },
        {
          node_id: leaf,
          text: 'Billing retries failed requests three times.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBContentChunk.id,
              quote: 'Billing retries failed requests three times.',
            },
          ],
        },
        {
          node_id: leaf,
          text: 'Billing retries failed requests five times.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBContentChunk.id,
              quote: 'Billing retries failed requests five times.',
            },
          ],
        },
        {
          node_id: leaf,
          text: 'Auth tokens expire after five minutes.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBContentChunk.id,
              quote: 'Auth tokens expire after five minutes.',
            },
          ],
        },
        {
          node_id: leaf,
          text: 'Auth tokens expire after ten minutes.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBContentChunk.id,
              quote: 'Auth tokens expire after ten minutes.',
            },
          ],
        },
      ],
    });
    const claimBData = (await invoke(['claim', 'apply', '--file', claimBPath], 'apply source B claims')) as {
      claims: Array<{ claimId: string }>;
    };
    const c1FromB = makeClaimId(claimBData.claims[0]!.claimId);
    if (c1FromB !== c1) throw new Error(`source B created a different C1 (${c1FromB})`);
    const c2 = makeClaimId(claimBData.claims[1]!.claimId);
    const supersededClaimId = makeClaimId(claimBData.claims[2]!.claimId);
    const supersedingClaimId = makeClaimId(claimBData.claims[3]!.claimId);
    const conflictedClaimIds: [ClaimId, ClaimId] = [
      makeClaimId(claimBData.claims[4]!.claimId),
      makeClaimId(claimBData.claims[5]!.claimId),
    ];

    const graphBPath = writePayload('source-b-graph', {
      source_id: sourceB,
      entities: [],
      relationships: [
        {
          type: 'depends_on',
          subject: { type: 'Service', name: 'Billing' },
          object: { type: 'Service', name: 'Auth' },
          evidence: [
            {
              chunk_id: sourceBContentChunk.id,
              quote: 'Billing calls Auth for token validation.',
            },
          ],
        },
      ],
    });
    const graphBData = (await invoke(['graph', 'apply', '--file', graphBPath], 'apply source B graph')) as {
      relationships: Array<{ relationshipId: string }>;
    };
    const r1FromB = makeRelationshipId(graphBData.relationships[0]!.relationshipId);
    if (r1FromB !== r1) throw new Error(`source B created a different R1 (${r1FromB})`);

    await invoke(
      ['claim', 'supersede', supersededClaimId, '--by', supersedingClaimId],
      'supersede source B claim',
    );
    await invoke(['claim', 'conflict', ...conflictedClaimIds], 'conflict source B claim pair');

    return {
      kbDir,
      sourceA,
      sourceB,
      c1,
      c2,
      r1,
      headingChunkId,
      supersededClaimId,
      supersedingClaimId,
      conflictedClaimIds,
      nodeIds: { root, topic, leaf },
    };
  } catch (error) {
    rmSync(kbDir, { recursive: true, force: true });
    throw error;
  }
}
