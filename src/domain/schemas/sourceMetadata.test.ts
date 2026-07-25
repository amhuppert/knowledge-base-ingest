import { describe, it, expect } from 'vitest';
import {
  SourceMetadataSchema,
  mergeOrigin,
  parseSourceMetadata,
  serializeSourceMetadata,
  type SourceMetadata,
} from './sourceMetadata.js';

/**
 * SOURCE METADATA (06 §2). The schema validates only the keys this tool writes and
 * PASSES THROUGH everything else, so a read-modify-write never destroys metadata some
 * other writer left behind. `origin` patch-merges; `extraction` immutability is
 * enforced by the ingest service, not here.
 */

const EXTRACTION = {
  method: 'agent-transcription/1',
  verification: 'none' as const,
  textFileHash: 'abc123',
  textFilePath: 'report.extracted.md',
};

describe('SourceMetadataSchema', () => {
  it('preserves unknown keys verbatim (passthrough)', () => {
    const parsed = SourceMetadataSchema.parse({
      extraction: EXTRACTION,
      legacyImport: { by: 'other-tool', nested: [1, 2, 3] },
    });
    expect(parsed).toEqual({ extraction: EXTRACTION, legacyImport: { by: 'other-tool', nested: [1, 2, 3] } });
  });

  it('rejects an out-of-vocabulary verification and a non-URL origin url', () => {
    expect(SourceMetadataSchema.safeParse({ extraction: { ...EXTRACTION, verification: 'eyeballed' } }).success).toBe(false);
    expect(SourceMetadataSchema.safeParse({ origin: { url: 'not a url' } }).success).toBe(false);
    expect(SourceMetadataSchema.safeParse({ origin: { url: 'https://example.com/x' } }).success).toBe(true);
  });
});

describe('parseSourceMetadata', () => {
  it('round-trips through serialize, keeping unknown keys', () => {
    const metadata: SourceMetadata = { extraction: EXTRACTION, custom: { a: 1 } };
    expect(parseSourceMetadata(serializeSourceMetadata(metadata))).toEqual(metadata);
  });

  it('degrades to {} for unusable metadata instead of failing the ingest', () => {
    for (const json of ['', 'not json', 'null', '"a string"', '[1,2]']) {
      expect(parseSourceMetadata(json), json).toEqual({});
    }
  });

  it('drops only the malformed block, never the surrounding metadata', () => {
    const parsed = parseSourceMetadata(
      JSON.stringify({ extraction: { method: 'x' }, origin: { system: 'notion' }, custom: { keep: true } }),
    );
    expect(parsed.extraction).toBeUndefined();
    expect(parsed.origin).toEqual({ system: 'notion' });
    expect(parsed['custom']).toEqual({ keep: true });
  });
});

describe('mergeOrigin (patch-merge, 06 §2)', () => {
  it('overwrites only the supplied keys and reports the change', () => {
    const before: SourceMetadata = { extraction: EXTRACTION, origin: { system: 'notion', externalId: 'PAGE-1' } };
    const after = mergeOrigin(before, { url: 'https://example.com/doc', externalId: 'PAGE-2' });
    expect(after.changed).toBe(true);
    expect(after.metadata.origin).toEqual({ system: 'notion', externalId: 'PAGE-2', url: 'https://example.com/doc' });
    expect(after.metadata.extraction).toEqual(EXTRACTION);
  });

  it('reports no change for an absent, empty, or identical patch', () => {
    const before: SourceMetadata = { origin: { system: 'notion' } };
    expect(mergeOrigin(before, undefined).changed).toBe(false);
    expect(mergeOrigin(before, {}).changed).toBe(false);
    expect(mergeOrigin(before, { system: 'notion' }).changed).toBe(false);
  });

  it('creates the origin block when none existed', () => {
    const after = mergeOrigin({}, { system: 'github' });
    expect(after.changed).toBe(true);
    expect(after.metadata.origin).toEqual({ system: 'github' });
  });
});
