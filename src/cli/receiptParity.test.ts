import { describe, it, expect } from 'vitest';
import { receiptProjection, PROJECTION_KEYS } from './receiptParity.js';

/**
 * Unit tests for the receipt-parity projection (03 §2, finding 18). The projection is an
 * ALLOWLIST limited to the §2 fields — per-input outcomes, ids, span/evidence accounting,
 * and staleNodes. The critical property (validator ask): a field OUTSIDE the projection —
 * the preview flag, a clock-derived field, a deprecated alias, or any unknown key —
 * CANNOT affect parity, while a differing PROJECTED field DOES break it (so the projection
 * is load-bearing, never vacuous).
 */
describe('receiptProjection (03 §2 allowlist)', () => {
  it('keeps only the §2 projection keys and drops everything else', () => {
    const data = {
      // §2 fields (kept)
      claimsCreated: 1,
      claimsUpdated: 0,
      spansCreated: 2,
      affectedNodes: 1,
      staleNodes: ['nod_a'],
      // excluded: preview flag, envelope leakage, clock-derived, and unknown
      dryRun: true,
      generatedAt: '2026-07-24T00:00:00.000Z',
      nextActions: [],
      hints: ['x'],
      missingCitations: [],
      somethingNew: 42,
    };
    expect(receiptProjection(data)).toEqual({
      claimsCreated: 1,
      claimsUpdated: 0,
      spansCreated: 2,
      affectedNodes: 1,
      staleNodes: ['nod_a'],
    });
  });

  it('excluded fields — preview flag, clock-derived, and unknown — cannot affect parity', () => {
    const shared = { claimsCreated: 1, spansCreated: 2, affectedNodes: 1, staleNodes: ['nod_a'] };
    // Two receipts identical on the §2 fields but wildly different on excluded fields.
    const dry = { ...shared, dryRun: true, generatedAt: '2026-07-24T00:00:01.000Z', receiptId: 'r-dry' };
    const real = { ...shared, dryRun: false, generatedAt: '2026-07-24T09:59:59.000Z', receiptId: 'r-real' };

    expect(dry).not.toEqual(real); // the raw payloads differ …
    expect(receiptProjection(dry)).toEqual(receiptProjection(real)); // … but the projections match.
  });

  it('a differing PROJECTED field DOES break parity (the projection is load-bearing)', () => {
    const a = { claimsCreated: 1, dryRun: true };
    const b = { claimsCreated: 2, dryRun: false };
    expect(receiptProjection(a)).not.toEqual(receiptProjection(b));
  });

  it('projects the graph and synthesize receipt shapes to their §2 accounting only', () => {
    const graph = {
      entitiesCreated: 2,
      entitiesUpdated: 0,
      entitiesUnchanged: 0,
      entitiesReferenced: 2,
      relationshipsCreated: 1,
      relationshipsUpdated: 0,
      relationshipsUnchanged: 0,
      spansCreated: 1,
      dryRun: true,
    };
    expect(receiptProjection(graph)).toEqual({
      entitiesCreated: 2,
      entitiesUpdated: 0,
      entitiesUnchanged: 0,
      entitiesReferenced: 2,
      relationshipsCreated: 1,
      relationshipsUpdated: 0,
      relationshipsUnchanged: 0,
      spansCreated: 1,
    });

    const synth = { updated: true, unchanged: false, missingCitations: [], dryRun: true };
    // `missingCitations` is a superseded alias (always []) — outside the projection.
    expect(receiptProjection(synth)).toEqual({ updated: true, unchanged: false });
  });

  it('projects a non-object payload to {} (failed preview vs failed apply compare structurally)', () => {
    expect(receiptProjection(null)).toEqual({});
    expect(receiptProjection(undefined)).toEqual({});
    expect(receiptProjection('nope')).toEqual({});
  });

  it('the allowlist has no duplicate keys', () => {
    expect(new Set(PROJECTION_KEYS).size).toBe(PROJECTION_KEYS.length);
  });
});
