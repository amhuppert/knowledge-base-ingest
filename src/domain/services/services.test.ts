import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { ClaimService } from './claimService.js';
import { GraphService } from './graphService.js';
import { NodeService, type SynthesizeOutcome } from './nodeService.js';
import type { Chunk } from '../schemas/models.js';
import type { SourceId } from '../ids.js';
import type { Synthesize } from '../schemas/agent.js';
import { DomainIssuesError } from '../issueCodes.js';

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
    expect(res.totals.spansCreated).toBe(1);
    expect(res.spansCreatedNet).toBe(1);
    const claim = repos.claims.listByNode(leafId)[0]!;
    expect(repos.claims.listFirstSeenBySource(sourceId).map((candidate) => candidate.id)).toEqual([claim.id]);
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

  it('is idempotent: an exact re-apply is a no-op (unchanged), not a duplicate or an update', () => {
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
    // Phase 1 no-op semantics: an exact repeat writes nothing and reports `unchanged`.
    expect(second.claimsCreated).toBe(0);
    expect(second.claimsUpdated).toBe(0);
    expect(second.totals.unchanged).toBe(1);
    expect(second.claims[0]!.outcome).toBe('unchanged');
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
        { type: 'Service', name: 'auth service', description: 'auth', confidence: 0.9 },
        { type: 'DataStore', name: 'PostgreSQL', description: 'db', confidence: 0.9 },
      ],
      relationships: [
        {
          type: 'stores_in',
          subject: { type: 'Service', name: 'auth service' },
          object: { type: 'DataStore', name: 'PostgreSQL' },
          description: 'sessions stored in pg',
          confidence: 0.8,
          evidence: [{ chunk_id: chunk.id, quote: 'Sessions are stored in PostgreSQL', role: 'supports' as const }],
        },
      ],
    };
    const r = new GraphService(ctx).apply(payload);
    expect(r.entitiesCreated).toBe(2);
    expect(r.entitiesUpdated).toBe(0);
    expect(r.entitiesUnchanged).toBe(0);
    expect(r.entitiesReferenced).toBe(2);
    expect(r.relationshipsCreated).toBe(1);
    expect(r.relationshipsUpdated).toBe(0);
    expect(r.relationshipsUnchanged).toBe(0);
    expect(repos.relationships.listAll()).toHaveLength(1);

    const again = new GraphService(ctx).apply(payload);
    expect(again.entitiesCreated).toBe(0);
    expect(again.entitiesUpdated).toBe(0);
    expect(again.entitiesUnchanged).toBe(2);
    expect(again.entitiesReferenced).toBe(2);
    expect(again.relationshipsCreated).toBe(0);
    expect(again.relationshipsUpdated).toBe(0);
    expect(again.relationshipsUnchanged).toBe(1);
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

  it('rechecks expected_body_hash inside the transaction when another apply wins after validation', () => {
    const { ctx, repos, leafId } = setupWithClaim();
    const beforeHash = repos.nodes.getById(leafId)!.bodyHash;
    const first = {
      node_id: leafId,
      body_md: 'First writer.',
      expected_body_hash: beforeHash,
    };
    const second = {
      node_id: leafId,
      body_md: 'Second writer.',
      expected_body_hash: beforeHash,
    };
    const realTx = repos.tx.bind(repos);
    vi.spyOn(repos, 'tx')
      .mockImplementationOnce((fn) => {
        new NodeService(ctx).synthesize(first);
        return realTx(fn);
      })
      .mockImplementation(realTx);

    let thrown: unknown;
    try {
      new NodeService(ctx).synthesize(second);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainIssuesError);
    expect((thrown as DomainIssuesError).issues).toEqual([
      expect.objectContaining({ code: 'BODY_HASH_MISMATCH' }),
    ]);
    expect(repos.nodes.getById(leafId)!.bodyMd).toBe('First writer.');
  });

  it('clears stale on the synthesized leaf but leaves the still-stale root', () => {
    const { ctx, repos, rootId, leafId, claimId } = setupWithClaim();
    new NodeService(ctx).synthesize({
      node_id: leafId,
      expected_body_hash: '',
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
        expected_body_hash: '',
        body_md: 'Bogus.[^clm_deadbeefdeadbeef]',
      }),
    ).toThrow(/unknown claim/);
  });

  const changelogCount = (repos: Repositories): number => repos.changelog.recent(1000).length;

  /**
   * A synthesized leaf at a KNOWN baseline: body=B0, title='Token Rotation', summary='',
   * and FRESH; its root is forced fresh too so a later ancestor-staling is observable. The
   * cross-product matrix perturbs one or more of {stale, body, title, summary} from here.
   */
  function baseline() {
    const { ctx, repos, rootId, leafId, claimId } = setupWithClaim();
    const B0 = `Rotate baseline.[^${claimId}]`;
    new NodeService(ctx).synthesize({ node_id: leafId, expected_body_hash: '', body_md: B0 }); // leaf fresh, title='Token Rotation', summary=''
    repos.nodes.setStale(rootId, false, '2000-01-01T00:00:00.000Z'); // root fresh baseline
    return { ctx, repos, rootId, leafId, claimId, B0 };
  }

  interface OutcomeRow {
    name: string;
    preStale: boolean;
    body: 'same' | 'diff';
    title?: string; // undefined = omit; a value = provided (same value ⇒ no change)
    summary?: string;
    outcome: SynthesizeOutcome;
    wrote: boolean; // updatedAt bumped + one changelog entry
    ancestorsStaled: boolean;
  }

  // The full stale × body × title × summary cross-product (03 §1, §4). `wrote`/`ancestorsStaled`
  // are the derived expectations. Content is "same" only when body, title, and summary are all
  // unchanged; ancestors stale only on a title or summary change (never body-only, never a no-op).
  const OUTCOME_MATRIX: OutcomeRow[] = [
    { name: 'fresh + no change → unchanged (zero writes, no ancestor effect)', preStale: false, body: 'same', outcome: 'unchanged', wrote: false, ancestorsStaled: false },
    { name: 'fresh + same-value title provided → unchanged (same value is not a change)', preStale: false, body: 'same', title: 'Token Rotation', outcome: 'unchanged', wrote: false, ancestorsStaled: false },
    { name: 'stale + no change → stale-cleared (clears stale, no ancestor effect)', preStale: true, body: 'same', outcome: 'stale-cleared', wrote: true, ancestorsStaled: false },
    { name: 'fresh + body-only change → updated, ancestors untouched', preStale: false, body: 'diff', outcome: 'updated', wrote: true, ancestorsStaled: false },
    { name: 'stale + body-only change → updated, ancestors untouched', preStale: true, body: 'diff', outcome: 'updated', wrote: true, ancestorsStaled: false },
    { name: 'fresh + title change → updated, ancestors staled', preStale: false, body: 'same', title: 'Rotation v2', outcome: 'updated', wrote: true, ancestorsStaled: true },
    { name: 'stale + title change → updated, ancestors staled', preStale: true, body: 'same', title: 'Rotation v2', outcome: 'updated', wrote: true, ancestorsStaled: true },
    { name: 'fresh + summary change → updated, ancestors staled', preStale: false, body: 'same', summary: 'How rotation works.', outcome: 'updated', wrote: true, ancestorsStaled: true },
    { name: 'stale + summary change → updated, ancestors staled', preStale: true, body: 'same', summary: 'How rotation works.', outcome: 'updated', wrote: true, ancestorsStaled: true },
    { name: 'fresh + body & title change → updated, ancestors staled', preStale: false, body: 'diff', title: 'Rotation v2', outcome: 'updated', wrote: true, ancestorsStaled: true },
    { name: 'fresh + body & summary change → updated, ancestors staled', preStale: false, body: 'diff', summary: 'How rotation works.', outcome: 'updated', wrote: true, ancestorsStaled: true },
    { name: 'fresh + simultaneous title & summary change → updated, ancestors staled', preStale: false, body: 'same', title: 'Rotation v2', summary: 'How rotation works.', outcome: 'updated', wrote: true, ancestorsStaled: true },
    { name: 'stale + body, title & summary all change → updated, ancestors staled', preStale: true, body: 'diff', title: 'Rotation v2', summary: 'How rotation works.', outcome: 'updated', wrote: true, ancestorsStaled: true },
  ];

  it.each(OUTCOME_MATRIX)('cross-product: $name', (row) => {
    const { ctx, repos, rootId, leafId, claimId, B0 } = baseline();
    const B1 = `Rotate CHANGED prose.[^${claimId}]`;
    if (row.preStale) repos.nodes.setStale(leafId, true, '2000-01-01T00:00:00.000Z');
    const before = repos.nodes.getById(leafId)!;
    const changelogBefore = changelogCount(repos);

    const payload: Synthesize = {
      node_id: leafId,
      expected_body_hash: before.bodyHash,
      body_md: row.body === 'diff' ? B1 : B0,
      ...(row.title !== undefined ? { title: row.title } : {}),
      ...(row.summary !== undefined ? { summary: row.summary } : {}),
    };
    const r = new NodeService(ctx).synthesize(payload);

    // Outcome + receipt (aliases derived from outcome; missingCitations always []).
    expect(r.outcome).toBe(row.outcome);
    expect(r.nodeId).toBe(leafId);
    expect(r.updated).toBe(row.outcome !== 'unchanged');
    expect(r.unchanged).toBe(row.outcome === 'unchanged');
    expect(r.missingCitations).toEqual([]);
    expect(r.staleNodes).toEqual(repos.nodes.listStaleDeepestFirst().map((n) => n.id));

    // The synthesized node is fresh in every outcome.
    expect(repos.nodes.getById(leafId)?.isStale).toBe(false);

    // Writes: a no-op leaves updatedAt + changelog untouched; every other outcome bumps both,
    // and the lone changelog entry records detail.unchanged (true only for stale-cleared).
    const after = repos.nodes.getById(leafId)!;
    if (row.wrote) {
      expect(after.updatedAt).not.toBe(before.updatedAt);
      expect(changelogCount(repos)).toBe(changelogBefore + 1);
      const latest = repos.changelog.recent(1)[0]!;
      expect(latest.op).toBe('synthesize');
      expect((JSON.parse(latest.detailJson) as { unchanged?: boolean }).unchanged).toBe(row.outcome === 'stale-cleared');
    } else {
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(changelogCount(repos)).toBe(changelogBefore);
    }

    // Ancestor staleness: only a title/summary change re-stales the (forced-fresh) root.
    expect(repos.nodes.getById(rootId)?.isStale).toBe(row.ancestorsStaled);
  });

  it('rejects a citation of an inactive (superseded) claim and persists nothing', () => {
    const { ctx, repos, leafId, claimId } = setupWithClaim();
    repos.claims.setStatus(claimId, 'superseded', null, '2000-01-01T00:00:00.000Z');
    const before = repos.nodes.getById(leafId)!;
    const changelogBefore = changelogCount(repos);

    let thrown: unknown;
    try {
      new NodeService(ctx).synthesize({ node_id: leafId, expected_body_hash: before.bodyHash, body_md: `Rotate.[^${claimId}]` });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainIssuesError);
    expect((thrown as DomainIssuesError).issues[0]!.code).toBe('CITATION_INACTIVE');
    // Persist-then-fail gap closed: body, staleness, and changelog are all untouched.
    expect(repos.nodes.getById(leafId)?.bodyMd).toBe(before.bodyMd);
    expect(repos.nodes.getById(leafId)?.isStale).toBe(before.isStale);
    expect(changelogCount(repos)).toBe(changelogBefore);
  });

  it('rejects a citation owned outside the node subtree and persists nothing', () => {
    const { ctx, repos } = makeCtx();
    const sourceId = ingestDoc(ctx);
    const root = new NodeService(ctx).createNode({ parentId: null, title: 'Auth', kind: 'root' }).node;
    const target = new NodeService(ctx).createNode({ parentId: root.id, title: 'Token Rotation', kind: 'leaf' }).node;
    const sibling = new NodeService(ctx).createNode({ parentId: root.id, title: 'Storage', kind: 'leaf' }).node;
    const chunk = chunkContaining(repos, sourceId, 'stored in PostgreSQL');
    new ClaimService(ctx).apply({
      source_id: sourceId,
      claims: [
        {
          node_id: sibling.id,
          text: 'Sessions are stored in PostgreSQL.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunk.id, quote: 'stored in PostgreSQL', role: 'supports', confidence: 0.9 }],
        },
      ],
    });
    const siblingClaimId = repos.claims.listByNode(sibling.id)[0]!.id;
    const before = repos.nodes.getById(target.id)!;

    let thrown: unknown;
    try {
      new NodeService(ctx).synthesize({ node_id: target.id, expected_body_hash: before.bodyHash, body_md: `Cross-cite.[^${siblingClaimId}]` });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainIssuesError);
    expect((thrown as DomainIssuesError).issues[0]!.code).toBe('CITATION_OUT_OF_SUBTREE');
    expect(repos.nodes.getById(target.id)?.bodyMd).toBe(before.bodyMd);
  });
});
