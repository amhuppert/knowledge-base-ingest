import { z } from 'zod';
import { CLAIM_TYPES, NODE_KINDS, SPAN_ROLES, type NodeKind } from './enums.js';
import { zSourceId, zChunkId, zNodeId, zClaimId } from './zodId.js';
import { DomainIssueError, formatPath } from '../issueCodes.js';

/**
 * The agent/CLI boundary. Everything an agent proposes is one of these payloads;
 * the CLI parses with Zod (rejecting before any DB write) then validates further
 * (e.g. quote verification) before persisting in a single transaction.
 *
 * Note on spans: the agent supplies a `chunk_id` + the exact `quote`. The CLI
 * locates the quote within that chunk's source range and derives absolute
 * offsets itself — the agent never computes character offsets (error-prone), and
 * the quote is still verified exactly against the immutable source text.
 */

const confidence = z.number().gte(0).lte(1);

export const SpanRefSchema = z
  .object({
    chunk_id: zChunkId,
    quote: z.string().min(1, 'quote must be non-empty'),
    role: z.enum(SPAN_ROLES).default('supports'),
    confidence: confidence.default(0.8),
  })
  .strict();
export type SpanRef = z.infer<typeof SpanRefSchema>;

export const ClaimInputSchema = z
  .object({
    node_id: zNodeId,
    text: z.string().min(1),
    claim_type: z.enum(CLAIM_TYPES),
    confidence: confidence.default(0.8),
    spans: z.array(SpanRefSchema).min(1, 'every claim needs >=1 provenance span'),
  })
  .strict();
export type ClaimInput = z.infer<typeof ClaimInputSchema>;

export const ClaimApplySchema = z
  .object({
    source_id: zSourceId,
    claims: z.array(ClaimInputSchema).min(1),
  })
  .strict();
export type ClaimApply = z.infer<typeof ClaimApplySchema>;

export const EntityRefSchema = z
  .object({
    type: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type EntityRef = z.infer<typeof EntityRefSchema>;

// Entity `evidence` is REMOVED (03 §3.2, breaking): the service never persisted it
// (there is no entity_spans table), so accepting-and-dropping silently lost data.
export const EntityInputSchema = EntityRefSchema.extend({
  description: z.string().default(''),
  confidence: confidence.default(0.8),
}).strict();
export type EntityInput = z.infer<typeof EntityInputSchema>;

// Relationship evidence has NO `confidence` (03 §3.2, breaking): relationship_spans
// has no such column, so a submitted confidence was silently dropped.
export const RelEvidenceSchema = z
  .object({
    chunk_id: zChunkId,
    quote: z.string().min(1, 'quote must be non-empty'),
    role: z.enum(SPAN_ROLES).default('supports'),
  })
  .strict();
export type RelEvidence = z.infer<typeof RelEvidenceSchema>;

export const RelationshipInputSchema = z
  .object({
    type: z.string().min(1),
    subject: EntityRefSchema,
    object: EntityRefSchema,
    description: z.string().default(''),
    confidence: confidence.default(0.8),
    evidence: z.array(RelEvidenceSchema).min(1, 'every relationship needs >=1 provenance span'),
  })
  .strict();
export type RelationshipInput = z.infer<typeof RelationshipInputSchema>;

export const GraphApplySchema = z
  .object({
    source_id: zSourceId,
    entities: z.array(EntityInputSchema).default([]),
    relationships: z.array(RelationshipInputSchema).default([]),
  })
  .strict();
export type GraphApply = z.infer<typeof GraphApplySchema>;

/**
 * The two INTENTIONALLY removed graph payload fields (03 §3.2, compat matrix). A payload
 * that still sends one is rejected with `PAYLOAD_SCHEMA` and `details.removedField` set to
 * the member below; `src/cli/issues.ts` turns that into the field-specific agent-facing
 * hint. The split is deliberate: the domain diagnostic carries only `code`/`path`/`ids`/
 * `details` and the CLI owns ALL hint wording (01 §3.1, finding 12).
 */
export const REMOVED_GRAPH_FIELDS = ['entity.evidence', 'relationship.evidence.confidence'] as const;
export type RemovedGraphField = (typeof REMOVED_GRAPH_FIELDS)[number];

/** The `details` shape a removed-field `PAYLOAD_SCHEMA` error carries. */
export interface RemovedGraphFieldDetails {
  removedField: RemovedGraphField;
}

/**
 * Parse a graph payload, rejecting the two breaking removals BEFORE the generic
 * strict-schema check so the failure names the removed field structurally (a bare strict
 * "unrecognized key" would not say WHICH removal it is, and the CLI could not attach the
 * precise silent-loss guidance).
 */
export function parseGraphApply(raw: unknown): GraphApply {
  assertNoRemovedGraphFields(raw);
  return GraphApplySchema.parse(raw);
}

/** Raise the removed-field rejection: message states the fact, `details` names the field. */
function removedFieldError(removedField: RemovedGraphField, path: ReadonlyArray<string | number>): DomainIssueError {
  const formatted = formatPath(path);
  return new DomainIssueError('PAYLOAD_SCHEMA', `${formatted} is no longer accepted (removed field ${removedField})`, {
    path: formatted,
    details: { removedField } satisfies RemovedGraphFieldDetails,
  });
}

function assertNoRemovedGraphFields(raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return;
  const record = raw as Record<string, unknown>;

  const entities = record['entities'];
  if (Array.isArray(entities)) {
    entities.forEach((e, i) => {
      if (e !== null && typeof e === 'object' && 'evidence' in (e as object)) {
        throw removedFieldError('entity.evidence', ['entities', i, 'evidence']);
      }
    });
  }

  const relationships = record['relationships'];
  if (Array.isArray(relationships)) {
    relationships.forEach((r, ri) => {
      const evidence = (r as Record<string, unknown> | null)?.['evidence'];
      if (Array.isArray(evidence)) {
        evidence.forEach((ev, ei) => {
          if (ev !== null && typeof ev === 'object' && 'confidence' in (ev as object)) {
            throw removedFieldError('relationship.evidence.confidence', ['relationships', ri, 'evidence', ei, 'confidence']);
          }
        });
      }
    });
  }
}

export const SynthesizeSchema = z
  .object({
    node_id: zNodeId,
    title: z.string().min(1).optional(),
    summary: z.string().optional(),
    body_md: z.string(),
  })
  .strict();
export type Synthesize = z.infer<typeof SynthesizeSchema>;

/**
 * The most nodes one batch synthesize may carry (04 §3). A bounded batch keeps the
 * single-transaction apply and the whole-batch prevalidation predictable; over-cap is a
 * `PAYLOAD_SCHEMA` failure, never a silent truncation (charter: no-silent-truncation).
 */
export const SYNTHESIZE_BATCH_MAX = 200;

/**
 * The BATCH synthesize payload (04 §3): the same per-node entries as the single-object
 * form, under `nodes`, capped at {@link SYNTHESIZE_BATCH_MAX}. A node may appear at most
 * once — two entries for one node would make the applied body depend on apply order, so a
 * repeat fails `PAYLOAD_SCHEMA` with a message naming BOTH offending indices.
 */
export const SynthesizeBatchSchema = z
  .object({
    nodes: z
      .array(SynthesizeSchema)
      .min(1, 'a batch needs >=1 node')
      .max(SYNTHESIZE_BATCH_MAX, `a batch holds at most ${SYNTHESIZE_BATCH_MAX} nodes`),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const firstIndexOf = new Map<string, number>();
    batch.nodes.forEach((entry, index) => {
      const first = firstIndexOf.get(entry.node_id);
      if (first === undefined) {
        firstIndexOf.set(entry.node_id, index);
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'node_id'],
        message: `duplicate node_id ${entry.node_id} at nodes[${first}] and nodes[${index}] — one entry per node`,
      });
    });
  });
