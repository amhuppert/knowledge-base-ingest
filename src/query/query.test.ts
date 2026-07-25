import { describe, it, expect } from 'vitest';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { MemorySourceStore } from '../ingest/sourceStore.js';
import type { ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { NodeService } from '../domain/services/nodeService.js';
import { GraphService } from '../domain/services/graphService.js';
import type { Chunk, Claim } from '../domain/schemas/models.js';
import type { SourceId, NodeId } from '../domain/ids.js';
import { makeClaimId } from '../domain/ids.js';
import { DomainIssueError } from '../domain/issueCodes.js';
import { search, askContext, answerCheck, type SearchResult } from './query.js';

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
    const { hits } = search(repos, 'PostgreSQL', { scope: 'chunks' });
    const chunkHit = hits.find((h) => h.kind === 'chunk');
    expect(chunkHit).toBeDefined();
    expect(chunkHit?.snippet).toMatch(/PostgreSQL/);
    expect(chunkHit?.sourceId).toBeDefined();
  });

  it('returns a claim hit in claims scope after a claim is applied', () => {
    const { repos, claimId } = seedKb();
    const { hits } = search(repos, 'refresh tokens rotate', { scope: 'claims' });
    const claimHit = hits.find((h) => h.kind === 'claim');
    expect(claimHit).toBeDefined();
    expect(claimHit?.id).toBe(claimId);
    expect(claimHit?.title).toBe('fact');
    expect(claimHit?.snippet).toMatch(/Refresh tokens rotate/);
  });

  it('merges scopes for scope=all', () => {
    const { repos } = seedKb();
    const { hits } = search(repos, 'tokens', { scope: 'all' });
    expect(hits.some((h) => h.kind === 'chunk')).toBe(true);
    expect(hits.some((h) => h.kind === 'claim')).toBe(true);
  });

  it('does not throw on FTS special characters and returns results', () => {
    const { repos } = seedKb();
    // Parens/quotes/operators would be FTS syntax if not sanitized.
    expect(() => search(repos, 'tokens "AND" (rotate) NEAR:', { scope: 'chunks' })).not.toThrow();
    expect(() => search(repos, '*', { scope: 'claims' })).not.toThrow();
    const { hits } = search(repos, 'refresh-tokens', { scope: 'claims' });
    expect(Array.isArray(hits)).toBe(true);
  });
});

/**
 * A corpus tailored for match-mode / per-scope-fallback assertions (05 §1):
 *  - one chunk carries BOTH "alpha" and "beta" (chunks hit on strict AND),
 *  - the applied claim carries "alpha" but NOT "beta" (claims scope must fall back
 *    to OR under `auto`),
 *  - an "alpha service" entity (LIKE hit, rank: null).
 */
function seedModes(): { repos: Repositories; claimId: string; entityId: string; chunkId: string } {
  const { ctx, repos } = makeCtx();
  const doc = '# Widget\n\nThe alpha beta widget enforces the alpha requirement strictly.\n';
  const src = new IngestService(ctx).ingest({
    bytes: Buffer.from(doc, 'utf8'),
    ext: 'md',
    mediaType: 'text/markdown',
    originalPath: 'widget.md',
  });
  const sourceId = src.source.id;
  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Widget', kind: 'root' }).node;
  const leaf = new NodeService(ctx).createNode({ parentId: root.id, title: 'Widget', kind: 'leaf' }).node;
  const chunk = chunkContaining(repos, sourceId, 'alpha requirement');
  new ClaimService(ctx).apply({
    source_id: sourceId,
    claims: [
      {
        node_id: leaf.id,
        text: 'The alpha requirement is enforced by policy.',
        claim_type: 'fact',
        confidence: 0.9,
        spans: [{ chunk_id: chunk.id, quote: 'alpha requirement', role: 'supports', confidence: 0.9 }],
      },
    ],
  });
  new GraphService(ctx).apply({
    source_id: sourceId,
    // No entity `evidence`: the field was removed in 03 §3.2 (it was never persisted).
    entities: [{ type: 'Service', name: 'alpha service', description: 'the alpha service', confidence: 0.9 }],
    relationships: [],
  });
  const claim = repos.claims.listByNode(leaf.id)[0]!;
  const entity = repos.entities.listAll()[0]!;
  return { repos, claimId: claim.id, entityId: entity.id, chunkId: chunk.id };
}

