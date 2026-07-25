import { describe, it, expect } from 'vitest';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { MemorySourceStore } from '../ingest/sourceStore.js';
import type { ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { GraphService } from '../domain/services/graphService.js';
import { NodeService } from '../domain/services/nodeService.js';
import { GraphApplySchema } from '../domain/schemas/agent.js';
import type { Repositories as Repos } from '../db/repositories/index.js';
import type { SourceId, ChunkId } from '../domain/ids.js';
import { snapshotJson, snapshotKb } from './snapshot.js';

const DOC = [
  '# Service',
  '',
  '## Tokens',
  '',
  'The service rotates refresh tokens on every use.',
  '',
  '## Storage',
  '',
  'Sessions are stored in PostgreSQL by the Gateway service.',
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

function chunkId(repos: Repos, sourceId: SourceId, needle: string): ChunkId {
  return repos.chunks.listBySource(sourceId).find((c) => c.text.includes(needle))!.id;
}

/** Assemble a small KB; `order` picks which of two same-knowledge claim orders to apply. */
function build(order: 'ab' | 'ba'): Repositories {
  const { ctx, repos } = makeCtx();
  const src = new IngestService(ctx).ingest({ bytes: Buffer.from(DOC, 'utf8'), ext: 'md', mediaType: 'text/markdown' }).source.id;
  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Root', kind: 'root' }).node;
  const tokens = new NodeService(ctx).createNode({ parentId: root.id, title: 'Tokens', kind: 'leaf' }).node;
  const storage = new NodeService(ctx).createNode({ parentId: root.id, title: 'Storage', kind: 'leaf' }).node;

  const claimA = {
    source_id: src,
    claims: [
      { node_id: tokens.id, text: 'Refresh tokens rotate on every use.', claim_type: 'fact' as const, confidence: 0.9,
        spans: [{ chunk_id: chunkId(repos, src, 'rotates refresh tokens'), quote: 'rotates refresh tokens on every use', role: 'supports' as const, confidence: 0.9 }] },
    ],
  };
  const claimB = {
    source_id: src,
    claims: [
      { node_id: storage.id, text: 'Sessions are stored in PostgreSQL.', claim_type: 'fact' as const, confidence: 0.9,
        spans: [{ chunk_id: chunkId(repos, src, 'PostgreSQL'), quote: 'Sessions are stored in PostgreSQL', role: 'supports' as const, confidence: 0.9 }] },
    ],
  };
  const svc = new ClaimService(ctx);
  if (order === 'ab') { svc.apply(claimA); svc.apply(claimB); } else { svc.apply(claimB); svc.apply(claimA); }

  new GraphService(ctx).apply(
    GraphApplySchema.parse({
      source_id: src,
      entities: [{ type: 'Service', name: 'Gateway service', description: 'Edge service.' }],
      relationships: [
        {
          type: 'stores_in',
          subject: { type: 'Service', name: 'Gateway service' },
          object: { type: 'DataStore', name: 'PostgreSQL' },
          description: 'stores sessions',
          evidence: [{ chunk_id: chunkId(repos, src, 'PostgreSQL'), quote: 'Sessions are stored in PostgreSQL by the Gateway service', role: 'supports' }],
        },
      ],
    }),
  );

  new NodeService(ctx).synthesize({ node_id: tokens.id, body_md: `Rotation.[^${repos.claims.listByNode(tokens.id)[0]!.id}]` });
  new NodeService(ctx).synthesize({ node_id: storage.id, body_md: `Storage.[^${repos.claims.listByNode(storage.id)[0]!.id}]` });
  new NodeService(ctx).synthesize({ node_id: root.id, body_md: 'Overview.' });
  return repos;
}

describe('kb-snapshot', () => {
  it('is deterministic across two runs of the same KB', () => {
    const repos = build('ab');
    expect(snapshotJson(repos)).toBe(snapshotJson(repos));
  });

  it('depends only on knowledge, not on insertion order or ids/timestamps', () => {
    // Same knowledge, claims applied in opposite order → byte-identical snapshot.
    expect(snapshotJson(build('ab'))).toBe(snapshotJson(build('ba')));
  });

  it('excludes timestamps, changelog, and render bookkeeping', () => {
    const json = snapshotJson(build('ab'));
    expect(json).not.toMatch(/2026-06-14/); // injected clock never leaks
    expect(json).not.toMatch(/createdAt|updatedAt|ingestedAt|changelog|renderedFiles|bodyHash|sortOrder/);
  });

  it('captures the semantic shape (sources, nodes, claims with quotes, graph)', () => {
    const snap = snapshotKb(build('ab'));
    expect(snap.sources).toHaveLength(1);
    expect(snap.nodes.map((n) => n.slugPath)).toEqual(['root', 'root/storage', 'root/tokens']);
    expect(snap.claims.find((c) => c.ownerSlugPath === 'root/tokens')?.quotes).toEqual(['rotates refresh tokens on every use']);
    expect(snap.entities.some((e) => e.name === 'Gateway service')).toBe(true);
    expect(snap.relationships[0]?.quotes[0]).toContain('Sessions are stored in PostgreSQL');
  });
});
