import type { Db } from '../connection.js';
import { EntityRow, RelationshipRow } from '../rows.js';
import type { Entity, Relationship } from '../../domain/schemas/models.js';
import type { EntityId, RelationshipId } from '../../domain/ids.js';

export class EntityRepo {
  constructor(private readonly db: Db) {}

  upsert(e: Entity): { entity: Entity; created: boolean } {
    const existing = this.getById(e.id);
    if (existing) {
      // Keep first-seen provenance; only enrich description/confidence if better.
      this.db
        .prepare(
          `UPDATE entities SET description = CASE WHEN length(@description) > length(description)
             THEN @description ELSE description END,
             confidence = MAX(confidence, @confidence), updated_at = @updatedAt WHERE id = @id`,
        )
        .run(e as unknown as Record<string, unknown>);
      return { entity: existing, created: false };
    }
    this.db
      .prepare(
        `INSERT INTO entities(id, type, canonical_name, normalized_name, description, confidence,
           first_seen_source_id, created_at, updated_at)
         VALUES (@id,@type,@canonicalName,@normalizedName,@description,@confidence,
           @firstSeenSourceId,@createdAt,@updatedAt)`,
      )
      .run(e as unknown as Record<string, unknown>);
    return { entity: e, created: true };
  }

  getById(id: EntityId): Entity | undefined {
    const r = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    return r ? EntityRow.parse(r) : undefined;
  }

  listAll(): Entity[] {
    return this.db
      .prepare('SELECT * FROM entities ORDER BY type, normalized_name')
      .all()
      .map((r) => EntityRow.parse(r));
  }

  search(term: string, limit: number): Entity[] {
    return this.db
      .prepare(
        "SELECT * FROM entities WHERE normalized_name LIKE ? OR canonical_name LIKE ? ORDER BY type, normalized_name LIMIT ?",
      )
      .all(`%${term.toLowerCase()}%`, `%${term}%`, limit)
      .map((r) => EntityRow.parse(r));
  }
}

export class RelationshipRepo {
  constructor(private readonly db: Db) {}

  upsert(r: Relationship): { relationship: Relationship; created: boolean } {
    const existing = this.getById(r.id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE relationships SET description = CASE WHEN length(@description) > length(description)
             THEN @description ELSE description END,
             confidence = MAX(confidence, @confidence), updated_at = @updatedAt WHERE id = @id`,
        )
        .run(r as unknown as Record<string, unknown>);
      return { relationship: existing, created: false };
    }
    this.db
      .prepare(
        `INSERT INTO relationships(id, type, subject_entity_id, object_entity_id, description,
           confidence, status, first_seen_source_id, created_at, updated_at)
         VALUES (@id,@type,@subjectEntityId,@objectEntityId,@description,@confidence,@status,
           @firstSeenSourceId,@createdAt,@updatedAt)`,
      )
      .run(r as unknown as Record<string, unknown>);
    return { relationship: r, created: true };
  }

  getById(id: RelationshipId): Relationship | undefined {
    const row = this.db.prepare('SELECT * FROM relationships WHERE id = ?').get(id);
    return row ? RelationshipRow.parse(row) : undefined;
  }

  listAll(): Relationship[] {
    return this.db
      .prepare('SELECT * FROM relationships ORDER BY type')
      .all()
      .map((r) => RelationshipRow.parse(r));
  }

  listByEntity(entityId: EntityId): Relationship[] {
    return this.db
      .prepare(
        'SELECT * FROM relationships WHERE subject_entity_id = ? OR object_entity_id = ? ORDER BY type',
      )
      .all(entityId, entityId)
      .map((r) => RelationshipRow.parse(r));
  }
}
