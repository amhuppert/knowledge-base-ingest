import type { Repositories } from '../../db/repositories/index.js';
import type { ClaimId, NodeId, SourceId } from '../ids.js';
import type { ClaimStatus, ClaimType, NodeKind } from '../schemas/enums.js';
import { allowedCitations } from './synthesisValidator.js';

/**
 * SYNTHESIS CONTEXT BUNDLE (04 §1).
 *
 * Everything a synthesis write needs, assembled in ONE read: the full node (its current
 * prose is what the agent revises), its children with own-claim counts, ONE owner-tagged
 * claim list covering the whole subtree, the sources behind those claims, the citable ids
 * from the shared Phase-1 validator, and stats. Compact-complete: no pagination and no
 * silent truncation — conflicts appear as claim `status` only.
 *
 * Pure + read-only. Two queries scale with the subtree (`listSubtree`, `listInSubtree`),
 * one with the children, and provenance for EVERY claim is a single batched `IN (…)`
 * (never one query per claim).
 */

/** Quote snippets are whitespace-collapsed and cut at this length, with `…` appended. */
export const SNIPPET_MAX_CHARS = 160;

/** The repository surface the bundle reads (nodes, claims, and claim→span provenance). */
export type NodeContextRepos = Pick<Repositories, 'nodes' | 'claims' | 'claimSpans'>;

/** The target node, INCLUDING its current prose — the agent revises this body (finding 25). */
export interface ContextNode {
  id: NodeId;
  parentId: NodeId | null;
  title: string;
  kind: NodeKind;
  depth: number;
  summary: string;
  isStale: boolean;
  bodyMd: string;
  bodyHash: string;
}

/** A direct child, with the number of CITABLE claims it owns itself (not its subtree). */
export interface ContextChild {
  id: NodeId;
  title: string;
  kind: NodeKind;
  summary: string;
  isStale: boolean;
  ownClaims: number;
}

/** One supporting quote, trimmed for reading; `kb provenance <claim_id>` has the full text. */
export interface ContextProvenance {
  sourceId: SourceId;
  sourceTitle: string;
  quoteSnippet: string;
}

/** A citable claim, tagged with the node that owns it. */
export interface ContextClaim {
  id: ClaimId;
  text: string;
  claimType: ClaimType;
  status: ClaimStatus;
  confidence: number;
  nodeId: NodeId;
  nodeTitle: string;
  provenance: ContextProvenance[];
}

/** A source behind the bundle's claims; `claimCount` counts THIS bundle's claims. */
export interface ContextSource {
  id: SourceId;
  title: string;
  claimCount: number;
}

export interface ContextStats {
  descendantNodes: number;
  claims: number;
  /** `ceil(len(JSON of the payload WITHOUT stats) / 4)` — see `buildNodeContext`. */
  approxTokens: number;
  /** Always `true` this phase; the field exists so future pagination is additive. */
  complete: true;
}

/** The `data` payload of `kb node show <id> --context`, in emission order. */
export interface NodeContextData {
  node: ContextNode;
  children: ContextChild[];
  claims: ContextClaim[];
  sources: ContextSource[];
  allowedCitationIds: ClaimId[];
  stats: ContextStats;
}

export interface NodeContextBundle {
  data: NodeContextData;
  /**
   * True when ANY `quoteSnippet` was cut — presentation metadata, deliberately OUTSIDE
   * `data` (which carries the command payload only, 01 §2). It drives the provenance
   * hint so a truncated quote is never silently truncated.
   */
  snippetsTruncated: boolean;
}

/** Lexicographic string compare (explicit, so every tie-break reads the same way). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whitespace-collapse a quote and cut it to {@link SNIPPET_MAX_CHARS}, appending `…`
 * when anything was dropped. Reports the cut so the caller can surface the
 * "full quotes live in kb provenance" hint.
 */
function snippet(quote: string): { text: string; truncated: boolean } {
  const collapsed = quote.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SNIPPET_MAX_CHARS) return { text: collapsed, truncated: false };
  return { text: `${collapsed.slice(0, SNIPPET_MAX_CHARS)}…`, truncated: true };
}

/** A claim plus the owner-derived sort keys, dropped before emission. */
interface SortableClaim {
  claim: ContextClaim;
  ownerDepth: number;
  ownerSortOrder: number;
  createdAt: string;
}

/**
 * Assemble the synthesis context for `nodeId`, or `undefined` when no such node exists.
 *
 * Total ordering (deterministic under ties, 04 §1):
 *   claims by `(ownerDepth, ownerSortOrder, ownerNodeId, createdAt, claimId)`;
 *   `provenance` within a claim by `(sourceId, charStart, spanId)`;
 *   `children` by `(sortOrder, nodeId)`; `sources` by `(title, sourceId)`;
 *   `allowedCitationIds` lexicographic (the validator's own order).
 *
 * `approxTokens` measures `{node, children, claims, sources, allowedCitationIds}` and is
 * computed BEFORE `stats` is attached, so the measurement can never include itself.
 */
