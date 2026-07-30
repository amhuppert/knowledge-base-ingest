import type { ServiceContext } from './context.js';
import type { GraphApply, EntityRef, RelEvidence } from '../schemas/agent.js';
import type { EntityId, RelationshipId, SpanId } from '../ids.js';
import { normalizeEntityName } from '../algorithms/normalize.js';
import { deriveEntityId, deriveRelationshipId } from '../algorithms/idDeriver.js';
import { resolveSpanCandidate, persistSpan, spanIdFor, spanRangeKey, type SpanCandidate } from './spanResolver.js';
import { DomainIssueError, type DomainIssue } from '../issueCodes.js';
import { ENTITY_TYPES, RELATIONSHIP_TYPES } from '../schemas/enums.js';

export type GraphOutcome = 'created' | 'updated' | 'unchanged';

/** Per-input entity receipt (payload.entities). Entities carry no provenance spans. */
export interface EntityReceipt {
  inputIndex: number;
  entityId: EntityId;
  outcome: GraphOutcome;
}

/** Per-relationship evidence accounting. `spansCreated + spansReused === submitted`; same for links. */
export interface RelEvidenceAccounting {
  submitted: number;
  spansCreated: number;
  spansReused: number;
  linksCreated: number;
  linksReused: number;
}

export interface RelationshipReceipt {
  inputIndex: number;
  relationshipId: RelationshipId;
  outcome: GraphOutcome;
  evidence: RelEvidenceAccounting;
}

export interface GraphApplyTotals {
  entitiesCreated: number;
  entitiesUpdated: number;
  entitiesUnchanged: number;
  entitiesReferenced: number;
  relationshipsCreated: number;
  relationshipsUpdated: number;
  relationshipsUnchanged: number;
  spansCreated: number;
  spansReused: number;
  linksCreated: number;
  linksReused: number;
}

/**
 * The `graph apply` receipt (03 §3.2). Authoritative fields: `entities`,
 * `relationships`, `totals`. NO `staleNodes` — graph mutations never stale nodes, so
 * the field is OMITTED (not always-empty). Aggregate counters are retained as
 * deprecated aliases (compat matrix); `spansCreated` is the net new-span count.
 */
export interface GraphApplyReceipt {
  entities: EntityReceipt[];
  relationships: RelationshipReceipt[];
  totals: GraphApplyTotals;
  // --- deprecated aliases (compat matrix) ---
  entitiesCreated: number;
  entitiesUpdated: number;
  entitiesUnchanged: number;
  entitiesReferenced: number;
  relationshipsCreated: number;
  relationshipsUpdated: number;
  relationshipsUnchanged: number;
  spansCreated: number;
}

/** One resolved relationship evidence ref, classified against the DB *and* the batch. */
interface EvidencePlan {
  candidate: SpanCandidate;
  role: RelEvidence['role'];
  /** The id this evidence span has, or will have once persisted. */
  spanId: SpanId;
  /** This ref is the first in the batch to introduce the span row (it must persist it). */
  spanCreated: boolean;
  /** No `(relationship_id, span_id, role)` edge exists yet — stored or already planned. */
  linkCreated: boolean;
}

/**
 * The batch's VIRTUAL post-write state (03 §3.2). A relationship's evidence is classified
 * in full BEFORE any of it is persisted, so duplicate refs must be accounted against what
 * the earlier refs will write — otherwise one physical span/edge is reported as two
 * creations (dishonest dedup).
 */
interface EvidenceBatchState {
  /** Spans this batch will insert, keyed by `(source, range)` → the id they will carry. */
  spans: Map<string, SpanId>;
  /** Evidence edges this batch will insert, keyed `${relId}|${spanId}|${role}`. */
  links: Set<string>;
}

interface GraphApplyOptions {
  /** Receives non-blocking type diagnostics computed against the pre-apply KB state. */
  onDiagnostics?: (issues: readonly DomainIssue[]) => void;
}

interface EstablishedType {
  type: string;
  count: number;
  recommendedOrder: number;
}

function normalizedGraphType(type: string): string {
  return type.toLowerCase().replace(/[_ -]/g, '');
}

