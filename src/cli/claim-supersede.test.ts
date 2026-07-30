import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db/connection.js';
import { runCli, type CliIo } from './runCli.js';

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; message: string }>;
  };
}

let kb: string;
let sourceId: string;
let chunkId: string;
let leftNodeId: string;
let rightNodeId: string;
let questionId: string;
let decisionId: string;
let alternateDecisionId: string;
let payloadCounter = 0;

async function run(args: string[]): Promise<CliResult> {
  let stdout = '';
  const io: CliIo = {
    stdout: (chunk) => (stdout += chunk),
    stderr: () => {},
    cwd: kb,
    env: { ...process.env, KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(stdout || '{}') as CliResult['json'] };
}

function payloadFile(payload: unknown): string {
  const path = join(kb, `claim-${payloadCounter++}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

async function applyClaim(nodeId: string, text: string, claimType: 'fact' | 'open_question', quote: string): Promise<string> {
  const result = await run([
    'claim',
    'apply',
    '--file',
    payloadFile({
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text,
          claim_type: claimType,
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote, role: 'supports', confidence: 0.9 }],
        },
      ],
    }),
  ]);
  expect(result.code).toBe(0);
  return (result.json.data as { claims: Array<{ claimId: string }> }).claims[0]!.claimId;
}

function expectInvalid(result: CliResult, condition: RegExp): void {
  expect(result.code).toBe(1);
  expect(result.json.ok).toBe(false);
  expect(result.json.issues).toEqual([
    expect.objectContaining({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(condition),
    }),
  ]);
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-claim-supersede-'));
  payloadCounter = 0;
  await run(['init', kb]);

  const sourcePath = join(kb, 'decisions.md');
  writeFileSync(
    sourcePath,
    [
      '# Session storage',
      '',
      'The current storage choice is unresolved.',
      '',
      'The approved decision is to use PostgreSQL.',
      '',
      'The fallback decision is to use SQLite.',
    ].join('\n'),
  );
  const ingested = await run(['ingest', sourcePath]);
  sourceId = (ingested.json.data as { sourceId: string }).sourceId;
  const chunks = await run(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as { chunks: Array<{ id: string }> }).chunks[0]!.id;

  const root = await run(['node', 'create', '--title', 'Architecture', '--kind', 'root']);
  const rootId = (root.json.data as { nodeId: string }).nodeId;
  const left = await run(['node', 'create', '--title', 'Open Questions', '--kind', 'leaf', '--parent', rootId]);
  leftNodeId = (left.json.data as { nodeId: string }).nodeId;
  const right = await run(['node', 'create', '--title', 'Decisions', '--kind', 'leaf', '--parent', rootId]);
  rightNodeId = (right.json.data as { nodeId: string }).nodeId;

  questionId = await applyClaim(
    leftNodeId,
    'Which database should store sessions?',
    'open_question',
    'The current storage choice is unresolved',
  );
  decisionId = await applyClaim(
    rightNodeId,
    'Sessions will be stored in PostgreSQL.',
    'fact',
    'The approved decision is to use PostgreSQL',
  );
  alternateDecisionId = await applyClaim(
    rightNodeId,
    'Sessions can fall back to SQLite.',
    'fact',
    'The fallback decision is to use SQLite',
  );
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('kb claim supersede integrity pins', () => {
  it('documents every superseding-claim integrity requirement in registry-backed help', async () => {
    const help = await run(['claim', 'supersede', '--help']);
    const data = help.json.data as {
      flags: Array<{ flags: string; description: string }>;
      workflow: string;
    };

    expect(help.code).toBe(0);
    expect(data.flags.find((flag) => flag.flags === '--by <new_claim_id>')?.description).toBe(
      'an existing active claim with at least one live span; must differ from the old claim and not create a cycle',
    );
    expect(data.workflow).toContain('Works across subtrees.');

    const provenanceHelp = await run(['provenance', '--help']);
    expect((provenanceHelp.json.data as { related: string[] }).related).toContain('claim supersede');
  });

  it('rejects self-supersession', async () => {
    expectInvalid(await run(['claim', 'supersede', questionId, '--by', questionId]), /self-supersession/i);
  });

  it('rejects a two-claim supersession cycle', async () => {
    expect((await run(['claim', 'supersede', questionId, '--by', decisionId])).code).toBe(0);

    expectInvalid(await run(['claim', 'supersede', decisionId, '--by', questionId]), /cycle/i);
  });

  it('rejects a missing superseding claim', async () => {
    expectInvalid(
      await run(['claim', 'supersede', questionId, '--by', 'clm_0000000000000000']),
      /superseding claim .* does not exist/i,
    );
  });

  it('rejects an inactive superseding claim', async () => {
    expect((await run(['claim', 'conflict', decisionId, alternateDecisionId])).code).toBe(0);

    expectInvalid(
      await run(['claim', 'supersede', questionId, '--by', decisionId]),
      /superseding claim .* must be active/i,
    );
  });

  it('rejects a superseding claim with no live span', async () => {
    const db = openDb(join(kb, 'kb.sqlite'));
    db.prepare('DELETE FROM claim_spans WHERE claim_id = ?').run(decisionId);
    db.close();

    expectInvalid(
      await run(['claim', 'supersede', questionId, '--by', decisionId]),
      /superseding claim .* must have at least one live span/i,
    );
  });

  it('allows an open question in one subtree to be superseded by an active span-backed claim in a sibling subtree', async () => {
    const result = await run(['claim', 'supersede', questionId, '--by', decisionId]);

    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.data).toMatchObject({ superseded: questionId, by: decisionId });

    const questionNode = await run(['node', 'show', leftNodeId]);
    expect(
      (questionNode.json.data as { claims: Array<{ id: string; status: string; supersededByClaimId: string | null }> })
        .claims,
    ).toContainEqual(expect.objectContaining({ id: questionId, status: 'superseded', supersededByClaimId: decisionId }));
  });
});
