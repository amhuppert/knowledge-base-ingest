import type { Repositories } from '../../db/repositories/index.js';
import type { ChunkId, SourceId, SpanId } from '../ids.js';
import type { SourceText } from '../schemas/models.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveSpanId } from '../algorithms/idDeriver.js';
import { verifyQuote } from '../algorithms/quoteVerifier.js';
import { DomainIssueError, formatPath } from '../issueCodes.js';

/**
 * The minimal span reference `resolveSpanCandidate` reads: a chunk id + the exact
 * quote. Both claim `SpanRef` (has role/confidence) and relationship `RelEvidence`
 * (role, no confidence — 03 §3.2) structurally satisfy it, so one resolver serves
 * both without depending on the extra fields.
 */
export interface SpanReference {
  chunk_id: ChunkId;
  quote: string;
}

/**
 * A READ-ONLY resolution of an agent-supplied span reference (03 §4.1). The agent
 * never computes offsets: we locate the exact quote inside the referenced chunk,
 * derive absolute offsets, and verify them against the immutable canonical text.
 * Ambiguous (non-unique) quotes are rejected so a citation always points at one
 * place. The candidate additionally reports whether that exact `(source, range)`
 * span already exists — `existingSpanId` — so a service can classify an input as
 * created / updated / unchanged from candidates + link lookups BEFORE any write
 * (finding 21: no circular "check before resolveSpan writes"). It also carries the
 * `sourceId`/`chunkId` `persistSpan` needs to insert the row.
 */
export interface SpanCandidate {
  sourceId: SourceId;
  chunkId: ChunkId;
  charStart: number;
  charEnd: number;
  quote: string;
  /** Id of the span already stored at this exact `(source, range)`, or null. */
  existingSpanId: SpanId | null;
}

/**
 * Locate + quote-verify a span reference and report whether it already exists —
 * WITHOUT writing anything. Verification semantics are byte-identical to the
 * pre-split resolver (locked architecture): unknown/foreign chunk, missing quote,
 * and non-unique quote all raise the same Phase-1 `DomainIssueError` codes.
 *
 * `pathPrefix` is the payload location of this span ref (e.g. `['claims', 2, 'spans', 0]`);
 * every quote failure carries `path = formatPath([...pathPrefix, 'quote'])` and the
 * offending chunk id in `ids`, so the CLI maps by code — never by message text (03 §1).
 */
export function resolveSpanCandidate(
  repos: Repositories,
  sourceId: SourceId,
  sourceText: SourceText,
  ref: SpanReference,
  pathPrefix: ReadonlyArray<string | number> = [],
): SpanCandidate {
  const quotePath = formatPath([...pathPrefix, 'quote']);
  const at = (): { path: string; ids: string[] } => ({ path: quotePath, ids: [ref.chunk_id] });

  const chunk = repos.chunks.getById(ref.chunk_id);
  if (!chunk) throw new DomainIssueError('QUOTE_NOT_FOUND', `unknown chunk ${ref.chunk_id}`, at());
  if (chunk.sourceId !== sourceId) {
    throw new DomainIssueError('QUOTE_NOT_FOUND', `chunk ${ref.chunk_id} does not belong to source ${sourceId}`, at());
  }

  const idx = chunk.text.indexOf(ref.quote);
  if (idx < 0) {
    throw new DomainIssueError(
      'QUOTE_NOT_FOUND',
      `quote not found in chunk ${ref.chunk_id}: ${JSON.stringify(ref.quote.slice(0, 60))}`,
      at(),
    );
  }
  if (chunk.text.indexOf(ref.quote, idx + 1) >= 0) {
    throw new DomainIssueError(
      'QUOTE_AMBIGUOUS',
      `quote is ambiguous in chunk ${ref.chunk_id} (appears more than once); provide a longer, unique quote`,
      at(),
    );
  }

  const charStart = chunk.charStart + idx;
  const charEnd = charStart + ref.quote.length;
  const check = verifyQuote(sourceText.text, ref.quote, charStart, charEnd);
  if (!check.ok) throw new DomainIssueError('QUOTE_NOT_FOUND', check.reason, at());

  const existing = repos.spans.getByRange(sourceId, charStart, charEnd);
  return {
    sourceId,
    chunkId: chunk.id,
    charStart,
    charEnd,
    quote: ref.quote,
    existingSpanId: existing ? existing.id : null,
  };
}

/**
 * The id of the span at this candidate's range — the stored one, or the id it WILL
 * have once persisted (span ids are content-addressed by `(source, range)`, so the
 * two agree). Services need it at CLASSIFICATION time to key link lookups and to
 * recognise a batch-local duplicate of a span no earlier input has written yet
 * (03 §4.1) — before `persistSpan` has run.
 */
export function spanIdFor(candidate: SpanCandidate): SpanId {
  return candidate.existingSpanId ?? deriveSpanId(candidate.sourceId, candidate.charStart, candidate.charEnd);
}

/** The `(source, range)` identity of a candidate — the key a batch dedups spans on. */
export function spanRangeKey(candidate: SpanCandidate): string {
  return `${candidate.sourceId}:${candidate.charStart}:${candidate.charEnd}`;
}

/**
 * The ONLY writer in the split (03 §4.1): insert the span iff it does not already
 * exist, returning its id either way. A candidate with a non-null `existingSpanId`
 * is a pure lookup (no write). The derived id equals what `SpanRepo.upsert` would
 * key on, so a persist is idempotent.
 */
export function persistSpan(repos: Repositories, candidate: SpanCandidate, now: string): SpanId {
  if (candidate.existingSpanId !== null) return candidate.existingSpanId;
  const spanId = spanIdFor(candidate);
  repos.spans.upsert({
    id: spanId,
    sourceId: candidate.sourceId,
    chunkId: candidate.chunkId,
    charStart: candidate.charStart,
    charEnd: candidate.charEnd,
    quote: candidate.quote,
    quoteHash: sha256Hex(candidate.quote),
    createdAt: now,
  });
  return spanId;
}
