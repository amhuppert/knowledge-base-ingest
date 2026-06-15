import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { ClaimService } from './claimService.js';
import { GraphService } from './graphService.js';
import { NodeService } from './nodeService.js';
import { verify } from '../../verify/verify.js';
import type { SourceId, NodeId, ChunkId } from '../ids.js';

/**
 * Regression tests for bugs found in independent (Codex) implementation review:
 * cross-source claim provenance, status resurrection, graph-only span tampering,
 * and structural staleness on child creation.
 */

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

function ingest(ctx: ServiceContext, text: string): SourceId {
  return new IngestService(ctx).ingest({ bytes: Buffer.from(text, 'utf8'), ext: 'md', mediaType: 'text/markdown' }).source.id;
}

function chunkId(repos: Repositories, sourceId: SourceId, needle: string): ChunkId {
  return repos.chunks.listBySource(sourceId).find((c) => c.text.includes(needle))!.id;
}

describe('regression: claim provenance accrues across sources', () => {
  it('the same assertion on the same node from a second source attaches new provenance, not a duplicate', () => {
    const { ctx, repos } = makeCtx();
    const a = ingest(ctx, '# A\n\nThe cache is backed by Redis for low latency.\n');
    const b = ingest(ctx, '# B\n\nConfirmed: the cache is backed by Redis in production.\n');
    const node = new NodeService(ctx).createNode({ parentId: null, title: 'Cache', kind: 'root' }).node;

    const apply = (src: SourceId, quote: string) =>
      new ClaimService(ctx).apply({
        source_id: src,
        claims: [
          {
            node_id: node.id,
            text: 'The cache is backed by Redis.',
            claim_type: 'fact',
            confidence: 0.9,
            spans: [{ chunk_id: chunkId(repos, src, quote), quote, role: 'supports', confidence: 0.9 }],
          },
        ],
      });

    apply(a, 'The cache is backed by Redis'); // exact (capitalized) in source A
    const second = apply(b, 'the cache is backed by Redis'); // exact (lowercase) in source B

    expect(second.claimsCreated).toBe(0);
    expect(second.claimsUpdated).toBe(1);
    const claims = repos.claims.listByNode(node.id);
    expect(claims).toHaveLength(1);
    // Provenance from BOTH sources is attached to the single claim.
    expect(repos.claimSpans.spansForClaim(claims[0]!.id).length).toBe(2);
  });
});

describe('regression: re-extraction does not resurrect a superseded claim', () => {
  it('re-applying the same extraction preserves a superseded status', () => {
    const { ctx, repos } = makeCtx();
    const src = ingest(ctx, '# A\n\nThe limit is 100 requests per second.\n');
    const node = new NodeService(ctx).createNode({ parentId: null, title: 'Limits', kind: 'root' }).node;
    const payload = {
      source_id: src,
      claims: [
        {
          node_id: node.id,
          text: 'The limit is 100 rps.',
          claim_type: 'fact' as const,
          confidence: 0.9,
          spans: [{ chunk_id: chunkId(repos, src, 'The limit is 100'), quote: 'The limit is 100 requests per second', role: 'supports' as const, confidence: 0.9 }],
        },
      ],
    };
    new ClaimService(ctx).apply(payload);
    const claim = repos.claims.listByNode(node.id)[0]!;
    repos.claims.setStatus(claim.id, 'superseded', null, '2026-06-14T00:01:00.000Z');

    // A later ingestion re-extracts the same assertion — it must NOT flip back to active.
    new ClaimService(ctx).apply(payload);
    expect(repos.claims.getById(claim.id)?.status).toBe('superseded');
  });
});

describe('regression: verify catches a tampered graph-only span', () => {
  it('a relationship evidence span that no claim references still fails strict verify when tampered', () => {
    const { ctx, repos } = makeCtx();
    const src = ingest(ctx, '# A\n\nThe service depends on Redis for storage.\n');
    new GraphService(ctx).apply({
      source_id: src,
      entities: [
        { type: 'Service', name: 'Svc', description: '', confidence: 0.9, evidence: [] },
        { type: 'DataStore', name: 'Redis', description: '', confidence: 0.9, evidence: [] },
      ],
      relationships: [
        {
          type: 'depends_on',
          subject: { type: 'Service', name: 'Svc' },
          object: { type: 'DataStore', name: 'Redis' },
          description: '',
          confidence: 0.9,
          evidence: [{ chunk_id: chunkId(repos, src, 'depends on Redis'), quote: 'The service depends on Redis', role: 'supports' as const, confidence: 0.9 }],
        },
      ],
    });

    expect(verify(repos, { strict: true }).ok).toBe(true);

    // Tamper the (relationship-only) span's stored quote — no claim references it.
    repos.db.prepare("UPDATE spans SET quote = 'TAMPERED' WHERE quote = 'The service depends on Redis'").run();

    const report = verify(repos, { strict: true });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.check === 'quote-matches-source')).toBe(true);
  });
});

describe('regression: creating a child marks the parent chain stale', () => {
  it('a fresh parent becomes stale when a child is added', () => {
    const { ctx, repos } = makeCtx();
    const root = new NodeService(ctx).createNode({ parentId: null, title: 'Root', kind: 'root' }).node;
    // Make the root fresh (synthesize with an empty, citation-free body is allowed for a non-leaf).
    new NodeService(ctx).synthesize({ node_id: root.id, body_md: 'Overview.' });
    expect(repos.nodes.getById(root.id)?.isStale).toBe(false);

    new NodeService(ctx).createNode({ parentId: root.id as NodeId, title: 'Child', kind: 'leaf' });
    expect(repos.nodes.getById(root.id)?.isStale).toBe(true);
  });
});
