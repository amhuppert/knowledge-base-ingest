/**
 * Normalization functions. Two very different jobs live here:
 *
 *  - {@link normalizeSourceText} produces the *canonical extracted text* that
 *    provenance offsets address. It must be conservative: it may only collapse
 *    representational noise (BOM, line endings, Unicode form) and must NOT touch
 *    internal whitespace, or `[char_start, char_end)` offsets would shift.
 *
 *  - {@link normalizeClaimText} / {@link normalizeEntityName} produce *identity
 *    keys* used for dedup. They are lossy on purpose (case/whitespace) but are
 *    never used to address source text, so losing information is fine.
 */

/**
 * Canonical source text. Strips a leading UTF-8 BOM, converts CRLF and lone CR
 * to LF, and applies Unicode NFC. Internal whitespace is preserved so that
 * character offsets into the result remain meaningful for quote verification.
 *
 * This is extractor `text-utf8/1` (see SOURCE_TEXT_EXTRACTOR).
 */
export function normalizeSourceText(raw: string): string {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip BOM
  s = s.replace(/\r\n?/g, '\n'); // CRLF / lone CR -> LF
  return s.normalize('NFC');
}

export const SOURCE_TEXT_EXTRACTOR = 'text-utf8' as const;
export const SOURCE_TEXT_EXTRACTOR_VERSION = 1 as const;

/** Collapse all runs of Unicode whitespace to a single ASCII space and trim. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Identity key for a claim: NFC, lowercased, whitespace-collapsed, trimmed, with
 * a single trailing sentence period removed. Case/whitespace variants collapse to
 * the same key so the same assertion is not stored twice within a node.
 */
export function normalizeClaimText(text: string): string {
  return collapseWhitespace(text.normalize('NFC').toLowerCase()).replace(/\.$/, '');
}

/**
 * Identity key for an entity name: NFC, lowercased, whitespace-collapsed, trimmed.
 *
 * Deliberately conservative — it does NOT strip version suffixes or punctuation,
 * because for software entities the version and punctuation are part of identity
 * ("React 18" != "React", "Node.js" != "Nodejs").
 */
export function normalizeEntityName(name: string): string {
  return collapseWhitespace(name.normalize('NFC').toLowerCase());
}

/** URL/file-safe slug: lowercase, non-alphanumerics to "-", collapsed and trimmed. */
export function slugify(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
