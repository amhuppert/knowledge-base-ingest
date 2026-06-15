import type { ServiceContext } from './context.js';
import type { Node } from '../schemas/models.js';
import type { NodeId } from '../ids.js';
import type { NodeKind } from '../schemas/enums.js';
import type { Synthesize } from '../schemas/agent.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveNodeId } from '../algorithms/idDeriver.js';
import { slugify } from '../algorithms/normalize.js';
import { extractCitations } from '../algorithms/citations.js';
import { makeClaimId } from '../ids.js';

export class NodeError extends Error {}

export interface CreateNodeInput {
  parentId: NodeId | null;
  slug?: string;
  title: string;
  kind: NodeKind;
  sortOrder?: number;
}

export class NodeService {
  constructor(private readonly ctx: ServiceContext) {}

  createNode(input: CreateNodeInput): { node: Node; created: boolean } {
    const repos = this.ctx.repos;
    const now = this.ctx.now();
    const slug = input.slug ? slugify(input.slug) : slugify(input.title);
    if (!slug) throw new NodeError('node slug/title must contain at least one alphanumeric char');

    if (input.kind === 'root') {
      if (input.parentId !== null) throw new NodeError('root node must have no parent');
    } else if (input.parentId === null) {
      throw new NodeError(`${input.kind} node requires a parent`);
    }

    let parent: Node | undefined;
    if (input.parentId !== null) {
      parent = repos.nodes.getById(input.parentId);
      if (!parent) throw new NodeError(`unknown parent node ${input.parentId}`);
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
   * Set a node's synthesized prose (clearing its stale flag). Validates that every
   * inline `[^clm_…]` citation resolves to an existing claim — broken citations are
   * rejected. No-ops (still clears stale) when the body is unchanged.
   */
  synthesize(payload: Synthesize): { updated: boolean; unchanged: boolean; missingCitations: string[] } {
    const repos = this.ctx.repos;
    const now = this.ctx.now();
    const node = repos.nodes.getById(payload.node_id);
    if (!node) throw new NodeError(`unknown node ${payload.node_id}`);

    const missing = extractCitations(payload.body_md).filter(
      (cid) => !repos.claims.getById(makeClaimId(cid)),
    );
    if (missing.length > 0) {
      throw new NodeError(`body cites unknown claim(s): ${missing.join(', ')}`);
    }

    const bodyHash = sha256Hex(payload.body_md);
    const unchanged = bodyHash === node.bodyHash;

    return repos.tx(() => {
      repos.nodes.updateBody(payload.node_id, {
        bodyMd: payload.body_md,
        bodyHash,
        isStale: false,
        updatedAt: now,
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
      });
      repos.changelog.append({
        ts: now,
        op: 'synthesize',
        summary: `Synthesized node "${payload.title ?? node.title}"`,
        detail: { nodeId: payload.node_id, unchanged },
      });
      return { updated: true, unchanged, missingCitations: [] };
    });
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
