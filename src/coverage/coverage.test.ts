import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { MemorySourceStore } from '../ingest/sourceStore.js';
import type { ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { GraphService } from '../domain/services/graphService.js';
import { NodeService } from '../domain/services/nodeService.js';
import { ClaimApplySchema, GraphApplySchema } from '../domain/schemas/agent.js';
import type { Chunk } from '../domain/schemas/models.js';
import type { SourceId } from '../domain/ids.js';
import { runCli, type CliIo } from '../cli/runCli.js';
import {
  seedCrossSourceKb,
  type FixtureCliResult,
  type FixtureCliRun,
} from '../cli/test-fixtures.js';
import { DB_FILENAME } from '../kb/workspace.js';
import {
  coverage,
  coverageForSource,
  COVERAGE_CHECKS,
  type CoverageCode,
} from './coverage.js';

/**
 * COVERAGE (06 §3). The five descriptive checks over live provenance links.
 * These tests exercise each check's exact semantics with minimal constructed
 * KBs (and the corpus press-release source for the SOURCE_NO_CLAIMS positive),
 * mirroring `verify.test.ts`.
 */

interface Ws {
  repos: Repositories;
  db: ReturnType<typeof openDb>;
  ingest: IngestService;
  claims: ClaimService;
  graph: GraphService;
  nodes: NodeService;
}

function makeWs(): Ws {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  let tick = 0;
  const ctx: ServiceContext = {
    repos,
    store: new MemorySourceStore(),
    now: () => `2026-07-23T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  return {
    repos,
    db,
    ingest: new IngestService(ctx),
    claims: new ClaimService(ctx),
    graph: new GraphService(ctx),
    nodes: new NodeService(ctx),
  };
}

function ingest(ws: Ws, body: string, name = 'doc.md'): SourceId {
  return ws.ingest.ingest({ bytes: Buffer.from(body, 'utf8'), ext: 'md', mediaType: 'text/markdown', originalPath: name }).source.id;
}

function chunkWith(ws: Ws, src: SourceId, needle: string): Chunk {
  const c = ws.repos.chunks.listBySource(src).find((ch) => ch.text.includes(needle));
  if (!c) throw new Error(`no chunk contains ${JSON.stringify(needle)}`);
  return c;
}

/** The ids for a given coverage check in a report. */
function idsFor(ws: Ws, code: CoverageCode): string[] {
  return coverage(ws.repos).findings.find((f) => f.code === code)!.ids;
}

describe('coverage — report shape', () => {
  it('always returns exactly the five checks in table order', () => {
    const ws = makeWs();
    expect(coverage(ws.repos).findings.map((f) => f.code)).toEqual([...COVERAGE_CHECKS]);
  });

  it('an empty KB produces no findings (clean negatives)', () => {
    const ws = makeWs();
    for (const f of coverage(ws.repos).findings) expect(f.ids).toEqual([]);
  });
});

describe('coverage — SOURCE_NO_CLAIMS (active sources with no live claim provenance)', () => {
  it('flags the corpus press-release source (ingested, zero claims)', () => {
    const ws = makeWs();
    const bytes = readFileSync(resolve(import.meta.dirname, '../../fixtures/corpus/sources/press-release.md'));
    const src = ws.ingest.ingest({ bytes, ext: 'md', mediaType: 'text/markdown', originalPath: 'press-release.md' }).source.id;
    expect(src).toBe('src_2769a4cdedc5235e'); // the corpus-derived id
    expect(idsFor(ws, 'SOURCE_NO_CLAIMS')).toEqual([src]);
    // Its chunks carry no span → they are all uncited too.
    expect(idsFor(ws, 'CHUNK_UNCITED').length).toBeGreaterThan(0);
  });

  it('does NOT flag a source once a live claim links it', () => {
    const ws = makeWs();
    const src = ingest(ws, '# Doc\n\nThe alpha service runs in Rust here.\n');
    const chunk = chunkWith(ws, src, 'runs in Rust');
    const root = ws.nodes.createNode({ parentId: null, title: 'Root', kind: 'root' }).node;
    const leaf = ws.nodes.createNode({ parentId: root.id, title: 'Leaf', kind: 'leaf' }).node;
    ws.claims.apply(
      ClaimApplySchema.parse({
        source_id: src,
        claims: [{ node_id: leaf.id, text: 'Alpha in Rust.', claim_type: 'fact', spans: [{ chunk_id: chunk.id, quote: 'runs in Rust' }] }],
      }),
    );
    expect(idsFor(ws, 'SOURCE_NO_CLAIMS')).toEqual([]);
  });

  it('ignores non-active sources', () => {
    const ws = makeWs();
    const src = ingest(ws, '# Doc\n\nA sentence with no claims at all.\n');
    ws.db.prepare("UPDATE sources SET status='superseded' WHERE id = ?").run(src);
    expect(idsFor(ws, 'SOURCE_NO_CLAIMS')).toEqual([]);
  });

  it('a claim span that only reaches an inactive claim does not count as provenance', () => {
    const ws = makeWs();
    const src = ingest(ws, '# Doc\n\nThe alpha service runs in Rust here.\n');
    const chunk = chunkWith(ws, src, 'runs in Rust');
    const root = ws.nodes.createNode({ parentId: null, title: 'Root', kind: 'root' }).node;
    const leaf = ws.nodes.createNode({ parentId: root.id, title: 'Leaf', kind: 'leaf' }).node;
    ws.claims.apply(
      ClaimApplySchema.parse({
        source_id: src,
        claims: [{ node_id: leaf.id, text: 'Alpha in Rust.', claim_type: 'fact', spans: [{ chunk_id: chunk.id, quote: 'runs in Rust' }] }],
      }),
    );
    ws.db.prepare("UPDATE claims SET status='superseded'").run();
    expect(idsFor(ws, 'SOURCE_NO_CLAIMS')).toEqual([src]);
  });
});

describe('coverage — CHUNK_UNCITED (live claim OR relationship link, half-open overlap)', () => {
  function seedClaimCoveredChunk(ws: Ws): { src: SourceId; chunk: Chunk } {
    const src = ingest(ws, '# Doc\n\nThe alpha service runs in Rust here.\n');
    const chunk = chunkWith(ws, src, 'runs in Rust');
    const root = ws.nodes.createNode({ parentId: null, title: 'Root', kind: 'root' }).node;
    const leaf = ws.nodes.createNode({ parentId: root.id, title: 'Leaf', kind: 'leaf' }).node;
    ws.claims.apply(
      ClaimApplySchema.parse({
        source_id: src,
        claims: [{ node_id: leaf.id, text: 'Alpha in Rust.', claim_type: 'fact', spans: [{ chunk_id: chunk.id, quote: 'runs in Rust' }] }],
      }),
    );
    return { src, chunk };
  }

  it('a chunk with a live active-claim span is covered', () => {
    const ws = makeWs();
    const { chunk } = seedClaimCoveredChunk(ws);
    expect(idsFor(ws, 'CHUNK_UNCITED')).not.toContain(chunk.id);
  });

  it('an orphan-span-only chunk (claim link deleted) is uncovered', () => {
    const ws = makeWs();
    const { chunk } = seedClaimCoveredChunk(ws);
    ws.db.prepare('DELETE FROM claim_spans').run(); // orphan the span
    expect(idsFor(ws, 'CHUNK_UNCITED')).toContain(chunk.id);
  });

  it('a chunk whose only span links an inactive claim is uncovered', () => {
    const ws = makeWs();
    const { chunk } = seedClaimCoveredChunk(ws);
    ws.db.prepare("UPDATE claims SET status='retracted'").run();
    expect(idsFor(ws, 'CHUNK_UNCITED')).toContain(chunk.id);
  });

  it('a relationship-only span covers its chunk', () => {
    const ws = makeWs();
    const src = ingest(ws, '# Doc\n\nThe alpha service depends on the beta service for auth.\n');
    const chunk = chunkWith(ws, src, 'depends on the beta service');
    ws.graph.apply(
      GraphApplySchema.parse({
        source_id: src,
        entities: [
          { type: 'Service', name: 'Alpha' },
          { type: 'Service', name: 'Beta' },
        ],
        relationships: [
          {
            type: 'depends_on',
            subject: { type: 'Service', name: 'Alpha' },
            object: { type: 'Service', name: 'Beta' },
            evidence: [{ chunk_id: chunk.id, quote: 'depends on the beta service' }],
          },
        ],
      }),
    );
    expect(idsFor(ws, 'CHUNK_UNCITED')).not.toContain(chunk.id);
  });

  it('excludes heading-only chunks and inventories them as structural', () => {
    const ws = makeWs();
    const src = ingest(ws, '# Structural\n## Details\nSubstantive prose without evidence.\n');
    const heading = chunkWith(ws, src, '# Structural');
    const prose = chunkWith(ws, src, 'Substantive prose');

    const report = coverage(ws.repos);

    expect(idsFor(ws, 'CHUNK_UNCITED')).toContain(prose.id);
    expect(idsFor(ws, 'CHUNK_UNCITED')).not.toContain(heading.id);
    expect(report.structuralChunks).toEqual({ total: 1, shown: 1, ids: [heading.id] });
  });

  it('caps structural chunk ids at 20 while preserving the exact total', () => {
    const ws = makeWs();
    for (let i = 0; i < 21; i++) {
      ingest(ws, `# Structural ${String(i).padStart(2, '0')}\n`, `structural-${i}.md`);
    }

    const inventory = coverage(ws.repos).structuralChunks;

    expect(inventory.total).toBe(21);
    expect(inventory.shown).toBe(20);
    expect(inventory.ids).toHaveLength(20);
    expect(inventory.ids).toEqual([...inventory.ids].sort());
  });
});

