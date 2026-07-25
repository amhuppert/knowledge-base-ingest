import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../kb/workspace.js';
import { makeClaimId, makeNodeId, makeSourceId, makeSpanId, type ClaimId, type NodeId, type SourceId, type SpanId } from '../ids.js';
import type { Claim, Node, Source, Span } from '../schemas/models.js';
import type { ClaimStatus } from '../schemas/enums.js';
import { buildNodeContext, SNIPPET_MAX_CHARS } from './nodeContext.js';

/**
 * SYNTHESIS CONTEXT BUNDLE (04 §1). `buildNodeContext` assembles everything a
 * synthesis write needs in ONE read: the full node (body included), its children with
 * own-claim counts, ONE owner-tagged claim list for the whole subtree, the sources
 * behind those claims, the validator's `allowedCitationIds`, and stats.
 *
 * The seed below plants an EQUAL key at every ordering tie-break so each comparator
 * level is proven independently (the id order is deliberately the opposite of the
 * expected order wherever an earlier key decides).
 */

// --- ids: chosen so lexicographic id order fights the expected order at every tie ---
const ROOT = makeNodeId('nod_root');
const TOPIC_A = makeNodeId('nod_topic_a');
const TOPIC_B = makeNodeId('nod_topic_b');
const LEAF_A1 = makeNodeId('nod_leaf_a1');
const LEAF_A2 = makeNodeId('nod_leaf_a2');

const CLM_ROOT = makeClaimId('clm_root1');
const CLM_TA = makeClaimId('clm_ta1');
const CLM_TB = makeClaimId('clm_tb1');
const CLM_TB_CONFLICT = makeClaimId('clm_tb2_conflicted');
const CLM_EARLY = makeClaimId('clm_x_early');
const CLM_LATE = makeClaimId('clm_a_late');
const CLM_TIE_B = makeClaimId('clm_b_tie');
const CLM_TIE_M = makeClaimId('clm_m_tie');
const CLM_SUPERSEDED = makeClaimId('clm_superseded');

const SRC_A1 = makeSourceId('src_a1');
const SRC_A2 = makeSourceId('src_a2');
const SRC_Z = makeSourceId('src_z');

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function source(id: SourceId, title: string): Source {
  return {
    id,
    sha256: `sha-${id}`,
    storedPath: `sources/${id}.md`,
    originalPath: null,
    title,
    mediaType: 'text/markdown',
    byteSize: 10,
    sourceDate: null,
    author: null,
    versionLabel: null,
    supersedesSourceId: null,
    status: 'active',
    metadataJson: '{}',
    ingestedAt: T0,
  };
}

function node(id: NodeId, parentId: NodeId | null, title: string, kind: Node['kind'], depth: number, sortOrder: number): Node {
  return {
    id,
    parentId,
    slug: id.replace('nod_', ''),
    title,
    kind,
    depth,
    sortOrder,
    summary: `${title} summary`,
    bodyMd: `# ${title}\n\nCurrent prose for ${title}.`,
    bodyHash: `hash-${id}`,
    isStale: true,
    createdAt: T0,
    updatedAt: T0,
  };
}

function claim(
  id: ClaimId,
  nodeId: NodeId,
  text: string,
  opts: { status?: ClaimStatus; createdAt?: string; supersededBy?: ClaimId } = {},
): Claim {
  return {
    id,
    nodeId,
    text,
    normalizedText: text.toLowerCase(),
    claimType: 'fact',
    confidence: 0.9,
    status: opts.status ?? 'active',
    supersededByClaimId: opts.supersededBy ?? null,
    firstSeenSourceId: SRC_A1,
    createdAt: opts.createdAt ?? T0,
    updatedAt: opts.createdAt ?? T0,
  };
}

function span(id: SpanId, sourceId: SourceId, charStart: number, charEnd: number, quote: string): Span {
  return { id, sourceId, chunkId: null, charStart, charEnd, quote, quoteHash: `qh-${id}`, createdAt: T0 };
}

