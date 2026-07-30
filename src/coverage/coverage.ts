import type { Repositories } from '../db/repositories/index.js';
import { extractCitations } from '../domain/algorithms/citations.js';
import { classifyChunkText } from '../domain/algorithms/chunkKind.js';
import { makeClaimId, type SourceId } from '../domain/ids.js';
import type { ClaimStatus, SourceStatus } from '../domain/schemas/enums.js';
import { candidatesForClaim } from '../domain/services/claimCandidates.js';

/**
 * COVERAGE (06 §3) — read-only, descriptive completeness checks.
 *
 * Coverage is NEVER an integrity gate (verify owns that); it surfaces where the
 * synthesis has gaps. A pure function over `Repositories`, mirroring `verify.ts`:
 * it issues no writes and returns one finding per check.
 *
 * Every check reads only LIVE provenance links, so an orphan span (its
 * `claim_spans` / `relationship_spans` rows deleted) never counts as coverage.
 * Span↔chunk overlap is half-open: `sp.char_start < c.char_end AND sp.char_end >
 * c.char_start`. Ids within a finding are lexicographic; findings are emitted in
 * the fixed table order below.
 */

/** The five coverage checks, in 06 §3 table order (also the issue-emission order). */
export const COVERAGE_CHECKS = [
  'SOURCE_NO_CLAIMS',
  'CHUNK_UNCITED',
  'CLAIM_NOT_SYNTHESIZED',
  'NODE_SINGLE_SOURCE',
  'OPEN_QUESTION_NOT_SYNTHESIZED',
] as const;

export type CoverageCode = (typeof COVERAGE_CHECKS)[number];

/** Maximum ids surfaced for any coverage inventory or issue; totals remain exact. */
export const COVERAGE_ID_CAP = 20;

/** One check's result: the code plus every matching id, lexicographically sorted. */
export interface CoverageFinding {
  code: CoverageCode;
  ids: string[];
}

/** The full coverage report: exactly one finding per check, in `COVERAGE_CHECKS` order. */
export interface CoverageReport {
  findings: CoverageFinding[];
  structuralChunks: { total: number; shown: number; ids: string[] };
}

export interface CappedCoverageIds {
  total: number;
  shown: number;
  ids: string[];
}

export type SourceCoverageCode =
  | 'SOURCE_NO_CLAIMS'
  | 'CHUNK_UNCITED'
  | 'CLAIM_NOT_SYNTHESIZED'
  | 'OPEN_QUESTION_NOT_SYNTHESIZED';

export interface CoverageSourceReport {
  scope: {
    kind: 'source';
    sourceId: SourceId;
    title: string;
    sourceStatus: SourceStatus;
    membership: 'evidence-span';
  };
  chunks: {
    total: number;
    substantive: number;
    cited: number;
    uncited: CappedCoverageIds;
    structural: CappedCoverageIds;
  };
  claims: {
    active: {
      total: number;
      synthesized: number;
      unsynthesized: CappedCoverageIds;
    };
    conflicted: CappedCoverageIds;
    superseded: CappedCoverageIds;
    retracted: CappedCoverageIds;
  };
  relationships: {
    total: number;
    byStatus: Record<ClaimStatus, number>;
  };
  candidates: {
    total: number;
    shown: number;
    claimIds: string[];
  };
  findings: Array<CappedCoverageIds & { code: SourceCoverageCode }>;
}

/** Raw `{ id }` rows → their id strings. */
function ids(rows: unknown[]): string[] {
  return rows.map((r) => (r as { id: string }).id);
}

function cappedIds(values: string[]): CappedCoverageIds {
  const sorted = [...values].sort();
  return {
    total: sorted.length,
    shown: Math.min(sorted.length, COVERAGE_ID_CAP),
    ids: sorted.slice(0, COVERAGE_ID_CAP),
  };
}

