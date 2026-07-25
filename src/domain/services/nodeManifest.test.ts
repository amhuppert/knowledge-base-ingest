import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { NodeService } from './nodeService.js';
import { prevalidateNodeManifest } from './nodeManifest.js';
import { NodeApplySchema } from '../schemas/agent.js';

/**
 * NODE-APPLY PREVALIDATION (04 §2, finding 24). One failing case per rule, plus the
 * replay-legality regression: a spec whose derived id equals an existing node's id is a
 * legal replay when its kind AND title match, and the root count is over DISTINCT LOGICAL
 * ROOT IDS so re-declaring the existing root is not a second root.
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

/** Parse a raw manifest object and prevalidate it, returning just the issue codes. */
function codesFor(repos: Repositories, payload: unknown): string[] {
  const plan = prevalidateNodeManifest(repos, NodeApplySchema.parse(payload));
  return plan.issues.map((i) => i.code);
}

/** A one-line root + two leaves manifest builder. */
const rootWith = (children: unknown[]) => ({
  nodes: [{ ref: 'root', title: 'Knowledge Base', kind: 'root', children }],
});

describe('prevalidateNodeManifest — one rule per test', () => {
  it('a valid fresh manifest collects no issues and resolves every spec parents-first', () => {
    const { repos } = makeCtx();
    const plan = prevalidateNodeManifest(
      repos,
      NodeApplySchema.parse(rootWith([{ ref: 'cache', title: 'Caching', kind: 'leaf' }])),
    );
    expect(plan.issues).toEqual([]);
    // Root (depth 0) is resolved before its child (depth 1).
    expect(plan.specs.map((s) => [s.ref, s.depth])).toEqual([
      ['root', 0],
      ['cache', 1],
    ]);
  });

  it('DUPLICATE_REF — two specs share a ref', () => {
    const { repos } = makeCtx();
    const codes = codesFor(
      repos,
      rootWith([
        { ref: 'dup', title: 'Alpha', kind: 'leaf' },
        { ref: 'dup', title: 'Beta', kind: 'leaf' },
      ]),
    );
    expect(codes).toContain('DUPLICATE_REF');
  });

  it('DUPLICATE_SLUG — two MANIFEST entries resolve to the same (parent, slug)', () => {
    const { repos } = makeCtx();
    const codes = codesFor(
      repos,
      rootWith([
        { ref: 'a', title: 'Same Title', kind: 'leaf' },
        { ref: 'b', title: 'Same Title', kind: 'leaf' },
      ]),
    );
    expect(codes).toContain('DUPLICATE_SLUG');
    expect(codes).not.toContain('DUPLICATE_REF'); // distinct refs
  });

  it('NODE_KIND_MISMATCH — a spec collides with an existing DB node of a different kind', () => {
    const { repos, nodes } = makeCtx();
    const root = nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });
    nodes.createNode({ parentId: root.node.id, title: 'Caching', kind: 'topic', slug: 'caching' });
    // Replay the root, then re-declare the existing "caching" node as a leaf (kind differs).
    const codes = codesFor(repos, rootWith([{ ref: 'c', title: 'Caching', kind: 'leaf', slug: 'caching' }]));
    expect(codes).toContain('NODE_KIND_MISMATCH');
    expect(codes).not.toContain('DUPLICATE_SLUG'); // a DB collision is not manifest-internal
  });

  it('NODE_TITLE_MISMATCH — a spec collides with an existing DB node of a different title', () => {
    const { repos, nodes } = makeCtx();
    const root = nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });
    nodes.createNode({ parentId: root.node.id, title: 'Caching', kind: 'topic', slug: 'caching' });
    const codes = codesFor(repos, rootWith([{ ref: 'c', title: 'Cache Layer', kind: 'topic', slug: 'caching' }]));
    expect(codes).toContain('NODE_TITLE_MISMATCH');
  });

  it('a spec differing in BOTH kind and title emits BOTH mismatch codes (independent checks)', () => {
    const { repos, nodes } = makeCtx();
    const root = nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });
    nodes.createNode({ parentId: root.node.id, title: 'Caching', kind: 'topic', slug: 'caching' });
    // Same derived id (slug "caching"), but the manifest declares a different kind AND title.
    const codes = codesFor(repos, rootWith([{ ref: 'c', title: 'Cache Layer', kind: 'leaf', slug: 'caching' }]));
    expect(codes).toContain('NODE_KIND_MISMATCH');
    expect(codes).toContain('NODE_TITLE_MISMATCH');
  });

  it('checks EVERY colliding spec, not just the first per derived id', () => {
    const { repos, nodes } = makeCtx();
    const root = nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });
    nodes.createNode({ parentId: root.node.id, title: 'Caching', kind: 'topic', slug: 'caching' });
    // Two manifest specs resolve to the SAME derived id (slug "caching"), each a kind mismatch
    // vs the existing DB topic. Every colliding spec must be reported — not deduped away.
    const codes = codesFor(
      repos,
      rootWith([
        { ref: 'c1', title: 'Caching', kind: 'leaf', slug: 'caching' },
        { ref: 'c2', title: 'Caching', kind: 'leaf', slug: 'caching' },
      ]),
    );
    expect(codes.filter((c) => c === 'NODE_KIND_MISMATCH')).toHaveLength(2);
  });

  it('a spec whose derived id, kind, and title all match is a legal replay (no issue)', () => {
    const { repos, nodes } = makeCtx();
    const root = nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });
    nodes.createNode({ parentId: root.node.id, title: 'Caching', kind: 'topic', slug: 'caching' });
    // Root replay + exact re-declaration of the existing topic → zero issues.
    const plan = prevalidateNodeManifest(
      repos,
      NodeApplySchema.parse(rootWith([{ ref: 'c', title: 'Caching', kind: 'topic', slug: 'caching' }])),
    );
    expect(plan.issues).toEqual([]);
  });

  it('MULTIPLE_ROOTS — two distinct logical roots in one manifest', () => {
    const { repos } = makeCtx();
    const codes = codesFor(repos, {
      nodes: [
        { ref: 'r1', title: 'Root One', kind: 'root' },
        { ref: 'r2', title: 'Root Two', kind: 'root' },
      ],
    });
    expect(codes).toContain('MULTIPLE_ROOTS');
  });

  it('root replay is NOT MULTIPLE_ROOTS — a manifest root re-declaring the existing root is legal', () => {
    const { repos, nodes } = makeCtx();
    nodes.createNode({ parentId: null, title: 'Knowledge Base', kind: 'root' });
    // The manifest re-declares that same root (same derived id) plus a fresh child.
    const codes = codesFor(repos, rootWith([{ ref: 'cache', title: 'Caching', kind: 'leaf' }]));
    expect(codes).not.toContain('MULTIPLE_ROOTS');
    expect(codes).toEqual([]); // fully legal replay-with-graft
  });

  it('MULTIPLE_ROOTS — a NEW root when the KB already has a different one', () => {
    const { repos, nodes } = makeCtx();
    nodes.createNode({ parentId: null, title: 'Existing Root', kind: 'root' });
    const codes = codesFor(repos, { nodes: [{ ref: 'r', title: 'A Second Root', kind: 'root' }] });
    expect(codes).toContain('MULTIPLE_ROOTS');
  });

  it('ROOT_HAS_PARENT — a root spec declares a parent_id', () => {
    const { repos } = makeCtx();
    const codes = codesFor(repos, {
      nodes: [{ ref: 'root', title: 'Knowledge Base', kind: 'root', parent_id: 'nod_deadbeefdeadbeef' }],
    });
    expect(codes).toEqual(['ROOT_HAS_PARENT']);
  });

  it('ROOT_HAS_PARENT — a nested spec is declared kind root', () => {
    const { repos } = makeCtx();
    const codes = codesFor(repos, rootWith([{ ref: 'bad', title: 'Nested Root', kind: 'root' }]));
    expect(codes).toContain('ROOT_HAS_PARENT');
  });

  it('UNKNOWN_PARENT_REF — a top-level parent_id is not in the DB', () => {
    const { repos } = makeCtx();
    const codes = codesFor(repos, {
      nodes: [{ ref: 'graft', title: 'Grafted', kind: 'topic', parent_id: 'nod_deadbeefdeadbeef' }],
    });
    expect(codes).toEqual(['UNKNOWN_PARENT_REF']);
  });

  it('PAYLOAD_SCHEMA — a non-root top-level spec with no resolvable parent', () => {
    const { repos } = makeCtx();
    const codes = codesFor(repos, { nodes: [{ ref: 'orphan', title: 'Orphan', kind: 'topic' }] });
    expect(codes).toEqual(['PAYLOAD_SCHEMA']);
  });

  it('collects ALL issues together before rejecting (not fail-fast)', () => {
    const { repos } = makeCtx();
    // A duplicate ref AND a duplicate slug AND a second root — every one is reported.
    const codes = codesFor(repos, {
      nodes: [
        {
          ref: 'root',
          title: 'Root One',
          kind: 'root',
          children: [
            { ref: 'x', title: 'Dup', kind: 'leaf' },
            { ref: 'x', title: 'Dup', kind: 'leaf' },
          ],
        },
        { ref: 'root2', title: 'Root Two', kind: 'root' },
      ],
    });
    expect(codes).toEqual(expect.arrayContaining(['DUPLICATE_REF', 'DUPLICATE_SLUG', 'MULTIPLE_ROOTS']));
  });
});
