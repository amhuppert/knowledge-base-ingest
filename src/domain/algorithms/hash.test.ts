import { describe, it, expect } from 'vitest';
import { sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('matches the known SHA-256 of an empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and stable across calls', () => {
    expect(sha256Hex('the same input')).toBe(sha256Hex('the same input'));
  });

  it('hashes a Buffer identically to its UTF-8 string', () => {
    expect(sha256Hex(Buffer.from('héllo', 'utf8'))).toBe(sha256Hex('héllo'));
  });

  it('treats CRLF and LF as different bytes (no hidden normalization)', () => {
    expect(sha256Hex('a\r\nb')).not.toBe(sha256Hex('a\nb'));
  });
});
