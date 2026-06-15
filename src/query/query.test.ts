import { describe, it, expect } from 'vitest';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { MemorySourceStore } from '../ingest/sourceStore.js';
import type { ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { NodeService } from '../domain/services/nodeService.js';
import type { Chunk } from '../domain/schemas/models.js';
import type { SourceId } from '../domain/ids.js';
import { search, askContext, answerCheck } from './query.js';

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

/** Full pipeline: ingest the doc, create root + leaf nodes, apply one claim. */
function seedKb(): {
  repos: Repositories;
  sourceId: SourceId;
  leafTitle: string;
  claimId: string;
} {
  const { ctx, repos } = makeCtx();
  const sourceId = ingestDoc(ctx);
  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
  const leaf = new NodeService(ctx).createNode({
    parentId: root.id,
    title: 'Token Rotation',
    kind: 'leaf',
  }).node;
  const chunk = chunkContaining(repos, sourceId, 'rotates refresh tokens');
  new ClaimService(ctx).apply({
    source_id: sourceId,
    claims: [
      {
        node_id: leaf.id,
        text: 'Refresh tokens rotate on every use.',
        claim_type: 'fact',
        confidence: 0.9,
        spans: [
          {
            chunk_id: chunk.id,
            quote: 'rotates refresh tokens on every use',
            role: 'supports',
            confidence: 0.9,
          },
        ],
      },
    ],
  });
  const claim = repos.claims.listByNode(leaf.id)[0]!;
  return { repos, sourceId, leafTitle: leaf.title, claimId: claim.id };
}

describe('search', () => {
  it('returns a chunk hit for a distinctive ingested word', () => {
    const { repos } = seedKb();
    const hits = search(repos, 'PostgreSQL', { scope: 'chunks' });
    const chunkHit = hits.find((h) => h.kind === 'chunk');
    expect(chunkHit).toBeDefined();
    expect(chunkHit?.snippet).toMatch(/PostgreSQL/);
    expect(chunkHit?.sourceId).toBeDefined();
  });

  it('returns a claim hit in claims scope after a claim is applied', () => {
    const { repos, claimId } = seedKb();
    const hits = search(repos, 'refresh tokens rotate', { scope: 'claims' });
    const claimHit = hits.find((h) => h.kind === 'claim');
    expect(claimHit).toBeDefined();
    expect(claimHit?.id).toBe(claimId);
    expect(claimHit?.title).toBe('fact');
    expect(claimHit?.snippet).toMatch(/Refresh tokens rotate/);
  });

  it('merges scopes for scope=all', () => {
    const { repos } = seedKb();
    const hits = search(repos, 'tokens', { scope: 'all' });
    expect(hits.some((h) => h.kind === 'chunk')).toBe(true);
    expect(hits.some((h) => h.kind === 'claim')).toBe(true);
  });

  it('does not throw on FTS special characters and returns results', () => {
    const { repos } = seedKb();
    // Parens/quotes/operators would be FTS syntax if not sanitized.
    expect(() => search(repos, 'tokens "AND" (rotate) NEAR:', { scope: 'chunks' })).not.toThrow();
    expect(() => search(repos, '*', { scope: 'claims' })).not.toThrow();
    const hits = search(repos, 'refresh-tokens', { scope: 'claims' });
    expect(Array.isArray(hits)).toBe(true);
  });
});

describe('askContext', () => {
  it('returns the matching claim with provenance quote and owning node title', () => {
    const { repos, claimId, leafTitle } = seedKb();
    const result = askContext(repos, 'how are refresh tokens rotated?');
    const ctx = result.claims.find((c) => c.id === claimId);
    expect(ctx).toBeDefined();
    expect(ctx?.nodeTitle).toBe(leafTitle);
    expect(ctx?.status).toBe('active');
    expect(ctx?.provenance.length).toBeGreaterThan(0);
    expect(ctx?.provenance[0]?.quote).toBe('rotates refresh tokens on every use');
    expect(ctx?.provenance[0]?.sourceTitle).toBe('Auth Service');
  });

  it('echoes the question', () => {
    const { repos } = seedKb();
    const result = askContext(repos, 'token rotation');
    expect(result.question).toBe('token rotation');
  });
});

describe('answerCheck', () => {
  it('passes for an answer that cites a real active claim', () => {
    const { repos, claimId } = seedKb();
    const answer = `Refresh tokens rotate on every use.[^${claimId}]`;
    const r = answerCheck(repos, answer);
    expect(r.ok).toBe(true);
    expect(r.citedClaims).toContain(claimId);
    expect(r.unknownCitations).toHaveLength(0);
    expect(r.inactiveCitations).toHaveLength(0);
    expect(r.uncitedSentences).toHaveLength(0);
  });

  it('fails with an unknown citation id', () => {
    const { repos } = seedKb();
    const answer = 'Tokens rotate on every use.[^clm_deadbeef]';
    const r = answerCheck(repos, answer);
    expect(r.ok).toBe(false);
    expect(r.unknownCitations).toContain('clm_deadbeef');
  });

  it('flags an uncited assertive sentence', () => {
    const { repos, claimId } = seedKb();
    const answer = `Refresh tokens rotate on every use.[^${claimId}] The system also stores sessions in a database.`;
    const r = answerCheck(repos, answer);
    expect(r.ok).toBe(false);
    expect(r.uncitedSentences.length).toBeGreaterThan(0);
    expect(r.uncitedSentences.some((s) => s.includes('stores sessions'))).toBe(true);
  });

  it('does not flag short non-assertive sentences', () => {
    const { repos, claimId } = seedKb();
    const answer = `Tokens rotate on every single use of the token.[^${claimId}] OK.`;
    const r = answerCheck(repos, answer);
    expect(r.ok).toBe(true);
    expect(r.uncitedSentences).toHaveLength(0);
  });
});
