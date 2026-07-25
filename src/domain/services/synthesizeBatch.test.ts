import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { ClaimService } from './claimService.js';
import { NodeService } from './nodeService.js';
import { DomainIssuesError, type DomainIssue } from '../issueCodes.js';
import type { NodeId } from '../ids.js';

/**
 * BATCH SYNTHESIS (04 §3). One `{nodes:[…]}` payload, prevalidated as a whole with the
 * Phase 1 validator under `nodes[i]…` paths, applied DEEPEST-FIRST (ties by payload
 * order) in ONE transaction. Any error issue fails the batch atomically — nothing is
 * applied. Per-node outcomes follow the Phase 1 semantics (updated / unchanged /
 * stale-cleared) and the receipt echoes each node's depth in application order.
 */

const DOC = [
  '# Auth Service',
  '',
  '## Token Rotation',
  '',
  'The auth service rotates refresh tokens on every use and revokes the previous token.',
  '',
  '## Storage',
  '',
  'Sessions are stored in PostgreSQL for durability.',
].join('\n');

interface Fixture {
  ctx: ServiceContext;
  repos: Repositories;
  nodes: NodeService;
  rootId: NodeId;
  topicId: NodeId;
  leafAId: NodeId;
  leafBId: NodeId;
  claimAId: string;
  claimBId: string;
}

/**
 * A four-node KB — root(0) → topic(1) → {leafA(2), leafB(2)} — with one claim under each
 * leaf, so every node has something citable in its own subtree and the two leaves share a
 * depth (the equal-depth tie the ordering rule must break by payload order).
 */