export function buildNodeContext(repos: NodeContextRepos, nodeId: NodeId): NodeContextBundle | undefined {
  const target = repos.nodes.getById(nodeId);
  if (!target) return undefined;

  const subtree = repos.nodes.listSubtree(nodeId);
  const owners = new Map(subtree.map((n) => [n.id, n]));

  // Citable = the exact status set the validator allows (active + conflicted), so the
  // claim list and `allowedCitationIds` can never disagree; superseded/retracted claims
  // are absent from both.
  const citable = repos.claims
    .listInSubtree(nodeId)
    .filter((c) => c.status === 'active' || c.status === 'conflicted');

  const ownClaimCounts = new Map<NodeId, number>();
  for (const claim of citable) {
    if (claim.nodeId) ownClaimCounts.set(claim.nodeId, (ownClaimCounts.get(claim.nodeId) ?? 0) + 1);
  }

  const children: ContextChild[] = repos.nodes
    .children(nodeId)
    .map((child) => ({
      id: child.id,
      title: child.title,
      kind: child.kind,
      summary: child.summary,
      isStale: child.isStale,
      ownClaims: ownClaimCounts.get(child.id) ?? 0,
    }))
    .sort((a, b) => {
      const sortOrder = (id: NodeId): number => owners.get(id)!.sortOrder;
      return sortOrder(a.id) - sortOrder(b.id) || cmp(a.id, b.id);
    });

  // ONE batched provenance query for every claim, grouped in memory.
  let snippetsTruncated = false;
  const provenanceByClaim = new Map<ClaimId, Array<ContextProvenance & { charStart: number; spanId: string }>>();
  for (const row of repos.claimSpans.provenanceForClaims(citable.map((c) => c.id))) {
    const cut = snippet(row.quote);
    snippetsTruncated = snippetsTruncated || cut.truncated;
    const entries = provenanceByClaim.get(row.claimId) ?? [];
    entries.push({
      sourceId: row.sourceId,
      sourceTitle: row.sourceTitle,
      quoteSnippet: cut.text,
      charStart: row.charStart,
      spanId: row.spanId,
    });
    provenanceByClaim.set(row.claimId, entries);
  }

  const sortable: SortableClaim[] = [];
  for (const claim of citable) {
    const owner = claim.nodeId ? owners.get(claim.nodeId) : undefined;
    if (!owner) continue; // unreachable: listInSubtree only returns claims owned in the subtree
    const provenance = (provenanceByClaim.get(claim.id) ?? [])
      .sort((a, b) => cmp(a.sourceId, b.sourceId) || a.charStart - b.charStart || cmp(a.spanId, b.spanId))
      .map(({ sourceId, sourceTitle, quoteSnippet }) => ({ sourceId, sourceTitle, quoteSnippet }));
    sortable.push({
      ownerDepth: owner.depth,
      ownerSortOrder: owner.sortOrder,
      createdAt: claim.createdAt,
      claim: {
        id: claim.id,
        text: claim.text,
        claimType: claim.claimType,
        status: claim.status,
        confidence: claim.confidence,
        nodeId: owner.id,
        nodeTitle: owner.title,
        provenance,
      },
    });
  }
  sortable.sort(
    (a, b) =>
      a.ownerDepth - b.ownerDepth ||
      a.ownerSortOrder - b.ownerSortOrder ||
      cmp(a.claim.nodeId, b.claim.nodeId) ||
      cmp(a.createdAt, b.createdAt) ||
      cmp(a.claim.id, b.claim.id),
  );
  const claims = sortable.map((s) => s.claim);

  // Sources behind the bundle: each claim counts ONCE per source it quotes.
  const sourceTitles = new Map<SourceId, string>();
  const sourceClaimCounts = new Map<SourceId, number>();
  for (const claim of claims) {
    for (const sourceId of new Set(claim.provenance.map((p) => p.sourceId))) {
      sourceTitles.set(sourceId, claim.provenance.find((p) => p.sourceId === sourceId)!.sourceTitle);
      sourceClaimCounts.set(sourceId, (sourceClaimCounts.get(sourceId) ?? 0) + 1);
    }
  }
  const sources: ContextSource[] = [...sourceClaimCounts.entries()]
    .map(([id, claimCount]) => ({ id, title: sourceTitles.get(id)!, claimCount }))
    .sort((a, b) => cmp(a.title, b.title) || cmp(a.id, b.id));

  const core = {
    node: {
      id: target.id,
      parentId: target.parentId,
      title: target.title,
      kind: target.kind,
      depth: target.depth,
      summary: target.summary,
      isStale: target.isStale,
      bodyMd: target.bodyMd,
      bodyHash: target.bodyHash,
    },
    children,
    claims,
    sources,
    // Sourced from the shared Phase-1 validator, so "what this node may cite" has exactly
    // one definition across `synthesize` and this bundle.
    allowedCitationIds: allowedCitations(repos, nodeId),
  };

  // Measured on `core` — `stats` does not exist yet, so it cannot measure itself.
  const approxTokens = Math.ceil(JSON.stringify(core).length / 4);

  return {
    data: {
      ...core,
      stats: {
        descendantNodes: subtree.length - 1,
        claims: claims.length,
        approxTokens,
        complete: true,
      },
    },
    snippetsTruncated,
  };
}
