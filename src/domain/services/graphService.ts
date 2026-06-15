import type { ServiceContext } from './context.js';
import type { GraphApply, EntityRef } from '../schemas/agent.js';
import type { EntityId } from '../ids.js';
import { normalizeEntityName } from '../algorithms/normalize.js';
import { deriveEntityId, deriveRelationshipId } from '../algorithms/idDeriver.js';
import { resolveSpan } from './spanResolver.js';

export interface GraphApplyResult {
  entitiesCreated: number;
  entitiesUpdated: number;
  relationshipsCreated: number;
  relationshipsUpdated: number;
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
        relationshipsCreated: 0,
        relationshipsUpdated: 0,
        spansCreated: 0,
      };
      const spansBefore = repos.spans.listBySource(payload.source_id).length;

      const ensureEntity = (ref: EntityRef, description: string, confidence: number): EntityId => {
        const normalizedName = normalizeEntityName(ref.name);
        const id = deriveEntityId(ref.type, normalizedName);
        const { created } = repos.entities.upsert({
          id,
          type: ref.type,
          canonicalName: ref.name,
          normalizedName,
          description,
          confidence,
          firstSeenSourceId: payload.source_id,
          createdAt: now,
          updatedAt: now,
        });
        if (created) result.entitiesCreated++;
        else result.entitiesUpdated++;
        return id;
      };

      for (const e of payload.entities) {
        ensureEntity({ type: e.type, name: e.name }, e.description, e.confidence);
      }

      for (const r of payload.relationships) {
        const subjectId = ensureEntity(r.subject, '', r.confidence);
        const objectId = ensureEntity(r.object, '', r.confidence);
        const relId = deriveRelationshipId(r.type, subjectId, objectId);
        const { created } = repos.relationships.upsert({
          id: relId,
          type: r.type,
          subjectEntityId: subjectId,
          objectEntityId: objectId,
          description: r.description,
          confidence: r.confidence,
          status: 'active',
          firstSeenSourceId: payload.source_id,
          createdAt: now,
          updatedAt: now,
        });
        if (created) result.relationshipsCreated++;
        else result.relationshipsUpdated++;

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