/** Seed the shared fixture KB: 5 nodes, 9 claims (one superseded), 3 sources, 5 spans. */
function seed(ws: Workspace): void {
  const repos = ws.repos;
  repos.tx(() => {
    // Two sources share a title so the (title, sourceId) tie-break is exercised.
    repos.sources.insert(source(SRC_A1, 'Shared Title'));
    repos.sources.insert(source(SRC_A2, 'Shared Title'));
    repos.sources.insert(source(SRC_Z, 'Another Title'));

    // topic_b is inserted FIRST but must sort after topic_a (equal sortOrder → id decides).
    repos.nodes.insert(node(ROOT, null, 'Root', 'root', 0, 0));
    repos.nodes.insert(node(TOPIC_B, ROOT, 'Topic B', 'topic', 1, 0));
    repos.nodes.insert(node(TOPIC_A, ROOT, 'Topic A', 'topic', 1, 0));
    // leaf_a2 sorts BEFORE leaf_a1 by sortOrder even though its id sorts later.
    repos.nodes.insert(node(LEAF_A1, TOPIC_A, 'Leaf A1', 'leaf', 2, 1));
    repos.nodes.insert(node(LEAF_A2, TOPIC_A, 'Leaf A2', 'leaf', 2, 0));

    repos.claims.upsert(claim(CLM_ROOT, ROOT, 'Root owns a claim.'));
    repos.claims.upsert(claim(CLM_TA, TOPIC_A, 'Topic A owns a claim.'));
    repos.claims.upsert(claim(CLM_TB, TOPIC_B, 'Topic B owns a claim.'));
    repos.claims.upsert(claim(CLM_TB_CONFLICT, TOPIC_B, 'Topic B owns a contested claim.', { status: 'conflicted', createdAt: T1 }));
    // Same owner (leaf_a2): createdAt decides, beating the id order (a_late < x_early).
    repos.claims.upsert(claim(CLM_EARLY, LEAF_A2, 'Leaf A2 recorded this first.', { createdAt: T0 }));
    repos.claims.upsert(claim(CLM_LATE, LEAF_A2, 'Leaf A2 recorded this second.', { createdAt: T1 }));
    // Same owner (leaf_a1) AND equal createdAt: only the claim id can break the tie.
    repos.claims.upsert(claim(CLM_TIE_M, LEAF_A1, 'Leaf A1 tie claim m.', { createdAt: T0 }));
    repos.claims.upsert(claim(CLM_TIE_B, LEAF_A1, 'Leaf A1 tie claim b.', { createdAt: T0 }));
    // Superseded: uncitable, so it appears in neither `claims` nor `allowedCitationIds`.
    repos.claims.upsert(
      claim(CLM_SUPERSEDED, LEAF_A1, 'Leaf A1 had an outdated claim.', { status: 'superseded', supersededBy: CLM_TIE_B }),
    );

    // Provenance for the root claim, planted so every provenance key is tie-broken:
    // (sourceId, charStart, spanId) — spn_dup_a/spn_dup_b share source AND charStart.
    repos.spans.upsert(span(makeSpanId('spn_dup_b'), SRC_A1, 5, 12, 'first  quote\nwith odd   whitespace'));
    repos.spans.upsert(span(makeSpanId('spn_dup_a'), SRC_A1, 5, 20, 'tied start, lower span id'));
    repos.spans.upsert(span(makeSpanId('spn_mid'), SRC_A1, 50, 60, 'later char start'));
    repos.spans.upsert(span(makeSpanId('spn_other'), SRC_A2, 10, 20, 'other source'));
    repos.spans.upsert(span(makeSpanId('spn_z'), SRC_Z, 0, 5, 'source z quote'));
    for (const spanId of ['spn_dup_b', 'spn_dup_a', 'spn_mid', 'spn_other'] as const) {
      repos.claimSpans.upsert({ claimId: CLM_ROOT, spanId: makeSpanId(spanId), role: 'supports', confidence: 0.9, extractor: 'agent' });
    }
    // A claim on the deepest leaf cites source Z, so `sources` spans more than one source.
    repos.claimSpans.upsert({ claimId: CLM_TIE_B, spanId: makeSpanId('spn_z'), role: 'supports', confidence: 0.9, extractor: 'agent' });
  });
}