export function coverage(repos: Repositories): CoverageReport {
  const db = repos.db;

  // SOURCE_NO_CLAIMS — active sources with zero spans linked (via live claim_spans)
  // to an active/conflicted claim.
  const sourceNoClaims = ids(
    db
      .prepare(
        `SELECT s.id AS id FROM sources s
          WHERE s.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM spans sp
                JOIN claim_spans cs ON cs.span_id = sp.id
                JOIN claims c ON c.id = cs.claim_id
               WHERE sp.source_id = s.id AND c.status IN ('active','conflicted')
            )
          ORDER BY s.id`,
      )
      .all(),
  );

  // CHUNK_UNCITED — chunks of active sources with no overlapping span that carries a
  // live claim_spans link (to an active/conflicted claim) OR a live relationship_spans
  // link. Half-open overlap; orphan spans (links deleted) do not cover.
  const uncitedChunkRows = db
    .prepare(
      `SELECT ch.id AS id, ch.text AS text FROM source_chunks ch
            JOIN sources s ON s.id = ch.source_id
           WHERE s.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM spans sp
                WHERE sp.source_id = ch.source_id
                  AND sp.char_start < ch.char_end AND sp.char_end > ch.char_start
                  AND (
                    EXISTS (SELECT 1 FROM claim_spans cs JOIN claims c ON c.id = cs.claim_id
                             WHERE cs.span_id = sp.id AND c.status IN ('active','conflicted'))
                    OR EXISTS (SELECT 1 FROM relationship_spans rs WHERE rs.span_id = sp.id)
                  )
             )
           ORDER BY ch.id`,
    )
    .all() as Array<{ id: string; text: string }>;
  const chunkUncited = uncitedChunkRows
    .filter((chunk) => classifyChunkText(chunk.text) === 'substantive')
    .map((chunk) => chunk.id);

  // Structural chunks are neutral inventory, never findings. Inventory includes every
  // structural chunk of an active source, whether or not a live span overlaps it.
  const structuralChunkIds = (
    db
      .prepare(
        `SELECT ch.id AS id, ch.text AS text FROM source_chunks ch
           JOIN sources s ON s.id = ch.source_id
          WHERE s.status = 'active'
          ORDER BY ch.id`,
      )
      .all() as Array<{ id: string; text: string }>
  )
    .filter((chunk) => classifyChunkText(chunk.text) === 'structural')
    .map((chunk) => chunk.id);
  const structuralShown = Math.min(structuralChunkIds.length, COVERAGE_ID_CAP);
  const structuralChunks = {
    total: structuralChunkIds.length,
    shown: structuralShown,
    ids: structuralChunkIds.slice(0, COVERAGE_ID_CAP),
  };

  // The set of every claim id cited across all node bodies (the same extractor verify
  // and the renderer use). Conflicted claims never surface here — they are excluded
  // from CLAIM_NOT_SYNTHESIZED and reach readers via the open-questions render.
  const nodes = repos.nodes.listAll();
  const citedClaimIds = new Set<string>();
  for (const node of nodes) for (const id of extractCitations(node.bodyMd)) citedClaimIds.add(id);

  // CLAIM_NOT_SYNTHESIZED — active claims whose id appears in no body citation.
  // OPEN_QUESTION_NOT_SYNTHESIZED — the open_question slice of the same.
  const activeClaims = db
    .prepare(`SELECT id, claim_type AS claimType FROM claims WHERE status = 'active' ORDER BY id`)
    .all() as Array<{ id: string; claimType: string }>;
  const claimNotSynthesized = activeClaims.filter((c) => !citedClaimIds.has(c.id)).map((c) => c.id);
  const openQuestionNotSynthesized = activeClaims
    .filter((c) => c.claimType === 'open_question' && !citedClaimIds.has(c.id))
    .map((c) => c.id);

  // NODE_SINGLE_SOURCE — nodes whose BODY-CITED claims trace via live spans to ≤1
  // distinct source. Nodes citing zero (resolvable) claims are excluded — that is a
  // stale/empty signal, measured elsewhere.
  const nodeSingleSource: string[] = [];
  for (const node of nodes) {
    const cited = extractCitations(node.bodyMd);
    if (cited.length === 0) continue;
    const sources = new Set<string>();
    let resolved = 0;
    for (const cid of cited) {
      const claim = repos.claims.getById(makeClaimId(cid));
      if (!claim) continue;
      resolved += 1;
      for (const span of repos.claimSpans.spansForClaim(claim.id)) sources.add(span.sourceId);
    }
    if (resolved === 0) continue;
    if (sources.size <= 1) nodeSingleSource.push(node.id);
  }
  nodeSingleSource.sort();

  const byCode: Record<CoverageCode, string[]> = {
    SOURCE_NO_CLAIMS: sourceNoClaims,
    CHUNK_UNCITED: chunkUncited,
    CLAIM_NOT_SYNTHESIZED: claimNotSynthesized,
    NODE_SINGLE_SOURCE: nodeSingleSource,
    OPEN_QUESTION_NOT_SYNTHESIZED: openQuestionNotSynthesized,
  };

  return {
    findings: COVERAGE_CHECKS.map((code) => ({ code, ids: byCode[code] })),
    structuralChunks,
  };
}

/**
 * Describe the graph and synthesis contribution of one source. Claim and
 * relationship membership comes exclusively from the canonical evidence-span
 * contribution repository; first-seen provenance is never consulted.
 */