function setup(): Fixture {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  let tick = 0;
  const ctx: ServiceContext = {
    repos,
    store: new MemorySourceStore(),
    now: () => `2026-07-24T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };

  const sourceId = new IngestService(ctx).ingest({
    bytes: Buffer.from(DOC, 'utf8'),
    ext: 'md',
    mediaType: 'text/markdown',
    originalPath: 'auth.md',
  }).source.id;

  const nodes = new NodeService(ctx);
  const root = nodes.createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
  const topic = nodes.createNode({ parentId: root.id, title: 'Sessions', kind: 'topic' }).node;
  const leafA = nodes.createNode({ parentId: topic.id, title: 'Token Rotation', kind: 'leaf' }).node;
  const leafB = nodes.createNode({ parentId: topic.id, title: 'Storage', kind: 'leaf' }).node;

  const claim = (nodeId: NodeId, text: string, quote: string): string => {
    const chunk = repos.chunks.listBySource(sourceId).find((c) => c.text.includes(quote));
    if (!chunk) throw new Error(`no chunk contains ${quote}`);
    new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text,
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunk.id, quote, role: 'supports', confidence: 0.9 }],
        },
      ],
    });
    return repos.claims.listByNode(nodeId)[0]!.id;
  };

  return {
    ctx,
    repos,
    nodes,
    rootId: root.id,
    topicId: topic.id,
    leafAId: leafA.id,
    leafBId: leafB.id,
    claimAId: claim(leafA.id, 'Refresh tokens rotate on every use.', 'rotates refresh tokens'),
    claimBId: claim(leafB.id, 'Sessions are stored in PostgreSQL.', 'stored in PostgreSQL'),
  };
}

/** Run `fn` and return the `DomainIssue`s it rejected with (fails if it did not reject). */
function issuesFrom(fn: () => unknown): DomainIssue[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainIssuesError) return e.issues;
    throw e;
  }
  throw new Error('expected the batch to reject');
}

describe('NodeService.synthesizeBatch — prevalidation is atomic (04 §3)', () => {
  it('rejects ONE bad citation among good nodes with a nodes[i]-prefixed path and applies nothing', () => {
    const f = setup();
    const issues = issuesFrom(() =>
      f.nodes.synthesizeBatch({
        nodes: [
          { node_id: f.leafAId, body_md: `Rotation.[^${f.claimAId}]` },
          { node_id: f.leafBId, body_md: 'Storage.[^clm_deadbeefdeadbeef]' },
          { node_id: f.topicId, body_md: `Sessions.[^${f.claimBId}]` },
        ],
      }),
    );

    expect(issues.map((i) => ({ code: i.code, path: i.path }))).toEqual([
      { code: 'CITATION_UNKNOWN', path: 'nodes[1].body_md' },
    ]);
    // Nothing applied: the two VALID entries wrote no body and the nodes stay stale.
    for (const id of [f.leafAId, f.leafBId, f.topicId]) {
      expect(f.repos.nodes.getById(id)?.bodyMd).toBe('');
      expect(f.repos.nodes.getById(id)?.isStale).toBe(true);
    }
  });

  it('collects EVERY entry issue in one rejection (unknown node + out-of-subtree citation)', () => {
    const f = setup();
    const issues = issuesFrom(() =>
      f.nodes.synthesizeBatch({
        nodes: [
          { node_id: f.leafAId, body_md: `Cross-cite.[^${f.claimBId}]` },
          { node_id: 'nod_absent0000000' as NodeId, body_md: 'Nowhere.' },
        ],
      }),
    );

    expect(issues.map((i) => ({ code: i.code, path: i.path }))).toEqual([
      { code: 'CITATION_OUT_OF_SUBTREE', path: 'nodes[0].body_md' },
      { code: 'UNKNOWN_NODE', path: 'nodes[1].node_id' },
    ]);
    expect(f.repos.nodes.getById(f.leafAId)?.bodyMd).toBe('');
  });
});

describe('NodeService.synthesizeBatch — deepest-first application order (04 §3, finding 26)', () => {
  /**
   * The order proof: a spy over the two writing repo methods records the real call order
   * for a mixed-depth batch submitted in a deliberately WRONG order (root first, then a
   * depth-2 leaf, the topic, and the other depth-2 leaf).
   */
  function orderedBatchFixture() {
    const f = setup();
    // leafA is pre-synthesized then re-staled, so its identical replay in the batch takes
    // the `stale-cleared` path — putting `clearStale` into the same ordered call log.
    const bodyA = `Rotation.[^${f.claimAId}]`;
    f.nodes.synthesize({ node_id: f.leafAId, body_md: bodyA });
    f.repos.nodes.markStaleWithAncestors(f.leafAId, '2026-07-24T00:01:00.000Z');

    const calls: Array<{ method: 'updateBody' | 'clearStale'; id: string }> = [];
    const realUpdateBody = f.repos.nodes.updateBody.bind(f.repos.nodes);
    const realClearStale = f.repos.nodes.clearStale.bind(f.repos.nodes);
    vi.spyOn(f.repos.nodes, 'updateBody').mockImplementation((id, fields) => {
      calls.push({ method: 'updateBody', id });
      realUpdateBody(id, fields);
    });
    vi.spyOn(f.repos.nodes, 'clearStale').mockImplementation((id, now) => {
      calls.push({ method: 'clearStale', id });
      realClearStale(id, now);
    });

    const receipt = f.nodes.synthesizeBatch({
      nodes: [
        { node_id: f.rootId, body_md: `Auth overview.[^${f.claimAId}]` }, // depth 0, index 0
        { node_id: f.leafBId, body_md: `Storage.[^${f.claimBId}]` }, //      depth 2, index 1
        { node_id: f.topicId, body_md: `Sessions.[^${f.claimBId}]` }, //     depth 1, index 2
        { node_id: f.leafAId, body_md: bodyA }, //                           depth 2, index 3 (replay)
      ],
    });

    return { f, calls, receipt };
  }

  it('writes strictly non-increasing depth, breaking equal-depth ties by payload order', () => {
    const { f, calls } = orderedBatchFixture();

    expect(calls).toEqual([
      { method: 'updateBody', id: f.leafBId }, // depth 2, payload index 1 — before leafA
      { method: 'clearStale', id: f.leafAId }, // depth 2, payload index 3
      { method: 'updateBody', id: f.topicId }, // depth 1
      { method: 'updateBody', id: f.rootId }, //  depth 0
    ]);
    const depths = calls.map((c) => f.repos.nodes.getById(c.id as NodeId)!.depth);
    for (let i = 1; i < depths.length; i++) expect(depths[i]!).toBeLessThanOrEqual(depths[i - 1]!);
  });

  it('the receipt echoes depth per node and its order matches the write order', () => {
    const { f, calls, receipt } = orderedBatchFixture();

    expect(receipt.nodes.map((n) => n.nodeId)).toEqual(calls.map((c) => c.id));
    expect(receipt.nodes).toEqual([
      { inputIndex: 1, nodeId: f.leafBId, depth: 2, outcome: 'updated' },
      { inputIndex: 3, nodeId: f.leafAId, depth: 2, outcome: 'stale-cleared' },
      { inputIndex: 2, nodeId: f.topicId, depth: 1, outcome: 'updated' },
      { inputIndex: 0, nodeId: f.rootId, depth: 0, outcome: 'updated' },
    ]);
    expect(receipt.totals).toEqual({ updated: 3, unchanged: 0, staleCleared: 1 });
    // Deepest-first means every node in the batch ends fresh, even though the leaf writes
    // ran before their ancestors'.
    expect(receipt.staleNodes).toEqual([]);
  });
});

describe('NodeService.synthesizeBatch — per-node outcomes (04 §3, Phase 1 semantics)', () => {
  it('reports updated / unchanged / stale-cleared with matching totals', () => {
    const f = setup();
    const bodyA = `Rotation.[^${f.claimAId}]`;
    const bodyB = `Storage.[^${f.claimBId}]`;
    // leafA: synthesized and left FRESH → an identical replay is `unchanged`.
    f.nodes.synthesize({ node_id: f.leafAId, body_md: bodyA });
    // leafB: synthesized then re-staled → an identical replay is `stale-cleared`.
    f.nodes.synthesize({ node_id: f.leafBId, body_md: bodyB });
    f.repos.nodes.markStaleWithAncestors(f.leafBId, '2026-07-24T00:02:00.000Z');

    const receipt = f.nodes.synthesizeBatch({
      nodes: [
        { node_id: f.leafAId, body_md: bodyA },
        { node_id: f.leafBId, body_md: bodyB },
        { node_id: f.topicId, body_md: `Sessions.[^${f.claimBId}]` },
      ],
    });

    expect(receipt.nodes.map((n) => [n.nodeId, n.outcome])).toEqual([
      [f.leafAId, 'unchanged'],
      [f.leafBId, 'stale-cleared'],
      [f.topicId, 'updated'],
    ]);
    expect(receipt.totals).toEqual({ updated: 1, unchanged: 1, staleCleared: 1 });
  });

  it('an exact whole-batch repeat is a true no-op (no writes, no changelog entries)', () => {
    const f = setup();
    const batch = {
      nodes: [
        { node_id: f.leafAId, body_md: `Rotation.[^${f.claimAId}]` },
        { node_id: f.leafBId, body_md: `Storage.[^${f.claimBId}]` },
      ],
    };
    f.nodes.synthesizeBatch(batch);
    const changelogBefore = f.repos.changelog.recent(1000).length;
    const updatedBefore = f.repos.nodes.getById(f.leafAId)!.updatedAt;

    const repeat = f.nodes.synthesizeBatch(batch);

    expect(repeat.nodes.every((n) => n.outcome === 'unchanged')).toBe(true);
    expect(repeat.totals).toEqual({ updated: 0, unchanged: 2, staleCleared: 0 });
    expect(f.repos.changelog.recent(1000).length).toBe(changelogBefore);
    expect(f.repos.nodes.getById(f.leafAId)!.updatedAt).toBe(updatedBefore);
  });

  it('every write lands inside the batch transaction (locked-architecture: one BEGIN IMMEDIATE)', () => {
    const f = setup();
    const bodyB = `Storage.[^${f.claimBId}]`;
    f.nodes.synthesize({ node_id: f.leafBId, body_md: bodyB });
    f.repos.nodes.markStaleWithAncestors(f.leafBId, '2026-07-24T00:03:00.000Z');

    // Both write kinds — an `updated` body write and a `stale-cleared` clear — must be
    // issued while the connection is inside a transaction, never in autocommit.
    const inTx: boolean[] = [];
    const realUpdateBody = f.repos.nodes.updateBody.bind(f.repos.nodes);
    const realClearStale = f.repos.nodes.clearStale.bind(f.repos.nodes);
    vi.spyOn(f.repos.nodes, 'updateBody').mockImplementation((id, fields) => {
      inTx.push(f.repos.db.inTransaction);
      realUpdateBody(id, fields);
    });
    vi.spyOn(f.repos.nodes, 'clearStale').mockImplementation((id, now) => {
      inTx.push(f.repos.db.inTransaction);
      realClearStale(id, now);
    });

    f.nodes.synthesizeBatch({
      nodes: [
        { node_id: f.leafAId, body_md: `Rotation.[^${f.claimAId}]` },
        { node_id: f.leafBId, body_md: bodyB },
      ],
    });

    expect(inTx).toEqual([true, true]);
  });

  it('runs the application pass in ONE transaction even when every entry looks like a no-op', () => {
    // The classification snapshot is read without a write lock, so a batch that looks like
    // a pure repeat must STILL apply inside the transaction: another writer could stale a
    // node in between, turning a "no-op" entry into a real `stale-cleared` write.
    const f = setup();
    const batch = {
      nodes: [
        { node_id: f.leafAId, body_md: `Rotation.[^${f.claimAId}]` },
        { node_id: f.leafBId, body_md: `Storage.[^${f.claimBId}]` },
      ],
    };
    f.nodes.synthesizeBatch(batch);

    const realTx = f.repos.tx.bind(f.repos);
    const tx = vi.spyOn(f.repos, 'tx').mockImplementation(realTx);
    const repeat = f.nodes.synthesizeBatch(batch);

    expect(repeat.totals).toEqual({ updated: 0, unchanged: 2, staleCleared: 0 });
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it('a one-entry batch matches the single-object apply on outcome and staleNodes', () => {
    const single = setup();
    const batched = setup();
    const bodyFor = (f: Fixture): string => `Rotation.[^${f.claimAId}]`;

    const one = single.nodes.synthesize({ node_id: single.leafAId, body_md: bodyFor(single) });
    const many = batched.nodes.synthesizeBatch({
      nodes: [{ node_id: batched.leafAId, body_md: bodyFor(batched) }],
    });

    expect(many.nodes).toEqual([
      { inputIndex: 0, nodeId: batched.leafAId, depth: 2, outcome: one.outcome },
    ]);
    expect(many.staleNodes).toEqual(one.staleNodes);
  });
});
