import { z } from 'zod';
import {
  SOURCE_STATUSES, NODE_KINDS, CLAIM_TYPES, CLAIM_STATUSES, SPAN_ROLES, EXTRACTORS,
} from '../domain/schemas/enums.js';
import {
  zSourceId, zChunkId, zSpanId, zNodeId, zClaimId, zEntityId, zRelationshipId,
} from '../domain/schemas/zodId.js';
import type {
  Source, SourceText, Chunk, Span, Node, Claim, ClaimSpan, Entity, Relationship,
} from '../domain/schemas/models.js';

/**
 * Zod schemas that validate raw DB rows (snake_case) and map them to typed
 * camelCase domain models. This is the only place raw rows are touched; a schema
 * violation here means DB corruption or drift and throws loudly.
 */

const intBool = z.number().int().transform((n) => n === 1);
const nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable();

export const SourceRow = z
  .object({
    id: zSourceId,
    sha256: z.string(),
    stored_path: z.string(),
    original_path: nullable(z.string()),
    title: z.string(),
    media_type: z.string(),
    byte_size: z.number().int(),
    source_date: nullable(z.string()),
    author: nullable(z.string()),
    version_label: nullable(z.string()),
    supersedes_source_id: nullable(zSourceId),
    status: z.enum(SOURCE_STATUSES),
    metadata_json: z.string(),
    ingested_at: z.string(),
  })
  .transform((r): Source => ({
    id: r.id,
    sha256: r.sha256,
    storedPath: r.stored_path,
    originalPath: r.original_path,
    title: r.title,
    mediaType: r.media_type,
    byteSize: r.byte_size,
    sourceDate: r.source_date,
    author: r.author,
    versionLabel: r.version_label,
    supersedesSourceId: r.supersedes_source_id,
    status: r.status,
    metadataJson: r.metadata_json,
    ingestedAt: r.ingested_at,
  }));

export const SourceTextRow = z
  .object({
    source_id: zSourceId,
    extractor: z.string(),
    extractor_version: z.number().int(),
    text: z.string(),
    text_hash: z.string(),
  })
  .transform((r): SourceText => ({
    sourceId: r.source_id,
    extractor: r.extractor,
    extractorVersion: r.extractor_version,
    text: r.text,
    textHash: r.text_hash,
  }));

export const ChunkRow = z
  .object({
    id: zChunkId,
    source_id: zSourceId,
    chunk_index: z.number().int(),
    heading_path: z.string(),
    text: z.string(),
    char_start: z.number().int(),
    char_end: z.number().int(),
    token_estimate: z.number().int(),
    content_hash: z.string(),
    chunker_version: z.number().int(),
  })
  .transform((r): Chunk => ({
    id: r.id,
    sourceId: r.source_id,
    chunkIndex: r.chunk_index,
    headingPath: r.heading_path,
    text: r.text,
    charStart: r.char_start,
    charEnd: r.char_end,
    tokenEstimate: r.token_estimate,
    contentHash: r.content_hash,
    chunkerVersion: r.chunker_version,
  }));

export const SpanRow = z
  .object({
    id: zSpanId,
    source_id: zSourceId,
    chunk_id: nullable(zChunkId),
    char_start: z.number().int(),
    char_end: z.number().int(),
    quote: z.string(),
    quote_hash: z.string(),
    created_at: z.string(),
  })
  .transform((r): Span => ({
    id: r.id,
    sourceId: r.source_id,
    chunkId: r.chunk_id,
    charStart: r.char_start,
    charEnd: r.char_end,
    quote: r.quote,
    quoteHash: r.quote_hash,
    createdAt: r.created_at,
  }));

export const NodeRow = z
  .object({
    id: zNodeId,
    parent_id: nullable(zNodeId),
    slug: z.string(),
    title: z.string(),
    kind: z.enum(NODE_KINDS),
    depth: z.number().int(),
    sort_order: z.number().int(),
    summary: z.string(),
    body_md: z.string(),
    body_hash: z.string(),
    is_stale: intBool,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r): Node => ({
    id: r.id,
    parentId: r.parent_id,
    slug: r.slug,
    title: r.title,
    kind: r.kind,
    depth: r.depth,
    sortOrder: r.sort_order,
    summary: r.summary,
    bodyMd: r.body_md,
    bodyHash: r.body_hash,
    isStale: r.is_stale,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

export const ClaimRow = z
  .object({
    id: zClaimId,
    node_id: nullable(zNodeId),
    text: z.string(),
    normalized_text: z.string(),
    claim_type: z.enum(CLAIM_TYPES),
    confidence: z.number(),
    status: z.enum(CLAIM_STATUSES),
    superseded_by_claim_id: nullable(zClaimId),
    first_seen_source_id: zSourceId,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r): Claim => ({
    id: r.id,
    nodeId: r.node_id,
    text: r.text,
    normalizedText: r.normalized_text,
    claimType: r.claim_type,
    confidence: r.confidence,
    status: r.status,
    supersededByClaimId: r.superseded_by_claim_id,
    firstSeenSourceId: r.first_seen_source_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

export const ClaimSpanRow = z
  .object({
    claim_id: zClaimId,
    span_id: zSpanId,
    role: z.enum(SPAN_ROLES),
    confidence: z.number(),
    extractor: z.enum(EXTRACTORS),
  })
  .transform((r): ClaimSpan => ({
    claimId: r.claim_id,
    spanId: r.span_id,
    role: r.role,
    confidence: r.confidence,
    extractor: r.extractor,
  }));

export const EntityRow = z
  .object({
    id: zEntityId,
    type: z.string(),
    canonical_name: z.string(),
    normalized_name: z.string(),
    description: z.string(),
    confidence: z.number(),
    first_seen_source_id: nullable(zSourceId),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r): Entity => ({
    id: r.id,
    type: r.type,
    canonicalName: r.canonical_name,
    normalizedName: r.normalized_name,
    description: r.description,
    confidence: r.confidence,
    firstSeenSourceId: r.first_seen_source_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

export const RelationshipRow = z
  .object({
    id: zRelationshipId,
    type: z.string(),
    subject_entity_id: zEntityId,
    object_entity_id: zEntityId,
    description: z.string(),
    confidence: z.number(),
    status: z.enum(CLAIM_STATUSES),
    first_seen_source_id: nullable(zSourceId),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r): Relationship => ({
    id: r.id,
    type: r.type,
    subjectEntityId: r.subject_entity_id,
    objectEntityId: r.object_entity_id,
    description: r.description,
    confidence: r.confidence,
    status: r.status,
    firstSeenSourceId: r.first_seen_source_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