/** Capture the FTS MATCH argument of every FTS query run inside `fn` (query spy). */
function captureMatchArgs(repos: Repositories, fn: () => void): string[] {
  const args: string[] = [];
  const db = repos.db as unknown as { prepare: (sql: string) => { all: (...a: unknown[]) => unknown } };
  const orig = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const stmt = orig(sql);
    if (sql.includes('MATCH')) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...a: unknown[]) => {
        args.push(a[0] as string);
        return origAll(...a);
      };
    }
    return stmt;
  };
  try {
    fn();
  } finally {
    db.prepare = orig;
  }
  return args;
}

describe('search match modes (05 §1)', () => {
  it('auto falls back per FTS scope independently: one scope hits on AND while another falls back', () => {
    const { repos } = seedModes();
    const res = search(repos, 'alpha beta', { scope: 'all' });
    // chunks: one chunk has both terms → strict AND succeeds, no fallback.
    expect(res.matchModes.chunks).toBe('all');
    // claims: no claim has "beta" → AND is empty for THIS scope → OR fallback.
    expect(res.matchModes.claims).toBe('any-fallback');
    const chunkHit = res.hits.find((h) => h.kind === 'chunk')!;
    const claimHit = res.hits.find((h) => h.kind === 'claim')!;
    expect(chunkHit.matchMode).toBe('all');
    expect(claimHit.matchMode).toBe('any-fallback');
  });

  it('auto issues the AND pass first, then OR only for the zero-AND scope', () => {
    const { repos } = seedModes();
    let res!: SearchResult;
    const chunkQueries = captureMatchArgs(repos, () => {
      res = search(repos, 'alpha beta', { scope: 'chunks', match: 'auto' });
    });
    // chunks hit on AND → OR is never issued.
    expect(res.matchModes.chunks).toBe('all');
    expect(chunkQueries).toEqual(['"alpha" "beta"']);

    let res2!: SearchResult;
    const claimQueries = captureMatchArgs(repos, () => {
      res2 = search(repos, 'alpha beta', { scope: 'claims', match: 'auto' });
    });
    // claims miss on AND → OR fallback is issued second.
    expect(res2.matchModes.claims).toBe('any-fallback');
    expect(claimQueries).toEqual(['"alpha" "beta"', '"alpha" OR "beta"']);
  });

  it('strict --match all does not fall back to OR', () => {
    const { repos } = seedModes();
    let res!: SearchResult;
    const queries = captureMatchArgs(repos, () => {
      res = search(repos, 'alpha beta', { scope: 'claims', match: 'all' });
    });
    expect(res.matchModes.claims).toBe('all');
    expect(res.hits.filter((h) => h.kind === 'claim')).toHaveLength(0);
    // Only the AND expression is ever issued.
    expect(queries).toEqual(['"alpha" "beta"']);
  });

  it('--match phrase matches the exact adjacent phrase without fallback', () => {
    const { repos } = seedModes();
    const present = search(repos, 'alpha beta', { scope: 'chunks', match: 'phrase' });
    expect(present.matchModes.chunks).toBe('phrase');
    expect(present.hits.some((h) => h.kind === 'chunk')).toBe(true);
    // "beta alpha" is not an adjacent phrase in the chunk → no hit, still no fallback.
    const absent = search(repos, 'beta alpha', { scope: 'chunks', match: 'phrase' });
    expect(absent.matchModes.chunks).toBe('phrase');
    expect(absent.hits.some((h) => h.kind === 'chunk')).toBe(false);
  });

  it('--match any skips the AND pass and reports mode "any"', () => {
    const { repos } = seedModes();
    let res!: SearchResult;
    const queries = captureMatchArgs(repos, () => {
      res = search(repos, 'alpha beta', { scope: 'claims', match: 'any' });
    });
    expect(res.matchModes.claims).toBe('any');
    // Only the OR expression is issued — the AND pass is skipped entirely.
    expect(queries).toEqual(['"alpha" OR "beta"']);
    expect(res.hits.some((h) => h.kind === 'claim')).toBe(true);
  });

  it('entity hits carry rank: null and matchMode "like"', () => {
    const { repos, entityId } = seedModes();
    const res = search(repos, 'alpha', { scope: 'entities' });
    expect(res.matchModes.entities).toBe('like');
    const entityHit = res.hits.find((h) => h.id === entityId)!;
    expect(entityHit.kind).toBe('entity');
    expect(entityHit.rank).toBeNull();
    expect(entityHit.matchMode).toBe('like');
  });

  it('FTS hits carry a numeric bm25 rank', () => {
    const { repos } = seedModes();
    const res = search(repos, 'alpha', { scope: 'chunks' });
    const chunkHit = res.hits.find((h) => h.kind === 'chunk')!;
    expect(typeof chunkHit.rank).toBe('number');
  });

  it('orders hits scope-major: chunks, then claims, then entities', () => {
    const { repos } = seedModes();
    const res = search(repos, 'alpha', { scope: 'all' });
    const order = ['chunk', 'claim', 'node', 'entity'];
    const positions = res.hits.map((h) => order.indexOf(h.kind));
    // Non-decreasing: every hit's scope index is ≥ the previous hit's.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThanOrEqual(positions[i - 1]!);
    }
    // The scenario genuinely spans several scopes.
    expect(res.hits.some((h) => h.kind === 'chunk')).toBe(true);
    expect(res.hits.some((h) => h.kind === 'claim')).toBe(true);
    expect(res.hits.some((h) => h.kind === 'entity')).toBe(true);
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

/** Insert a claim directly (bypassing span/quote verification) to control status,
 *  type, node, and text/rank precisely for filter and ranking assertions. */
function insertClaim(
  repos: Repositories,
  args: { id: string; nodeId: NodeId | null; text: string; claimType: string; status: string; sourceId: SourceId },
): string {
  const claim: Claim = {
    id: makeClaimId(args.id),
    nodeId: args.nodeId,
    text: args.text,
    normalizedText: args.text.toLowerCase(),
    claimType: args.claimType as Claim['claimType'],
    confidence: 0.8,
    status: args.status as Claim['status'],
    supersededByClaimId: null,
    firstSeenSourceId: args.sourceId,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  repos.claims.upsert(claim);
  return claim.id;
}

/**
 * Root → {A, B}; three active claims all matching "delta topic": fact on A, fact on
 * B, open_question on A. Lets each filter (type, subtree, composition) be asserted.
 */
function seedFilters(): {
  repos: Repositories;
  rootId: NodeId;
  nodeA: NodeId;
  nodeB: NodeId;
  factA: string;
  factB: string;
  questionA: string;
} {
  const { ctx, repos } = makeCtx();
  const sourceId = ingestDoc(ctx);
  const root = new NodeService(ctx).createNode({ parentId: null, title: 'Root', kind: 'root' }).node;
  const a = new NodeService(ctx).createNode({ parentId: root.id, title: 'Alpha node', kind: 'leaf' }).node;
  const b = new NodeService(ctx).createNode({ parentId: root.id, title: 'Bravo node', kind: 'leaf' }).node;
  const factA = insertClaim(repos, { id: 'clm_delta0001', nodeId: a.id, text: 'delta topic overview', claimType: 'fact', status: 'active', sourceId });
  const factB = insertClaim(repos, { id: 'clm_delta0002', nodeId: b.id, text: 'delta topic details', claimType: 'fact', status: 'active', sourceId });
  const questionA = insertClaim(repos, { id: 'clm_delta0003', nodeId: a.id, text: 'delta topic unresolved', claimType: 'open_question', status: 'active', sourceId });
  return { repos, rootId: root.id, nodeA: a.id, nodeB: b.id, factA, factB, questionA };
}

describe('askContext filters (05 §2)', () => {
  it('--claim-type narrows to the given type', () => {
    const { repos, questionA } = seedFilters();
    const res = askContext(repos, 'delta topic', { claimType: 'open_question' });
    expect(res.claims.map((c) => c.id)).toContain(questionA);
    expect(res.claims.every((c) => c.claimType === 'open_question')).toBe(true);
  });

  it('--node restricts to the node subtree', () => {
    const { repos, nodeA, rootId, factA, factB, questionA } = seedFilters();
    const inA = askContext(repos, 'delta topic', { nodeId: nodeA });
    const idsA = inA.claims.map((c) => c.id);
    expect(idsA).toContain(factA);
    expect(idsA).toContain(questionA);
    expect(idsA).not.toContain(factB);

    const inRoot = askContext(repos, 'delta topic', { nodeId: rootId });
    expect(inRoot.claims.map((c) => c.id)).toEqual(expect.arrayContaining([factA, factB, questionA]));
  });

  it('composes --claim-type and --node', () => {
    const { repos, nodeA, questionA, factA } = seedFilters();
    const res = askContext(repos, 'delta topic', { nodeId: nodeA, claimType: 'open_question' });
    const ids = res.claims.map((c) => c.id);
    expect(ids).toEqual([questionA]);
    expect(ids).not.toContain(factA);
  });

  it('echoes the applied filters (both supplied and both absent)', () => {
    const { repos, nodeA } = seedFilters();
    expect(askContext(repos, 'delta topic', { nodeId: nodeA, claimType: 'fact' }).applied).toEqual({
      claimType: 'fact',
      node: nodeA,
    });
    expect(askContext(repos, 'delta topic').applied).toEqual({ claimType: null, node: null });
  });

  it('validates --node FIRST: an unknown node throws UNKNOWN_NODE', () => {
    const { repos } = seedFilters();
    let caught: unknown;
    try {
      askContext(repos, 'delta topic', { nodeId: 'nod_doesnotexist' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DomainIssueError);
    expect((caught as DomainIssueError).code).toBe('UNKNOWN_NODE');
  });

  it('pushes the status filter into SQL: a qualifying claim past the old 4×limit over-fetch is still returned', () => {
    const { ctx, repos } = makeCtx();
    const sourceId = ingestDoc(ctx);
    // 8 SUPERSEDED claims (high TF, short → strong bm25) outrank one ACTIVE claim
    // (TF 1, long → weak bm25). With limit=1 the OLD code over-fetched limit*4 = 4
    // rows by rank — all superseded — then post-filtered status → a FALSE ZERO.
    // Status now lives in the SQL WHERE, so ranking never sees the excluded rows.
    for (let i = 0; i < 8; i++) {
      insertClaim(repos, {
        id: `clm_supersed${i}`,
        nodeId: null,
        text: 'zeta zeta zeta zeta',
        claimType: 'fact',
        status: 'superseded',
        sourceId,
      });
    }
    const activeId = insertClaim(repos, {
      id: 'clm_activezeta1',
      nodeId: null,
      text: 'zeta appears once among many other filler padding words here there everywhere plus extra',
      claimType: 'fact',
      status: 'active',
      sourceId,
    });
    const res = askContext(repos, 'zeta', { limit: 1 });
    expect(res.claims.map((c) => c.id)).toEqual([activeId]);
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

  // Phase 0 filed this as `it.fails`: a footnote-definition line in a rendered
  // "Sources" block that quotes questions was split by the old `splitSentences`
  // at the `?"` inside the quote, and the trailing fragment ("...and also \"When
  // do they expire?\"") — carrying no [^clm_…] token — was wrongly flagged as an
  // uncited assertion. The Phase 3 Markdown scanner classifies that line as a
  // footnoteDef region (never assertion-checked), so the regression is fixed.
  it('does not flag quoted questions inside a Sources footnote block', () => {
    const { repos, claimId } = seedKb();
    const answer = [
      `Refresh tokens rotate on every use.[^${claimId}]`,
      '',
      '## Sources',
      '',
      `[^${claimId}]: The design doc asks "How do tokens rotate?" and also "When do they expire?"`,
    ].join('\n');
    const r = answerCheck(repos, answer);
    expect(r.ok).toBe(true);
    expect(r.uncited).toHaveLength(0);
    expect(r.uncitedSentences).toHaveLength(0);
    // The footnote-definition citation is still counted and validated.
    expect(r.citedClaims).toContain(claimId);
  });

  it('reports the correct line number for a genuinely uncited assertion', () => {
    const { repos, claimId } = seedKb();
    const answer = [
      `Refresh tokens rotate on every use.[^${claimId}]`,
      '',
      'The system also stores sessions in a database without any citation.',
    ].join('\n');
    const r = answerCheck(repos, answer);
    expect(r.ok).toBe(false);
    expect(r.uncited).toHaveLength(1);
    expect(r.uncited[0]!.text).toContain('stores sessions');
    expect(r.uncited[0]!.line).toBe(3);
    // The deprecated alias mirrors uncited[].text.
    expect(r.uncitedSentences).toEqual([r.uncited[0]!.text]);
  });

  it('still requires a citation for an assertive sentence that contains an inline quoted question', () => {
    const { repos } = seedKb();
    // The `?` is inside the quote (no split); the whole sentence is one assertion
    // with no citation — quoting a question does not exempt it (finding 31).
    const answer = 'The design asks "How do tokens rotate?" yet the service still rotates them silently.';
    const r = answerCheck(repos, answer);
    expect(r.ok).toBe(false);
    expect(r.uncited).toHaveLength(1);
    expect(r.uncited[0]!.line).toBe(1);
  });

  it('still validates a citation that appears only in a footnote definition', () => {
    const { repos } = seedKb();
    const answer = ['Short intro.', '', '[^clm_deadbeef]: A dangling footnote definition citing a missing claim.'].join('\n');
    const r = answerCheck(repos, answer);
    // The footnote-definition citation IS extracted and validated for existence…
    expect(r.citedClaims).toContain('clm_deadbeef');
    expect(r.unknownCitations).toContain('clm_deadbeef');
    expect(r.ok).toBe(false);
    // …and the definition line itself is never treated as an uncited assertion.
    expect(r.uncited).toHaveLength(0);
  });

  it('neither validates nor counts a citation that appears only inside fenced code', () => {
    const { repos, claimId } = seedKb();
    const answer = [
      `Refresh tokens rotate on every use.[^${claimId}]`,
      '',
      '```',
      'To cite a claim, write [^clm_deadbeef] inline.',
      '```',
    ].join('\n');
    const r = answerCheck(repos, answer);
    // The fake id inside the fence is not extracted, so it is not an unknown citation…
    expect(r.unknownCitations).not.toContain('clm_deadbeef');
    expect(r.unknownCitations).toHaveLength(0);
    // …and it is not counted as a cited claim.
    expect(r.citedClaims).not.toContain('clm_deadbeef');
    expect(r.citedClaims).toContain(claimId);
    // The code block is not prose, so it raises no uncited assertion.
    expect(r.ok).toBe(true);
    expect(r.uncited).toHaveLength(0);
  });
});
