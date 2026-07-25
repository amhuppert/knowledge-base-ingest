/**
 * MEDIA POLICY (06 §1.1) — the single extension→media-type table, the strict UTF-8
 * decode, and the `UNSUPPORTED_MEDIA` recovery recipe.
 *
 * Policy, exactly as specified:
 *  - **Known-binary extensions** (`pdf docx pptx xlsx png jpg jpeg gif zip`) always
 *    require `--text-from`; their bytes are never decoded.
 *  - **Everything else** — known-text extensions AND unknown extensions alike — is
 *    decoded with `new TextDecoder('utf-8', { fatal: true })` plus a NUL guard. This
 *    REPLACES the old lossy `Buffer.toString('utf8')`, which substituted U+FFFD
 *    silently; the change is stricter and is recorded in the phase compatibility
 *    matrix. Unknown-extension UTF-8 text keeps working exactly as before.
 *
 * The table lives here (not in `src/cli/commands/ingest.ts`) because the domain layer
 * decodes and must gate binary media, and the domain cannot import the CLI. It is
 * still a SINGLE table: `ingest.ts` imports it for the media-type guess and renders it
 * in the HelpSpec via `mediaFormatTable()`, so the help text can never drift from the
 * policy the service enforces.
 */

import { shellQuoteArg } from './shellQuote.js';

/**
 * Extension → media type. Insertion order is the 06 §1.1 order and drives the rendered
 * format table. Anything absent falls back to `text/plain` when it decodes as UTF-8,
 * else `application/octet-stream` (see {@link mediaTypeFor}).
 */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  rst: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  zip: 'application/zip',
};

/** Extensions whose bytes are never canonical text: ingest requires `--text-from`. */
export const KNOWN_BINARY_EXTENSIONS = [
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'zip',
] as const;

const BINARY_SET: ReadonlySet<string> = new Set(KNOWN_BINARY_EXTENSIONS);

/** The mapped extensions that are NOT known-binary — ingestable without a sidecar. */
export const TEXT_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPES).filter((e) => !BINARY_SET.has(e));

/** Normalize an extension for lookup: lowercase, leading dot stripped. */
function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

/** True iff `ext` is a known-binary extension, which always requires `--text-from`. */
export function requiresTextSidecar(ext: string): boolean {
  return BINARY_SET.has(normalizeExt(ext));
}

/**
 * Strictly decode bytes as UTF-8 text, or `null` when they are not text: a fatal
 * decode failure (malformed UTF-8 — never silently replaced with U+FFFD) or a NUL
 * byte, which never appears in a valid UTF-8 text source.
 */
export function decodeUtf8Strict(bytes: Buffer): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\0') ? null : text;
}

/**
 * The media type recorded for an input: the mapped type for a known extension, else
 * `text/plain` when the bytes decode as UTF-8 and `application/octet-stream` when they
 * do not (06 §1.1). Bytes are only decoded for the unknown-extension case.
 */
export function mediaTypeFor(ext: string, bytes: Buffer): string {
  const mapped = MEDIA_TYPES[normalizeExt(ext)];
  if (mapped) return mapped;
  return decodeUtf8Strict(bytes) === null ? 'application/octet-stream' : 'text/plain';
}

/**
 * The format table as human lines, derived from {@link MEDIA_TYPES} so help text can
 * never drift from policy: one line per media type (extensions grouped, in table
 * order), the `--text-from` requirement marked, then the unknown-extension fallback.
 */
export function mediaFormatTable(): string[] {
  const byType = new Map<string, string[]>();
  for (const [ext, type] of Object.entries(MEDIA_TYPES)) {
    const exts = byType.get(type) ?? [];
    exts.push(ext);
    byType.set(type, exts);
  }
  const lines: string[] = [];
  for (const [type, exts] of byType) {
    const gated = exts.every((e) => BINARY_SET.has(e)) ? ' — requires --text-from' : '';
    lines.push(`${exts.join(', ')} → ${type}${gated}`);
  }
  lines.push(
    'any other extension → text/plain when it decodes as UTF-8 (no sidecar needed), else application/octet-stream — requires --text-from',
  );
  return lines;
}

/**
 * The `UNSUPPORTED_MEDIA` message (06 §1.5): the literal two-step `--text-from`
 * recipe, runnable verbatim for `originalPath`, plus the pointer to the full
 * supported-format table.
 */
export function unsupportedMediaMessage(originalPath: string | undefined): string {
  const target = originalPath ? shellQuoteArg(originalPath) : '<original>';
  return [
    `${originalPath ?? 'The input'} is not decodable UTF-8 text, so kb cannot read its canonical text directly.`,
    'Transcribe or extract the text yourself, then ingest the ORIGINAL with that text as a sidecar:',
    '  1. write the extracted text to a UTF-8 file, e.g. extracted.md',
    `  2. kb ingest ${target} --text-from extracted.md --json`,
    `Ingestable without a sidecar: ${TEXT_EXTENSIONS.join(', ')}, or any other UTF-8 text file.`,
    `Always requires --text-from: ${[...KNOWN_BINARY_EXTENSIONS].join(', ')}. Run kb ingest --help --json for the full format table.`,
  ].join('\n');
}
