/**
 * Inline claim citations in synthesis prose use GFM footnote-reference syntax
 * `[^clm_<hex>]`. The agent writes only these references; the renderer generates
 * the matching footnote definitions from the DB. Pure + deterministic.
 */

/** All claim ids referenced in `bodyMd`, in first-seen order, de-duplicated. */
export function extractCitations(bodyMd: string): string[] {
  const seen = new Set<string>();
  // A FRESH global regex per call: a module-shared /g regex leaks `lastIndex`
  // across calls, so a prior `hasCitation()` (or a prior extraction) would make
  // this `matchAll` start mid-string and drop earlier citations (finding 32).
  for (const m of bodyMd.matchAll(/\[\^(clm_[0-9a-f]+)\]/g)) {
    const id = m[1]!;
    if (!seen.has(id)) seen.add(id);
  }
  return [...seen];
}

/** True if the prose contains at least one claim citation. */
export function hasCitation(bodyMd: string): boolean {
  // NON-global: `.test()` on a /g regex advances and leaks `lastIndex`.
  return /\[\^clm_[0-9a-f]+\]/.test(bodyMd);
}
