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

  listBySource(sourceId: SourceId): Span[] {
    return this.db
      .prepare('SELECT * FROM spans WHERE source_id = ? ORDER BY char_start')
      .all(sourceId)
      .map((r) => SpanRow.parse(r));
  }
}

export class ClaimSpanRepo {
  constructor(private readonly db: Db) {}

  upsert(cs: ClaimSpan): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO claim_spans(claim_id, span_id, role, confidence, extractor)
         VALUES (@claimId,@spanId,@role,@confidence,@extractor)
         ON CONFLICT(claim_id, span_id, role) DO UPDATE SET
           confidence = excluded.confidence, extractor = excluded.extractor`,
      )
      .run(cs as unknown as Record<string, unknown>);
    return info.changes > 0 && info.lastInsertRowid !== 0;
  }

  listByClaim(claimId: ClaimId): ClaimSpan[] {
    return this.db
      .prepare('SELECT * FROM claim_spans WHERE claim_id = ?')
      .all(claimId)
      .map((r) => ClaimSpanRow.parse(r));
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
