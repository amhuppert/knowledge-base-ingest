/**
 * SOURCE METADATA (06 §2) — the shape of `sources.metadata_json`.
 *
 * No migration: the column already exists. The schema validates only THE KEYS THIS
 * TOOL WRITES (`extraction`, `origin`) and is `.passthrough()`, so any other key an
 * earlier version (or a future one) put there survives a read-modify-write verbatim.
 *
 * Write rules (enforced by `IngestService`):
 *  - `extraction` is IMMUTABLE after its first write — an attempt to change it is the
 *    §1.4 rejection, because canonical text is immutable and identity comes from the
 *    original bytes;
 *  - `origin` fields PATCH-MERGE: only the flags actually supplied overwrite their keys.
 */

import { z } from 'zod';
import { TEXT_VERIFICATIONS } from './enums.js';

const ExtractionSchema = z.object({
  /** The recombined `name/version` extractor label. */
  method: z.string(),
  verification: z.enum(TEXT_VERIFICATIONS),
  /** sha256 of the sidecar file bytes as given. */
  textFileHash: z.string(),
  textFilePath: z.string(),
});

const OriginSchema = z.object({
  system: z.string().optional(),
  externalId: z.string().optional(),
  url: z.string().url().optional(),
});

export const SourceMetadataSchema = z
  .object({
    extraction: ExtractionSchema.optional(),
    origin: OriginSchema.optional(),
  })
  .passthrough();

export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;
export type SourceExtraction = NonNullable<SourceMetadata['extraction']>;
export type SourceOrigin = NonNullable<SourceMetadata['origin']>;

/**
 * Parse a stored `metadata_json` string. Unreadable or non-object JSON degrades to an
 * empty object rather than failing an ingest: metadata is descriptive, and a source
 * row that predates the schema must stay ingestable/inspectable.
 */
export function parseSourceMetadata(json: string): SourceMetadata {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const parsed = SourceMetadataSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // A MALFORMED `extraction`/`origin` block can only come from outside this tool. Drop
  // just the offending block — every other key (including unknown ones) still survives,
  // so one corrupt block never costs unrelated metadata.
  const { extraction, origin, ...rest } = raw as Record<string, unknown>;
  return {
    ...rest,
    ...(ExtractionSchema.safeParse(extraction).success ? { extraction: extraction as SourceExtraction } : {}),
    ...(OriginSchema.safeParse(origin).success ? { origin: origin as SourceOrigin } : {}),
  };
}

/** Serialize metadata for the `metadata_json` column (stable key order per JSON.stringify). */
export function serializeSourceMetadata(metadata: SourceMetadata): string {
  return JSON.stringify(metadata);
}

/**
 * PATCH-MERGE origin fields (06 §2): only the supplied keys overwrite; every other key
 * — including unknown top-level metadata keys — is preserved. Returns the merged
 * metadata and whether anything actually changed (drives the receipt's `updated`).
 */
export function mergeOrigin(
  metadata: SourceMetadata,
  patch: SourceOrigin | undefined,
): { metadata: SourceMetadata; changed: boolean } {
  if (!patch || Object.keys(patch).length === 0) return { metadata, changed: false };
  const merged: SourceOrigin = { ...(metadata.origin ?? {}), ...patch };
  const changed = JSON.stringify(merged) !== JSON.stringify(metadata.origin ?? {});
  return { metadata: { ...metadata, origin: merged }, changed };
}
