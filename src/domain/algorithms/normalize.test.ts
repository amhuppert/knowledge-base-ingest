import { describe, it, expect } from 'vitest';
import {
  normalizeClaimText,
  normalizeEntityName,
  normalizeSourceText,
  slugify,
} from './normalize.js';

describe('normalizeSourceText (canonical extracted text)', () => {
  it('strips a leading UTF-8 BOM', () => {
    expect(normalizeSourceText('﻿hello')).toBe('hello');
  });

  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeSourceText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('applies Unicode NFC normalization', () => {
    // "é" as e + combining acute (NFD) becomes the single NFC codepoint.
    const nfd = 'é';
    expect(normalizeSourceText(nfd)).toBe('é');
  });

  it('does NOT collapse internal whitespace (offsets must stay meaningful)', () => {
    expect(normalizeSourceText('a    b\tc')).toBe('a    b\tc');
  });
});

describe('normalizeClaimText (identity/dedup key)', () => {
  it('lowercases, collapses whitespace, trims, and drops a trailing period', () => {
    expect(normalizeClaimText('  The   Service  Restarts.\n')).toBe('the service restarts');
  });

  it('treats case/whitespace variants as the same key', () => {
    expect(normalizeClaimText('Tokens rotate on use')).toBe(
      normalizeClaimText('tokens   rotate on use'),
    );
  });
});

describe('normalizeEntityName (does NOT strip versions)', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeEntityName('  React   Router ')).toBe('react router');
  });

  it('keeps version suffixes (version is identity)', () => {
    expect(normalizeEntityName('React 18')).not.toBe(normalizeEntityName('React'));
  });

  it('does not merge punctuated forms (Node.js != Nodejs)', () => {
    expect(normalizeEntityName('Node.js')).not.toBe(normalizeEntityName('Nodejs'));
  });
});

describe('slugify', () => {
  it('produces a url/file-safe slug', () => {
    expect(slugify('Token Rotation & Refresh!')).toBe('token-rotation-refresh');
  });

  it('collapses and trims separators', () => {
    expect(slugify('  --Hello   World--  ')).toBe('hello-world');
  });
});
