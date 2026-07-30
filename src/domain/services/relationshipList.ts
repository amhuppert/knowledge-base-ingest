import type { Repositories } from '../../db/repositories/index.js';
import { EntityRow, RelationshipRow } from '../../db/rows.js';
import type {
  ChunkId,
  EntityId,
  RelationshipId,
  SourceId,
  SpanId,
} from '../ids.js';
import type { ClaimStatus, SourceStatus, SpanRole } from '../schemas/enums.js';

export interface RelationshipListFilter {
  sourceId?: SourceId;
  entityId?: EntityId;
  type?: string;
  status?: ClaimStatus;
}

export interface RelationshipListEntity {
  id: EntityId;
  type: string;
  canonicalName: string;
}

export interface RelationshipListSource {
  id: SourceId;
  title: string;
  status: SourceStatus;
}

export interface RelationshipListEvidence {
  spanId: SpanId;
  role: SpanRole;
  chunkId: ChunkId;
  sourceId: SourceId;
  sourceTitle: string;
  sourceStatus: SourceStatus;
  charStart: number;
  charEnd: number;
  quote: string;
  matchesSourceScope?: boolean;
}

export interface RelationshipListRow {
  id: RelationshipId;
  type: string;
  status: ClaimStatus;
  description: string;
  confidence: number;
  firstSeenSource: RelationshipListSource | null;
  subject: RelationshipListEntity;
  object: RelationshipListEntity;
  evidence: RelationshipListEvidence[];
}

export interface RelationshipListTotals {
  relationships: number;
  evidenceLinks: number;
  matchingEvidenceLinks?: number;
  byStatus: Record<ClaimStatus, number>;
  byType: Record<string, number>;
}

export interface RelationshipListResult {
  filter: RelationshipListFilter;
  relationships: RelationshipListRow[];
  totals: RelationshipListTotals;
}

interface RelationshipQueryRow {
  id: string;
  type: string;
  subject_entity_id: string;
  object_entity_id: string;
  description: string;
  confidence: number;
  status: string;
  first_seen_source_id: string | null;
  created_at: string;
  updated_at: string;
  firstSeenSourceTitle: string | null;
  firstSeenSourceStatus: SourceStatus | null;
}

interface EvidenceQueryRow {
  relationshipId: RelationshipId;
  spanId: SpanId;
  role: SpanRole;
  chunkId: ChunkId;
  sourceId: SourceId;
  sourceTitle: string;
  sourceStatus: SourceStatus;
  charStart: number;
  charEnd: number;
  quote: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Build the complete relationship read model with three batched hydration queries:
 * filtered relationships, all involved entities, and all linked evidence.
 *
 * Source membership is resolved exclusively through `sourceContribution`; its
 * evidence-membership query precedes hydration only when `filter.sourceId` is set.
 */
export function buildRelationshipList(
  repos: Repositories,
  filter: RelationshipListFilter,
): RelationshipListResult {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.sourceId !== undefined) {
    const contributedIds = repos.sourceContribution
      .relationshipsEvidencedBy(filter.sourceId)
      .map((row) => row.relationshipId);
    if (contributedIds.length === 0) {
      clauses.push('0');
    } else {
      clauses.push(`r.id IN (${placeholders(contributedIds.length)})`);
      params.push(...contributedIds);
    }
  }
  if (filter.entityId !== undefined) {
    clauses.push('(r.subject_entity_id = ? OR r.object_entity_id = ?)');
    params.push(filter.entityId, filter.entityId);
  }
  if (filter.type !== undefined) {
    clauses.push('r.type = ?');
    params.push(filter.type);
  }
  if (filter.status !== undefined) {
    clauses.push('r.status = ?');
    params.push(filter.status);
  }

  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
  const relationshipRows = repos.db
    .prepare(
      `SELECT r.*, source.title AS firstSeenSourceTitle,
              source.status AS firstSeenSourceStatus
         FROM relationships r
         LEFT JOIN sources source ON source.id = r.first_seen_source_id
         ${where}`,
    )
    .all(...params) as RelationshipQueryRow[];
  const relationships = relationshipRows.map((row) => ({
    relationship: RelationshipRow.parse(row),
    firstSeenSource:
      row.first_seen_source_id === null
        ? null
        : {
            id: row.first_seen_source_id as SourceId,
            title: row.firstSeenSourceTitle!,
            status: row.firstSeenSourceStatus!,
          },
  }));

