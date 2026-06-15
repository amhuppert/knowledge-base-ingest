import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { ClaimService } from './claimService.js';
import { GraphService } from './graphService.js';
import { NodeService } from './nodeService.js';
import type { Chunk } from '../schemas/models.js';
import type { SourceId } from '../ids.js';

const DOC = [
  '# Auth Service',
  '',
  '## Token Rotation',
  '',
  'The auth service rotates refresh tokens on every use and revokes the previous token.',
  '',
  '## Storage',
  '',
  'Sessions are stored in PostgreSQL.',
].join('\n');

function makeCtx(): { ctx: ServiceContext; repos: Repositories } {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  let tick = 0;
  const ctx: ServiceContext = {
    repos,
    store: new MemorySourceStore(),
    now: () => `2026-06-14T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  return { ctx, repos };
}

function ingestDoc(ctx: ServiceContext): SourceId {
  const r = new IngestService(ctx).ingest({
    bytes: Buffer.from(DOC, 'utf8'),
    ext: 'md',
    mediaType: 'text/markdown',
    originalPath: 'auth.md',
  });
  return r.source.id;
}

function chunkContaining(repos: Repositories, sourceId: SourceId, needle: string): Chunk {
  const c = repos.chunks.listBySource(sourceId).find((ch) => ch.text.includes(needle));
  if (!c) throw new Error(`no chunk contains ${needle}`);
  return c;
}

describe('IngestService', () => {
  it('registers a source with canonical text and chunks', () => {
    const { ctx, repos } = makeCtx();
    const r = new IngestService(ctx).ingest({
      bytes: Buffer.from(DOC, 'utf8'),
      ext: 'md',
      mediaType: 'text/markdown',
      originalPath: 'auth.md',
    });
    expect(r.status).toBe('new');
    expect(r.source.title).toBe('Auth Service');
    expect(repos.sourceTexts.get(r.source.id)?.text).toBe(DOC);
    expect(repos.chunks.listBySource(r.source.id).length).toBeGreaterThan(0);
  });

  it('is idempotent on identical bytes (no duplicate source)', () => {
    const { ctx, repos } = makeCtx();
    const a = ingestDoc(ctx);
    const second = new IngestService(ctx).ingest({
      bytes: Buffer.from(DOC, 'utf8'),
      ext: 'md',
      mediaType: 'text/markdown',
    });
    expect(second.status).toBe('duplicate');
    expect(second.source.id).toBe(a);
    expect(repos.sources.listAll()).toHaveLength(1);
  });

  it('rejects binary input', () => {
    const { ctx } = makeCtx();
    expect(() =>
      new IngestService(ctx).ingest({
        bytes: Buffer.from([0x00, 0x01, 0x02]),
        ext: 'bin',
        mediaType: 'application/octet-stream',
      }),
    ).toThrow(/UTF-8 text/);
  });
});

describe('ClaimService', () => {
  function setup() {
    const { ctx, repos } = makeCtx();
    const sourceId = ingestDoc(ctx);
    const root = new NodeService(ctx).createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
    const leaf = new NodeService(ctx).createNode({
      parentId: root.id,
      title: 'Token Rotation',
      kind: 'leaf',
    }).node;
    return { ctx, repos, sourceId, rootId: root.id, leafId: leaf.id };
  }

  it('persists claims with quote-verified provenance and marks the node + ancestors stale', () => {
    const { ctx, repos, sourceId, rootId, leafId } = setup();
    const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
    const res = new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Refresh tokens rotate on every use.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunk.id, quote: 'rotates refresh tokens on every use', role: 'supports', confidence: 0.9 }],
        },
      ],
    });
    expect(res.claimsCreated).toBe(1);
    expect(res.spansCreated).toBe(1);
    const claim = repos.claims.listByNode(leafId)[0]!;
    expect(repos.claimSpans.spansForClaim(claim.id)[0]?.quote).toBe('rotates refresh tokens on every use');
    expect(repos.nodes.getById(leafId)?.isStale).toBe(true);
    expect(repos.nodes.getById(rootId)?.isStale).toBe(true);
  });

  it('ROLLS BACK the whole batch if any quote fails verification (atomicity)', () => {
    const { ctx, repos, sourceId, leafId } = setup();
    const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
    expect(() =>
      new ClaimService(ctx).apply({
        source_id: sourceId,
        claims: [
          {
            node_id: leafId,
            text: 'Good claim.',
            claim_type: 'fact',
            confidence: 0.9,
            spans: [{ chunk_id: chunk.id, quote: 'rotates refresh tokens', role: 'supports', confidence: 0.9 }],
          },
          {
            node_id: leafId,
            text: 'Hallucinated claim.',
            claim_type: 'fact',
            confidence: 0.9,
            spans: [{ chunk_id: chunk.id, quote: 'this text is not in the source', role: 'supports', confidence: 0.9 }],
          },
        ],
      }),
    ).toThrow(/quote not found/);
    // Nothing persisted — the good claim was rolled back with the bad one.
    expect(repos.claims.listByNode(leafId)).toHaveLength(0);
    expect(repos.spans.listBySource(sourceId)).toHaveLength(0);
  });

  it('rejects a paraphrased quote (anti-hallucination)', () => {
    const { ctx, repos, sourceId, leafId } = setup();
    const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
    expect(() =>
      new ClaimService(ctx).apply({
        source_id: sourceId,
        claims: [
          {
            node_id: leafId,
            text: 'Paraphrase.',
            claim_type: 'fact',
            confidence: 0.9,
            spans: [{ chunk_id: chunk.id, quote: 'rotates the refresh token', role: 'supports', confidence: 0.9 }],
          },
        ],
      }),
    ).toThrow(/quote not found/);
  });

  it('is idempotent: re-applying the same claim updates rather than duplicates', () => {
    const { ctx, repos, sourceId, leafId } = setup();
    const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
    const payload = {
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Refresh tokens rotate on every use.',
          claim_type: 'fact' as const,
          confidence: 0.9,
          spans: [{ chunk_id: chunk.id, quote: 'rotates refresh tokens', role: 'supports' as const, confidence: 0.9 }],
        },
      ],
    };
    new ClaimService(ctx).apply(payload);
    const second = new ClaimService(ctx).apply(payload);
    expect(second.claimsCreated).toBe(0);
    expect(second.claimsUpdated).toBe(1);
    expect(repos.claims.listByNode(leafId)).toHaveLength(1);
    expect(repos.spans.listBySource(sourceId)).toHaveLength(1);
  });
});

describe('GraphService', () => {
  it('persists entities and relationships with provenance, idempotently', () => {
    const { ctx, repos } = makeCtx();
    const sourceId = ingestDoc(ctx);
    const chunk = chunkContaining(repos, sourceId, 'PostgreSQL');
    const payload = {
      source_id: sourceId,
      entities: [
        { type: 'Service', name: 'auth service', description: 'auth', confidence: 0.9, evidence: [] },
        { type: 'DataStore', name: 'PostgreSQL', description: 'db', confidence: 0.9, evidence: [] },
      ],
      relationships: [
        {
          type: 'stores_in',
          subject: { type: 'Service', name: 'auth service' },
          object: { type: 'DataStore', name: 'PostgreSQL' },
          description: 'sessions stored in pg',
          confidence: 0.8,
          evidence: [{ chunk_id: chunk.id, quote: 'Sessions are stored in PostgreSQL', role: 'supports' as const, confidence: 0.8 }],
        },
      ],
    };
    const r = new GraphService(ctx).apply(payload);
    expect(r.entitiesCreated).toBe(2);
    expect(r.relationshipsCreated).toBe(1);
    expect(repos.relationships.listAll()).toHaveLength(1);

    const again = new GraphService(ctx).apply(payload);
    expect(again.entitiesCreated).toBe(0);
    expect(again.relationshipsCreated).toBe(0);
    expect(repos.entities.listAll()).toHaveLength(2);
  });
});

describe('NodeService.synthesize', () => {
  function setupWithClaim() {
    const { ctx, repos } = makeCtx();
    const sourceId = ingestDoc(ctx);
    const root = new NodeService(ctx).createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
    const leaf = new NodeService(ctx).createNode({ parentId: root.id, title: 'Token Rotation', kind: 'leaf' }).node;
    const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
    new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: leaf.id,
          text: 'Refresh tokens rotate on every use.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunk.id, quote: 'rotates refresh tokens', role: 'supports', confidence: 0.9 }],
        },
      ],
    });
    const claim = repos.claims.listByNode(leaf.id)[0]!;
    return { ctx, repos, rootId: root.id, leafId: leaf.id, claimId: claim.id };
  }

  it('clears stale on the synthesized leaf but leaves the still-stale root', () => {
    const { ctx, repos, rootId, leafId, claimId } = setupWithClaim();
    new NodeService(ctx).synthesize({
      node_id: leafId,
      body_md: `Refresh tokens rotate on every use.[^${claimId}]`,
    });
    expect(repos.nodes.getById(leafId)?.isStale).toBe(false);
    expect(repos.nodes.getById(rootId)?.isStale).toBe(true);
  });

  it('rejects a body that cites an unknown claim', () => {
    const { ctx, leafId } = setupWithClaim();
    expect(() =>
      new NodeService(ctx).synthesize({
        node_id: leafId,
        body_md: 'Bogus.[^clm_deadbeefdeadbeef]',
      }),
    ).toThrow(/unknown claim/);
  });
});
