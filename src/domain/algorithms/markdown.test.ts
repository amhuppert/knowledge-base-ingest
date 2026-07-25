import { describe, it, expect } from 'vitest';
import { scanRegions, splitSentenceSpans, type Region } from './markdown.js';

/** 1-based line of an offset in `text` — mirrors how answerCheck derives lines. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++;
  return line;
}

/** The substring a region covers. */
function textOf(text: string, r: Region): string {
  return text.slice(r.startOffset, r.endOffset);
}

/** Assert the regions form a gapless, non-overlapping cover of [0, text.length). */
function assertTotalPartition(text: string, regions: Region[]): void {
  let cursor = 0;
  for (const r of regions) {
    expect(r.startOffset).toBe(cursor);
    expect(r.endOffset).toBeGreaterThan(r.startOffset);
    cursor = r.endOffset;
  }
  expect(cursor).toBe(text.length);
}

describe('scanRegions', () => {
  it('classifies a backtick fenced block as one fence region between prose', () => {
    const text = ['Before the code.', '```', 'const x = 1;', '```', 'After the code.'].join('\n');
    const regions = scanRegions(text);
    const fences = regions.filter((r) => r.kind === 'fence');
    expect(fences).toHaveLength(1);
    expect(textOf(text, fences[0]!)).toBe('```\nconst x = 1;\n```\n');
    expect(regions.filter((r) => r.kind === 'prose')).toHaveLength(2);
    assertTotalPartition(text, regions);
  });

  it('treats a tilde fence the same as a backtick fence', () => {
    const text = ['Intro.', '~~~', 'raw text', '~~~', 'Outro.'].join('\n');
    const fences = scanRegions(text).filter((r) => r.kind === 'fence');
    expect(fences).toHaveLength(1);
    expect(textOf(text, fences[0]!)).toContain('~~~\nraw text\n~~~');
  });

  it('does not open a fence with more than three leading spaces', () => {
    const text = ['    ```not a fence', 'still prose'].join('\n');
    const regions = scanRegions(text);
    expect(regions.some((r) => r.kind === 'fence')).toBe(false);
    assertTotalPartition(text, regions);
  });

  it('requires the closing fence to be at least as long as the opener', () => {
    // Opener is three backticks. A two-backtick line cannot close it; the four-backtick line does.
    const text = ['```', 'inside', '``', 'still inside', '````', 'after'].join('\n');
    const regions = scanRegions(text);
    const fences = regions.filter((r) => r.kind === 'fence');
    expect(fences).toHaveLength(1);
    expect(textOf(text, fences[0]!)).toBe('```\ninside\n``\nstill inside\n````\n');
    // Everything after the closing fence is prose.
    expect(regions[regions.length - 1]!.kind).toBe('prose');
    expect(textOf(text, regions[regions.length - 1]!)).toBe('after');
    assertTotalPartition(text, regions);
  });

  it('requires the closing fence to be the SAME character as the opener', () => {
    // A backtick fence is NOT closed by a tilde line of equal length; the matching
    // backtick line closes it. The tilde line stays inside the fence.
    const text = ['```', 'body one', '~~~', 'body two', '```', 'after'].join('\n');
    const regions = scanRegions(text);
    const fences = regions.filter((r) => r.kind === 'fence');
    expect(fences).toHaveLength(1);
    expect(textOf(text, fences[0]!)).toBe('```\nbody one\n~~~\nbody two\n```\n');
    expect(regions[regions.length - 1]!.kind).toBe('prose');
    expect(textOf(text, regions[regions.length - 1]!)).toBe('after');
    assertTotalPartition(text, regions);
  });

  it('runs an unclosed fence to end of file', () => {
    const text = ['Lead in.', '```', 'no closing fence here', 'more code'].join('\n');
    const regions = scanRegions(text);
    const fences = regions.filter((r) => r.kind === 'fence');
    expect(fences).toHaveLength(1);
    expect(textOf(text, fences[0]!)).toBe('```\nno closing fence here\nmore code');
    expect(fences[0]!.endOffset).toBe(text.length);
    assertTotalPartition(text, regions);
  });

  it('absorbs a blank-then-indented continuation into a footnote definition', () => {
    // The blank line between the definition and its indented continuation must not
    // end the definition (GFM lazy continuation).
    const text = ['[^clm_ab]: A definition line.', '', '  indented continuation after a blank line.'].join('\n');
    const regions = scanRegions(text);
    const defs = regions.filter((r) => r.kind === 'footnoteDef');
    expect(defs).toHaveLength(1);
    expect(textOf(text, defs[0]!)).toBe(
      '[^clm_ab]: A definition line.\n\n  indented continuation after a blank line.',
    );
    // No prose region was split out of the continuation block.
    expect(regions.some((r) => r.kind === 'prose')).toBe(false);
    assertTotalPartition(text, regions);
  });

  it('ends a footnote definition at the first non-blank unindented line, which is prose', () => {
    const text = ['[^clm_ab]: A definition line.', 'This unindented line is prose again.'].join('\n');
    const regions = scanRegions(text);
    const defs = regions.filter((r) => r.kind === 'footnoteDef');
    expect(defs).toHaveLength(1);
    expect(textOf(text, defs[0]!)).toBe('[^clm_ab]: A definition line.\n');
    const prose = regions.filter((r) => r.kind === 'prose');
    expect(prose).toHaveLength(1);
    expect(textOf(text, prose[0]!)).toBe('This unindented line is prose again.');
    expect(prose[0]!.startLine).toBe(2);
    assertTotalPartition(text, regions);
  });

  it('groups a maximal run of blockquote lines into one region', () => {
    const text = ['Intro.', '> quoted one', '> quoted two', 'Back to prose.'].join('\n');
    const regions = scanRegions(text);
    const quotes = regions.filter((r) => r.kind === 'blockquote');
    expect(quotes).toHaveLength(1);
    expect(textOf(text, quotes[0]!)).toBe('> quoted one\n> quoted two\n');
    assertTotalPartition(text, regions);
  });

  it('treats a tab-indented blockquote line as a blockquote (^\\s{0,3}>), not prose', () => {
    const text = ['Intro.', '\t> tab-indented quote asserts a fact.', 'Back to prose.'].join('\n');
    const regions = scanRegions(text);
    const quotes = regions.filter((r) => r.kind === 'blockquote');
    expect(quotes).toHaveLength(1);
    expect(textOf(text, quotes[0]!)).toBe('\t> tab-indented quote asserts a fact.\n');
    // The quoted line is NOT a prose region, so it can never be assertion-checked.
    expect(regions.filter((r) => r.kind === 'prose').map((r) => textOf(text, r))).not.toContain(
      '\t> tab-indented quote asserts a fact.\n',
    );
    assertTotalPartition(text, regions);
  });

  it('matches multi-backtick inline code, ignoring single backticks inside', () => {
    const text = 'Call ``a ` b`` now.';
    const regions = scanRegions(text);
    const code = regions.filter((r) => r.kind === 'inlineCode');
    expect(code).toHaveLength(1);
    expect(textOf(text, code[0]!)).toBe('``a ` b``');
    assertTotalPartition(text, regions);
  });

  it('leaves an unmatched backtick run as literal prose', () => {
    const text = 'Here is a ` lonely backtick with no partner.';
    const regions = scanRegions(text);
    expect(regions.some((r) => r.kind === 'inlineCode')).toBe(false);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.kind).toBe('prose');
    assertTotalPartition(text, regions);
  });
});