  const entityIds = [
    ...new Set(
      relationships.flatMap(({ relationship }) => [
        relationship.subjectEntityId,
        relationship.objectEntityId,
      ]),
    ),
  ];
  const entitySql =
    entityIds.length === 0
      ? 'SELECT * FROM entities WHERE 0'
      : `SELECT * FROM entities WHERE id IN (${placeholders(entityIds.length)})`;
  const entities = (repos.db.prepare(entitySql).all(...entityIds) as unknown[]).map((row) =>
    EntityRow.parse(row),
  );
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));

  const relationshipIds = relationships.map(({ relationship }) => relationship.id);
  const evidenceSql =
    relationshipIds.length === 0
      ? `SELECT rs.relationship_id AS relationshipId, s.id AS spanId, rs.role,
                s.chunk_id AS chunkId, s.source_id AS sourceId,
                source.title AS sourceTitle, source.status AS sourceStatus,
                s.char_start AS charStart, s.char_end AS charEnd, s.quote
           FROM relationship_spans rs
           JOIN spans s ON s.id = rs.span_id
           JOIN sources source ON source.id = s.source_id
          WHERE 0`
      : `SELECT rs.relationship_id AS relationshipId, s.id AS spanId, rs.role,
                s.chunk_id AS chunkId, s.source_id AS sourceId,
                source.title AS sourceTitle, source.status AS sourceStatus,
                s.char_start AS charStart, s.char_end AS charEnd, s.quote
           FROM relationship_spans rs
           JOIN spans s ON s.id = rs.span_id
           JOIN sources source ON source.id = s.source_id
          WHERE rs.relationship_id IN (${placeholders(relationshipIds.length)})
          ORDER BY rs.relationship_id, s.source_id, s.char_start, s.id`;
  const evidenceRows = repos.db
    .prepare(evidenceSql)
    .all(...relationshipIds) as EvidenceQueryRow[];
  const evidenceByRelationship = new Map<RelationshipId, RelationshipListEvidence[]>();
  for (const row of evidenceRows) {
    const evidence: RelationshipListEvidence =
      filter.sourceId === undefined
        ? {
            spanId: row.spanId,
            role: row.role,
            chunkId: row.chunkId,
            sourceId: row.sourceId,
            sourceTitle: row.sourceTitle,
            sourceStatus: row.sourceStatus,
            charStart: row.charStart,
            charEnd: row.charEnd,
            quote: row.quote,
          }
        : {
            spanId: row.spanId,
            role: row.role,
            chunkId: row.chunkId,
            sourceId: row.sourceId,
            sourceTitle: row.sourceTitle,
            sourceStatus: row.sourceStatus,
            charStart: row.charStart,
            charEnd: row.charEnd,
            quote: row.quote,
            matchesSourceScope: row.sourceId === filter.sourceId,
          };
    const grouped = evidenceByRelationship.get(row.relationshipId) ?? [];
    grouped.push(evidence);
    evidenceByRelationship.set(row.relationshipId, grouped);
  }

  const rows: RelationshipListRow[] = relationships
    .map(({ relationship, firstSeenSource }) => {
      const subject = entitiesById.get(relationship.subjectEntityId);
      const object = entitiesById.get(relationship.objectEntityId);
      if (!subject || !object) {
        throw new Error(`relationship ${relationship.id} references an unknown entity`);
      }
      return {
        id: relationship.id,
        type: relationship.type,
        status: relationship.status,
        description: relationship.description,
        confidence: relationship.confidence,
        firstSeenSource,
        subject: {
          id: subject.id,
          type: subject.type,
          canonicalName: subject.canonicalName,
        },
        object: {
          id: object.id,
          type: object.type,
          canonicalName: object.canonicalName,
        },
        evidence: evidenceByRelationship.get(relationship.id) ?? [],
      };
    })
    .sort(
      (left, right) =>
        compareStrings(left.type, right.type) ||
        compareStrings(left.subject.canonicalName, right.subject.canonicalName) ||
        compareStrings(left.object.canonicalName, right.object.canonicalName) ||
        compareStrings(left.id, right.id),
    );

  const byStatus: Record<ClaimStatus, number> = {
    active: 0,
    superseded: 0,
    conflicted: 0,
    retracted: 0,
  };
  const byType: Record<string, number> = {};
  let evidenceLinks = 0;
  let matchingEvidenceLinks = 0;
  for (const row of rows) {
    byStatus[row.status] += 1;
    byType[row.type] = (byType[row.type] ?? 0) + 1;
    evidenceLinks += row.evidence.length;
    matchingEvidenceLinks += row.evidence.filter((evidence) => evidence.matchesSourceScope === true).length;
  }

  const resultFilter: RelationshipListFilter = {
    ...(filter.sourceId === undefined ? {} : { sourceId: filter.sourceId }),
    ...(filter.entityId === undefined ? {} : { entityId: filter.entityId }),
    ...(filter.type === undefined ? {} : { type: filter.type }),
    ...(filter.status === undefined ? {} : { status: filter.status }),
  };
  const totals: RelationshipListTotals =
    filter.sourceId === undefined
      ? { relationships: rows.length, evidenceLinks, byStatus, byType }
      : {
          relationships: rows.length,
          evidenceLinks,
          matchingEvidenceLinks,
          byStatus,
          byType,
        };
  return { filter: resultFilter, relationships: rows, totals };
}
