/**
 * Markdown pre-pass for `answer-check` (05 §4). A single line-oriented state
 * machine partitions the answer text into regions so citation/assertion checks
 * run only where they should: assertions over prose, citations over everything
 * except code. Pure + deterministic; no DB.
 */

export type RegionKind = 'prose' | 'fence' | 'footnoteDef' | 'blockquote' | 'inlineCode';

/** A contiguous slice of the source text with a single classification. */
export interface Region {
  kind: RegionKind;
  startOffset: number;
  endOffset: number;
  /** 1-based line of `startOffset` in the original text. */
  startLine: number;
}

/** A sentence located by absolute offsets into the original answer text. */
export interface SentenceSpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

/** Chars that may trail terminal punctuation and still belong to the sentence. */
const TRAILING_CLOSERS = new Set(["'", '"', ')', ']']);
const CITATION_TOKEN = /^\[\^clm_[0-9a-f]+\]/;

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * From a terminal punctuation mark at `p` (known to be outside any open quote),
 * consume trailing closing quotes/brackets and citation tokens. Returns the
 * boundary end offset iff whitespace or EOF follows the group; `null` otherwise
 * (e.g. `3.14`, where the `.` is mid-token, so it is not a sentence end).
 */
function boundaryEnd(prose: string, p: number): number | null {
  let k = p + 1;
  while (k < prose.length && TRAILING_CLOSERS.has(prose[k]!)) k++;
  for (;;) {
    let m = k;
    while (m < prose.length && isSpace(prose[m]!)) m++;
    const cm = CITATION_TOKEN.exec(prose.slice(m));
    if (!cm) break;
    k = m + cm[0].length;
  }
  if (k >= prose.length || isSpace(prose[k]!)) return k;
  return null;
}

/**
 * Split `prose` into sentence spans as an index scanner (05 §4.2), REPLACING the
 * old string-mutating splitter. The boundary rule is unchanged (terminal `.!?`
 * plus trailing closing quotes and citation tokens), with two additions:
 *   - a `.`/`!`/`?` inside an open double quote (straight `"` or curly `“ ”`;
 *     `\"` escapes ignored) does NOT end a sentence — quoting evidence stays part
 *     of the asserting sentence;
 *   - quote state resets at every blank line, so an unbalanced quote cannot leak
 *     across a paragraph break.
 * Offsets are absolute (`baseOffset` + local), so the caller derives line numbers
 * directly from `startOffset` against the original text — no lineMap indirection.
 */
export function splitSentenceSpans(prose: string, baseOffset: number): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const emit = (rawStart: number, rawEnd: number): void => {
    let s = rawStart;
    let e = rawEnd;
    while (s < e && isSpace(prose[s]!)) s++;
    while (e > s && isSpace(prose[e - 1]!)) e--;
    if (e <= s) return;
    spans.push({ text: prose.slice(s, e), startOffset: baseOffset + s, endOffset: baseOffset + e });
  };

  let inQuote = false;
  let lineHasContent = false;
  let segStart = 0;
  let i = 0;
  while (i < prose.length) {
    const ch = prose[i]!;
    if (ch === '\\') {
      // A backslash is ordinary content. Escapes ONLY suppress quote toggling —
      // `\"` (and `\“`/`\”`) must not open/close a quote — so we swallow the char
      // after the backslash iff it is a double-quote. Any other following char
      // (e.g. `\.`) is left for normal processing, preserving the boundary rule.
      lineHasContent = true;
      const next = prose[i + 1];
      if (next === '"' || next === '“' || next === '”') i += 2;
      else i += 1;
      continue;
    }
    if (ch === '\n') {
      if (!lineHasContent) {
        // A blank line is a paragraph break: close the pending sentence (even if
        // an unbalanced quote left it unterminated) and drop the quote state.
        emit(segStart, i);
        segStart = i;
        inQuote = false;
      }
      lineHasContent = false;
      i++;
      continue;
    }
    if (!isSpace(ch)) lineHasContent = true;
    if (ch === '"') {
      inQuote = !inQuote;
      i++;
      continue;
    }
    if (ch === '“') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === '”') {
      inQuote = false;
      i++;
      continue;
    }
    if ((ch === '.' || ch === '!' || ch === '?') && !inQuote) {
      const be = boundaryEnd(prose, i);
      if (be !== null) {
        // Trailing closers may include a `"`; keep quote state consistent.
        for (let q = i + 1; q < be; q++) {
          if (prose[q] === '"') inQuote = !inQuote;
          else if (prose[q] === '“') inQuote = true;
          else if (prose[q] === '”') inQuote = false;
        }
        emit(segStart, be);
        segStart = be;
        i = be;
        continue;
      }
    }
    i++;
  }
  emit(segStart, prose.length);
  return spans;
}

/** One physical line: content (no trailing newline) plus its offset bounds. */
interface Line {
  /** Offset of the first character. */
  start: number;
  /** Offset one past the trailing newline (or EOF) — the next line's start. */
  unitEnd: number;
  /** The line text without its trailing newline. */
  content: string;
}

