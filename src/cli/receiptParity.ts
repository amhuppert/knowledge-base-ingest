/**
 * RECEIPT-PARITY PROJECTION (03 §2, finding 18).
 *
 * A dry-run receipt must equal its real apply on the DETERMINISTIC §2 fields ONLY —
 * per-input OUTCOMES, IDs, span/evidence ACCOUNTING, and `staleNodes`. This is an
 * ALLOWLIST, not a denylist: a key absent from `PROJECTION_KEYS` is dropped whether or
 * not it exists today, so the preview-only `dryRun` flag, the envelope-level steering
 * (`nextActions`/`hints`, which never live in `data`), any deprecated compatibility
 * alias, and any future clock-derived field CANNOT influence parity — proven by
 * `receiptParity.test.ts` (excluded fields differ wildly yet the projections match).
 *
 * The keys span all three DB-only dry-run receipts (`claim apply` / `graph apply` /
 * `synthesize`, 03 §3). Today these are the AUTHORITATIVE accounting counters — the
 * per-input `claims[]`/`entities[]`/`relationships[]` arrays and `totals` object land
 * with the receipts refactor (03 §3), which demotes the flat counters to deprecated
 * aliases and updates this allowlist + its parity goldens in the same commit (charter:
 * compat-aliases). Keeping the accounting keys here now makes the parity test
 * load-bearing rather than vacuous; the array/`totals` keys are pre-registered so that
 * refactor swaps authority without widening the projection surface.
 */

/**
 * The §2 projection allowlist, grouped by category (per-input outcomes, ids, accounting,
 * staleNodes). Only these keys survive `receiptProjection`; everything else is excluded.
 */
export const PROJECTION_KEYS: readonly string[] = [
  // per-input outcomes (arrays land with the receipts refactor) + synthesize's single outcome
  'claims',
  'entities',
  'relationships',
  // `nodes` covers both Phase 2 per-node arrays: node apply's ref→{nodeId, outcome} map
  // (04 §2) and batch synthesize's outcomes + ids + echoed depth (04 §3)
  'nodes',
  'outcome',
  // ids
  'nodeId',
  // accounting — flat counters are authoritative today; `totals` supersedes them later
  'totals',
  'claimsCreated',
  'claimsUpdated',
  'spansCreated',
  'affectedNodes',
  'entitiesCreated',
  'entitiesUpdated',
  'entitiesUnchanged',
  'entitiesReferenced',
  'relationshipsCreated',
  'relationshipsUpdated',
  'relationshipsUnchanged',
  'updated',
  'unchanged',
  // stale accounting
  'staleNodes',
];

const PROJECTION_SET = new Set(PROJECTION_KEYS);

/**
 * The 03 §2 parity projection of an envelope's `data`: only the allowlisted §2 fields.
 * A non-object payload (e.g. `null` from a failed preview) projects to `{}` so a failed
 * preview and a failed real apply still compare structurally.
 */
export function receiptProjection(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!PROJECTION_SET.has(key)) continue;
    if (key === 'claims' && Array.isArray(value)) {
      out[key] = value.map((row) => {
        if (row === null || typeof row !== 'object') return row;
        const { reviewCandidates: _previewOnly, ...projected } = row as Record<
          string,
          unknown
        >;
        return projected;
      });
    } else {
      out[key] = value;
    }
  }
  return out;
}
