import type { Db } from '../connection.js';
import { SpanRow, ClaimSpanRow } from '../rows.js';
import type { Span, ClaimSpan } from '../../domain/schemas/models.js';
import type { SourceId, SpanId, ClaimId, RelationshipId } from '../../domain/ids.js';
import type { SpanRole } from '../../domain/schemas/enums.js';

export class SpanRepo {
  constructor(private readonly db: Db) {}

  /** Insert, or return the existing span at the same (source, range). Idempotent. */
  upsert(span: Span): { span: Span; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM spans WHERE source_id = ? AND char_start = ? AND char_end = ?')
      .get(span.sourceId, span.charStart, span.charEnd);
    if (existing) return { span: SpanRow.parse(existing), created: false };
    this.db
      .prepare(
        `INSERT INTO spans(id, source_id, chunk_id, char_start, char_end, quote, quote_hash, created_at)
         VALUES (@id,@sourceId,@chunkId,@charStart,@charEnd,@quote,@quoteHash,@createdAt)`,
      )
      .run(span as unknown as Record<string, unknown>);
    return { span, created: true };
  }

  getById(id: SpanId): Span | undefined {
    const r = this.db.prepare('SELECT * FROM spans WHERE id = ?').get(id);
    return r ? SpanRow.parse(r) : undefined;
  }

  /** The span already stored at this exact (source, range), or undefined. Read-only. */
  getByRange(sourceId: SourceId, charStart: number, charEnd: number): Span | undefined {
    const r = this.db
      .prepare('SELECT * FROM spans WHERE source_id = ? AND char_start = ? AND char_end = ?')
      .get(sourceId, charStart, charEnd);
    return r ? SpanRow.parse(r) : undefined;
  }

  listBySource(sourceId: SourceId): Span[] {
    return this.db
      .prepare('SELECT * FROM spans WHERE source_id = ? ORDER BY char_start')
      .all(sourceId)
      .map((r) => SpanRow.parse(r));
  }
}

/**
 * One claim→span provenance edge, joined with its span and source. A projection (not a
 * table row), so it is typed here rather than in `rows.ts`.
 */
export interface ClaimProvenance {
  claimId: ClaimId;
  spanId: SpanId;
  sourceId: SourceId;
  sourceTitle: string;
  /** The anchoring source's status — non-active means the quote is dated (Phase 5 §2). */
  sourceStatus: string;
  charStart: number;
  quote: string;
}

export class ClaimSpanRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert or update the claim→span link. Link identity is `(claim_id, span_id)`
   * (03 §4, finding 21): a differing `role` on the same edge updates it in place
   * rather than adding a parallel row. Callers pass the already-reconciled
   * (monotone-max) confidence; this method persists exactly what it is given.
   */
  upsert(cs: ClaimSpan): void {
    this.db
      .prepare(
        `INSERT INTO claim_spans(claim_id, span_id, role, confidence, extractor)
         VALUES (@claimId,@spanId,@role,@confidence,@extractor)
         ON CONFLICT(claim_id, span_id) DO UPDATE SET
           role = excluded.role, confidence = excluded.confidence, extractor = excluded.extractor`,
      )
      .run(cs as unknown as Record<string, unknown>);
  }

  /** The existing link on `(claim_id, span_id)`, or undefined. Read-only. */
  getLink(claimId: ClaimId, spanId: SpanId): ClaimSpan | undefined {
    const r = this.db
      .prepare('SELECT * FROM claim_spans WHERE claim_id = ? AND span_id = ?')
      .get(claimId, spanId);
    return r ? ClaimSpanRow.parse(r) : undefined;
  }

  listByClaim(claimId: ClaimId): ClaimSpan[] {
    return this.db
      .prepare('SELECT * FROM claim_spans WHERE claim_id = ?')
      .all(claimId)
      .map((r) => ClaimSpanRow.parse(r));
  }

  /**
   * Provenance for MANY claims in ONE batched `IN (…)` query (04 §1) — the
   * synthesis-context bundle must never issue a query per claim. `DISTINCT` collapses
   * the same span linked under several roles into a single provenance entry, and each
   * row carries its source title so the caller needs no follow-up source lookup.
   * An empty `claimIds` prepares nothing (an empty `IN ()` is not valid SQL).
   */
  provenanceForClaims(claimIds: readonly ClaimId[]): ClaimProvenance[] {
    if (claimIds.length === 0) return [];
    const placeholders = claimIds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT DISTINCT cs.claim_id AS claimId, s.id AS spanId, s.source_id AS sourceId,
                src.title AS sourceTitle, src.status AS sourceStatus,
                s.char_start AS charStart, s.quote AS quote
           FROM claim_spans cs
           JOIN spans s ON s.id = cs.span_id
           JOIN sources src ON src.id = s.source_id
          WHERE cs.claim_id IN (${placeholders})
          ORDER BY cs.claim_id, s.source_id, s.char_start, s.id`,
      )
      .all(...claimIds) as ClaimProvenance[];
  }

  /**
   * ACTIVE claims quoting `sourceId` (supports role) whose EVERY supporting span
   * anchors to a non-active source — the claims a `--supersedes` ingest just
   * stranded (Phase 5 §1.4). Ordered by claim id for a deterministic receipt.
   */
  strandedClaimIds(sourceId: SourceId): ClaimId[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT cs.claim_id AS claimId
           FROM claim_spans cs
           JOIN spans s ON s.id = cs.span_id
           JOIN claims c ON c.id = cs.claim_id
          WHERE s.source_id = ? AND cs.role = 'supports' AND c.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM claim_spans cs2
                JOIN spans s2 ON s2.id = cs2.span_id
                JOIN sources src2 ON src2.id = s2.source_id
               WHERE cs2.claim_id = cs.claim_id AND cs2.role = 'supports' AND src2.status = 'active'
            )
          ORDER BY cs.claim_id`,
      )
      .all(sourceId) as Array<{ claimId: ClaimId }>;
    return rows.map((r) => r.claimId);
  }

  /** Spans (joined) that support a claim, for provenance display. */
  spansForClaim(claimId: ClaimId): Span[] {
    return this.db
      .prepare(
        `SELECT s.* FROM spans s JOIN claim_spans cs ON cs.span_id = s.id
         WHERE cs.claim_id = ? ORDER BY s.char_start`,
      )
      .all(claimId)
      .map((r) => SpanRow.parse(r));
  }
}

export class RelationshipSpanRepo {
  constructor(private readonly db: Db) {}

  upsert(relationshipId: RelationshipId, spanId: SpanId, role: SpanRole): void {
    this.db
      .prepare(
        `INSERT INTO relationship_spans(relationship_id, span_id, role)
         VALUES (?,?,?) ON CONFLICT(relationship_id, span_id, role) DO NOTHING`,
      )
      .run(relationshipId, spanId, role);
  }

  /** Whether the `(relationship_id, span_id, role)` evidence edge already exists. Read-only. */
  hasLink(relationshipId: RelationshipId, spanId: SpanId, role: SpanRole): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM relationship_spans WHERE relationship_id = ? AND span_id = ? AND role = ?')
        .get(relationshipId, spanId, role) !== undefined
    );
  }

  /** Spans (joined) that support a relationship, for provenance display. */
  spansForRelationship(relationshipId: RelationshipId): Span[] {
    return this.db
      .prepare(
        `SELECT s.* FROM spans s JOIN relationship_spans rs ON rs.span_id = s.id
         WHERE rs.relationship_id = ? ORDER BY s.char_start`,
      )
      .all(relationshipId)
      .map((r) => SpanRow.parse(r));
  }
}
