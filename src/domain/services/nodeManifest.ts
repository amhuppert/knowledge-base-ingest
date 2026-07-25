/**
 * NODE-APPLY MANIFEST PREVALIDATION (04 §2, review finding 24).
 *
 * `prevalidateNodeManifest` flattens the `nodes` forest into an apply-ordered list of
 * resolved specs and collects ALL structural/collision issues before the caller
 * rejects — the batch is atomic, so any error means nothing is applied. It is READ-ONLY
 * (the DB reads let it distinguish a legal replay of an existing node from a genuine
 * collision); the actual writes happen in `NodeService.applyManifest`.
 *
 * The load-bearing subtlety is replay legality (finding 24): node ids derive from
 * `(parent, slug)`, so a spec whose derived id already exists is NOT automatically an
 * error. When its `kind` and `title` also match, it is exactly the replay case →
 * outcome `existing`, no issue. Only a differing `kind`/`title` is a mismatch, and the
 * root count is taken over DISTINCT LOGICAL ROOT IDS so re-declaring the existing root
 * is a replay, not a second root.
 */

import type { Repositories } from '../../db/repositories/index.js';
import type { NodeApply, NodeManifestChild, NodeManifestTop } from '../schemas/agent.js';
import type { NodeId } from '../ids.js';
import type { NodeKind } from '../schemas/enums.js';
import { slugify } from '../algorithms/normalize.js';
import { deriveNodeId } from '../algorithms/idDeriver.js';
import type { DomainIssueDetail } from '../issueCodes.js';

/** A manifest spec after parent resolution and id derivation. */
export interface ResolvedNodeSpec {
  ref: string;
  title: string;
  kind: NodeKind;
  /** The raw `slug` from the spec (undefined ⇒ derived from the title, as `createNode` does). */
  slugInput: string | undefined;
  /** The slugified slug/title — the value `(parent, slug)` id derivation and grouping use. */
  slug: string;
  /** Resolved parent: a manifest parent's derived id, an existing DB node id (graft), or null (root). */
  parentId: NodeId | null;
  derivedId: NodeId;
  /** Manifest-relative depth (a top-level spec is 0). Used to order parents before children. */
  depth: number;
  /** Canonical bracket-dot path, e.g. `nodes[0].children[1]`. */
  path: string;
}

export interface NodeManifestPlan {
  /** Every collected issue; a non-empty list means reject the whole manifest. */
  issues: DomainIssueDetail[];
  /** Resolved specs in DFS/pre-order; `applyManifest` sorts them parents-before-children. */
  specs: ResolvedNodeSpec[];
}

/** Push a resolved spec (computing its slug + derived id) and recurse into its children. */
function walk(
  spec: NodeManifestChild | NodeManifestTop,
  parentId: NodeId | null,
  path: string,
  depth: number,
  specs: ResolvedNodeSpec[],
  issues: DomainIssueDetail[],
): void {
  const slugInput = spec.slug;
  const slug = slugify(slugInput ?? spec.title);
  if (!slug) {
    issues.push({
      code: 'PAYLOAD_SCHEMA',
      message: `node "${spec.title}" has no sluggable ${slugInput !== undefined ? 'slug' : 'title'} (needs ≥1 alphanumeric char)`,
      path: `${path}.${slugInput !== undefined ? 'slug' : 'title'}`,
    });
  }
  const derivedId = deriveNodeId(parentId, slug);
  specs.push({ ref: spec.ref, title: spec.title, kind: spec.kind, slugInput, slug, parentId, derivedId, depth, path });

  const children = spec.children ?? [];
  children.forEach((child, ci) => {
    const childPath = `${path}.children[${ci}]`;
    // A nested spec has a parent by position, so it can never be a root.
    if (child.kind === 'root') {
      issues.push({
        code: 'ROOT_HAS_PARENT',
        message: `nested node "${child.title}" cannot be kind root (a root has no parent)`,
        path: childPath,
      });
    }
    walk(child, derivedId, childPath, depth + 1, specs, issues);
  });
}

