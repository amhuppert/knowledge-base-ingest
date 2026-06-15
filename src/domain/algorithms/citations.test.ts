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
});