let dir: string;
let ws: Workspace;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-nodectx-'));
  ws = initWorkspace(dir).ws;
  seed(ws);
});

afterAll(() => {
  ws.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildNodeContext — bundle shape at every level (04 §1)', () => {
  it('root: full node with body, children with ownClaims, the whole subtree claim list', () => {
    const bundle = buildNodeContext(ws.repos, ROOT)!;
    expect(bundle).toBeDefined();

    expect(bundle.data.node).toMatchObject({
      id: ROOT,
      parentId: null,
      title: 'Root',
      kind: 'root',
      depth: 0,
      summary: 'Root summary',
      isStale: true,
      bodyMd: '# Root\n\nCurrent prose for Root.',
      bodyHash: 'hash-nod_root',
    });

    // Children: (sortOrder, nodeId) — equal sortOrder, so the id decides.
    expect(bundle.data.children).toEqual([
      { id: TOPIC_A, title: 'Topic A', kind: 'topic', summary: 'Topic A summary', isStale: true, ownClaims: 1 },
      { id: TOPIC_B, title: 'Topic B', kind: 'topic', summary: 'Topic B summary', isStale: true, ownClaims: 2 },
    ]);

    // ONE claim list covering the entire subtree, each entry owner-tagged.
    expect(bundle.data.claims.map((c) => c.id)).toEqual([
      CLM_ROOT,
      CLM_TA,
      CLM_TB,
      CLM_TB_CONFLICT,
      CLM_EARLY,
      CLM_LATE,
      CLM_TIE_B,
      CLM_TIE_M,
    ]);
    expect(bundle.data.claims.find((c) => c.id === CLM_TIE_B)).toMatchObject({
      nodeId: LEAF_A1,
      nodeTitle: 'Leaf A1',
      claimType: 'fact',
      status: 'active',
      confidence: 0.9,
    });
    expect(bundle.data.claims.find((c) => c.id === CLM_TB_CONFLICT)!.status).toBe('conflicted');

    expect(bundle.data.stats).toEqual({
      descendantNodes: 4,
      claims: 8,
      approxTokens: expect.any(Number),
      complete: true,
    });
  });

  it('topic: subtree-scoped claims and its own children only', () => {
    const bundle = buildNodeContext(ws.repos, TOPIC_A)!;
    expect(bundle.data.node.id).toBe(TOPIC_A);
    // (sortOrder, nodeId): leaf_a2 has the lower sortOrder despite the higher id.
    expect(bundle.data.children.map((c) => c.id)).toEqual([LEAF_A2, LEAF_A1]);
    expect(bundle.data.children.map((c) => c.ownClaims)).toEqual([2, 2]);
    expect(bundle.data.claims.map((c) => c.id)).toEqual([CLM_TA, CLM_EARLY, CLM_LATE, CLM_TIE_B, CLM_TIE_M]);
    expect(bundle.data.stats.descendantNodes).toBe(2);
    expect(bundle.data.stats.claims).toBe(5);
  });

  it('leaf: no children, only its own citable claims', () => {
    const bundle = buildNodeContext(ws.repos, LEAF_A1)!;
    expect(bundle.data.children).toEqual([]);
    expect(bundle.data.claims.map((c) => c.id)).toEqual([CLM_TIE_B, CLM_TIE_M]);
    expect(bundle.data.stats).toMatchObject({ descendantNodes: 0, claims: 2, complete: true });
  });

  it('returns undefined for an unknown node', () => {
    expect(buildNodeContext(ws.repos, makeNodeId('nod_missing'))).toBeUndefined();
  });
});