/** Prevalidate a parsed manifest, collecting every issue and the resolved spec list. */
export function prevalidateNodeManifest(repos: Repositories, payload: NodeApply): NodeManifestPlan {
  const issues: DomainIssueDetail[] = [];
  const specs: ResolvedNodeSpec[] = [];

  // 1. Flatten + resolve each top-level spec's parent, then recurse.
  payload.nodes.forEach((top, i) => {
    const path = `nodes[${i}]`;
    let parentId: NodeId | null;
    if (top.kind === 'root') {
      parentId = null;
      if (top.parent_id !== undefined) {
        issues.push({
          code: 'ROOT_HAS_PARENT',
          message: `root node "${top.title}" cannot declare a parent_id`,
          path: `${path}.parent_id`,
          ids: [top.parent_id],
        });
      }
    } else if (top.parent_id !== undefined) {
      // A graft: the parent must already exist in the DB.
      if (!repos.nodes.getById(top.parent_id)) {
        issues.push({
          code: 'UNKNOWN_PARENT_REF',
          message: `parent node ${top.parent_id} is not in the knowledge base`,
          path: `${path}.parent_id`,
          ids: [top.parent_id],
        });
      }
      parentId = top.parent_id; // derive ids off it regardless, so children are still checked
    } else {
      // A non-root top-level spec with no parent is unplaceable.
      issues.push({
        code: 'PAYLOAD_SCHEMA',
        message: `top-level ${top.kind} node "${top.title}" needs a parent_id; only a root node may omit it`,
        path,
      });
      parentId = null;
    }
    walk(top, parentId, path, 0, specs, issues);
  });

  // 2. DUPLICATE_REF — refs must be unique across the whole manifest.
  const byRef = new Map<string, ResolvedNodeSpec[]>();
  for (const s of specs) {
    const group = byRef.get(s.ref);
    if (group) group.push(s);
    else byRef.set(s.ref, [s]);
  }
  for (const [ref, group] of byRef) {
    if (group.length > 1) {
      issues.push({
        code: 'DUPLICATE_REF',
        message: `ref "${ref}" is used ${group.length} times; every manifest ref must be unique`,
        path: group[1]!.path,
      });
    }
  }

  // 3. DUPLICATE_SLUG — two MANIFEST entries resolving to the same (parent, slug), i.e. the
  //    same derived id. Manifest-internal only; a collision with an existing DB node is
  //    handled by the replay/mismatch rule (step 4), never as DUPLICATE_SLUG.
  const byDerived = new Map<string, ResolvedNodeSpec[]>();
  for (const s of specs) {
    const group = byDerived.get(s.derivedId);
    if (group) group.push(s);
    else byDerived.set(s.derivedId, [s]);
  }
  for (const [, group] of byDerived) {
    if (group.length > 1) {
      const dup = group[1]!;
      issues.push({
        code: 'DUPLICATE_SLUG',
        message: `two manifest nodes resolve to the same parent and slug "${dup.slug}"`,
        path: dup.path,
        ids: [dup.derivedId],
      });
    }
  }

  // 4. DB collision: an existing node with a matching kind AND title is a legal replay
  //    (outcome `existing`); a differing kind and/or title is a hard mismatch. EVERY spec
  //    is checked (not deduped per derived id — two specs sharing a derived id are each a
  //    distinct manifest entry that could mismatch), and the kind and title checks are
  //    INDEPENDENT so a spec differing in both fields raises BOTH codes.
  for (const s of specs) {
    const existing = repos.nodes.getById(s.derivedId);
    if (!existing) continue;
    if (existing.kind !== s.kind) {
      issues.push({
        code: 'NODE_KIND_MISMATCH',
        message: `node ${s.derivedId} already exists as kind "${existing.kind}"; the manifest declares "${s.kind}"`,
        path: s.path,
        ids: [s.derivedId],
      });
    }
    if (existing.title !== s.title) {
      issues.push({
        code: 'NODE_TITLE_MISMATCH',
        message: `node ${s.derivedId} already exists with title "${existing.title}"; the manifest declares "${s.title}"`,
        path: s.path,
        ids: [s.derivedId],
      });
    }
    // kind + title both match → replay, no issue.
  }

  // 5. MULTIPLE_ROOTS — count DISTINCT LOGICAL ROOT IDS = the existing root's id (if any)
  //    ∪ the derived ids of every manifest root spec. A root spec whose derived id equals
  //    the existing root's is a replay, not a second root, so it does not raise the count.
  const rootIds = new Set<string>();
  const existingRoot = repos.nodes.getRoot();
  if (existingRoot) rootIds.add(existingRoot.id);
  for (const s of specs) {
    if (s.kind === 'root') rootIds.add(deriveNodeId(null, s.slug));
  }
  if (rootIds.size > 1) {
    const firstRoot = specs.find((s) => s.kind === 'root');
    issues.push({
      code: 'MULTIPLE_ROOTS',
      message: `manifest would introduce multiple roots; a knowledge base has exactly one (root ids: ${[...rootIds].join(', ')})`,
      path: firstRoot?.path ?? 'nodes',
      ids: [...rootIds],
    });
  }

  return { issues, specs };
}
