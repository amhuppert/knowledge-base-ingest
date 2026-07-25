import { describe, it, expect } from 'vitest';
import { extractCitations, hasCitation } from './citations.js';

describe('extractCitations', () => {
  it('extracts claim ids in first-seen order, de-duplicated', () => {
    const body = 'Tokens rotate.[^clm_aaa] They expire.[^clm_bbb] Also rotate again.[^clm_aaa]';
    expect(extractCitations(body)).toEqual(['clm_aaa', 'clm_bbb']);
  });

  it('returns an empty array when there are no citations', () => {
    expect(extractCitations('Just prose, no refs.')).toEqual([]);
  });

  it('ignores tokens that are not claim citations', () => {
    expect(extractCitations('See [link](url) and [^note] and [^ent_x].')).toEqual([]);
  });

  it('hasCitation reflects presence', () => {
    expect(hasCitation('a[^clm_abc123]')).toBe(true);
    expect(hasCitation('none')).toBe(false);
  });

  // Regression (codex-review finding 32): a module-shared /g regex leaks
  // `lastIndex` between calls. Calling hasCitation() first left lastIndex past
  // the first match, so the subsequent matchAll in extractCitations skipped the
  // earliest citation. Fixed here (Phase 0) with fresh/non-global regexes;
  // asserted positively.
  it('extractCitations is unaffected by a prior hasCitation call (reverse-call-order)', () => {
    const body = 'Tokens rotate.[^clm_aaa] They expire.[^clm_bbb]';
    expect(hasCitation(body)).toBe(true);
    // Both ids must still be returned — the first must not be dropped.
    expect(extractCitations(body)).toEqual(['clm_aaa', 'clm_bbb']);
  });
});
