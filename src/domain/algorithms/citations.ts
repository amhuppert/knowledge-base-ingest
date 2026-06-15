/**
 * Inline claim citations in synthesis prose use GFM footnote-reference syntax
 * `[^clm_<hex>]`. The agent writes only these references; the renderer generates
 * the matching footnote definitions from the DB. Pure + deterministic.
 */

const CITATION_RE = /\[\^(clm_[0-9a-f]+)\]/g;

/** All claim ids referenced in `bodyMd`, in first-seen order, de-duplicated. */
export function extractCitations(bodyMd: string): string[] {
  const seen = new Set<string>();
  for (const m of bodyMd.matchAll(CITATION_RE)) {
    const id = m[1]!;
    if (!seen.has(id)) seen.add(id);
  }
  return [...seen];
}

/** True if the prose contains at least one claim citation. */
export function hasCitation(bodyMd: string): boolean {
  CITATION_RE.lastIndex = 0;
  return CITATION_RE.test(bodyMd);
}
