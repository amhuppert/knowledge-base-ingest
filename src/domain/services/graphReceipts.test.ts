import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { GraphService } from './graphService.js';
import type { GraphApply } from '../schemas/agent.js';
import type { GraphApplyReceipt } from './graphService.js';
import type { SourceId } from '../ids.js';

/**
 * Graph-apply receipts + exact-repeat no-ops (03 §3.2). Per-input entity/relationship
 * outcomes with relationship evidence accounting; evidence-only additions → updated;
 * an exact repeat writes NOTHING (including the changelog); the receipt omits staleNodes
 * (graph mutations never stale nodes).
 */

const DOC = ['# API', '', 'The Gateway service validates the key against the Accounts service for every request.'].join('\n');

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

function setup() {
  const { ctx, repos } = makeCtx();
  const sourceId = new IngestService(ctx)
    .ingest({ bytes: Buffer.from(DOC, 'utf8'), ext: 'md', mediaType: 'text/markdown', originalPath: 'api.md' })
    .source.id;
  const chunkId = repos.chunks.listBySource(sourceId).find((c) => c.text.includes('validates the key'))!.id;
  return { ctx, repos, sourceId, chunkId };
}

function counts(repos: Repositories): { entities: number; relationships: number; spans: number; relSpans: number; changelog: number } {
  const n = (t: string): number => (repos.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { entities: n('entities'), relationships: n('relationships'), spans: n('spans'), relSpans: n('relationship_spans'), changelog: n('changelog') };
}

function assertEvidenceBalances(receipt: GraphApplyReceipt): void {
  for (const r of receipt.relationships) {
    expect(r.evidence.spansCreated + r.evidence.spansReused).toBe(r.evidence.submitted);
    expect(r.evidence.linksCreated + r.evidence.linksReused).toBe(r.evidence.submitted);
  }
}

function graphPayload(sourceId: SourceId, chunkId: string, quote = 'validates the key against the Accounts service'): GraphApply {
  return {
    source_id: sourceId,
    entities: [
      { type: 'Service', name: 'Gateway service', description: 'Edge service.', confidence: 0.9 },
      { type: 'Service', name: 'Accounts service', description: 'Validates keys.', confidence: 0.9 },
    ],
    relationships: [
      {
        type: 'depends_on',
        subject: { type: 'Service', name: 'Gateway service' },
        object: { type: 'Service', name: 'Accounts service' },
        description: 'Gateway validates keys against Accounts.',
        confidence: 0.9,
        evidence: [{ chunk_id: chunkId as never, quote, role: 'supports' }],
      },
    ],
  } as GraphApply;
}

describe('GraphService.apply — receipts (03 §3.2)', () => {
  it('created: per-input entities/relationships, evidence accounting, totals, NO staleNodes field', () => {
    const { ctx, repos, sourceId, chunkId } = setup();
    const changelogBefore = counts(repos).changelog;
    const receipt = new GraphService(ctx).apply(graphPayload(sourceId, chunkId));

    assertEvidenceBalances(receipt);
    expect(receipt.entities.map((e) => e.outcome)).toEqual(['created', 'created']);
    expect(receipt.entities[0]!.entityId).toMatch(/^ent_/);
    expect(receipt.relationships).toHaveLength(1);
    expect(receipt.relationships[0]).toMatchObject({
      inputIndex: 0,
      outcome: 'created',
      evidence: { submitted: 1, spansCreated: 1, spansReused: 0, linksCreated: 1, linksReused: 0 },
    });
    expect(receipt.relationships[0]!.relationshipId).toMatch(/^rel_/);
    expect(receipt.totals).toMatchObject({
      entitiesCreated: 2,
      entitiesUnchanged: 0,
      relationshipsCreated: 1,
      relationshipsUnchanged: 0,
    });
    // staleNodes must be ABSENT entirely (graph never stales nodes).
    expect('staleNodes' in (receipt as object)).toBe(false);
    // Aliases retained.
    expect(receipt.entitiesCreated).toBe(2);
    expect(receipt.relationshipsCreated).toBe(1);
    // Changelog written because created + updated > 0.
    expect(counts(repos).changelog).toBe(changelogBefore + 1);
  });

  it('exact-repeat writes NOTHING (all unchanged, no changelog, byte-identical DB)', () => {
    const { ctx, repos, sourceId, chunkId } = setup();
    const payload = graphPayload(sourceId, chunkId);
    new GraphService(ctx).apply(payload);
    const before = counts(repos);

    const receipt = new GraphService(ctx).apply(payload);

    assertEvidenceBalances(receipt);
    expect(receipt.entities.map((e) => e.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(receipt.relationships[0]!.outcome).toBe('unchanged');
    expect(receipt.relationships[0]!.evidence).toMatchObject({ submitted: 1, spansReused: 1, linksReused: 1, spansCreated: 0, linksCreated: 0 });
    expect(receipt.totals).toMatchObject({ entitiesUnchanged: 2, relationshipsUnchanged: 1, entitiesCreated: 0, relationshipsCreated: 0 });
    // Zero writes: every count byte-identical, no new changelog entry.
    expect(counts(repos)).toEqual(before);
  });

  it('evidence-only addition to an existing relationship → outcome updated', () => {
    const { ctx, repos, sourceId, chunkId } = setup();
    const first = graphPayload(sourceId, chunkId, 'validates the key against the Accounts service');
    new GraphService(ctx).apply(first);
    const before = counts(repos);

    // Same entities + relationship (no description/confidence change), but a NEW evidence quote.
    const second = graphPayload(sourceId, chunkId);
    second.relationships[0]!.evidence = [{ chunk_id: chunkId as never, quote: 'for every request', role: 'supports' }];
    const receipt = new GraphService(ctx).apply(second);

    assertEvidenceBalances(receipt);
    expect(receipt.relationships[0]).toMatchObject({
      outcome: 'updated',
      evidence: { submitted: 1, spansCreated: 1, spansReused: 0, linksCreated: 1, linksReused: 0 },
    });
    expect(receipt.totals).toMatchObject({ relationshipsUpdated: 1, entitiesUnchanged: 2 });
    // A new evidence span + link were persisted, and a changelog entry written.
    expect(counts(repos).relSpans).toBe(before.relSpans + 1);
    expect(counts(repos).changelog).toBe(before.changelog + 1);
  });

  /**
   * BATCH-LOCAL duplicates (03 §3.2 honest dedup): all of a relationship's evidence is
   * classified before any of it is persisted, so duplicate refs must be accounted against
   * what the earlier refs of the same batch will write — not reported as two creations.
   */
  it('duplicate evidence refs on one relationship create ONE span + ONE link and report the twin as reused', () => {
    const { ctx, repos, sourceId, chunkId } = setup();
    const payload = graphPayload(sourceId, chunkId);
    const quote = 'validates the key against the Accounts service';
    payload.relationships[0]!.evidence = [
      { chunk_id: chunkId as never, quote, role: 'supports' },
      { chunk_id: chunkId as never, quote, role: 'supports' },
    ];

    const receipt = new GraphService(ctx).apply(payload);

    assertEvidenceBalances(receipt);
    expect(receipt.relationships[0]).toMatchObject({
      outcome: 'created',
      evidence: { submitted: 2, spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 },
    });
    expect(receipt.totals).toMatchObject({ spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 });
    const state = counts(repos);
    expect(state.spans).toBe(1);
    expect(state.relSpans).toBe(1);
    // The alias reports the same physical net-span count the receipt claims.
    expect(receipt.spansCreated).toBe(receipt.totals.spansCreated);
  });

  it('two relationships citing the same new quote create the span once, with an evidence link each', () => {
    const { ctx, repos, sourceId, chunkId } = setup();
    const payload = graphPayload(sourceId, chunkId);
    const quote = 'validates the key against the Accounts service';
    payload.relationships.push({
      type: 'validates_for',
      subject: { type: 'Service', name: 'Accounts service' },
      object: { type: 'Service', name: 'Gateway service' },
      description: 'Accounts validates keys for Gateway.',
      confidence: 0.9,
      evidence: [{ chunk_id: chunkId as never, quote, role: 'supports' }],
    });

    const receipt = new GraphService(ctx).apply(payload);

    assertEvidenceBalances(receipt);
    expect(receipt.relationships[1]!.evidence).toMatchObject({ submitted: 1, spansCreated: 0, spansReused: 1, linksCreated: 1, linksReused: 0 });
    expect(receipt.totals).toMatchObject({ relationshipsCreated: 2, spansCreated: 1, spansReused: 1, linksCreated: 2, linksReused: 0 });
    const state = counts(repos);
    expect(state.spans).toBe(1);
    expect(state.relSpans).toBe(2);
    expect(receipt.spansCreated).toBe(receipt.totals.spansCreated);
  });
});
