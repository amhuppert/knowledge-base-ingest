import { z } from 'zod';
import { CLAIM_TYPES, SPAN_ROLES } from './enums.js';
import { zSourceId, zChunkId, zNodeId, zClaimId } from './zodId.js';

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

export const EntityInputSchema = EntityRefSchema.extend({
  description: z.string().default(''),
  confidence: confidence.default(0.8),
  evidence: z.array(SpanRefSchema).default([]),
}).strict();
export type EntityInput = z.infer<typeof EntityInputSchema>;

export const RelationshipInputSchema = z
  .object({
    type: z.string().min(1),
    subject: EntityRefSchema,
    object: EntityRefSchema,
    description: z.string().default(''),
    confidence: confidence.default(0.8),
    evidence: z.array(SpanRefSchema).min(1, 'every relationship needs >=1 provenance span'),
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

export const SynthesizeSchema = z
  .object({
    node_id: zNodeId,
    title: z.string().min(1).optional(),
    summary: z.string().optional(),
    body_md: z.string(),
  })
  .strict();
export type Synthesize = z.infer<typeof SynthesizeSchema>;

export const AnswerCheckSchema = z
  .object({
    answer: z.string().min(1),
    claim_ids: z.array(zClaimId).optional(),
  })
  .strict();
export type AnswerCheck = z.infer<typeof AnswerCheckSchema>;
