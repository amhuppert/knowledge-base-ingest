import { describe, it, expect } from 'vitest';
import { verifyQuote } from './quoteVerifier.js';

const source = 'The auth service rotates refresh tokens on every use. 🔐 Multi-byte ok.';

describe('verifyQuote — exact substring at exact offsets (anti-hallucination)', () => {
  it('accepts an exact quote at the correct offsets', () => {
    const start = source.indexOf('rotates refresh tokens');
    const end = start + 'rotates refresh tokens'.length;
    const r = verifyQuote(source, 'rotates refresh tokens', start, end);
    expect(r.ok).toBe(true);
  });

  it('rejects a quote whose offsets point elsewhere', () => {
    const r = verifyQuote(source, 'rotates refresh tokens', 0, 22);
    expect(r.ok).toBe(false);
  });

  it('rejects a paraphrase even when plausible (no fuzzy matching)', () => {
    const start = source.indexOf('rotates');
    const r = verifyQuote(source, 'rotates the refresh token', start, start + 25);
    expect(r.ok).toBe(false);
  });

  it('rejects a whitespace-only difference (exactness, not normalization)', () => {
    const start = source.indexOf('rotates refresh tokens');
    const end = start + 'rotates refresh tokens'.length;
    const r = verifyQuote(source, 'rotates  refresh tokens', start, end);
    expect(r.ok).toBe(false);
  });

  it('uses UTF-16 code-unit offsets so multi-byte characters line up', () => {
    const start = source.indexOf('Multi-byte ok.');
    const end = start + 'Multi-byte ok.'.length;
    const r = verifyQuote(source, 'Multi-byte ok.', start, end);
    expect(r.ok).toBe(true);
  });

  it('rejects out-of-range or inverted offsets without throwing', () => {
    expect(verifyQuote(source, 'x', -1, 2).ok).toBe(false);
    expect(verifyQuote(source, 'x', 5, 4).ok).toBe(false);
    expect(verifyQuote(source, 'x', 0, source.length + 10).ok).toBe(false);
  });

  it('reports the reason on failure for actionable CLI errors', () => {
    const r = verifyQuote(source, 'nope', 0, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not match|out of range/i);
  });
});
