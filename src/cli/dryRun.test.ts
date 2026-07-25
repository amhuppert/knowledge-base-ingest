import { describe, it, expect } from 'vitest';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { MemorySourceStore } from '../ingest/sourceStore.js';
import type { ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { NodeService } from '../domain/services/nodeService.js';
import { search } from '../query/query.js';
import { inDryRunTx, DryRunRollback } from './dryRun.js';
import type { SourceId, NodeId, ChunkId } from '../domain/ids.js';

/**
 * Unit tests for the dry-run runner (03 §2). It must (a) roll back nested service
 * transactions as savepoints so a preview leaves NO net state change (row counts,
 * changelog count, FTS probe all byte-identical), and (b) propagate a non-sentinel
 * throw unchanged.
 */

const DOC = [
  '# Cache',
  '',
  '## Redis',
  '',
  'The widget service caches results in Redis for low latency.',
].join('\n');

function makeCtx(): { ctx: ServiceContext; repos: Repositories } {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  let tick = 0;
  const ctx: ServiceContext = {
    repos,
    store: new MemorySourceStore(),
    now: () => `2026-06-14T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  return { ctx, repos };
}

/** A committed fixture: an ingested source + a root + leaf node, and the target chunk. */
function seed(ctx: ServiceContext, repos: Repositories): {
  sourceId: SourceId;
  leafId: NodeId;
  chunkId: ChunkId;
} {
  const sourceId = new IngestService(ctx).ingest({
    bytes: Buffer.from(DOC, 'utf8'),
    ext: 'md',
    mediaType: 'text/markdown',
    originalPath: 'cache.md',
  }).source.id;
  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Cache', kind: 'root' }).node;
  const leaf = new NodeService(ctx).createNode({ parentId: root.id, title: 'Redis', kind: 'leaf' }).node;
  const chunkId = repos.chunks.listBySource(sourceId).find((c) => c.text.includes('caches results in Redis'))!.id;
  return { sourceId, leafId: leaf.id, chunkId };
}

/** The full observable DB state a dry-run must leave untouched. */
function snapshot(repos: Repositories): {
  claims: number;
  spans: number;
  claimSpans: number;
  changelog: number;
  fts: string[];
} {
  const count = (table: string): number => (repos.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    claims: count('claims'),
    spans: count('spans'),
    claimSpans: count('claim_spans'),
    changelog: repos.changelog.recent(100_000).length,
    // FTS probe on a token that appears ONLY in the previewed claim text (not in any
    // seeded chunk/node), so a leaked claim would surface here and nowhere else.
    fts: search(repos, PROBE_TOKEN, { scope: 'claims', limit: 50 }).hits.map((h) => h.id).sort(),
  };
}

/** A token present only in the previewed claim text — the FTS leak sentinel. */
const PROBE_TOKEN = 'zqxprobe';

function claimPayload(sourceId: SourceId, leafId: NodeId, chunkId: ChunkId) {
  return {
    source_id: sourceId,
    claims: [
      {
        node_id: leafId,
        text: `The widget service ${PROBE_TOKEN} caches in Redis.`,
        claim_type: 'fact' as const,
        confidence: 0.9,
        spans: [{ chunk_id: chunkId, quote: 'caches results in Redis', role: 'supports' as const, confidence: 0.9 }],
      },
    ],
  };
}

describe('inDryRunTx', () => {
  it('returns the previewed receipt yet leaves the DB byte-identical (rows, changelog, FTS)', () => {
    const { ctx, repos } = makeCtx();
    const { sourceId, leafId, chunkId } = seed(ctx, repos);

    const before = snapshot(repos);
    const receipt = inDryRunTx(repos, () =>
      new ClaimService(ctx).apply(claimPayload(sourceId, leafId, chunkId)),
    );

    // The preview ran the REAL code path: it computed an authoritative receipt.
    expect(receipt.claimsCreated).toBe(1);
    expect(receipt.totals.spansCreated).toBe(1);
    expect(receipt.claims[0]!.outcome).toBe('created');

    // …but nothing persisted. Nested service `repos.tx` rolled back as a savepoint.
    const after = snapshot(repos);
    expect(after).toEqual(before);
    expect(after.claims).toBe(0);
    expect(after.fts).toEqual([]);

    // Positive control: the SAME apply run for real DOES surface in the FTS probe, so
    // the probe above is load-bearing (an empty result means "rolled back", not "blind").
    new ClaimService(ctx).apply(claimPayload(sourceId, leafId, chunkId));
    expect(snapshot(repos).fts).toHaveLength(1);
  });

  it('does not stale the target node (staleness write is rolled back)', () => {
    const { ctx, repos } = makeCtx();
    const { sourceId, leafId, chunkId } = seed(ctx, repos);
    // Clear the leaf's initial stale flag so a leaked staleness write would be visible.
    new NodeService(ctx).synthesize({ node_id: leafId, body_md: 'Placeholder.' });
    expect(repos.nodes.getById(leafId)?.isStale).toBe(false);

    inDryRunTx(repos, () => new ClaimService(ctx).apply(claimPayload(sourceId, leafId, chunkId)));

    expect(repos.nodes.getById(leafId)?.isStale).toBe(false);
  });

  it('propagates a non-sentinel throw and still leaves state clean', () => {
    const { ctx, repos } = makeCtx();
    const { sourceId, leafId, chunkId } = seed(ctx, repos);
    const before = snapshot(repos);

    const badPayload = {
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Hallucinated.',
          claim_type: 'fact' as const,
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote: 'this text is not in the source', role: 'supports' as const, confidence: 0.9 }],
        },
      ],
    };

    expect(() => inDryRunTx(repos, () => new ClaimService(ctx).apply(badPayload))).toThrow(/quote not found/);
    expect(snapshot(repos)).toEqual(before);
  });

  it('rethrows a plain error from fn unchanged (never swallowed as a rollback)', () => {
    const { repos } = makeCtx();
    const boom = new Error('boom');
    expect(() => inDryRunTx(repos, () => { throw boom; })).toThrow(boom);
  });

  it('DryRunRollback is the sentinel and never escapes a successful preview', () => {
    const { repos } = makeCtx();
    expect(new DryRunRollback()).toBeInstanceOf(Error);
    // A successful preview returns fn's value; the sentinel is caught internally.
    expect(inDryRunTx(repos, () => 42)).toBe(42);
  });
});
