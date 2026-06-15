import { describe, it, expect } from 'vitest';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { MemorySourceStore } from '../ingest/sourceStore.js';
import type { ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { NodeService } from '../domain/services/nodeService.js';
import type { Chunk } from '../domain/schemas/models.js';
import type { SourceId } from '../domain/ids.js';
import { verify } from './verify.js';

const DOC = [
  '# Auth Service',
  '',
  '## Token Rotation',
  '',
  'The auth service rotates refresh tokens on every use and revokes the previous token.',
  '',
  '## Storage',
  '',
  'Sessions are stored in PostgreSQL.',
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

function ingestDoc(ctx: ServiceContext): SourceId {
  const r = new IngestService(ctx).ingest({
    bytes: Buffer.from(DOC, 'utf8'),
    ext: 'md',
    mediaType: 'text/markdown',
    originalPath: 'auth.md',
  });
  return r.source.id;
}

function chunkContaining(repos: Repositories, sourceId: SourceId, needle: string): Chunk {
  const c = repos.chunks.listBySource(sourceId).find((ch) => ch.text.includes(needle));
  if (!c) throw new Error(`no chunk contains ${needle}`);
  return c;
}

/**
 * Seed a fully-consistent KB: ingest a source, build root+leaf, apply a
 * quote-verified claim to the leaf, then synthesize the leaf citing that claim.
 */
function seedConsistentKb(): { ctx: ServiceContext; repos: Repositories; claimId: string; leafId: string } {
  const { ctx, repos } = makeCtx();
  const sourceId = ingestDoc(ctx);
  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
  const leaf = new NodeService(ctx).createNode({
    parentId: root.id,
    title: 'Token Rotation',
    kind: 'leaf',
  }).node;
  const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
  new ClaimService(ctx).apply({
    source_id: sourceId,
    claims: [
      {
        node_id: leaf.id,
        text: 'Refresh tokens rotate on every use.',
        claim_type: 'fact',
        confidence: 0.9,
        spans: [{ chunk_id: chunk.id, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.9 }],
      },
    ],
  });
  const claim = repos.claims.listByNode(leaf.id)[0]!;
  new NodeService(ctx).synthesize({
    node_id: leaf.id,
    body_md: `Refresh tokens rotate on every use.[^${claim.id}]`,
  });
  return { ctx, repos, claimId: claim.id, leafId: leaf.id };
}

function findingsFor(report: ReturnType<typeof verify>, check: string) {
  return report.findings.filter((f) => f.check === check);
}

describe('verify', () => {
  it('a correctly-seeded KB passes citation-resolves and claim-has-provenance', () => {
    const { repos } = seedConsistentKb();
    const report = verify(repos);

    expect(findingsFor(report, 'citation-resolves')).toHaveLength(0);
    expect(findingsFor(report, 'claim-has-provenance')).toHaveLength(0);
    expect(findingsFor(report, 'quote-matches-source')).toHaveLength(0);
    expect(findingsFor(report, 'parent-cites-subtree')).toHaveLength(0);
    // The leaf was synthesized fresh, so no stale-node errors remain on it; only
    // the still-stale root would warn — but we cleared just the leaf, so assert
    // explicitly on the provenance invariants above.
  });

  it('detects a tampered span quote (quote-matches-source error)', () => {
    const { repos } = seedConsistentKb();

    // Directly corrupt a span's stored quote so it no longer matches the source.
    const info = repos.db
      .prepare("UPDATE spans SET quote = 'totally wrong quote'")
      .run();
    expect(info.changes).toBeGreaterThan(0);

    const report = verify(repos);
    const quoteFindings = findingsFor(report, 'quote-matches-source');
    expect(quoteFindings.length).toBeGreaterThan(0);
    expect(quoteFindings[0]!.severity).toBe('error');
    expect(report.errors).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it('reports an unresolved citation (citation-resolves error)', () => {
    const { repos, leafId } = seedConsistentKb();

    // synthesize() rejects unknown citations, so inject a bad body directly.
    repos.db
      .prepare('UPDATE nodes SET body_md = ? WHERE id = ?')
      .run('Bogus.[^clm_deadbeef]', leafId);

    const report = verify(repos);
    const citationFindings = findingsFor(report, 'citation-resolves');
    expect(citationFindings).toHaveLength(1);
    expect(citationFindings[0]!.severity).toBe('error');
    expect(citationFindings[0]!.ids).toContain('clm_deadbeef');
    expect(report.ok).toBe(false);
  });

  it('warns on stale nodes, and strict mode flips ok to false', () => {
    const { repos } = seedConsistentKb();
    // The root remains stale after seeding (only the leaf was synthesized).
    const stale = repos.nodes.listStaleDeepestFirst();
    expect(stale.length).toBeGreaterThan(0);

    const report = verify(repos);
    const staleFindings = findingsFor(report, 'no-stale-nodes');
    expect(staleFindings).toHaveLength(1);
    expect(staleFindings[0]!.severity).toBe('warning');
    expect(report.warnings).toBeGreaterThan(0);

    // Non-strict: warnings don't fail the run (no errors present).
    expect(report.errors).toBe(0);
    expect(report.ok).toBe(true);

    // Strict: warnings flip ok to false.
    const strictReport = verify(repos, { strict: true });
    expect(strictReport.errors).toBe(0);
    expect(strictReport.warnings).toBeGreaterThan(0);
    expect(strictReport.ok).toBe(false);
  });
});
