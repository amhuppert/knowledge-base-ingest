/**
 * Structure-aware, deterministic chunker for the canonical source text.
 *
 * Invariants (covered by tests):
 *  - Deterministic: same input -> identical output, no clock/randomness.
 *  - Exact tiling: chunks are contiguous, non-overlapping, and concatenate back
 *    to the input. Every char belongs to exactly one chunk, so offsets stay valid.
 *  - Heading-aware: splits at ATX headings (respecting fenced code blocks) and
 *    records the heading breadcrumb; oversized sections are size-split at line
 *    boundaries.
 *
 * Offsets are JS string indices (UTF-16 code units) into the canonical text —
 * the same units `String.prototype.slice` uses — so quote verification lines up.
 */

/** Bump when the algorithm changes in a way that alters chunk boundaries. */
export const CHUNKER_VERSION = 1;

/** Target maximum chunk size in characters before a section is size-split. */
const MAX_CHARS = 2000;

export interface Chunk {
  readonly chunkIndex: number;
  readonly headingPath: string;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenEstimate: number;
}

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Line {
  readonly text: string; // without trailing newline
  readonly start: number; // char offset of first char
}

function splitLines(text: string): Line[] {
  const parts = text.split('\n');
  const lines: Line[] = [];
  let offset = 0;
  for (const part of parts) {
    lines.push({ text: part, start: offset });
    offset += part.length + 1; // + the '\n' we split on
  }
  return lines;
}

interface Section {
  readonly headingPath: string;
  readonly startLine: number; // inclusive
  readonly endLine: number; // inclusive
}

function findSections(lines: Line[]): Section[] {
  const sections: Section[] = [];
  const stack: string[] = []; // headings by level-1 index
  let inFence = false;
  let currentPath = '';
  let sectionStart = 0;

  const flush = (endLine: number, path: string) => {
    if (endLine >= sectionStart) {
      sections.push({ headingPath: path, startLine: sectionStart, endLine });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(text);
    if (m) {
      // Close the section that ended on the previous line.
      flush(i - 1, currentPath);
      const level = m[1]!.length;
      const title = m[2]!.trim();
      stack.length = level - 1;
      stack[level - 1] = title;
      currentPath = stack.slice(0, level).join(' > ');
      sectionStart = i;
    }
  }
  flush(lines.length - 1, currentPath);
  return sections;
}

function sectionRange(lines: Line[], textLen: number, s: Section): [number, number] {
  const start = lines[s.startLine]!.start;
  const end = s.endLine + 1 < lines.length ? lines[s.endLine + 1]!.start : textLen;
  return [start, end];
}

/** Greedily pack lines of a section into pieces no larger than MAX_CHARS. */
function sizeSplit(lines: Line[], textLen: number, s: Section): Array<[number, number]> {
  const [start, end] = sectionRange(lines, textLen, s);
  if (end - start <= MAX_CHARS) return [[start, end]];

  const ranges: Array<[number, number]> = [];
  let pieceStart = start;
  for (let i = s.startLine; i <= s.endLine; i++) {
    const lineEnd = i + 1 < lines.length ? lines[i + 1]!.start : textLen;
    if (lineEnd - pieceStart >= MAX_CHARS) {
      ranges.push([pieceStart, lineEnd]);
      pieceStart = lineEnd;
    }
  }
  if (pieceStart < end) ranges.push([pieceStart, end]);
  return ranges;
}

export function chunk(canonicalText: string): Chunk[] {
  if (canonicalText.length === 0) return [];
  const lines = splitLines(canonicalText);
  const sections = findSections(lines);

  const chunks: Chunk[] = [];
  let index = 0;
  for (const section of sections) {
    for (const [charStart, charEnd] of sizeSplit(lines, canonicalText.length, section)) {
      const text = canonicalText.slice(charStart, charEnd);
      chunks.push({
        chunkIndex: index++,
        headingPath: section.headingPath,
        text,
        charStart,
        charEnd,
        tokenEstimate: Math.ceil(text.length / 4),
      });
    }
  }
  return chunks;
}