describe('buildNodeContext — total ordering (every tie-break asserted)', () => {
  it('claims order by (ownerDepth, ownerSortOrder, ownerNodeId, createdAt, claimId)', () => {
    const claims = buildNodeContext(ws.repos, ROOT)!.data.claims;
    const order = claims.map((c) => c.id);

    // ownerDepth: root(0) → topics(1) → leaves(2).
    expect(order.indexOf(CLM_ROOT)).toBeLessThan(order.indexOf(CLM_TA));
    expect(order.indexOf(CLM_TA)).toBeLessThan(order.indexOf(CLM_EARLY));
    // ownerDepth AND ownerSortOrder tie (both topics: depth 1, sortOrder 0) → ownerNodeId.
    expect(order.indexOf(CLM_TA)).toBeLessThan(order.indexOf(CLM_TB));
    // ownerDepth tie, ownerSortOrder decides (leaf_a2 sortOrder 0 < leaf_a1 sortOrder 1),
    // beating the id order (nod_leaf_a1 < nod_leaf_a2).
    expect(order.indexOf(CLM_LATE)).toBeLessThan(order.indexOf(CLM_TIE_B));
    // Same owner, createdAt decides — beating the id order (clm_a_late < clm_x_early).
    expect(order.indexOf(CLM_EARLY)).toBeLessThan(order.indexOf(CLM_LATE));
    // Same owner AND equal createdAt → claimId decides.
    expect(order.indexOf(CLM_TIE_B)).toBeLessThan(order.indexOf(CLM_TIE_M));
  });

  it('provenance orders by (sourceId, charStart, spanId) with a tie at every level', () => {
    const rootClaim = buildNodeContext(ws.repos, ROOT)!.data.claims.find((c) => c.id === CLM_ROOT)!;
    expect(rootClaim.provenance.map((p) => p.quoteSnippet)).toEqual([
      'tied start, lower span id', // src_a1, charStart 5, spn_dup_a
      'first quote with odd whitespace', // src_a1, charStart 5, spn_dup_b (whitespace collapsed)
      'later char start', // src_a1, charStart 50
      'other source', // src_a2
    ]);
    expect(rootClaim.provenance.map((p) => p.sourceId)).toEqual([SRC_A1, SRC_A1, SRC_A1, SRC_A2]);
    expect(rootClaim.provenance[0]).toEqual({
      sourceId: SRC_A1,
      sourceTitle: 'Shared Title',
      quoteSnippet: 'tied start, lower span id',
    });
  });

  it('sources order by (title, sourceId) — the shared title falls back to the id', () => {
    const sources = buildNodeContext(ws.repos, ROOT)!.data.sources;
    expect(sources).toEqual([
      { id: SRC_Z, title: 'Another Title', claimCount: 1 },
      { id: SRC_A1, title: 'Shared Title', claimCount: 1 },
      { id: SRC_A2, title: 'Shared Title', claimCount: 1 },
    ]);
  });

  it('children order by (sortOrder, nodeId) and allowedCitationIds are lexicographic', () => {
    const bundle = buildNodeContext(ws.repos, ROOT)!;
    expect(bundle.data.children.map((c) => c.id)).toEqual([TOPIC_A, TOPIC_B]);
    expect(bundle.data.allowedCitationIds).toEqual([...bundle.data.allowedCitationIds].sort());
  });
});

describe('buildNodeContext — citability (validator-sourced)', () => {
  it('allowedCitationIds equals the citable subtree claim ids, superseded excluded', () => {
    const bundle = buildNodeContext(ws.repos, LEAF_A1)!;
    expect(bundle.data.allowedCitationIds).toEqual([CLM_TIE_B, CLM_TIE_M]);
    expect(bundle.data.allowedCitationIds).not.toContain(CLM_SUPERSEDED);
    expect(bundle.data.claims.map((c) => c.id)).not.toContain(CLM_SUPERSEDED);
  });

  it('every listed claim id is citable, and every citable id is listed (root)', () => {
    const bundle = buildNodeContext(ws.repos, ROOT)!;
    expect([...bundle.data.claims.map((c) => c.id)].sort()).toEqual(bundle.data.allowedCitationIds);
  });
});

