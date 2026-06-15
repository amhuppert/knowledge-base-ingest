/**
 * Quote verification — the anti-hallucination keystone of provenance.
 *
 * A claim's provenance is an exact substring (`quote`) of a source's canonical
 * text at a half-open `[charStart, charEnd)` range, measured in JS UTF-16 code
 * units. This function checks, with NO normalization or fuzzy matching, that the
 * quote really is that slice. The CLI runs it before persisting any span, so the
 * agent cannot attach a paraphrased or invented quote as evidence.
 */

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyQuote(
  sourceText: string,
  quote: string,
  charStart: number,
  charEnd: number,
): VerifyResult {
  if (
    !Number.isInteger(charStart) ||
    !Number.isInteger(charEnd) ||
    charStart < 0 ||
    charEnd < charStart ||
    charEnd > sourceText.length
  ) {
    return {
      ok: false,
      reason: `offsets [${charStart}, ${charEnd}) are out of range for source of length ${sourceText.length}`,
    };
  }
  const actual = sourceText.slice(charStart, charEnd);
  if (actual !== quote) {
    return {
      ok: false,
      reason: `quote does not match source at [${charStart}, ${charEnd}): expected ${JSON.stringify(
        actual,
      )}, got ${JSON.stringify(quote)}`,
    };
  }
  return { ok: true };
}
