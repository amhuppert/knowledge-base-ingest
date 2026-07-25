import type { Repositories } from '../db/repositories/index.js';
import { extractCitations } from '../domain/algorithms/citations.js';
import { makeClaimId } from '../domain/ids.js';

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

/** One check's result: the code plus every matching id, lexicographically sorted. */
export interface CoverageFinding {
  code: CoverageCode;
  ids: string[];
}

/** The full coverage report: exactly one finding per check, in `COVERAGE_CHECKS` order. */
export interface CoverageReport {
  findings: CoverageFinding[];
}

/** Raw `{ id }` rows → their id strings. */
function ids(rows: unknown[]): string[] {
  return rows.map((r) => (r as { id: string }).id);
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
  const chunkUncited = ids(
    db
      .prepare(
        `SELECT ch.id AS id FROM source_chunks ch
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
      .all(),
  );

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

  return { findings: COVERAGE_CHECKS.map((code) => ({ code, ids: byCode[code] })) };
}
