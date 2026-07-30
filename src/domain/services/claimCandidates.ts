import type { Repositories } from '../../db/repositories/index.js';
import type { ClaimId, NodeId } from '../ids.js';
import { makeClaimId, makeNodeId } from '../ids.js';
import type { ClaimStatus, ClaimType } from '../schemas/enums.js';

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'has',
  'have',
  'not',
  'its',
]);
const MAX_QUERY_TOKENS = 8;
const CANDIDATE_CAP = 5;

export interface ClaimCandidate {
  claimId: ClaimId;
  nodeId: NodeId | null;
  status: 'active' | 'conflicted';
  claimType: ClaimType;
  text: string;
  reason: 'same_node' | 'lexical_overlap';
  score: number;
}

export interface ClaimCandidateSet {
  matched: number;
  shown: number;
  complete: boolean;
  items: ClaimCandidate[];
}

interface CandidateRow {
  claim_id: string;
  node_id: string | null;
  status: ClaimStatus;
  claim_type: ClaimType;
  text: string;
  score?: number;
}

/** @internal Exported so the exact lexical-query contract can be table-tested. */
export function buildClaimCandidateMatchQuery(text: string): string | null {
  const distinct = new Set<string>();
  for (const token of text.toLowerCase().split(/\W+/)) {
    if (token.length < 3 || STOPWORDS.has(token) || distinct.has(token)) continue;
    distinct.add(token);
    if (distinct.size === MAX_QUERY_TOKENS) break;
  }
  return distinct.size === 0 ? null : [...distinct].join(' OR ');
}

function candidate(row: CandidateRow, reason: ClaimCandidate['reason']): ClaimCandidate {
  return {
    claimId: makeClaimId(row.claim_id),
    nodeId: row.node_id === null ? null : makeNodeId(row.node_id),
    status: row.status as 'active' | 'conflicted',
    claimType: row.claim_type,
    text: row.text,
    reason,
    score: reason === 'same_node' ? 1 : row.score!,
  };
}

/**
 * Find active/conflicted claims worth reviewing beside a proposed claim.
 *
 * Ordering is deterministic: same-node candidates by claim id first, followed by
 * lexical candidates by ascending FTS rank and claim id. Same-node retrieval wins
 * when both routes find the same claim.
 */
export function candidatesForClaim(
  repos: Repositories,
  input: { nodeId: NodeId | null; text: string; excludeClaimIds: ClaimId[] },
): ClaimCandidateSet {
  const excluded = new Set<ClaimId>(input.excludeClaimIds);
  const byId = new Map<ClaimId, ClaimCandidate>();

  const sameNodeRows = (
    input.nodeId === null
      ? repos.db
          .prepare(
            `SELECT id AS claim_id, node_id, status, claim_type, text
             FROM claims
             WHERE node_id IS NULL AND status IN ('active', 'conflicted')
             ORDER BY id`,
          )
          .all()
      : repos.db
          .prepare(
            `SELECT id AS claim_id, node_id, status, claim_type, text
             FROM claims
             WHERE node_id = ? AND status IN ('active', 'conflicted')
             ORDER BY id`,
          )
          .all(input.nodeId)
  ) as CandidateRow[];

  for (const row of sameNodeRows) {
    const item = candidate(row, 'same_node');
    if (!excluded.has(item.claimId)) byId.set(item.claimId, item);
  }

  const query = buildClaimCandidateMatchQuery(input.text);
  if (query !== null) {
    const lexicalRows = repos.db
      .prepare(
        `SELECT c.id AS claim_id, c.node_id, c.status, c.claim_type, c.text,
                bm25(claims_fts) AS score
         FROM claims_fts
         JOIN claims c ON c.rowid = claims_fts.rowid
         WHERE claims_fts MATCH ?
           AND c.status IN ('active', 'conflicted')
         ORDER BY score, c.id`,
      )
      .all(query) as CandidateRow[];

    for (const row of lexicalRows) {
      const item = candidate(row, 'lexical_overlap');
      if (!excluded.has(item.claimId) && !byId.has(item.claimId)) {
        byId.set(item.claimId, item);
      }
    }
  }

  const matches = [...byId.values()];
  const items = matches.slice(0, CANDIDATE_CAP);
  return {
    matched: matches.length,
    shown: items.length,
    complete: matches.length <= CANDIDATE_CAP,
    items,
  };
}
