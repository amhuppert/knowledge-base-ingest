import type { Repositories } from '../../db/repositories/index.js';
import type { Synthesize } from '../schemas/agent.js';
import type { ClaimId, NodeId } from '../ids.js';
import { makeClaimId } from '../ids.js';
import { extractCitations } from '../algorithms/citations.js';
import { formatPath, type DomainIssue } from '../issueCodes.js';

/**
 * SHARED SYNTHESIS VALIDATOR (03 §1).
 *
 * The one place that decides which claims a node MAY cite and classifies every inline
 * `[^clm_…]` citation. `NodeService.synthesize` rejects on any error issue (closing the
 * former persist-then-fail gap); `kb verify` keeps its own equivalent checks as defense
 * in depth. Pure + read-only — it issues no writes and never mutates `repos`.
 */

/** The minimal repository surface the validator reads (nodes + claims only). */
export type ValidatorRepos = Pick<Repositories, 'nodes' | 'claims'>;

/** Per-call knobs; today only the batch path prefix (04 §3). */
export interface ValidateSynthesisOptions {
  /**
   * Path segments prepended to every issue path, formatted through the one canonical
   * `formatPath` (01 §3.1). A batch entry passes `['nodes', i]`, so a citation issue
   * reports `nodes[3].body_md` instead of the single-payload `body_md` (04 §3).
   */
  pathPrefix?: ReadonlyArray<string | number>;
}

export interface SynthesisValidation {
  /** One issue per distinct problematic citation, ordered by first occurrence; `[]` when valid. */
  issues: DomainIssue[];
  /** The citable claim ids for the target node, sorted lexicographically. */
  allowedCitationIds: ClaimId[];
}

/**
 * The claims a node may cite: `status ∈ {active, conflicted}` owned anywhere in the
 * node's own subtree (`ClaimRepo.listInSubtree` + status filter), sorted lexicographically.
 * Superseded/retracted claims are uncitable even when correctly owned, so they are excluded.
 */
export function allowedCitations(repos: ValidatorRepos, nodeId: NodeId): ClaimId[] {
  return repos.claims
    .listInSubtree(nodeId)
    .filter((c) => c.status === 'active' || c.status === 'conflicted')
    .map((c) => c.id)
    .sort();
}

/**
 * Classify every distinct citation in `payload.body_md` against the target node, applying
 * per-citation precedence (finding 23) — exactly ONE issue per distinct cited id, first
 * matching rule wins:
 *   1. unknown id                                   → CITATION_UNKNOWN
 *   2. known but superseded/retracted               → CITATION_INACTIVE (dominates; even a
 *      correctly-owned inactive claim is uncitable — the hint names the superseding claim
 *      when one is set)
 *   3. known, active/conflicted, outside the subtree → CITATION_OUT_OF_SUBTREE
 *      (`ids: [claimId, owningNodeId]`; the hint names the owning node's title)
 * Issues are ordered by the citation's first occurrence in `body_md` (`extractCitations`
 * already returns first-seen, de-duplicated order). Every issue path is built from
 * `options.pathPrefix` + `body_md`, so a batch entry reports `nodes[i].body_md` (04 §3)
 * while a single payload keeps the bare `body_md`.
 */
export function validateSynthesis(
  repos: ValidatorRepos,
  payload: Synthesize,
  options: ValidateSynthesisOptions = {},
): SynthesisValidation {
  const allowedCitationIds = allowedCitations(repos, payload.node_id);
  const allowed = new Set<string>(allowedCitationIds);
  const bodyPath = formatPath([...(options.pathPrefix ?? []), 'body_md']);
  const issues: DomainIssue[] = [];

  for (const cid of extractCitations(payload.body_md)) {
    const claimId = makeClaimId(cid);
    const claim = repos.claims.getById(claimId);

    if (!claim) {
      issues.push({
        code: 'CITATION_UNKNOWN',
        message: `body cites unknown claim ${claimId}`,
        path: bodyPath,
        ids: [claimId],
      });
      continue;
    }

    if (claim.status === 'superseded' || claim.status === 'retracted') {
      const supersededBy = claim.supersededByClaimId;
      issues.push({
        code: 'CITATION_INACTIVE',
        message: `body cites ${claim.status} claim ${claimId}`,
        path: bodyPath,
        ids: [claimId],
        hint: supersededBy
          ? `Cite the superseding claim ${supersededBy} instead.`
          : `Claim ${claimId} is ${claim.status}; cite an active replacement instead.`,
      });
      continue;
    }

    // Active/conflicted but not in the node's subtree.
    if (!allowed.has(claimId)) {
      const owningNodeId = claim.nodeId;
      const owningNode = owningNodeId ? repos.nodes.getById(owningNodeId) : undefined;
      issues.push({
        code: 'CITATION_OUT_OF_SUBTREE',
        message: `body cites claim ${claimId} owned by node ${owningNodeId ?? '(none)'} outside this node's subtree`,
        path: bodyPath,
        ids: owningNodeId ? [claimId, owningNodeId] : [claimId],
        hint: owningNode
          ? `Claim is owned by node "${owningNode.title}" (${owningNodeId}), outside this node's subtree.`
          : `Claim ${claimId} is owned outside this node's subtree.`,
      });
    }
  }

  return { issues, allowedCitationIds };
}