describe('buildNodeContext — approxTokens has no self-reference (finding 25)', () => {
  it('measures {node, children, claims, sources, allowedCitationIds} BEFORE stats is attached', () => {
    const { data } = buildNodeContext(ws.repos, ROOT)!;
    const measured = Math.ceil(
      JSON.stringify({
        node: data.node,
        children: data.children,
        claims: data.claims,
        sources: data.sources,
        allowedCitationIds: data.allowedCitationIds,
      }).length / 4,
    );
    expect(data.stats.approxTokens).toBe(measured);
    // Regression: measuring the WHOLE payload (stats included) is a different number,
    // so a self-referential implementation cannot accidentally satisfy the assertion.
    expect(Math.ceil(JSON.stringify(data).length / 4)).not.toBe(data.stats.approxTokens);
  });
});

describe('buildNodeContext — quote snippets', () => {
  it('collapses whitespace and reports no truncation for short quotes', () => {
    const bundle = buildNodeContext(ws.repos, ROOT)!;
    expect(bundle.snippetsTruncated).toBe(false);
    const snippets = bundle.data.claims.flatMap((c) => c.provenance.map((p) => p.quoteSnippet));
    expect(snippets.some((s) => /\s\s|\n/.test(s))).toBe(false);
    expect(snippets.every((s) => s.length <= SNIPPET_MAX_CHARS + 1)).toBe(true);
  });

  it('truncates a long quote to 160 chars + ellipsis and flags the truncation', () => {
    const longDir = mkdtempSync(join(tmpdir(), 'kb-nodectx-long-'));
    const long = initWorkspace(longDir).ws;
    try {
      const quote = `${'word '.repeat(60)}end`; // 300+ chars, whitespace-separated
      long.repos.tx(() => {
        long.repos.sources.insert(source(SRC_A1, 'Long Source'));
        long.repos.nodes.insert(node(ROOT, null, 'Root', 'root', 0, 0));
        long.repos.claims.upsert(claim(CLM_ROOT, ROOT, 'A long quote backs this claim.'));
        long.repos.spans.upsert(span(makeSpanId('spn_long'), SRC_A1, 0, quote.length, quote));
        long.repos.claimSpans.upsert({
          claimId: CLM_ROOT,
          spanId: makeSpanId('spn_long'),
          role: 'supports',
          confidence: 0.9,
          extractor: 'agent',
        });
      });

      const bundle = buildNodeContext(long.repos, ROOT)!;
      const snippet = bundle.data.claims[0]!.provenance[0]!.quoteSnippet;
      expect(bundle.snippetsTruncated).toBe(true);
      expect(snippet.endsWith('…')).toBe(true);
      expect(snippet.slice(0, -1)).toHaveLength(SNIPPET_MAX_CHARS);
      expect(snippet.slice(0, -1)).toBe(quote.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX_CHARS));
    } finally {
      long.close();
      rmSync(longDir, { recursive: true, force: true });
    }
  });
});

describe('buildNodeContext — provenance is ONE batched query (no N+1)', () => {
  it('prepares exactly one claim_spans statement for a multi-claim subtree', () => {
    const db = ws.repos.db;
    const original = db.prepare.bind(db) as (sql: string) => unknown;
    const prepared: string[] = [];
    const patched = db as unknown as { prepare: (sql: string) => unknown };
    patched.prepare = (sql: string) => {
      prepared.push(sql);
      return original(sql);
    };
    try {
      const bundle = buildNodeContext(ws.repos, ROOT)!;
      expect(bundle.data.claims.length).toBeGreaterThan(1);
    } finally {
      delete (patched as Partial<typeof patched>).prepare;
    }
    expect(prepared.filter((sql) => sql.includes('claim_spans'))).toHaveLength(1);
  });
});
