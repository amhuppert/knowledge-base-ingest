/**
 * Branded id types. At runtime these are plain strings; the brand exists only at
 * the type level so that, e.g., a {@link ChunkId} cannot be passed where a
 * {@link SourceId} is expected. Construct them exclusively through the `make*`
 * helpers (validating) or the deriver in `algorithms/idDeriver.ts`.
 */

// Phantom property (never present at runtime) — nameable across modules so these
// branded types can appear in exported declarations.
type Brand<T, B extends string> = T & { readonly __kbBrand: B };

export type SourceId = Brand<string, 'SourceId'>;
export type ChunkId = Brand<string, 'ChunkId'>;
export type SpanId = Brand<string, 'SpanId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type ClaimId = Brand<string, 'ClaimId'>;
export type EntityId = Brand<string, 'EntityId'>;
export type RelationshipId = Brand<string, 'RelationshipId'>;

export type AnyId =
  | SourceId
  | ChunkId
  | SpanId
  | NodeId
  | ClaimId
  | EntityId
  | RelationshipId;

const PREFIXES = {
  SourceId: 'src_',
  ChunkId: 'chk_',
  SpanId: 'spn_',
  NodeId: 'nod_',
  ClaimId: 'clm_',
  EntityId: 'ent_',
  RelationshipId: 'rel_',
} as const;

type IdName = keyof typeof PREFIXES;

function make<N extends IdName>(name: N, raw: string): Brand<string, N> {
  const prefix = PREFIXES[name];
  if (typeof raw !== 'string' || raw.length <= prefix.length || !raw.startsWith(prefix)) {
    throw new Error(`Invalid ${name}: expected "${prefix}…", got ${JSON.stringify(raw)}`);
  }
  return raw as Brand<string, N>;
}

export const makeSourceId = (raw: string): SourceId => make('SourceId', raw);
export const makeChunkId = (raw: string): ChunkId => make('ChunkId', raw);
export const makeSpanId = (raw: string): SpanId => make('SpanId', raw);
export const makeNodeId = (raw: string): NodeId => make('NodeId', raw);
export const makeClaimId = (raw: string): ClaimId => make('ClaimId', raw);
export const makeEntityId = (raw: string): EntityId => make('EntityId', raw);
export const makeRelationshipId = (raw: string): RelationshipId => make('RelationshipId', raw);

export const ID_PREFIXES = PREFIXES;