export function coverageForSource(repos: Repositories, sourceId: SourceId): CoverageSourceReport {
  const source = repos.sources.getById(sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);

  const chunkRows = repos.db
    .prepare(
      `SELECT ch.id AS id, ch.text AS text,
              EXISTS (
                SELECT 1 FROM spans sp
                 WHERE sp.source_id = ch.source_id
                   AND sp.char_start < ch.char_end AND sp.char_end > ch.char_start
                   AND (
                     EXISTS (
                       SELECT 1 FROM claim_spans cs
                         JOIN claims c ON c.id = cs.claim_id
                        WHERE cs.span_id = sp.id AND c.status IN ('active','conflicted')
                     )
                     OR EXISTS (
                       SELECT 1 FROM relationship_spans rs WHERE rs.span_id = sp.id
                     )
                   )
              ) AS cited
         FROM source_chunks ch
        WHERE ch.source_id = ?
        ORDER BY ch.id`,
    )
    .all(sourceId) as Array<{ id: string; text: string; cited: 0 | 1 }>;
  const substantiveChunks = chunkRows.filter(
    (chunk) => classifyChunkText(chunk.text) === 'substantive',
  );
  const structuralChunks = chunkRows.filter(
    (chunk) => classifyChunkText(chunk.text) === 'structural',
  );
  const uncitedChunkIds = substantiveChunks
    .filter((chunk) => chunk.cited === 0)
    .map((chunk) => chunk.id);

  const contributions = repos.sourceContribution.claimsEvidencedBy(sourceId);
  const byClaimStatus: Record<ClaimStatus, typeof contributions> = {
    active: [],
    conflicted: [],
    superseded: [],
    retracted: [],
  };
  for (const contribution of contributions) byClaimStatus[contribution.status].push(contribution);

  const citedClaimIds = new Set<string>();
  for (const node of repos.nodes.listAll()) {
    for (const claimId of extractCitations(node.bodyMd)) citedClaimIds.add(claimId);
  }
  const unsynthesizedActive = byClaimStatus.active.filter(
    (claim) => !citedClaimIds.has(claim.claimId),
  );
  const unsynthesizedIds = unsynthesizedActive.map((claim) => claim.claimId);
  const openQuestionIds = unsynthesizedActive
    .filter((claim) => claim.claimType === 'open_question')
    .map((claim) => claim.claimId);

  const relationshipContributions = repos.sourceContribution.relationshipsEvidencedBy(sourceId);
  const relationshipByStatus: Record<ClaimStatus, number> = {
    active: 0,
    superseded: 0,
    conflicted: 0,
    retracted: 0,
  };
  for (const relationship of relationshipContributions) {
    relationshipByStatus[relationship.status] += 1;
  }

  const sourceNoClaims =
    byClaimStatus.active.length + byClaimStatus.conflicted.length === 0 ? [sourceId] : [];
  const uncited = cappedIds(uncitedChunkIds);
  const unsynthesized = cappedIds(unsynthesizedIds);
  const candidateClaimIds = byClaimStatus.active
    .filter((contribution) => {
      const claim = repos.claims.getById(contribution.claimId);
      if (!claim) {
        throw new Error(
          `source contribution references missing claim ${contribution.claimId}`,
        );
      }
      return (
        candidatesForClaim(repos, {
          nodeId: claim.nodeId,
          text: claim.text,
          excludeClaimIds: [claim.id],
        }).matched > 0
      );
    })
    .map((contribution) => contribution.claimId);
  const cappedCandidates = cappedIds(candidateClaimIds);

  return {
    scope: {
      kind: 'source',
      sourceId,
      title: source.title,
      sourceStatus: source.status,
      membership: 'evidence-span',
    },
    chunks: {
      total: chunkRows.length,
      substantive: substantiveChunks.length,
      cited: substantiveChunks.length - uncitedChunkIds.length,
      uncited,
      structural: cappedIds(structuralChunks.map((chunk) => chunk.id)),
    },
    claims: {
      active: {
        total: byClaimStatus.active.length,
        synthesized: byClaimStatus.active.length - unsynthesizedActive.length,
        unsynthesized,
      },
      conflicted: cappedIds(byClaimStatus.conflicted.map((claim) => claim.claimId)),
      superseded: cappedIds(byClaimStatus.superseded.map((claim) => claim.claimId)),
      retracted: cappedIds(byClaimStatus.retracted.map((claim) => claim.claimId)),
    },
    relationships: {
      total: relationshipContributions.length,
      byStatus: relationshipByStatus,
    },
    candidates: {
      total: cappedCandidates.total,
      shown: cappedCandidates.shown,
      claimIds: cappedCandidates.ids,
    },
    findings: [
      { code: 'SOURCE_NO_CLAIMS', ...cappedIds(sourceNoClaims) },
      { code: 'CHUNK_UNCITED', ...uncited },
      { code: 'CLAIM_NOT_SYNTHESIZED', ...unsynthesized },
      { code: 'OPEN_QUESTION_NOT_SYNTHESIZED', ...cappedIds(openQuestionIds) },
    ],
  };
}
