/** Zod output schemas for read commands are defined in this module. */

import { z } from 'zod';
import { CLAIM_STATUSES, SOURCE_STATUSES, SPAN_ROLES } from './enums.js';
import {
  zChunkId,
  zClaimId,
  zEntityId,
  zRelationshipId,
  zSourceId,
  zSpanId,
} from './zodId.js';

const CappedIdsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    shown: z.number().int().nonnegative(),
    ids: z.array(z.string()),
  })
  .strict();

const FindingSchema = <Code extends string>(code: Code) =>
  CappedIdsSchema.extend({ code: z.literal(code) }).strict();

export const CoverageSourceReportSchema = z
  .object({
    scope: z
      .object({
        kind: z.literal('source'),
        sourceId: z.string(),
        title: z.string(),
        sourceStatus: z.enum(SOURCE_STATUSES),
        membership: z.literal('evidence-span'),
      })
      .strict(),
    chunks: z
      .object({
        total: z.number().int().nonnegative(),
        substantive: z.number().int().nonnegative(),
        cited: z.number().int().nonnegative(),
        uncited: CappedIdsSchema,
        structural: CappedIdsSchema,
      })
      .strict(),
    claims: z
      .object({
        active: z
          .object({
            total: z.number().int().nonnegative(),
            synthesized: z.number().int().nonnegative(),
            unsynthesized: CappedIdsSchema,
          })
          .strict(),
        conflicted: CappedIdsSchema,
        superseded: CappedIdsSchema,
        retracted: CappedIdsSchema,
      })
      .strict(),
    relationships: z
      .object({
        total: z.number().int().nonnegative(),
        byStatus: z
          .object(
            Object.fromEntries(
              CLAIM_STATUSES.map((status) => [status, z.number().int().nonnegative()]),
            ) as Record<(typeof CLAIM_STATUSES)[number], z.ZodNumber>,
          )
          .strict(),
      })
      .strict(),
    candidates: z
      .object({
        total: z.number().int().nonnegative(),
        shown: z.number().int().nonnegative(),
        claimIds: z.array(zClaimId),
      })
      .strict(),
    findings: z.tuple([
      FindingSchema('SOURCE_NO_CLAIMS'),
      FindingSchema('CHUNK_UNCITED'),
      FindingSchema('CLAIM_NOT_SYNTHESIZED'),
      FindingSchema('OPEN_QUESTION_NOT_SYNTHESIZED'),
    ]),
  })
  .strict();

const RelationshipListEntitySchema = z.object({
  id: zEntityId,
  type: z.string(),
  canonicalName: z.string(),
});

const RelationshipListSourceSchema = z.object({
  id: zSourceId,
  title: z.string(),
  status: z.enum(SOURCE_STATUSES),
});

const RelationshipListEvidenceSchema = z.object({
  spanId: zSpanId,
  role: z.enum(SPAN_ROLES),
  chunkId: zChunkId,
  sourceId: zSourceId,
  sourceTitle: z.string(),
  sourceStatus: z.enum(SOURCE_STATUSES),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  quote: z.string(),
  matchesSourceScope: z.boolean().optional(),
});

/** Runtime contract for the successful `kb relationship list` data payload. */
export const RelationshipListSchema = z.object({
  filter: z.object({
    sourceId: zSourceId.optional(),
    entityId: zEntityId.optional(),
    type: z.string().optional(),
    status: z.enum(CLAIM_STATUSES).optional(),
  }),
  relationships: z.array(
    z.object({
      id: zRelationshipId,
      type: z.string(),
      status: z.enum(CLAIM_STATUSES),
      description: z.string(),
      confidence: z.number(),
      firstSeenSource: RelationshipListSourceSchema.nullable(),
      subject: RelationshipListEntitySchema,
      object: RelationshipListEntitySchema,
      evidence: z.array(RelationshipListEvidenceSchema),
    }),
  ),
  totals: z.object({
    relationships: z.number().int().nonnegative(),
    evidenceLinks: z.number().int().nonnegative(),
    matchingEvidenceLinks: z.number().int().nonnegative().optional(),
    byStatus: z.object({
      active: z.number().int().nonnegative(),
      superseded: z.number().int().nonnegative(),
      conflicted: z.number().int().nonnegative(),
      retracted: z.number().int().nonnegative(),
    }),
    byType: z.record(z.number().int().nonnegative()),
  }),
});
