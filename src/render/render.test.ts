import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { MemorySourceStore } from '../ingest/sourceStore.js';
import type { ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { GraphService } from '../domain/services/graphService.js';
import { NodeService } from '../domain/services/nodeService.js';
import type { Chunk } from '../domain/schemas/models.js';
import type { NodeId, SourceId } from '../domain/ids.js';
import { renderAll, writeRender, checkRender } from './render.js';

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

/** A fully-seeded KB: source, root+leaf nodes, a quote-verified claim, a synthesized leaf body. */
function seed(): { ctx: ServiceContext; repos: Repositories; sourceId: SourceId; leafId: NodeId; quote: string } {
  const { ctx, repos } = makeCtx();
  const sourceId = ingestDoc(ctx);

  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
  const leaf = new NodeService(ctx).createNode({
    parentId: root.id,
    title: 'Token Rotation',
    kind: 'leaf',
  }).node;

  const quote = 'rotates refresh tokens on every use';
  const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
  new ClaimService(ctx).apply({
    source_id: sourceId,
    claims: [
      {
        node_id: leaf.id,
        text: 'Refresh tokens rotate on every use.',
        claim_type: 'fact',
        confidence: 0.9,
        spans: [{ chunk_id: chunk.id, quote, role: 'supports', confidence: 0.9 }],
      },
    ],
  });
  const claim = repos.claims.listByNode(leaf.id)[0]!;

  // Synthesize the leaf body with an inline citation to that claim.
  new NodeService(ctx).synthesize({
    node_id: leaf.id,
    body_md: `Refresh tokens rotate on every use.[^${claim.id}]`,
    summary: 'How refresh tokens rotate.',
  });

  // A small knowledge graph so index + graph docs are exercised.
  const pgChunk = chunkContaining(repos, sourceId, 'PostgreSQL');
  new GraphService(ctx).apply({
    source_id: sourceId,
    entities: [
      { type: 'Service', name: 'auth service', description: 'the auth service', confidence: 0.9, evidence: [] },
      { type: 'DataStore', name: 'PostgreSQL', description: 'session store', confidence: 0.9, evidence: [] },
    ],
    relationships: [
      {
        type: 'stores_in',
        subject: { type: 'Service', name: 'auth service' },
        object: { type: 'DataStore', name: 'PostgreSQL' },
        description: 'sessions stored in pg',
        confidence: 0.8,
        evidence: [{ chunk_id: pgChunk.id, quote: 'Sessions are stored in PostgreSQL', role: 'supports', confidence: 0.8 }],
      },
    ],
  });

  return { ctx, repos, sourceId, leafId: leaf.id, quote };
}

describe('renderAll', () => {
  it('is deterministic: two calls produce deep-equal output', () => {
    const { repos } = seed();
    const a = renderAll(repos);
    const b = renderAll(repos);
    expect(a).toEqual(b);
    // Content hashes are sha256 of the body.
    for (const f of a) expect(f.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders the leaf body with the claim quote in a footnote definition', () => {
    const { repos, quote } = seed();
    const files = renderAll(repos);

    // Leaf path: root slug "auth" has a child, so root is index.md; the leaf has
    // no children, so it is a flat .md under the root's directory.
    const leaf = files.find((f) => f.path === 'kb/synthesis/auth/token-rotation.md');
    expect(leaf).toBeDefined();
    expect(leaf!.body).toContain('# Token Rotation');
    expect(leaf!.body).toContain('## Sources');
    // Footnote definition carries the EXACT verified quote.
    expect(leaf!.body).toContain(`“${quote}”`);
    expect(leaf!.body).toMatch(/\[\^clm_[0-9a-f]+\]: Refresh tokens rotate on every use\. —/);
  });

  it('renders the root as a parent index linking the leaf subtopic', () => {
    const { repos } = seed();
    const files = renderAll(repos);
    const root = files.find((f) => f.path === 'kb/synthesis/auth/index.md');
    expect(root).toBeDefined();
    expect(root!.body).toContain('## Subtopics');
    expect(root!.body).toContain('[Token Rotation](token-rotation.md)');
  });

  it('lists the source in index.md and links the graph docs', () => {
    const { repos } = seed();
    const files = renderAll(repos);
    const index = files.find((f) => f.path === 'kb/index.md');
    expect(index).toBeDefined();
    expect(index!.body).toContain('# Knowledge Base Index');
    expect(index!.body).toContain('Auth Service'); // source title
    expect(index!.body).toContain('[Entities](graph/entities.md)');
    expect(index!.body).toContain('[Auth](synthesis/auth/index.md)'); // root synthesis link
  });

  it('renders entities grouped by type and relationships with resolved names', () => {
    const { repos } = seed();
    const files = renderAll(repos);
    const entities = files.find((f) => f.path === 'kb/graph/entities.md')!;
    expect(entities.body).toContain('**auth service** (Service)');
    expect(entities.body).toContain('**PostgreSQL** (DataStore)');

    const rels = files.find((f) => f.path === 'kb/graph/relationships.md')!;
    expect(rels.body).toContain('auth service **stores_in** PostgreSQL');
    expect(rels.body).toContain('sessions stored in pg');
    expect(rels.body).toContain('“Sessions are stored in PostgreSQL”');
    expect(rels.body).toContain('(Auth Service, sources/');
  });

  it('writes "_No open questions._" when no claim is conflicted', () => {
    const { repos } = seed();
    const oq = renderAll(repos).find((f) => f.path === 'kb/open-questions.md')!;
    expect(oq.body).toContain('_No open questions._');
  });

  it('renders open_question claims in open-questions.md', () => {
    const { ctx, repos, sourceId, leafId } = seed();
    const chunk = chunkContaining(repos, sourceId, 'PostgreSQL');
    new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: leafId,
          text: 'Should sessions stay in PostgreSQL?',
          claim_type: 'open_question',
          confidence: 0.7,
          spans: [{ chunk_id: chunk.id, quote: 'Sessions are stored in PostgreSQL', role: 'supports', confidence: 0.7 }],
        },
      ],
    });

    const oq = renderAll(repos).find((f) => f.path === 'kb/open-questions.md')!;
    expect(oq.body).toContain('Should sessions stay in PostgreSQL?');
    expect(oq.body).toContain('Node: Token Rotation');
    expect(oq.body).toContain('“Sessions are stored in PostgreSQL”');
  });

  it('renders conflicted claims in open-questions.md', () => {
    const { repos, leafId } = seed();
    const claim = repos.claims.listByNode(leafId)[0]!;
    repos.claims.setStatus(claim.id, 'conflicted', null, '2026-06-14T00:01:00.000Z');

    const oq = renderAll(repos).find((f) => f.path === 'kb/open-questions.md')!;
    expect(oq.body).toContain('Refresh tokens rotate on every use.');
    expect(oq.body).toContain('Status: conflicted');
  });
});

