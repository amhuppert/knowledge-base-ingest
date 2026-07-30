import type { ServiceContext } from './context.js';
import type { Node } from '../schemas/models.js';
import { makeClaimId, type NodeId } from '../ids.js';
import type { NodeKind } from '../schemas/enums.js';
import type { NodeApply, Synthesize, SynthesizeBatch } from '../schemas/agent.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveNodeId } from '../algorithms/idDeriver.js';
import { slugify } from '../algorithms/normalize.js';
import { DomainIssueError, DomainIssuesError, formatPath, type DomainIssue } from '../issueCodes.js';
import { prevalidateNodeManifest } from './nodeManifest.js';
import { validateSynthesis } from './synthesisValidator.js';
import { computeBodyDelta, type BodyDelta } from './bodyDelta.js';

export interface CreateNodeInput {
  parentId: NodeId | null;
  slug?: string;
  title: string;
  kind: NodeKind;
  sortOrder?: number;
}

/** Per-ref outcome in a node-apply receipt. */
export interface NodeApplyRefOutcome {
  ref: string;
  nodeId: NodeId;
  outcome: 'created' | 'existing';
}

/** The `node apply` receipt payload (04 §2). */
export interface NodeApplyReceipt {
  dryRun: boolean;
  nodes: NodeApplyRefOutcome[];
  totals: { created: number; existing: number };
  /** Nodes this apply marked stale (created nodes and their ancestor chains), deepest first. */
  staleNodes: NodeId[];
}

/** The outcome of a synthesize call — the authoritative field on its receipt (03 §3.3). */
export type SynthesizeOutcome = 'updated' | 'unchanged' | 'stale-cleared';

/**
 * The per-node receipt a synthesize returns (03 §3.3). `outcome` + `staleNodes` are
 * authoritative; `updated`/`unchanged`/`missingCitations` are DEPRECATED aliases retained
 * for the life of envelope v2 (compat-aliases): `unchanged` ⇔ `outcome === 'unchanged'`,
 * `updated` ⇔ a write occurred (outcome ≠ 'unchanged'), and `missingCitations` is always
 * `[]` — broken citations are now issues, not a data field.
 */
export interface SynthesizeReceipt {
  nodeId: NodeId;
  outcome: SynthesizeOutcome;
  bodyDelta: BodyDelta;
  staleNodes: NodeId[];
  /** @deprecated superseded by `outcome`; true iff a write occurred (outcome ≠ 'unchanged'). */
  updated: boolean;
  /** @deprecated superseded by `outcome`; true iff outcome === 'unchanged'. */
  unchanged: boolean;
  /** @deprecated always `[]`; broken citations surface as issues, not here. */
  missingCitations: string[];
}

/** One entry of a batch receipt, listed in APPLICATION order with its depth echoed (04 §3). */
export interface SynthesizeNodeReceipt {
  /** The entry's position in the submitted `nodes` array (application order differs). */
  inputIndex: number;
  nodeId: NodeId;
  /** The node's depth — the key the deepest-first ordering sorts on, echoed for visibility. */
  depth: number;
  outcome: SynthesizeOutcome;
  bodyDelta: BodyDelta;
}

/**
 * The receipt a batch synthesize returns (04 §3): per-node outcomes in application order,
 * outcome totals, and the post-apply stale set (deepest-first) that steering consumes.
 */
export interface SynthesizeBatchReceipt {
  nodes: SynthesizeNodeReceipt[];
  totals: { updated: number; unchanged: number; staleCleared: number };
  staleNodes: NodeId[];
}

export class NodeService {
  constructor(private readonly ctx: ServiceContext) {}