describe('coverage — synthesis checks (CLAIM_NOT_SYNTHESIZED, OPEN_QUESTION, NODE_SINGLE_SOURCE)', () => {
  /**
   * A KB with a single-source leaf (leafA), a two-source leaf (leafB), an uncited
   * open-question claim, an uncited conflicted claim, and an unsynthesized root.
   */
  function seed(ws: Ws) {
    const src1 = ingest(ws, '# Doc1\n\n## Alpha\n\nThe alpha service runs in Rust.\n\n## Open\n\nWhether burst credits roll over is unresolved.\n', 'doc1.md');
    const src2 = ingest(ws, '# Doc2\n\nThe alpha service uses caching heavily.\n', 'doc2.md');
    const rust1 = chunkWith(ws, src1, 'runs in Rust');
    const burst = chunkWith(ws, src1, 'burst credits roll over');
    const cache = chunkWith(ws, src2, 'uses caching heavily');

    const root = ws.nodes.createNode({ parentId: null, title: 'Root', kind: 'root' }).node;
    const leafA = ws.nodes.createNode({ parentId: root.id, title: 'A', kind: 'leaf' }).node;
    const leafB = ws.nodes.createNode({ parentId: root.id, title: 'B', kind: 'leaf' }).node;

    ws.claims.apply(
      ClaimApplySchema.parse({
        source_id: src1,
        claims: [
          { node_id: leafA.id, text: 'Alpha runs in Rust.', claim_type: 'fact', spans: [{ chunk_id: rust1.id, quote: 'runs in Rust' }] },
          { node_id: leafA.id, text: 'Burst credits may roll over.', claim_type: 'open_question', spans: [{ chunk_id: burst.id, quote: 'burst credits roll over' }] },
          { node_id: leafA.id, text: 'Alpha might be written in Go.', claim_type: 'fact', spans: [{ chunk_id: rust1.id, quote: 'runs in Rust' }] },
          { node_id: leafB.id, text: 'Alpha is a systems-language service.', claim_type: 'fact', spans: [{ chunk_id: rust1.id, quote: 'runs in Rust' }] },
        ],
      }),
    );
    ws.claims.apply(
      ClaimApplySchema.parse({
        source_id: src2,
        claims: [{ node_id: leafB.id, text: 'Alpha uses caching.', claim_type: 'fact', spans: [{ chunk_id: cache.id, quote: 'uses caching heavily' }] }],
      }),
    );

    const byText = (nodeId: string, text: string) => ws.repos.claims.listByNode(nodeId as never).find((c) => c.text === text)!;
    const factA = byText(leafA.id, 'Alpha runs in Rust.');
    const openA = byText(leafA.id, 'Burst credits may roll over.');
    const conflictedA = byText(leafA.id, 'Alpha might be written in Go.');
    const factB1 = byText(leafB.id, 'Alpha is a systems-language service.');
    const factB2 = byText(leafB.id, 'Alpha uses caching.');

    // Mark the extra leafA fact conflicted (uncited → must be excluded from CLAIM_NOT_SYNTHESIZED).
    ws.db.prepare("UPDATE claims SET status='conflicted' WHERE id = ?").run(conflictedA.id);

    // leafA cites only its single-source fact; leafB cites both its (two-source) facts.
    ws.nodes.synthesize({ node_id: leafA.id, expected_body_hash: '', body_md: `Alpha runs in Rust.[^${factA.id}]` });
    ws.nodes.synthesize({ node_id: leafB.id, expected_body_hash: '', body_md: `Alpha is a systems service[^${factB1.id}] that caches.[^${factB2.id}]` });

    return { root, leafA, leafB, factA, openA, conflictedA };
  }

  it('CLAIM_NOT_SYNTHESIZED lists active uncited claims, excludes cited and conflicted', () => {
    const ws = makeWs();
    const { openA, factA, conflictedA } = seed(ws);
    const ids = idsFor(ws, 'CLAIM_NOT_SYNTHESIZED');
    expect(ids).toContain(openA.id);
    expect(ids).not.toContain(factA.id); // cited in leafA body
    expect(ids).not.toContain(conflictedA.id); // conflicted claims are excluded
  });

  it('OPEN_QUESTION_NOT_SYNTHESIZED is the open_question slice of CLAIM_NOT_SYNTHESIZED', () => {
    const ws = makeWs();
    const { openA } = seed(ws);
    expect(idsFor(ws, 'OPEN_QUESTION_NOT_SYNTHESIZED')).toEqual([openA.id]);
    // The slice relationship holds: every open-question id is also in the broader check.
    expect(idsFor(ws, 'CLAIM_NOT_SYNTHESIZED')).toContain(openA.id);
  });

  it('NODE_SINGLE_SOURCE flags a single-source node, excludes multi-source and uncited nodes', () => {
    const ws = makeWs();
    const { root, leafA, leafB } = seed(ws);
    const ids = idsFor(ws, 'NODE_SINGLE_SOURCE');
    expect(ids).toContain(leafA.id); // cited claims trace to one source
    expect(ids).not.toContain(leafB.id); // two distinct sources
    expect(ids).not.toContain(root.id); // cites zero claims → excluded
  });
});