describe('splitSentenceSpans', () => {
  it('returns spans whose offsets recover the sentence text against the original', () => {
    const prose = 'First sentence is here now. Second sentence follows on.';
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(2);
    for (const s of spans) expect(prose.slice(s.startOffset, s.endOffset)).toBe(s.text);
    expect(spans[0]!.text).toBe('First sentence is here now.');
    expect(spans[1]!.text).toBe('Second sentence follows on.');
  });

  it('offsets are relative to baseOffset for region-embedded prose', () => {
    const prose = 'A single asserted sentence here.';
    const spans = splitSentenceSpans(prose, 100);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startOffset).toBe(100);
    expect(spans[0]!.endOffset).toBe(100 + prose.length);
  });

  it('does not split on a question mark inside an open double quote', () => {
    const prose = 'He asked "How does it work?" before moving on to the next topic.';
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe(prose);
  });

  it('does not split inside curly double quotes either', () => {
    const prose = 'She wondered “Is this correct?” and then answered her own question fully.';
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(1);
  });

  it('ignores escaped double quotes so an aside does not open a quote', () => {
    // The escaped quote must NOT open a quote; both periods are real boundaries.
    const prose = 'He wrote \\"an aside and kept the real claim here. A second factual sentence follows now.';
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(2);
  });

  it('escaping only suppresses quote toggling — a backslash before terminal punctuation still ends the sentence', () => {
    // `\.` must remain a sentence boundary; otherwise a citation on the second
    // assertion could mask the first (the two would merge into one span).
    const prose = 'First assertion ends here\\. Second assertion follows plainly.';
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.text).toBe('First assertion ends here\\.');
    expect(spans[1]!.text).toBe('Second assertion follows plainly.');
  });

  it('resets quote state at a blank line so an unmatched quote does not swallow the next paragraph', () => {
    const prose = ['He said "this quote never closes here.', '', 'The system stores its data reliably now.'].join('\n');
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(2);
    expect(spans[1]!.text).toBe('The system stores its data reliably now.');
    expect(lineAt(prose, spans[1]!.startOffset)).toBe(3);
  });

  it('keeps a trailing citation token attached to the sentence it follows', () => {
    const prose = 'Refresh tokens rotate on every use.[^clm_ab] The next claim also holds true.';
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.text).toBe('Refresh tokens rotate on every use.[^clm_ab]');
  });

  it('gives identical sentences on different lines distinct offsets and lines', () => {
    const prose = ['The cache stores results in memory here.', 'The cache stores results in memory here.'].join('\n');
    const spans = splitSentenceSpans(prose, 0);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.text).toBe(spans[1]!.text);
    expect(spans[1]!.startOffset).toBeGreaterThan(spans[0]!.startOffset);
    expect(lineAt(prose, spans[0]!.startOffset)).toBe(1);
    expect(lineAt(prose, spans[1]!.startOffset)).toBe(2);
  });
});