  createNode(input: CreateNodeInput): { node: Node; created: boolean } {
    const repos = this.ctx.repos;
    const now = this.ctx.now();
    const slug = input.slug ? slugify(input.slug) : slugify(input.title);
    if (!slug) {
      throw new DomainIssueError('INVALID_ARGUMENT', 'node slug/title must contain at least one alphanumeric char', { path: 'title' });
    }

    if (input.kind === 'root') {
      if (input.parentId !== null) {
        throw new DomainIssueError('ROOT_HAS_PARENT', 'root node must have no parent', { path: 'parentId' });
      }
    } else if (input.parentId === null) {
      throw new DomainIssueError('INVALID_ARGUMENT', `${input.kind} node requires a parent`, { path: 'parentId' });
    }

    let parent: Node | undefined;
    if (input.parentId !== null) {
      parent = repos.nodes.getById(input.parentId);
      if (!parent) {
        throw new DomainIssueError('UNKNOWN_PARENT_REF', `unknown parent node ${input.parentId}`, { path: 'parentId', ids: [input.parentId] });
      }
    }

    const id = deriveNodeId(input.parentId, slug);
    const existing = repos.nodes.getById(id);
    if (existing) return { node: existing, created: false };

    const depth = parent ? parent.depth + 1 : 0;
    const sortOrder =
      input.sortOrder ?? (input.parentId ? repos.nodes.children(input.parentId).length : 0);

    const node: Node = {
      id,
      parentId: input.parentId,
      slug,
      title: input.title,
      kind: input.kind,
      depth,
      sortOrder,
      summary: '',
      bodyMd: '',
      bodyHash: '',
      isStale: true,
      createdAt: now,
      updatedAt: now,
    };

    return repos.tx(() => {
      repos.nodes.insert(node);
      // Adding a child changes the parent's rendered subtopic list and synthesis
      // inputs, so the parent chain becomes stale too (this node starts stale).
      repos.nodes.markStaleWithAncestors(id, now);
      repos.changelog.append({
        ts: now,
        op: 'node_create',
        summary: `Created ${input.kind} node "${input.title}"`,
        detail: { id, parentId: input.parentId },
      });
      return { node, created: true };
    });
  }

  /**
   * Apply a hierarchy manifest atomically (04 §2). Prevalidation collects ALL issues
   * first; any error rejects the whole batch (nothing is written). The valid manifest is
   * applied parents before children via `createNode` — so an exact full-manifest replay
   * (every derived id already present with a matching kind/title) yields all outcomes
   * `existing` with zero writes and no changelog (`createNode` returns the existing node
   * before writing, and an empty transaction commits nothing).
   *
   * Prevalidation reads DB state to tell a legal replay from a genuine collision, and the
   * application writes based on that same state — so BOTH run inside ONE outer
   * `BEGIN IMMEDIATE` transaction. The write lock is taken up front, closing the TOCTOU
   * window where a concurrent apply could create a conflicting node or a second root
   * between validation and write (`createNode`'s own `repos.tx` nests as a SAVEPOINT).
   */
  applyManifest(payload: NodeApply): NodeApplyReceipt {
    const repos = this.ctx.repos;

    return repos.tx(() => {
      const plan = prevalidateNodeManifest(repos, payload);
      if (plan.issues.length > 0) {
        // Rolls back the (still empty) transaction and rejects the whole batch.
        throw new DomainIssuesError(plan.issues);
      }

      // Parents before children: a manifest parent (depth d) precedes every depth-(d+1)
      // node. Array.sort is stable, so manifest order is preserved within a depth.
      const ordered = [...plan.specs].sort((a, b) => a.depth - b.depth);

      const nodes: NodeApplyRefOutcome[] = [];
      const createdIds: NodeId[] = [];
      let created = 0;
      let existing = 0;

      for (const spec of ordered) {
        const r = this.createNode({
          parentId: spec.parentId,
          title: spec.title,
          kind: spec.kind,
          ...(spec.slugInput !== undefined ? { slug: spec.slugInput } : {}),
        });
        const outcome: NodeApplyRefOutcome['outcome'] = r.created ? 'created' : 'existing';
        nodes.push({ ref: spec.ref, nodeId: r.node.id, outcome });
        if (r.created) {
          created++;
          createdIds.push(r.node.id);
        } else {
          existing++;
        }
      }

      // staleNodes = the set this apply marked stale = every created node ∪ its ancestor
      // chain (creating a child stales its parent chain). A pure replay creates nothing, so
      // this is empty. Reported deepest-first (the order synthesis consumes stale nodes in).
      const staled = new Set<NodeId>();
      for (const id of createdIds) {
        let cur: NodeId | null = id;
        while (cur && !staled.has(cur)) {
          staled.add(cur);
          cur = repos.nodes.getById(cur)?.parentId ?? null;
        }
      }
      const staleNodes = [...staled]
        .map((id) => repos.nodes.getById(id)!)
        .sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((n) => n.id);

      return { dryRun: false, nodes, totals: { created, existing }, staleNodes };
    });
  }