describe('coverage — ordering', () => {
  it('emits ids lexicographically within each check', () => {
    const ws = makeWs();
    // Three claimless active sources whose ids are inserted out of order.
    for (const id of ['src_cccc', 'src_aaaa', 'src_bbbb']) {
      ws.db
        .prepare(`INSERT INTO sources(id,sha256,stored_path,title,media_type,byte_size,ingested_at) VALUES(?,?,?,?,?,?,?)`)
        .run(id, `sha-${id}`, `sources/${id}.md`, id, 'text/markdown', 1, '2026-07-23T00:00:00.000Z');
    }
    expect(idsFor(ws, 'SOURCE_NO_CLAIMS')).toEqual(['src_aaaa', 'src_bbbb', 'src_cccc']);
  });
});

describe('coverageForSource — evidence-scoped contribution report', () => {
  it('uses live evidence membership and partitions actionable versus historical claims', async () => {
    const run: FixtureCliRun = async (args): Promise<FixtureCliResult> => {
      let stdout = '';
      const env = { ...process.env };
      delete env.KB_DIR;
      const io: CliIo = {
        stdout: (chunk) => (stdout += chunk),
        stderr: () => {},
        cwd: process.cwd(),
        env,
      };
      const code = await runCli([...args, '--json'], io);
      return { code, json: JSON.parse(stdout || '{}') as FixtureCliResult['json'] };
    };
    const fixture = await seedCrossSourceKb(run);
    const db = openDb(join(fixture.kbDir, DB_FILENAME));
    try {
      const repos = new Repositories(db);
      const source = repos.sources.getById(fixture.sourceB)!;

      expect(coverageForSource(repos, fixture.sourceB)).toEqual({
        scope: {
          kind: 'source',
          sourceId: fixture.sourceB,
          title: source.title,
          sourceStatus: 'active',
          membership: 'evidence-span',
        },
        chunks: {
          total: 3,
          substantive: 1,
          cited: 1,
          uncited: { total: 0, shown: 0, ids: [] },
          structural: {
            total: 2,
            shown: 2,
            ids: expect.arrayContaining([fixture.headingChunkId]),
          },
        },
        claims: {
          active: {
            total: 3,
            synthesized: 1,
            unsynthesized: {
              total: 2,
              shown: 2,
              ids: expect.arrayContaining([fixture.c2]),
            },
          },
          conflicted: {
            total: 2,
            shown: 2,
            ids: [...fixture.conflictedClaimIds].sort(),
          },
          superseded: {
            total: 1,
            shown: 1,
            ids: [fixture.supersededClaimId],
          },
          retracted: { total: 0, shown: 0, ids: [] },
        },
        relationships: {
          total: 1,
          byStatus: { active: 1, superseded: 0, conflicted: 0, retracted: 0 },
        },
        candidates: {
          total: 3,
          shown: 3,
          claimIds: [
            fixture.c1,
            fixture.c2,
            fixture.supersedingClaimId,
          ].sort(),
        },
        findings: [
          { code: 'SOURCE_NO_CLAIMS', total: 0, shown: 0, ids: [] },
          { code: 'CHUNK_UNCITED', total: 0, shown: 0, ids: [] },
          {
            code: 'CLAIM_NOT_SYNTHESIZED',
            total: 2,
            shown: 2,
            ids: expect.arrayContaining([fixture.c2]),
          },
          { code: 'OPEN_QUESTION_NOT_SYNTHESIZED', total: 0, shown: 0, ids: [] },
        ],
      });

      const contributedActiveIds = repos.sourceContribution
        .claimsEvidencedBy(fixture.sourceB)
        .filter((claim) => claim.status === 'active')
        .map((claim) => claim.claimId);
      expect(contributedActiveIds).toContain(fixture.c1);
      expect(repos.claims.getById(fixture.c1)?.firstSeenSourceId).toBe(fixture.sourceA);
    } finally {
      db.close();
      rmSync(fixture.kbDir, { recursive: true, force: true });
    }
  });
});
