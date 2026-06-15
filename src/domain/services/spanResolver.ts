import type { Repositories } from '../../db/repositories/index.js';
import type { SourceId, SpanId } from '../ids.js';
import type { SpanRef } from '../schemas/agent.js';
import type { SourceText } from '../schemas/models.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveSpanId } from '../algorithms/idDeriver.js';
import { verifyQuote } from '../algorithms/quoteVerifier.js';

export class ProvenanceError extends Error {}

/**
 * Turn an agent-supplied span reference (chunk + exact quote) into a persisted,
 * quote-verified span, and return its id. The agent never computes offsets: we
 * locate the quote inside the referenced chunk, derive absolute offsets, and
 * verify them against the immutable canonical text. Ambiguous (non-unique) quotes
 * are rejected so a citation always points at one place.
 */
export function resolveSpan(
  repos: Repositories,
  sourceId: SourceId,
  sourceText: SourceText,
  ref: SpanRef,
  now: string,
): SpanId {
  const chunk = repos.chunks.getById(ref.chunk_id);
  if (!chunk) throw new ProvenanceError(`unknown chunk ${ref.chunk_id}`);
  if (chunk.sourceId !== sourceId) {
    throw new ProvenanceError(`chunk ${ref.chunk_id} does not belong to source ${sourceId}`);
  }

  const idx = chunk.text.indexOf(ref.quote);
  if (idx < 0) {
    throw new ProvenanceError(
      `quote not found in chunk ${ref.chunk_id}: ${JSON.stringify(ref.quote.slice(0, 60))}`,
    );
  }
  if (chunk.text.indexOf(ref.quote, idx + 1) >= 0) {
    throw new ProvenanceError(
      `quote is ambiguous in chunk ${ref.chunk_id} (appears more than once); provide a longer, unique quote`,
    );
  }

  const charStart = chunk.charStart + idx;
  const charEnd = charStart + ref.quote.length;
  const check = verifyQuote(sourceText.text, ref.quote, charStart, charEnd);
  if (!check.ok) throw new ProvenanceError(check.reason);

  const spanId = deriveSpanId(sourceId, charStart, charEnd);
  repos.spans.upsert({
    id: spanId,
    sourceId,
    chunkId: chunk.id,
    charStart,
    charEnd,
    quote: ref.quote,
    quoteHash: sha256Hex(ref.quote),
    createdAt: now,
  });
  return spanId;
}
