import type { Repositories } from '../db/repositories/index.js';
import { verifyQuote } from '../domain/algorithms/quoteVerifier.js';
import { extractCitations } from '../domain/algorithms/citations.js';
import { sha256Hex } from '../domain/algorithms/hash.js';
import { makeClaimId } from '../domain/ids.js';
import type { SourceId } from '../domain/ids.js';
import { SpanRow } from '../db/rows.js';

/**
 * VERIFY — read-only invariant checks that guarantee provenance integrity.
 *
 * Every check has a stable `check` name so callers (and tests) can assert on
 * specific invariants. The module never mutates the DB; the only writes it
 * issues are FTS5 `integrity-check` control inserts, which validate the index
 * structure without changing content.
 *
 * Severity: an `error` means a provenance/structural invariant is violated;
 * a `warning` flags a maintenance condition (e.g. stale nodes) that does not
 * break provenance but should be addressed. In `--strict` mode warnings also
 * fail the run.
 */

export type Severity = 'error' | 'warning';

export interface VerifyFinding {
  check: string;
  severity: Severity;
  message: string;
  ids?: string[];
}

export interface VerifyReport {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: VerifyFinding[];
}

/** A single FTS table's integrity-check probe. */
function ftsIntegrity(repos: Repositories, table: string): VerifyFinding | undefined {
  try {
    repos.db.prepare(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`).run();
    return undefined;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      check: 'fts-integrity',
      severity: 'error',
      message: `FTS index ${table} failed integrity-check: ${reason}`,
    };
  }
}

export function verify(repos: Repositories, opts?: { strict?: boolean }): VerifyReport {
  const findings: VerifyFinding[] = [];

  const claims = repos.claims;
  const nodes = repos.nodes.listAll();

  // Cache canonical source text so we read each source at most once.
  const sourceTextCache = new Map<string, string | undefined>();
  const sourceTextFor = (sourceId: SourceId): string | undefined => {
    if (!sourceTextCache.has(sourceId)) {
      sourceTextCache.set(sourceId, repos.sourceTexts.get(sourceId)?.text);
    }
    return sourceTextCache.get(sourceId);
  };

  // 1. claim-has-provenance: every active claim has >=1 supporting span.
  const noProvenance: string[] = [];
  for (const node of nodes) {
    for (const claim of claims.listByNode(node.id)) {
      if (claim.status !== 'active') continue;
      const supports = repos.claimSpans.listByClaim(claim.id).filter((cs) => cs.role === 'supports');
      if (supports.length === 0) noProvenance.push(claim.id);
    }
  }
  if (noProvenance.length > 0) {
    findings.push({
      check: 'claim-has-provenance',
      severity: 'error',
      message: `${noProvenance.length} active claim(s) lack a supporting span`,
      ids: noProvenance,
    });
  }

  // 2. quote-matches-source: EVERY span (claim- or relationship-backed) must still
  // quote its source exactly, and its quote_hash must be intact. Iterating all spans
  // — not just claim-reachable ones — catches tampering with graph-only evidence.
  for (const row of repos.db.prepare('SELECT * FROM spans').all()) {
    const span = SpanRow.parse(row);
    if (span.quoteHash !== sha256Hex(span.quote)) {
      findings.push({ check: 'quote-matches-source', severity: 'error', message: `span ${span.id} quote_hash does not match its quote`, ids: [span.id] });
    }
    const text = sourceTextFor(span.sourceId);
    if (text === undefined) {
      findings.push({ check: 'quote-matches-source', severity: 'error', message: `span ${span.id} references source ${span.sourceId} with no canonical text`, ids: [span.id] });
      continue;
    }
    const res = verifyQuote(text, span.quote, span.charStart, span.charEnd);
    if (!res.ok) {
      findings.push({ check: 'quote-matches-source', severity: 'error', message: `span ${span.id} quote no longer matches source ${span.sourceId}: ${res.reason}`, ids: [span.id] });
    }
  }

  // 3. leaf-has-citation: every leaf node with a non-empty body cites >=1 claim.
  const uncitedLeaves: string[] = [];
  // 4. citation-resolves: every cited claim id resolves to an existing claim.
  const unresolvedCitations: string[] = [];
  // 5. parent-cites-subtree: every cited claim's owning node is in the citing node's subtree.
  const subtreeViolations: string[] = [];
  // 6. citation-active: fresh prose must not cite a superseded/retracted claim.
  const inactiveCitations: string[] = [];

  for (const node of nodes) {
    const cited = extractCitations(node.bodyMd);

    if (node.kind === 'leaf' && node.bodyMd.length > 0 && cited.length === 0) {
      uncitedLeaves.push(node.id);
    }

    if (cited.length === 0) continue;

    const subtreeIds = new Set(claims.listInSubtree(node.id).map((c) => c.id));

    for (const cid of cited) {
      const claim = claims.getById(makeClaimId(cid));
      if (!claim) {
        unresolvedCitations.push(cid);
        continue;
      }
      if (!subtreeIds.has(claim.id)) {
        subtreeViolations.push(`${node.id}->${cid}`);
      }
      if (claim.status === 'superseded' || claim.status === 'retracted') {
        inactiveCitations.push(`${node.id}->${cid}`);
      }
    }
  }

  if (uncitedLeaves.length > 0) {
    findings.push({
      check: 'leaf-has-citation',
      severity: 'warning',
      message: `${uncitedLeaves.length} leaf node(s) with a body cite no claim`,
      ids: uncitedLeaves,
    });
  }
  if (unresolvedCitations.length > 0) {
    findings.push({
      check: 'citation-resolves',
      severity: 'error',
      message: `${unresolvedCitations.length} inline citation(s) resolve to no claim`,
      ids: unresolvedCitations,
    });
  }
  if (subtreeViolations.length > 0) {
    findings.push({
      check: 'parent-cites-subtree',
      severity: 'error',
      message: `${subtreeViolations.length} citation(s) reference a claim outside the citing node's subtree`,
      ids: subtreeViolations,
    });
  }
  if (inactiveCitations.length > 0) {
    findings.push({
      check: 'citation-active',
      severity: 'error',
      message: `${inactiveCitations.length} citation(s) reference a superseded/retracted claim`,
      ids: inactiveCitations,
    });
  }

  // 6. no-stale-nodes: no node should be stale.
  const stale = repos.nodes.listStaleDeepestFirst();
  if (stale.length > 0) {
    findings.push({
      check: 'no-stale-nodes',
      severity: 'warning',
      message: `${stale.length} node(s) are stale and need re-synthesis`,
      ids: stale.map((n) => n.id),
    });
  }

  // 7. fts-integrity: each FTS index passes its internal integrity-check.
  for (const table of ['chunks_fts', 'claims_fts', 'nodes_fts'] as const) {
    const finding = ftsIntegrity(repos, table);
    if (finding) findings.push(finding);
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const strict = opts?.strict ?? false;
  const ok = strict ? errors === 0 && warnings === 0 : errors === 0;

  return { ok, errors, warnings, findings };
}
