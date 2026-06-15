import type {
  SourceId, ChunkId, SpanId, NodeId, ClaimId, EntityId, RelationshipId,
} from '../ids.js';
import type {
  SourceStatus, NodeKind, ClaimType, ClaimStatus, SpanRole, Extractor,
} from './enums.js';

/** Typed domain models. Repositories return these; nothing past the repo layer sees raw rows. */

export interface Source {
  id: SourceId;
  sha256: string;
  storedPath: string;
  originalPath: string | null;
  title: string;
  mediaType: string;
  byteSize: number;
  sourceDate: string | null;
  author: string | null;
  versionLabel: string | null;
  supersedesSourceId: SourceId | null;
  status: SourceStatus;
  metadataJson: string;
  ingestedAt: string;
}

export interface SourceText {
  sourceId: SourceId;
  extractor: string;
  extractorVersion: number;
  text: string;
  textHash: string;
}

export interface Chunk {
  id: ChunkId;
  sourceId: SourceId;
  chunkIndex: number;
  headingPath: string;
  text: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  contentHash: string;
  chunkerVersion: number;
}

export interface Span {
  id: SpanId;
  sourceId: SourceId;
  chunkId: ChunkId | null;
  charStart: number;
  charEnd: number;
  quote: string;
  quoteHash: string;
  createdAt: string;
}

export interface Node {
  id: NodeId;
  parentId: NodeId | null;
  slug: string;
  title: string;
  kind: NodeKind;
  depth: number;
  sortOrder: number;
  summary: string;
  bodyMd: string;
  bodyHash: string;
  isStale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Claim {
  id: ClaimId;
  nodeId: NodeId | null;
  text: string;
  normalizedText: string;
  claimType: ClaimType;
  confidence: number;
  status: ClaimStatus;
  supersededByClaimId: ClaimId | null;
  firstSeenSourceId: SourceId;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimSpan {
  claimId: ClaimId;
  spanId: SpanId;
  role: SpanRole;
  confidence: number;
  extractor: Extractor;
}

export interface Entity {
  id: EntityId;
  type: string;
  canonicalName: string;
  normalizedName: string;
  description: string;
  confidence: number;
  firstSeenSourceId: SourceId | null;
  createdAt: string;
  updatedAt: string;
}

export interface Relationship {
  id: RelationshipId;
  type: string;
  subjectEntityId: EntityId;
  objectEntityId: EntityId;
  description: string;
  confidence: number;
  status: ClaimStatus;
  firstSeenSourceId: SourceId | null;
  createdAt: string;
  updatedAt: string;
}