  /**
   * Set a node's synthesized prose (clearing its stale flag). Every inline `[^clm_…]`
   * citation is validated by the shared synthesis validator (03 §1) BEFORE any write, so
   * an unknown / inactive / out-of-subtree citation rejects the whole call and persists
   * nothing (the former persist-then-fail gap). Three outcomes (03 §4):
   *  - `unchanged`     — body/title/summary all identical AND the node is fresh ⇒ ZERO writes;
   *  - `stale-cleared` — content identical but the node is stale ⇒ `clearStale` (timestamped)
   *    + one changelog entry, ancestors untouched;
   *  - `updated`       — content changed ⇒ write body/title/summary and clear the node's own
   *    stale; a title or summary change additionally stales the ANCESTOR chain (both feed the
   *    parent's render/synthesis), a body-only change never does.
   */
  synthesize(payload: Synthesize): SynthesizeReceipt {
    const repos = this.ctx.repos;
    const now = this.ctx.now();
    const node = this.requireNode(payload.node_id);

    const validation = validateSynthesis(repos, payload);
    const mismatch = this.bodyHashMismatch(node, payload);
    const errors = [...(mismatch ? [mismatch] : []), ...validation.issues].filter(
      (i) => (i.severity ?? 'error') === 'error',
    );
    if (errors.length > 0) throw new DomainIssuesError(errors);

    // True no-op: nothing to write and the node is already fresh.
    if (this.isNoop(node, payload)) {
      return this.synthReceipt(
        payload.node_id,
        'unchanged',
        this.bodyDelta(node.bodyMd, payload.body_md),
      );
    }

    const applied = repos.tx(() => this.applySynthesize(payload, now));
    return this.synthReceipt(payload.node_id, applied.outcome, applied.bodyDelta);
  }

  /**
   * BATCH SYNTHESIS (04 §3). One payload, one transaction: every entry is prevalidated
   * with the same validator the single form uses — under `nodes[i]…` paths — and ANY error
   * issue rejects the whole batch with all issues collected, having applied nothing. The
   * surviving entries are applied DEEPEST-FIRST (ties broken by payload order) so a child's
   * title change stales its parent BEFORE the parent's own entry runs, letting one batch
   * leave a whole branch fresh. Per-node outcomes follow the Phase 1 semantics; the receipt
   * lists nodes in APPLICATION order with each node's depth echoed for visibility.
   */
  synthesizeBatch(payload: SynthesizeBatch): SynthesizeBatchReceipt {
    const repos = this.ctx.repos;
    const now = this.ctx.now();

    const entries: Array<{ inputIndex: number; entry: Synthesize; node: Node }> = [];
    const issues: DomainIssue[] = [];
    payload.nodes.forEach((entry, inputIndex) => {
      const node = repos.nodes.getById(entry.node_id);
      if (!node) {
        issues.push({
          code: 'UNKNOWN_NODE',
          message: `unknown node ${entry.node_id}`,
          path: formatPath(['nodes', inputIndex, 'node_id']),
          ids: [entry.node_id],
        });
        return;
      }
      const mismatch = this.bodyHashMismatch(node, entry, ['nodes', inputIndex]);
      if (mismatch) issues.push(mismatch);
      issues.push(...validateSynthesis(repos, entry, { pathPrefix: ['nodes', inputIndex] }).issues);
      entries.push({ inputIndex, entry, node });
    });

    const errors = issues.filter((i) => (i.severity ?? 'error') === 'error');
    if (errors.length > 0) throw new DomainIssuesError(errors);

    // Deepest-first, payload order breaking ties (explicit, not relying on sort stability).
    const ordered = [...entries].sort((a, b) => b.node.depth - a.node.depth || a.inputIndex - b.inputIndex);
    // ONE `BEGIN IMMEDIATE` around the WHOLE application pass, unconditionally
    // (charter: locked-architecture). Each entry is re-read inside it by `applySynthesize`,
    // so an ancestor sees the staleness a deeper sibling just propagated — and because that
    // re-read can disagree with the unlocked prevalidation snapshot (another writer may have
    // staled a node in between), an apparent all-no-op batch may still write. The write lock
    // is therefore taken even for a pure repeat, which then simply commits empty: outcomes
    // are all `unchanged`, no row and no changelog entry is touched.
    const nodes = repos.tx((): SynthesizeNodeReceipt[] =>
      ordered.map(({ inputIndex, entry, node }) => ({
        inputIndex,
        nodeId: entry.node_id,
        depth: node.depth,
        ...this.applySynthesize(entry, now),
      })),
    );

    const count = (outcome: SynthesizeOutcome): number => nodes.filter((n) => n.outcome === outcome).length;
    return {
      nodes,
      totals: { updated: count('updated'), unchanged: count('unchanged'), staleCleared: count('stale-cleared') },
      staleNodes: repos.nodes.listStaleDeepestFirst().map((n) => n.id),
    };
  }

  /** The node, or a coded `UNKNOWN_NODE` rejection. */
  private requireNode(nodeId: NodeId): Node {
    const node = this.ctx.repos.nodes.getById(nodeId);
    if (!node) {
      throw new DomainIssueError('UNKNOWN_NODE', `unknown node ${nodeId}`, { path: 'node_id', ids: [nodeId] });
    }
    return node;
  }

