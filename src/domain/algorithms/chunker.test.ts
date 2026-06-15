import { describe, it, expect } from 'vitest';
import { chunk, CHUNKER_VERSION } from './chunker.js';
import { normalizeSourceText } from './normalize.js';

const doc = normalizeSourceText(
  [
    'Intro paragraph before any heading.',
    '',
    '# Title',
    '',
    'Top level body.',
    '',
    '## Storage',
    '',
    'We use SQLite.',
    '',
    '## Rendering',
    '',
    'Markdown is generated.',
  ].join('\n'),
);

describe('chunk — structure-aware, deterministic, exact-tiling', () => {
  it('is deterministic on byte-identical input', () => {
    expect(chunk(doc)).toEqual(chunk(doc));
  });

  it('tiles the document exactly (chunks concatenate back to the input, no gaps/overlap)', () => {
    const chunks = chunk(doc);
    expect(chunks.map((c) => c.text).join('')).toBe(doc);
    // contiguous, non-overlapping, covering [0, len)
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks.at(-1)!.charEnd).toBe(doc.length);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.charStart).toBe(chunks[i - 1]!.charEnd);
    }
  });

  it('every chunk text equals the slice of the source at its offsets', () => {
    for (const c of chunk(doc)) {
      expect(doc.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it('assigns sequential chunk indices from 0', () => {
    expect(chunk(doc).map((c) => c.chunkIndex)).toEqual(
      chunk(doc).map((_, i) => i),
    );
  });

  it('builds a heading path reflecting the heading hierarchy', () => {
    const chunks = chunk(doc);
    const storage = chunks.find((c) => c.text.includes('We use SQLite'));
    expect(storage?.headingPath).toBe('Title > Storage');
    const rendering = chunks.find((c) => c.text.includes('Markdown is generated'));
    expect(rendering?.headingPath).toBe('Title > Rendering');
  });

  it('gives pre-heading content an empty heading path', () => {
    const intro = chunk(doc).find((c) => c.text.includes('Intro paragraph'));
    expect(intro?.headingPath).toBe('');
  });

  it('does NOT treat a "#" inside a fenced code block as a heading', () => {
    const code = normalizeSourceText(
      ['# Real Heading', '', '```sh', '# this is a shell comment, not a heading', 'echo hi', '```', '', 'After code.'].join(
        '\n',
      ),
    );
    const chunks = chunk(code);
    // Only one real heading -> the fence content stays in the "Real Heading" section.
    const paths = new Set(chunks.map((c) => c.headingPath));
    expect(paths).toEqual(new Set(['Real Heading']));
    expect(chunks.some((c) => c.text.includes('shell comment'))).toBe(true);
  });

  it('size-splits an oversized section at line boundaries while still tiling exactly', () => {
    const big = normalizeSourceText(
      '# Big\n\n' + Array.from({ length: 400 }, (_, i) => `line ${i} with some filler words`).join('\n'),
    );
    const chunks = chunk(big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join('')).toBe(big);
    for (const c of chunks) expect(c.headingPath).toBe('Big');
  });

  it('returns no chunks for an empty document', () => {
    expect(chunk('')).toEqual([]);
  });

  it('exposes a stable chunker version (identity input to re-chunk idempotency)', () => {
    expect(typeof CHUNKER_VERSION).toBe('number');
  });
});