export class GraphService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Diagnose payload types against recommended vocabulary plus types already stored in
   * this KB. Diagnostics are advisory: neither a warning nor info issue blocks writes.
   */
  private typeDiagnostics(payload: GraphApply): DomainIssue[] {
    const repos = this.ctx.repos;
    const established = (
      recommended: readonly string[],
      observedTypes: readonly string[],
    ): EstablishedType[] => {
      const counts = new Map<string, number>();
      for (const type of observedTypes) counts.set(type, (counts.get(type) ?? 0) + 1);
      const recommendationOrder = new Map(recommended.map((type, index) => [type, index]));
      const types = new Set<string>([...recommended, ...counts.keys()]);
      return [...types]
        .map((type) => ({
          type,
          count: counts.get(type) ?? 0,
          recommendedOrder: recommendationOrder.get(type) ?? Number.MAX_SAFE_INTEGER,
        }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.recommendedOrder - b.recommendedOrder ||
            a.type.localeCompare(b.type),
        );
    };

    const entityTypes = established(ENTITY_TYPES, repos.entities.listAll().map((entity) => entity.type));
    const relationshipTypes = established(
      RELATIONSHIP_TYPES,
      repos.relationships.listAll().map((relationship) => relationship.type),
    );
    const candidates: Array<{
      kind: 'entity' | 'relationship';
      type: string;
      path: string;
      established: EstablishedType[];
    }> = [
      ...payload.entities.map((entity, index) => ({
        kind: 'entity' as const,
        type: entity.type,
        path: `entities[${index}].type`,
        established: entityTypes,
      })),
      ...payload.relationships.flatMap((relationship, index) => [
        {
          kind: 'relationship' as const,
          type: relationship.type,
          path: `relationships[${index}].type`,
          established: relationshipTypes,
        },
        {
          kind: 'entity' as const,
          type: relationship.subject.type,
          path: `relationships[${index}].subject.type`,
          established: entityTypes,
        },
        {
          kind: 'entity' as const,
          type: relationship.object.type,
          path: `relationships[${index}].object.type`,
          established: entityTypes,
        },
      ]),
    ];

    const seen = new Set<string>();
    return candidates.flatMap<DomainIssue>(({ kind, type, path, established: known }): DomainIssue[] => {
      const key = `${kind}\0${type}`;
      if (seen.has(key)) return [];
      seen.add(key);
      if (known.some((entry) => entry.type === type)) return [];

      const normalized = normalizedGraphType(type);
      const nearMiss = known.find((entry) => normalizedGraphType(entry.type) === normalized);
      if (nearMiss) {
        return [{
          code: 'GRAPH_TYPE_NEAR_MISS',
          severity: 'warning',
          message: `${kind} type "${type}" is a near miss for established type "${nearMiss.type}".`,
          path,
        }];
      }

      const examples = known
        .slice(0, 5)
        .map((entry) => `${entry.type} (${entry.count})`)
        .join(', ');
      return [{
        code: 'GRAPH_TYPE_NEW',
        severity: 'info',
        message: `New ${kind} type "${type}". Established ${kind} types with counts: ${examples}.`,
        path,
      }];
    });
  }

  /**
   * Persist agent-extracted entities and relationships with quote-verified provenance,
   * atomically, returning a per-input receipt (03 §3.2). Entities and relationships are
   * classified created/updated/unchanged; an evidence-only addition to an existing
   * relationship counts as `updated`; an exact repeat writes NOTHING (no rows, no
   * changelog). The changelog is appended iff `created + updated > 0`.
   */
  apply(payload: GraphApply, options: GraphApplyOptions = {}): GraphApplyReceipt {
    const repos = this.ctx.repos;
    const now = this.ctx.now();
    const source = repos.sources.getById(payload.source_id);
    if (!source) {
      throw new DomainIssueError('UNKNOWN_SOURCE', `unknown source ${payload.source_id}`, { path: 'source_id', ids: [payload.source_id] });
    }
    const sourceText = repos.sourceTexts.get(payload.source_id);
    if (!sourceText) {
      throw new DomainIssueError('UNKNOWN_SOURCE', `no canonical text for source ${payload.source_id}`, { path: 'source_id', ids: [payload.source_id] });
    }

    options.onDiagnostics?.(this.typeDiagnostics(payload));

    return repos.tx(() => {
      const spansBefore = repos.spans.listBySource(payload.source_id).length;
      const batch: EvidenceBatchState = { spans: new Map(), links: new Set() };
      const totals: GraphApplyTotals = {
        entitiesCreated: 0, entitiesUpdated: 0, entitiesUnchanged: 0, entitiesReferenced: 0,
        relationshipsCreated: 0, relationshipsUpdated: 0, relationshipsUnchanged: 0,
        spansCreated: 0, spansReused: 0, linksCreated: 0, linksReused: 0,
      };

      // Definition mode WRITES an entity (create/update/skip-unchanged); reference mode
      // looks it up, creating a stub only when the endpoint is otherwise unknown.
      const ensureEntity = (ref: EntityRef, description: string, confidence: number, mode: 'definition' | 'reference'): { id: EntityId; outcome: GraphOutcome } => {
        const id = deriveEntityId(ref.type, normalizeEntityName(ref.name));
        const existing = repos.entities.getById(id);
        if (existing && mode === 'reference') {
          totals.entitiesReferenced++;
          return { id, outcome: 'unchanged' };
        }
        if (existing) {
          const improves = description.length > existing.description.length || confidence > existing.confidence;
          if (!improves) {
            totals.entitiesUnchanged++;
            return { id, outcome: 'unchanged' };
          }
        }
        const { created } = repos.entities.upsert({
          id, type: ref.type, canonicalName: ref.name, normalizedName: normalizeEntityName(ref.name),
          description, confidence, firstSeenSourceId: payload.source_id, createdAt: now, updatedAt: now,
        });
        if (created) totals.entitiesCreated++;
        else totals.entitiesUpdated++;
        return { id, outcome: created ? 'created' : 'updated' };
      };

      const entities: EntityReceipt[] = payload.entities.map((e, i) => {
        const { id, outcome } = ensureEntity({ type: e.type, name: e.name }, e.description, e.confidence, 'definition');
        return { inputIndex: i, entityId: id, outcome };
      });

      const relationships: RelationshipReceipt[] = payload.relationships.map((r, ri) => {
        const subjectId = ensureEntity(r.subject, '', r.confidence, 'reference').id;
        const objectId = ensureEntity(r.object, '', r.confidence, 'reference').id;
        const relId = deriveRelationshipId(r.type, subjectId, objectId);
        const existing = repos.relationships.getById(relId);

        // Classify evidence read-only against the DB AND the batch: does the span already
        // exist (or will an earlier ref create it), and does the (relationship, span, role)
        // edge already exist (or is it already planned)?
        const plans: EvidencePlan[] = r.evidence.map((ev, ei) => {
          const candidate = resolveSpanCandidate(repos, payload.source_id, sourceText, ev, ['relationships', ri, 'evidence', ei]);
          const rangeKey = spanRangeKey(candidate);
          const spanId = spanIdFor(candidate);
          const spanCreated = candidate.existingSpanId === null && !batch.spans.has(rangeKey);
          if (spanCreated) batch.spans.set(rangeKey, spanId);

          const linkKey = `${relId}|${spanId}|${ev.role}`;
          const linkExists =
            batch.links.has(linkKey) ||
            (candidate.existingSpanId !== null && repos.relationshipSpans.hasLink(relId, candidate.existingSpanId, ev.role));
          if (!linkExists) batch.links.add(linkKey);
          return { candidate, role: ev.role, spanId, spanCreated, linkCreated: !linkExists };
        });
        const evidence: RelEvidenceAccounting = {
          submitted: plans.length,
          spansCreated: plans.filter((p) => p.spanCreated).length,
          spansReused: plans.filter((p) => !p.spanCreated).length,
          linksCreated: plans.filter((p) => p.linkCreated).length,
          linksReused: plans.filter((p) => !p.linkCreated).length,
        };

        const improves = existing !== undefined && (r.description.length > existing.description.length || r.confidence > existing.confidence);
        const anyNewEvidence = plans.some((p) => p.linkCreated);
        const outcome: GraphOutcome = existing === undefined ? 'created' : improves || anyNewEvidence ? 'updated' : 'unchanged';

        if (outcome !== 'unchanged') {
          repos.relationships.upsert({
            id: relId, type: r.type, subjectEntityId: subjectId, objectEntityId: objectId,
            description: r.description, confidence: r.confidence, status: 'active',
            firstSeenSourceId: payload.source_id, createdAt: now, updatedAt: now,
          });
          for (const p of plans) {
            // Only the ref that CLAIMED the creation persists the span; a batch-local
            // duplicate reuses the id its twin will have written (they are identical).
            if (p.spanCreated) persistSpan(repos, p.candidate, now);
            if (p.linkCreated) repos.relationshipSpans.upsert(relId, p.spanId, p.role);
          }
        }

        if (outcome === 'created') totals.relationshipsCreated++;
        else if (outcome === 'updated') totals.relationshipsUpdated++;
        else totals.relationshipsUnchanged++;
        totals.spansCreated += evidence.spansCreated;
        totals.spansReused += evidence.spansReused;
        totals.linksCreated += evidence.linksCreated;
        totals.linksReused += evidence.linksReused;

        return { inputIndex: ri, relationshipId: relId, outcome, evidence };
      });

      const written = totals.entitiesCreated + totals.entitiesUpdated + totals.relationshipsCreated + totals.relationshipsUpdated;
      if (written > 0) {
        repos.changelog.append({
          ts: now,
          op: 'graph_apply',
          sourceId: payload.source_id,
          summary: `Graph: +${totals.entitiesCreated} entities, +${totals.relationshipsCreated} relationships`,
          detail: totals,
        });
      }

      const spansCreatedNet = repos.spans.listBySource(payload.source_id).length - spansBefore;

      return {
        entities,
        relationships,
        totals,
        entitiesCreated: totals.entitiesCreated,
        entitiesUpdated: totals.entitiesUpdated,
        entitiesUnchanged: totals.entitiesUnchanged,
        entitiesReferenced: totals.entitiesReferenced,
        relationshipsCreated: totals.relationshipsCreated,
        relationshipsUpdated: totals.relationshipsUpdated,
        relationshipsUnchanged: totals.relationshipsUnchanged,
        spansCreated: spansCreatedNet,
      };
    });
  }
}