  /** Whether `payload` restates the node's current content (body, and title/summary when given). */
  private contentSame(node: Node, payload: Synthesize): boolean {
    return (
      sha256Hex(payload.body_md) === node.bodyHash &&
      (payload.title === undefined || payload.title === node.title) &&
      (payload.summary === undefined || payload.summary === node.summary)
    );
  }

  /** A true no-op: nothing to write AND the node is already fresh (03 §4). */
  private isNoop(node: Node, payload: Synthesize): boolean {
    return this.contentSame(node, payload) && !node.isStale;
  }

  private bodyHashMismatch(
    node: Node,
    payload: Synthesize,
    pathPrefix: ReadonlyArray<string | number> = [],
  ): DomainIssue | undefined {
    if (payload.expected_body_hash === node.bodyHash) return undefined;
    return {
      code: 'BODY_HASH_MISMATCH',
      message: `node ${node.id} body changed since it was read`,
      path: formatPath([...pathPrefix, 'expected_body_hash']),
      ids: [node.id],
      hint: `Re-read the node: kb node show ${node.id} --context --json`,
    };
  }

  private bodyDelta(oldBody: string, newBody: string): BodyDelta {
    return computeBodyDelta(oldBody, newBody, (id) => {
      const claim = this.ctx.repos.claims.getById(makeClaimId(id));
      return claim?.status === 'active' || claim?.status === 'conflicted';
    });
  }

  /**
   * Apply ONE already-validated entry (node existence + citations checked by the caller)
   * and report its outcome. Must run inside a transaction whenever it can write. The node
   * is re-read here rather than reused from prevalidation so a batch entry sees the
   * staleness a deeper entry propagated moments earlier.
   */
  private applySynthesize(
    payload: Synthesize,
    now: string,
  ): { outcome: SynthesizeOutcome; bodyDelta: BodyDelta } {
    const repos = this.ctx.repos;
    const node = this.requireNode(payload.node_id);
    const mismatch = this.bodyHashMismatch(node, payload);
    if (mismatch) throw new DomainIssuesError([mismatch]);
    const bodyDelta = this.bodyDelta(node.bodyMd, payload.body_md);
    const contentSame = this.contentSame(node, payload);

    if (contentSame && !node.isStale) return { outcome: 'unchanged', bodyDelta };

    if (contentSame) {
      // Content identical but stale — re-affirm freshness as a timestamped state change.
      repos.nodes.clearStale(payload.node_id, now);
      repos.changelog.append({
        ts: now,
        op: 'synthesize',
        summary: `Cleared stale on node "${node.title}"`,
        detail: { nodeId: payload.node_id, unchanged: true },
      });
      return { outcome: 'stale-cleared', bodyDelta };
    }

    const titleChanged = payload.title !== undefined && payload.title !== node.title;
    const summaryChanged = payload.summary !== undefined && payload.summary !== node.summary;
    repos.nodes.updateBody(payload.node_id, {
      bodyMd: payload.body_md,
      bodyHash: sha256Hex(payload.body_md),
      isStale: false,
      updatedAt: now,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
    });
    // A title/summary change alters the parent's rendered child list + synthesis inputs, so
    // the ANCESTOR chain goes stale (never this node — we just cleared it). markStaleWithAncestors
    // starts at the PARENT so the freshly-synthesized node stays fresh.
    if ((titleChanged || summaryChanged) && node.parentId !== null) {
      repos.nodes.markStaleWithAncestors(node.parentId, now);
    }
    repos.changelog.append({
      ts: now,
      op: 'synthesize',
      summary: `Synthesized node "${payload.title ?? node.title}"`,
      detail: { nodeId: payload.node_id, unchanged: false },
    });
    return { outcome: 'updated', bodyDelta };
  }

  /** Assemble a synthesize receipt: authoritative `outcome`/`staleNodes` + deprecated aliases. */
  private synthReceipt(nodeId: NodeId, outcome: SynthesizeOutcome, bodyDelta: BodyDelta): SynthesizeReceipt {
    const staleNodes = this.ctx.repos.nodes.listStaleDeepestFirst().map((n) => n.id);
    return {
      nodeId,
      outcome,
      bodyDelta,
      staleNodes,
      updated: outcome !== 'unchanged',
      unchanged: outcome === 'unchanged',
      missingCitations: [],
    };
  }

  /** Re-assert staleness propagation: every stale node marks its ancestors stale. */
  propagate(): { staleCount: number } {
    const repos = this.ctx.repos;
    const now = this.ctx.now();
    return repos.tx(() => {
      for (const n of repos.nodes.listStaleDeepestFirst()) {
        repos.nodes.markStaleWithAncestors(n.id, now);
      }
      return { staleCount: repos.nodes.listStaleDeepestFirst().length };
    });
  }
}
