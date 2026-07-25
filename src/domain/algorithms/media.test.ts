import { describe, it, expect } from 'vitest';
import {
  KNOWN_BINARY_EXTENSIONS,
  MEDIA_TYPES,
  decodeUtf8Strict,
  mediaFormatTable,
  mediaTypeFor,
  requiresTextSidecar,
  unsupportedMediaMessage,
} from './media.js';

/**
 * MEDIA POLICY (06 §1.1). One table for extension → media type; a strict UTF-8
 * decode (fatal, plus a NUL guard) that REPLACES the old lossy `Buffer.toString`
 * (compatibility matrix: undecodable bytes now fail loudly instead of being
 * silently replaced with U+FFFD); known-binary extensions gated behind
 * `--text-from`; every other extension — known-text or unknown — decoded.
 */

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('MEDIA_TYPES (the single 06 §1.1 table)', () => {
  it('is the complete map from the plan, verbatim', () => {
    expect({ ...MEDIA_TYPES }).toEqual({
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
    });
  });

  it('renders a human format table that covers every mapped extension plus the fallback', () => {
    const table = mediaFormatTable();
    for (const ext of Object.keys(MEDIA_TYPES)) {
      expect(table.join('\n'), ext).toContain(ext);
    }
    expect(table.join('\n')).toContain('application/octet-stream');
  });
});

describe('KNOWN_BINARY_EXTENSIONS', () => {
  it('is exactly the 06 §1.1 list', () => {
    expect([...KNOWN_BINARY_EXTENSIONS]).toEqual(['pdf', 'docx', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'zip']);
  });

  it('requiresTextSidecar is true for exactly those extensions, case-insensitively', () => {
    for (const ext of KNOWN_BINARY_EXTENSIONS) {
      expect(requiresTextSidecar(ext), ext).toBe(true);
      expect(requiresTextSidecar(ext.toUpperCase()), ext).toBe(true);
    }
    for (const ext of ['md', 'markdown', 'txt', 'rst', 'html', 'htm', 'csv', 'json', 'weird', '']) {
      expect(requiresTextSidecar(ext), ext).toBe(false);
    }
  });
});

describe('decodeUtf8Strict (fatal decode + NUL guard)', () => {
  it('decodes valid UTF-8, including multi-byte text', () => {
    expect(decodeUtf8Strict(utf8('# Title\n\nplain ascii\n'))).toBe('# Title\n\nplain ascii\n');
    expect(decodeUtf8Strict(utf8('naïve café — 日本語 🌍'))).toBe('naïve café — 日本語 🌍');
  });

  it('returns null on malformed UTF-8 instead of substituting U+FFFD (replaces Buffer.toString)', () => {
    // A lone continuation byte, a truncated 3-byte sequence, and an invalid lead byte.
    for (const bytes of [Buffer.from([0x80]), Buffer.from([0xe2, 0x82]), Buffer.from([0xff, 0xfe, 0x41])]) {
      expect(decodeUtf8Strict(bytes)).toBeNull();
      // The old lossy path would have "succeeded" with replacement characters.
      expect(bytes.toString('utf8')).toContain('�');
    }
  });

  it('returns null when the bytes decode but contain a NUL', () => {
    expect(decodeUtf8Strict(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
  });

  it('accepts an empty file', () => {
    expect(decodeUtf8Strict(Buffer.alloc(0))).toBe('');
  });
});

describe('mediaTypeFor', () => {
  it('maps a known extension, case-insensitively', () => {
    expect(mediaTypeFor('md', utf8('# x'))).toBe('text/markdown');
    expect(mediaTypeFor('MD', utf8('# x'))).toBe('text/markdown');
    expect(mediaTypeFor('pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBe('application/pdf');
  });

  it('falls back to text/plain for an unknown extension that decodes', () => {
    expect(mediaTypeFor('weird', utf8('still text\n'))).toBe('text/plain');
    expect(mediaTypeFor('', utf8('no extension at all\n'))).toBe('text/plain');
  });

  it('falls back to application/octet-stream for an unknown extension that does not decode', () => {
    expect(mediaTypeFor('bin', Buffer.from([0x00, 0x01, 0xff]))).toBe('application/octet-stream');
  });
});

describe('unsupportedMediaMessage (06 §1.5 recipe)', () => {
  const message = unsupportedMediaMessage('report.pdf');

  it('carries the literal two-step --text-from recipe', () => {
    expect(message).toContain('--text-from');
    expect(message).toContain('1.');
    expect(message).toContain('2.');
    expect(message).toContain('kb ingest report.pdf --text-from');
  });

  it('points at the supported-format table', () => {
    expect(message).toContain('kb ingest --help --json');
  });

  it('shell-quotes an awkward original path so step 2 stays runnable verbatim', () => {
    expect(unsupportedMediaMessage('my report.pdf')).toContain("kb ingest 'my report.pdf' --text-from");
  });
});
