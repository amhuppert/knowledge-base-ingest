import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { ClaimService } from './claimService.js';
import { NodeService } from './nodeService.js';
import type { ClaimApply } from '../schemas/agent.js';
import type { ClaimApplyReceipt } from './claimService.js';
import type { Chunk } from '../schemas/models.js';
import type { Repositories as Repos } from '../../db/repositories/index.js';
import type { SourceId } from '../ids.js';

/**
 * Claim-apply receipts + exact-repeat no-op semantics (03 §3.1, §4). Every input is
 * classified from span candidates + (claim_id, span_id) link lookups BEFORE any write;
 * exact repeats become true no-ops (zero writes, no changelog, no new staleness).
 */

const DOC = [
  '# Auth Service',
  '',
  '## Token Rotation',
  '',
  'The auth service rotates refresh tokens on every use and revokes the previous token.',
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

function chunkContaining(repos: Repositories, sourceId: SourceId, needle: string): Chunk {
  const c = repos.chunks.listBySource(sourceId).find((ch) => ch.text.includes(needle));
  if (!c) throw new Error(`no chunk contains ${needle}`);
  return c;
}

function setup() {
  const { ctx, repos } = makeCtx();
  const sourceId = new IngestService(ctx)
    .ingest({ bytes: Buffer.from(DOC, 'utf8'), ext: 'md', mediaType: 'text/markdown', originalPath: 'auth.md' })
    .source.id;
  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
  const leaf = new NodeService(ctx).createNode({ parentId: root.id, title: 'Token Rotation', kind: 'leaf' }).node;
  const chunkId = chunkContaining(repos, sourceId, 'rotates refresh tokens').id;
  return { ctx, repos, sourceId, rootId: root.id, leafId: leaf.id, chunkId };
}

/** DB row/changelog counts a no-op must leave byte-identical. */
function counts(repos: Repos): { claims: number; spans: number; claimSpans: number; changelog: number } {
  const n = (t: string): number => (repos.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { claims: n('claims'), spans: n('spans'), claimSpans: n('claim_spans'), changelog: n('changelog') };
}

/** The invariant every receipt input must satisfy (acceptance criterion 2). */
function assertAccountingBalances(receipt: ClaimApplyReceipt): void {
  for (const c of receipt.claims) {
    expect(c.spans.spansCreated + c.spans.spansReused).toBe(c.spans.submitted);
    expect(c.spans.linksCreated + c.spans.linksReused).toBe(c.spans.submitted);
  }
}

describe('ClaimService.apply — receipts (03 §3.1)', () => {
  it('created: per-input outcome, balanced accounting, totals, deepest-first staleNodes, and aliases', () => {
    const { ctx, repos, sourceId, rootId, leafId, chunkId } = setup();
    const changelogBefore = counts(repos).changelog;
    const receipt = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Refresh tokens rotate and the previous token is revoked.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [
            { chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.9 },
            { chunk_id: chunkId, quote: 'revokes the previous token', role: 'supports', confidence: 0.9 },
          ],
        },
      ],
    });

    assertAccountingBalances(receipt);
    expect(receipt.claims).toHaveLength(1);
    expect(receipt.claims[0]).toMatchObject({
      inputIndex: 0,
      outcome: 'created',
      spans: { submitted: 2, spansCreated: 2, spansReused: 0, linksCreated: 2, linksReused: 0 },
    });
    expect(receipt.claims[0]!.claimId).toMatch(/^clm_/);
    expect(receipt.totals).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      spansCreated: 2,
      spansReused: 0,
      linksCreated: 2,
      linksReused: 0,
      linksUpdated: 0,
    });
    // Deepest-first: leaf (depth 1) before root (depth 0).
    expect(receipt.staleNodes).toEqual([leafId, rootId]);
    // Deprecated aliases (compat matrix).
    expect(receipt.claimsCreated).toBe(1);
    expect(receipt.claimsUpdated).toBe(0);
    expect(receipt.affectedNodes).toBe(1);
    expect(receipt.spansCreatedNet).toBe(2);
    // Changelog written because created + updated > 0 (exactly one new entry).
    expect(counts(repos).changelog).toBe(changelogBefore + 1);
  });

  it('exact-repeat is a TRUE no-op: every input unchanged, zero writes, no changelog, no new staleness', () => {
    const { ctx, repos, leafId, sourceId, chunkId } = setup();
    const payload: ClaimApply = {
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Refresh tokens rotate on every use.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.9 }],
        },
      ],
    };
    new ClaimService(ctx).apply(payload);
    const before = counts(repos);
    const leafUpdatedAt = repos.nodes.getById(leafId)!.updatedAt;

    const receipt = new ClaimService(ctx).apply(payload);

    assertAccountingBalances(receipt);
    expect(receipt.claims[0]).toMatchObject({
      outcome: 'unchanged',
      spans: { submitted: 1, spansCreated: 0, spansReused: 1, linksCreated: 0, linksReused: 1 },
    });
    expect(receipt.totals).toMatchObject({ created: 0, updated: 0, unchanged: 1, linksUpdated: 0 });
    // Zero writes: counts byte-identical, no new changelog, node untouched.
    expect(counts(repos)).toEqual(before);
    expect(repos.nodes.getById(leafId)!.updatedAt).toBe(leafUpdatedAt);
  });

  it('lower-confidence replay is unchanged (confidence is never lowered)', () => {
    const { ctx, repos, leafId, sourceId, chunkId } = setup();
    const base = {
      node_id: leafId,
      text: 'Refresh tokens rotate on every use.',
      claim_type: 'fact' as const,
      spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports' as const, confidence: 0.9 }],
    };
    new ClaimService(ctx).apply({ source_id: sourceId, claims: [{ ...base, confidence: 0.9 }] });
    const before = counts(repos);

    const receipt = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [{ ...base, confidence: 0.5, spans: [{ ...base.spans[0]!, confidence: 0.5 }] }],
    });

    assertAccountingBalances(receipt);
    expect(receipt.claims[0]!.outcome).toBe('unchanged');
    expect(counts(repos)).toEqual(before);
    // The stored claim keeps its higher confidence.
    expect(repos.claims.getById(receipt.claims[0]!.claimId)!.confidence).toBe(0.9);
  });

  it('role change on an existing (claim_id, span_id) link → updated, monotone-max confidence, single row', () => {
    const { ctx, repos, leafId, sourceId, chunkId } = setup();
    const base = {
      node_id: leafId,
      text: 'Refresh tokens rotate on every use.',
      claim_type: 'fact' as const,
      confidence: 0.9,
    };
    new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [{ ...base, spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.8 }] }],
    });
    const before = counts(repos);

    const receipt = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [{ ...base, spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'context', confidence: 0.6 }] }],
    });

    assertAccountingBalances(receipt);
    expect(receipt.claims[0]).toMatchObject({
      outcome: 'updated',
      spans: { submitted: 1, spansCreated: 0, spansReused: 1, linksCreated: 0, linksReused: 1 },
    });
    expect(receipt.totals).toMatchObject({ updated: 1, linksUpdated: 1 });
    // No new span row, exactly one link row (role updated in place, confidence never lowered).
    expect(counts(repos).spans).toBe(before.spans);
    expect(counts(repos).claimSpans).toBe(before.claimSpans);
    const links = repos.claimSpans.listByClaim(receipt.claims[0]!.claimId);
    expect(links).toHaveLength(1);
    expect(links[0]!.role).toBe('context');
    expect(links[0]!.confidence).toBe(0.8); // max(0.8, 0.6)
  });

  it('higher span-ref confidence on the same link → updated (linksUpdated), monotone max', () => {
    const { ctx, repos, leafId, sourceId, chunkId } = setup();
    const base = {
      node_id: leafId,
      text: 'Refresh tokens rotate on every use.',
      claim_type: 'fact' as const,
      confidence: 0.9,
    };
    new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [{ ...base, spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.7 }] }],
    });

    const receipt = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [{ ...base, spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.95 }] }],
    });

    assertAccountingBalances(receipt);
    expect(receipt.claims[0]!.outcome).toBe('updated');
    expect(receipt.totals.linksUpdated).toBe(1);
    expect(repos.claimSpans.listByClaim(receipt.claims[0]!.claimId)[0]!.confidence).toBe(0.95);
  });

  it('mixed new + reused refs in one claim → updated with balanced split accounting', () => {
    const { ctx, sourceId, leafId, chunkId } = setup();
    const base = {
      node_id: leafId,
      text: 'Refresh tokens rotate on every use.',
      claim_type: 'fact' as const,
      confidence: 0.9,
    };
    const spanA = { chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports' as const, confidence: 0.9 };
    const spanB = { chunk_id: chunkId, quote: 'revokes the previous token', role: 'supports' as const, confidence: 0.9 };
    new ClaimService(ctx).apply({ source_id: sourceId, claims: [{ ...base, spans: [spanA] }] });

    const receipt = new ClaimService(ctx).apply({ source_id: sourceId, claims: [{ ...base, spans: [spanA, spanB] }] });

    assertAccountingBalances(receipt);
    expect(receipt.claims[0]).toMatchObject({
      outcome: 'updated',
      spans: { submitted: 2, spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 },
    });
    expect(receipt.totals).toMatchObject({ updated: 1, spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 });
  });


  it('changelog is written iff created + updated > 0, and only owners of created/updated claims are staled', () => {
    const { ctx, repos, sourceId, leafId, rootId, chunkId } = setup();
    const payload: ClaimApply = {
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Refresh tokens rotate on every use.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.9 }],
        },
      ],
    };
    new ClaimService(ctx).apply(payload);
    // Clear the leaf's staleness so a leaked stale write on the exact repeat would show.
    new NodeService(ctx).synthesize({ node_id: leafId, expected_body_hash: '', body_md: `Rotation.[^${repos.claims.listByNode(leafId)[0]!.id}]` });
    const changelogBefore = counts(repos).changelog;
    const leafStaleBefore = repos.nodes.getById(leafId)!.isStale;
    const rootStaleBefore = repos.nodes.getById(rootId)!.isStale;
    expect(leafStaleBefore).toBe(false);

    // Exact repeat: unchanged → no changelog entry, no staleness write (state frozen).
    new ClaimService(ctx).apply(payload);
    expect(counts(repos).changelog).toBe(changelogBefore);
    expect(repos.nodes.getById(leafId)!.isStale).toBe(leafStaleBefore);
    expect(repos.nodes.getById(rootId)!.isStale).toBe(rootStaleBefore);
  });
});