/** Split into line units whose ranges tile the whole text (newlines included). */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let p = 0; p <= text.length; p++) {
    if (p === text.length || text[p] === '\n') {
      const content = text.slice(start, p);
      const unitEnd = p < text.length ? p + 1 : p;
      lines.push({ start, unitEnd, content });
      start = unitEnd;
      if (p === text.length) break;
    }
  }
  return lines;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/;
// Plan-authoritative (05 §4.1): `^\s{0,3}>` — so a tab-prefixed blockquote line
// is a blockquote, not prose that could be assertion-checked.
const BLOCKQUOTE = /^\s{0,3}>/;

/** A closing fence: same char, run length ≥ opener, ≤3 leading spaces, only trailing space. */
function isFenceClose(content: string, char: string, openLen: number): boolean {
  const m = /^ {0,3}(`+|~+)\s*$/.exec(content);
  if (!m) return false;
  const run = m[1]!;
  return run[0] === char && run.length >= openLen;
}

/**
 * CommonMark inline code spans within a prose run: a backtick run of length n
 * opens; the next run of EXACTLY length n closes. An unmatched run is literal.
 * Returns spans relative to `s`.
 */
function findInlineCodeSpans(s: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '`') {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === '`') j++;
    const runLen = j - i;
    let k = j;
    let closeAt = -1;
    while (k < s.length) {
      if (s[k] !== '`') {
        k++;
        continue;
      }
      let m = k;
      while (m < s.length && s[m] === '`') m++;
      if (m - k === runLen) {
        closeAt = k;
        break;
      }
      k = m;
    }
    if (closeAt >= 0) {
      spans.push({ start: i, end: closeAt + runLen });
      i = closeAt + runLen;
    } else {
      i = j; // unmatched run: literal, skip past it
    }
  }
  return spans;
}

/**
 * Partition `text` into non-overlapping regions covering `[0, text.length)`.
 * Fences, footnote definitions, and blockquotes are decided per line; prose runs
 * are then subdivided by inline-code spans. Zero-length regions are omitted, so a
 * trailing empty line contributes nothing.
 */
export function scanRegions(text: string): Region[] {
  const lines = splitLines(text);
  const lineStarts = lines.map((l) => l.start);
  const lineAt = (offset: number): number => {
    // 1-based line of `offset`: greatest lineStart ≤ offset.
    let lo = 0;
    let hi = lineStarts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid]! <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1;
  };

  const out: Region[] = [];
  const push = (kind: RegionKind, startOffset: number, endOffset: number): void => {
    if (endOffset <= startOffset) return;
    out.push({ kind, startOffset, endOffset, startLine: lineAt(startOffset) });
  };

  let proseStart = -1;
  let proseEnd = -1;
  const flushProse = (): void => {
    if (proseStart < 0) return;
    const runStart = proseStart;
    const runEnd = proseEnd;
    proseStart = -1;
    proseEnd = -1;
    const s = text.slice(runStart, runEnd);
    let cursor = 0;
    for (const span of findInlineCodeSpans(s)) {
      push('prose', runStart + cursor, runStart + span.start);
      push('inlineCode', runStart + span.start, runStart + span.end);
      cursor = span.end;
    }
    push('prose', runStart + cursor, runStart + s.length);
  };

  let li = 0;
  while (li < lines.length) {
    const line = lines[li]!;
    const c = line.content;

    if (FENCE_OPEN.test(c)) {
      flushProse();
      const openRun = FENCE_OPEN.exec(c)![1]!;
      const char = openRun[0]!;
      const openLen = openRun.length;
      let j = li + 1;
      let closeIdx = -1;
      while (j < lines.length) {
        if (isFenceClose(lines[j]!.content, char, openLen)) {
          closeIdx = j;
          break;
        }
        j++;
      }
      const endIdx = closeIdx >= 0 ? closeIdx : lines.length - 1;
      push('fence', line.start, lines[endIdx]!.unitEnd);
      li = endIdx + 1;
      continue;
    }

    if (FOOTNOTE_DEF.test(c)) {
      flushProse();
      let j = li + 1;
      while (j < lines.length) {
        const cc = lines[j]!.content;
        const blank = cc.trim() === '';
        const indented = /^ {2,}\S/.test(cc);
        if (blank || indented) {
          j++;
          continue;
        }
        break;
      }
      push('footnoteDef', line.start, lines[j - 1]!.unitEnd);
      li = j;
      continue;
    }

    if (BLOCKQUOTE.test(c)) {
      flushProse();
      let j = li;
      while (j < lines.length && BLOCKQUOTE.test(lines[j]!.content)) j++;
      push('blockquote', line.start, lines[j - 1]!.unitEnd);
      li = j;
      continue;
    }

    // Prose line: extend the current run.
    if (proseStart < 0) proseStart = line.start;
    proseEnd = line.unitEnd;
    li++;
  }
  flushProse();

  return out;
}
