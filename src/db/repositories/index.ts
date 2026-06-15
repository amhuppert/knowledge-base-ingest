import type { Db } from '../connection.js';
import { SourceRepo, SourceTextRepo, ChunkRepo } from './sources.js';
import { SpanRepo, ClaimSpanRepo, RelationshipSpanRepo } from './provenance.js';
import { NodeRepo, ClaimRepo } from './synthesis.js';
import { EntityRepo, RelationshipRepo } from './graph.js';
import { ChangelogRepo, RenderedFileRepo } from './ops.js';

/** All repositories for a connection, constructed once and passed to services. */
export class Repositories {
  readonly sources: SourceRepo;
  readonly sourceTexts: SourceTextRepo;
  readonly chunks: ChunkRepo;
  readonly spans: SpanRepo;
  readonly claimSpans: ClaimSpanRepo;
  readonly relationshipSpans: RelationshipSpanRepo;
  readonly nodes: NodeRepo;
  readonly claims: ClaimRepo;
  readonly entities: EntityRepo;
  readonly relationships: RelationshipRepo;
  readonly changelog: ChangelogRepo;
  readonly renderedFiles: RenderedFileRepo;

  constructor(readonly db: Db) {
    this.sources = new SourceRepo(db);
    this.sourceTexts = new SourceTextRepo(db);
    this.chunks = new ChunkRepo(db);
    this.spans = new SpanRepo(db);
    this.claimSpans = new ClaimSpanRepo(db);
    this.relationshipSpans = new RelationshipSpanRepo(db);
    this.nodes = new NodeRepo(db);
    this.claims = new ClaimRepo(db);
    this.entities = new EntityRepo(db);
    this.relationships = new RelationshipRepo(db);
    this.changelog = new ChangelogRepo(db);
    this.renderedFiles = new RenderedFileRepo(db);
  }

  /** Run `fn` inside a single transaction with BEGIN IMMEDIATE (write lock taken up front). */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
}

export * from './sources.js';
export * from './provenance.js';
export * from './synthesis.js';
export * from './graph.js';
export * from './ops.js';