export type SynthesizeBatch = z.infer<typeof SynthesizeBatchSchema>;

/**
 * What `kb synthesize --file` accepts: the single object (unchanged) or a batch. The
 * runtime parse path discriminates on the presence of `nodes` before parsing (so a bad
 * payload reports ITS OWN field errors rather than a union's), while this schema names
 * the accepted surface for help and drift checks.
 */
export const SynthesizePayloadSchema = z.union([SynthesizeBatchSchema, SynthesizeSchema]);
export type SynthesizePayload = z.infer<typeof SynthesizePayloadSchema>;

/**
 * NODE APPLY manifest (04 §2). A forest of node specs applied atomically. Each spec
 * carries a manifest-local `ref` (unique within the manifest) used to map ref→nodeId
 * in the receipt, an optional explicit `slug` (defaults to a slugified title), and may
 * nest `children`. Only a TOP-LEVEL spec may set `parent_id` to graft the whole forest
 * under an existing DB node; a nested child inherits its parent by position, so a
 * `parent_id` on a child is rejected by `.strict()` (top-level-only parent_id).
 */
const nodeRef = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'ref must start alphanumeric and use only letters, digits, dashes, or underscores',
  );

export interface NodeManifestChild {
  ref: string;
  title: string;
  kind: NodeKind;
  slug?: string;
  children?: NodeManifestChild[];
}

// The cast bridges Zod's recursive `z.lazy` output to the hand-authored interface: under
// `exactOptionalPropertyTypes`, Zod's `.optional()` infers `slug: string | undefined`
// (key present) while the interface uses `slug?: string` (key absent) — same runtime
// shape, so the schema is annotated with the interface for ergonomic consumers.
const NodeManifestChildSchema: z.ZodType<NodeManifestChild> = z.lazy(() =>
  z
    .object({
      ref: nodeRef,
      title: z.string().min(1),
      kind: z.enum(NODE_KINDS),
      slug: z.string().min(1).optional(),
      children: z.array(NodeManifestChildSchema).optional(),
    })
    .strict(),
) as z.ZodType<NodeManifestChild>;

const NodeManifestTopSchema = z
  .object({
    ref: nodeRef,
    title: z.string().min(1),
    kind: z.enum(NODE_KINDS),
    slug: z.string().min(1).optional(),
    parent_id: zNodeId.optional(),
    children: z.array(NodeManifestChildSchema).optional(),
  })
  .strict();
export type NodeManifestTop = z.infer<typeof NodeManifestTopSchema>;

export const NodeApplySchema = z
  .object({
    nodes: z.array(NodeManifestTopSchema).min(1),
  })
  .strict();
export type NodeApply = z.infer<typeof NodeApplySchema>;

export const AnswerCheckSchema = z
  .object({
    answer: z.string().min(1),
    claim_ids: z.array(zClaimId).optional(),
  })
  .strict();
export type AnswerCheck = z.infer<typeof AnswerCheckSchema>;
