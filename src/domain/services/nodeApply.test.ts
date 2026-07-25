import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { NodeService } from './nodeService.js';
import { NodeApplySchema } from '../schemas/agent.js';
import { deriveNodeId } from '../algorithms/idDeriver.js';
import { DomainIssuesError } from '../issueCodes.js';

/**
 * NODE-APPLY ATOMIC APPLY + RECEIPT (04 §2). The manifest is created in one transaction,
 * parents before children, via `createNode`. The receipt maps every ref to its node id
 * and outcome; an exact replay is a zero-write no-op; any prevalidation error rejects the
 * whole batch with no partial nodes.
 */

function makeCtx(): { ctx: ServiceContext; repos: Repositories; nodes: NodeService } {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  let tick = 0;
  const ctx: ServiceContext = {
    repos,
    store: new MemorySourceStore(),
    now: () => `2026-07-24T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  return { ctx, repos, nodes: new NodeService(ctx) };
}

/** A root with 4 topics of 4 leaves each — 1 + 4 + 16 = 21 nodes. */
function twentyOneNodeManifest() {
  const topics = Array.from({ length: 4 }, (_, t) => ({
    ref: `t${t}`,
    title: `Topic ${t}`,
    kind: 'topic',
    children: Array.from({ length: 4 }, (_, l) => ({
      ref: `t${t}-l${l}`,
      title: `Leaf ${t}.${l}`,
      kind: 'leaf',
    })),
  }));
  return NodeApplySchema.parse({ nodes: [{ ref: 'root', title: 'Knowledge Base', kind: 'root', children: topics }] });
}

const changelogCount = (repos: Repositories): number => repos.changelog.recent(10_000).length;

describe('NodeService.applyManifest — atomic apply', () => {
  it('creates a 21-node tree in one command, parents before children, with a full ref→nodeId map', () => {
    const { repos, nodes } = makeCtx();
    const receipt = nodes.applyManifest(twentyOneNodeManifest());

    expect(receipt.nodes).toHaveLength(21);
    expect(receipt.nodes.every((n) => n.outcome === 'created')).toBe(true);
    expect(receipt.totals).toEqual({ created: 21, existing: 0 });
    expect(repos.nodes.listAll()).toHaveLength(21);

    // The tree is well-formed (proves parents were created before children — otherwise
    // createNode would have thrown UNKNOWN_PARENT_REF): depths 0 / 1 / 2.
    const byKind = (kind: string) => repos.nodes.listAll().filter((n) => n.kind === kind);
    expect(byKind('root').map((n) => n.depth)).toEqual([0]);
    expect(byKind('topic').every((n) => n.depth === 1)).toBe(true);
    expect(byKind('leaf').every((n) => n.depth === 2)).toBe(true);

    // The receipt's ref→nodeId map matches deterministic derivation.
    const rootId = deriveNodeId(null, 'knowledge-base');
    const topic0Id = deriveNodeId(rootId, 'topic-0');
    const map = new Map(receipt.nodes.map((n) => [n.ref, n.nodeId]));
    expect(map.get('root')).toBe(rootId);
    expect(map.get('t0')).toBe(topic0Id);
    expect(map.get('t0-l0')).toBe(deriveNodeId(topic0Id, 'leaf-0-0'));

    // Every created node (and its ancestors) is stale, reported deepest-first.
    expect(receipt.staleNodes).toHaveLength(21);
    expect(repos.nodes.getById(map.get('t0-l0')!)!.isStale).toBe(true);
  });

  it('grafts a top-level parent_id subtree under an existing node', () => {
    const { repos, nodes } = makeCtx();
    const root = nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });

    const manifest = NodeApplySchema.parse({
      nodes: [
        {
          ref: 'graft',
          title: 'Observability',
          kind: 'topic',
          parent_id: root.node.id,
          children: [{ ref: 'graft-leaf', title: 'Tracing', kind: 'leaf' }],
        },
      ],
    });
    const receipt = nodes.applyManifest(manifest);

    const graftId = deriveNodeId(root.node.id, 'observability');
    expect(receipt.totals).toEqual({ created: 2, existing: 0 });
    expect(repos.nodes.getById(graftId)!.parentId).toBe(root.node.id);
    expect(repos.nodes.getById(deriveNodeId(graftId, 'tracing'))!.depth).toBe(2);
    // Grafting stales the new subtree and the existing ancestor chain (root included).
    expect(receipt.staleNodes).toContain(root.node.id);
  });

  it('an exact full-manifest replay (including the root) is a zero-write no-op with no changelog', () => {
    const { repos, nodes } = makeCtx();
    nodes.applyManifest(twentyOneNodeManifest());
    const changelogAfterFirst = changelogCount(repos);
    const nodesAfterFirst = repos.nodes.listAll().map((n) => n.updatedAt);

    const replay = nodes.applyManifest(twentyOneNodeManifest());

    expect(replay.nodes.every((n) => n.outcome === 'existing')).toBe(true);
    expect(replay.totals).toEqual({ created: 0, existing: 21 });
    expect(replay.staleNodes).toEqual([]); // this apply staled nothing
    // Zero writes: no new changelog entries and no updated_at bumps.
    expect(changelogCount(repos)).toBe(changelogAfterFirst);
    expect(repos.nodes.listAll().map((n) => n.updatedAt)).toEqual(nodesAfterFirst);
  });

  it('prevalidates INSIDE the write transaction (BEGIN IMMEDIATE taken before the collision reads)', () => {
    const { repos, nodes } = makeCtx();
    nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });

    // Capture whether the DB is already inside a transaction at prevalidation's first
    // collision read. The fix takes BEGIN IMMEDIATE up front, so the read that decides
    // replay-vs-collision runs under the write lock — closing the TOCTOU window.
    let inTxAtFirstRead: boolean | undefined;
    const realGetById = repos.nodes.getById.bind(repos.nodes);
    repos.nodes.getById = ((id: Parameters<typeof realGetById>[0]) => {
      if (inTxAtFirstRead === undefined) inTxAtFirstRead = repos.db.inTransaction;
      return realGetById(id);
    }) as typeof repos.nodes.getById;

    nodes.applyManifest(twentyOneNodeManifest());
    expect(inTxAtFirstRead).toBe(true);
  });

  it('a kind mismatch anywhere fails the whole batch with no partial nodes persisted', () => {
    const { repos, nodes } = makeCtx();
    const root = nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });
    nodes.createNode({ parentId: root.node.id, title: 'Caching', kind: 'topic', slug: 'caching' });
    const before = repos.nodes.listAll().length; // 2
    const changelogBefore = changelogCount(repos);

    // Root replay + a VALID new leaf + a leaf that collides with the existing "caching" topic.
    const bad = NodeApplySchema.parse({
      nodes: [
        {
          ref: 'root',
          title: 'Knowledge Base',
          kind: 'root',
          children: [
            { ref: 'fresh', title: 'Fresh Leaf', kind: 'leaf' },
            { ref: 'clash', title: 'Caching', kind: 'leaf', slug: 'caching' },
          ],
        },
      ],
    });

    let thrown: unknown;
    try {
      nodes.applyManifest(bad);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainIssuesError);
    expect((thrown as DomainIssuesError).issues.map((i) => i.code)).toContain('NODE_KIND_MISMATCH');

    // Nothing was applied — not even the valid "fresh" leaf.
    expect(repos.nodes.listAll()).toHaveLength(before);
    expect(repos.nodes.getById(deriveNodeId(root.node.id, 'fresh-leaf'))).toBeUndefined();
    expect(changelogCount(repos)).toBe(changelogBefore);
  });
});
