import { createHash } from 'node:crypto';

/**
 * SHA-256 of a string (UTF-8) or Buffer, as lowercase hex.
 *
 * Deterministic and byte-exact: no hidden normalization. Callers that want a
 * canonical form must normalize before hashing (see {@link normalizeSourceText}).
 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