describe('writeRender + checkRender', () => {
  it('writes files, reports all ok, and detects drift on mutation', () => {
    const { repos } = seed();
    const root = mkdtempSync(join(tmpdir(), 'kb-render-'));
    try {
      const files = renderAll(repos);
      const { written } = writeRender(root, files, repos, '2026-06-14T12:00:00.000Z');
      expect(written).toBe(files.length);

      const fresh = checkRender(root, files);
      expect(fresh.every((c) => c.status === 'ok')).toBe(true);

      // rendered_files bookkeeping recorded each path with the body hash.
      const leafPath = 'kb/synthesis/auth/token-rotation.md';
      const leafFile = files.find((f) => f.path === leafPath)!;
      expect(repos.renderedFiles.get(leafPath)?.contentHash).toBe(leafFile.contentHash);

      // Mutate one file on disk -> that path drifts, the rest stay ok.
      writeFileSync(join(root, leafPath), 'tampered\n');
      const after = checkRender(root, files);
      const drifted = after.find((c) => c.path === leafPath)!;
      expect(drifted.status).toBe('drifted');
      expect(after.filter((c) => c.status === 'drifted')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports missing for an expected file that was never written', () => {
    const { repos } = seed();
    const root = mkdtempSync(join(tmpdir(), 'kb-render-'));
    try {
      const files = renderAll(repos);
      // Do not write anything.
      const result = checkRender(root, files);
      expect(result.every((c) => c.status === 'missing')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
