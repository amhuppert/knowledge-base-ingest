import type { ServiceContext } from './context.js';
import type { GraphApply, EntityRef } from '../schemas/agent.js';
import type { EntityId } from '../ids.js';
import { normalizeEntityName } from '../algorithms/normalize.js';
import { deriveEntityId, deriveRelationshipId } from '../algorithms/idDeriver.js';
import { resolveSpan } from './spanResolver.js';

export interface GraphApplyResult {
  entitiesCreated: number;
  entitiesUpdated: number;
  entitiesUnchanged: number;
  entitiesReferenced: number;
  relationshipsCreated: number;
  relationshipsUpdated: number;
  relationshipsUnchanged: number;
  spansCreated: number;
}

export class GraphService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Persist agent-extracted entities and relationships with quote-verified provenance. */
  apply(payload: GraphApply): GraphApplyResult {
    const repos = this.ctx.repos;
    const now = this.ctx.now();
    const source = repos.sources.getById(payload.source_id);
    if (!source) throw new Error(`unknown source ${payload.source_id}`);
    const sourceText = repos.sourceTexts.get(payload.source_id);
    if (!sourceText) throw new Error(`no canonical text for source ${payload.source_id}`);

    return repos.tx(() => {
      const result: GraphApplyResult = {
        entitiesCreated: 0,
        entitiesUpdated: 0,
        entitiesUnchanged: 0,
        entitiesReferenced: 0,
        relationshipsCreated: 0,
        relationshipsUpdated: 0,
        relationshipsUnchanged: 0,
        spansCreated: 0,
      };
      const spansBefore = repos.spans.listBySource(payload.source_id).length;

      const ensureEntity = (
        ref: EntityRef,
        description: string,
        confidence: number,
        mode: 'definition' | 'reference',
      ): EntityId => {
        const normalizedName = normalizeEntityName(ref.name);
        const id = deriveEntityId(ref.type, normalizedName);
        const existing = repos.entities.getById(id);
        if (existing && mode === 'reference') {
          result.entitiesReferenced++;
          return id;
        }

        const entity = {
          id,
          type: ref.type,
          canonicalName: ref.name,
          normalizedName,
          description,
          confidence,
          firstSeenSourceId: payload.source_id,
          createdAt: now,
          updatedAt: now,
        };

        if (existing) {
          const improvesDescription = description.length > existing.description.length;
          const improvesConfidence = confidence > existing.confidence;
          if (!improvesDescription && !improvesConfidence) {
            result.entitiesUnchanged++;
            return id;
          }
        }

        const { created } = repos.entities.upsert(entity);
        if (created) result.entitiesCreated++;
        else result.entitiesUpdated++;
        return id;
      };

      for (const e of payload.entities) {
        ensureEntity({ type: e.type, name: e.name }, e.description, e.confidence, 'definition');
      }

      for (const r of payload.relationships) {
        const subjectId = ensureEntity(r.subject, '', r.confidence, 'reference');
        const objectId = ensureEntity(r.object, '', r.confidence, 'reference');
        const relId = deriveRelationshipId(r.type, subjectId, objectId);
        const existing = repos.relationships.getById(relId);
        const relationship = {
          id: relId,
          type: r.type,
          subjectEntityId: subjectId,
          objectEntityId: objectId,
          description: r.description,
          confidence: r.confidence,
          status: 'active' as const,
          firstSeenSourceId: payload.source_id,
          createdAt: now,
          updatedAt: now,
        };
        if (existing) {
          const improvesDescription = r.description.length > existing.description.length;
          const improvesConfidence = r.confidence > existing.confidence;
          if (improvesDescription || improvesConfidence) {
            repos.relationships.upsert(relationship);
            result.relationshipsUpdated++;
          } else {
            result.relationshipsUnchanged++;
          }
        } else {
          repos.relationships.upsert(relationship);
          result.relationshipsCreated++;
        }

        for (const ref of r.evidence) {
          const spanId = resolveSpan(repos, payload.source_id, sourceText, ref, now);
          repos.relationshipSpans.upsert(relId, spanId, ref.role);
        }
      }

      result.spansCreated = repos.spans.listBySource(payload.source_id).length - spansBefore;
      repos.changelog.append({
        ts: now,
        op: 'graph_apply',
        sourceId: payload.source_id,
        summary: `Graph: +${result.entitiesCreated} entities, +${result.relationshipsCreated} relationships`,
        detail: result,
      });
      return result;
    });
  }
}