/**
 * BATCH-LOCAL duplicates (03 §3.1 honest dedup + §4 monotone links). Classification runs
 * before any write, so it must also account for what EARLIER inputs of the same batch will
 * write — otherwise one physical row is reported as two creations, and a lower-confidence
 * duplicate silently overwrites its higher-confidence twin.
 */
describe('ClaimService.apply — batch-local duplicates', () => {
  it('a span ref repeated inside one input creates ONE span + ONE link and reports the twin as reused', () => {
    const { ctx, repos, sourceId, leafId, chunkId } = setup();
    const quote = 'rotates refresh tokens on every use';
    const receipt = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Refresh tokens rotate on every use.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [
            { chunk_id: chunkId, quote, role: 'supports', confidence: 0.9 },
            { chunk_id: chunkId, quote, role: 'supports', confidence: 0.5 },
          ],
        },
      ],
    });

    assertAccountingBalances(receipt);
    expect(receipt.claims[0]).toMatchObject({
      outcome: 'created',
      spans: { submitted: 2, spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 },
    });
    expect(receipt.totals).toMatchObject({ spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 });
    // Exactly one physical span + link, and the lower-confidence twin never lowered it.
    const state = counts(repos);
    expect(state.spans).toBe(1);
    expect(state.claimSpans).toBe(1);
    expect(repos.claimSpans.listByClaim(receipt.claims[0]!.claimId)[0]!.confidence).toBe(0.9);
    // The receipt's spansCreated agrees with the physical net-span alias.
    expect(receipt.spansCreatedNet).toBe(receipt.totals.spansCreated);
  });

  it('a higher-confidence duplicate ref raises the link monotonically and counts as linksUpdated', () => {
    const { ctx, repos, sourceId, leafId, chunkId } = setup();
    const quote = 'rotates refresh tokens on every use';
    const receipt = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Refresh tokens rotate on every use.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [
            { chunk_id: chunkId, quote, role: 'supports', confidence: 0.5 },
            { chunk_id: chunkId, quote, role: 'supports', confidence: 0.95 },
          ],
        },
      ],
    });

    assertAccountingBalances(receipt);
    expect(receipt.claims[0]!.spans).toMatchObject({ submitted: 2, spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 });
    expect(receipt.totals.linksUpdated).toBe(1);
    expect(counts(repos).claimSpans).toBe(1);
    expect(repos.claimSpans.listByClaim(receipt.claims[0]!.claimId)[0]!.confidence).toBe(0.95);
  });

  it('the same claim repeated in one payload is created once, then unchanged (one row, one changelog entry)', () => {
    const { ctx, repos, sourceId, leafId, chunkId } = setup();
    const input = {
      node_id: leafId,
      text: 'Refresh tokens rotate on every use.',
      claim_type: 'fact' as const,
      confidence: 0.9,
      spans: [{ chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports' as const, confidence: 0.9 }],
    };
    const changelogBefore = counts(repos).changelog;

    const receipt = new ClaimService(ctx).apply({ source_id: sourceId, claims: [input, { ...input }] });

    assertAccountingBalances(receipt);
    expect(receipt.claims.map((c) => c.outcome)).toEqual(['created', 'unchanged']);
    expect(receipt.claims[0]!.claimId).toBe(receipt.claims[1]!.claimId);
    expect(receipt.claims[1]!.spans).toMatchObject({ submitted: 1, spansCreated: 0, spansReused: 1, linksCreated: 0, linksReused: 1 });
    expect(receipt.totals).toMatchObject({ created: 1, updated: 0, unchanged: 1, spansCreated: 1, spansReused: 1, linksCreated: 1, linksReused: 1 });
    const state = counts(repos);
    expect(state.claims).toBe(1);
    expect(state.spans).toBe(1);
    expect(state.claimSpans).toBe(1);
    expect(state.changelog).toBe(changelogBefore + 1);
    expect(receipt.spansCreatedNet).toBe(receipt.totals.spansCreated);
  });

  it('two distinct claims sharing one new span create the span once and a link each', () => {
    const { ctx, repos, sourceId, leafId, chunkId } = setup();
    const span = { chunk_id: chunkId, quote: 'rotates refresh tokens on every use', role: 'supports' as const, confidence: 0.9 };
    const receipt = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        { node_id: leafId, text: 'Refresh tokens rotate on every use.', claim_type: 'fact', confidence: 0.9, spans: [span] },
        { node_id: leafId, text: 'Rotation happens on every token use.', claim_type: 'fact', confidence: 0.9, spans: [{ ...span }] },
      ],
    });

    assertAccountingBalances(receipt);
    expect(receipt.claims[1]!.spans).toMatchObject({ submitted: 1, spansCreated: 0, spansReused: 1, linksCreated: 1, linksReused: 0 });
    expect(receipt.totals).toMatchObject({ created: 2, spansCreated: 1, spansReused: 1, linksCreated: 2, linksReused: 0 });
    const state = counts(repos);
    expect(state.claims).toBe(2);
    expect(state.spans).toBe(1);
    expect(state.claimSpans).toBe(2);
    expect(receipt.spansCreatedNet).toBe(receipt.totals.spansCreated);
  });
});
