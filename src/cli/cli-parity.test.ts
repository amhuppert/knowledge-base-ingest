import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import type { Envelope } from './output.js';

/**
 * GOLDEN PARITY SUITE.
 *
 * Captures the EXACT current output envelope for every representative command
 * against a single seeded temp-dir KB. These goldens are the contract the
 * Commander migration (Phase 0, step 3) must reproduce: after the swap, the
 * envelopes must still `toMatchObject` these shapes (later phases may only ADD
 * fields — never change or drop the ones asserted here).
 *
 * The seed is fixed (source bytes, slugs, claim text), so every id and hash it
 * produces is deterministic and content-addressed. Those values are FROZEN as
 * literals below — a regression in id or hash derivation must break this suite.
 * Asymmetric matchers are used ONLY for genuinely volatile fields: absolute temp
 * paths and ISO timestamps.
 */

interface Captured {
  code: number;
  env: Envelope<Record<string, unknown>>;
}

type CapKey =
  | 'ingest'
  | 'claimApplySuccess'
  | 'claimApplyAmbiguous'
  | 'graphApply'
  | 'synthesize'
  | 'status'
  | 'sourceShow'
  | 'sourceChunks'
  | 'nodeTree'
  | 'nodeShow'
  | 'provenance'
  | 'search'
  | 'askContext'
  | 'answerCheck'
  | 'verify'
  | 'verifyStrict'
  | 'renderCheck';

const SRC = `# Caching

The cache layer stores data. The cache layer stores data in Redis for durability. The widget service caches results in Redis for speed.
`;

// --- Frozen golden values (deterministic, content-addressed by the fixed seed) ---
const SOURCE_ID = 'src_1e2dfabe4d1fa4d7';
const SOURCE_SHA256 = '1e2dfabe4d1fa4d7d4f642a4fcccef09f6b44b64e9ef36404be39c905706b611';
const STORED_PATH = 'sources/1e/1e2dfabe4d1fa4d7.md';
const SOURCE_BYTES = 147;
const CHUNK_ID = 'chk_b203e8b55974d3f7';
const ROOT_ID = 'nod_117ec771a64b24df';
const LEAF_ID = 'nod_b44f1ba76dede8ee';
const CLAIM_ID = 'clm_8348b2f57ed0cbff';
const LEAF_BODY_MD = `The widget service caches results in Redis for speed.[^${CLAIM_ID}]\n`;
const LEAF_BODY_HASH = 'd73f9a164e7d4e6653e6aae20cceeff5fdb244ef29ab241825438318b64146ef';
const QUOTE = 'caches results in Redis';
const QUOTE_START = 112;
const QUOTE_END = 135;
// graph apply ids (content-addressed by type + normalized name, and by the endpoints).
const WIDGET_ENTITY_ID = 'ent_3fe9b90ec517acbc';
const REDIS_ENTITY_ID = 'ent_07951754e8973924';
const RELATIONSHIP_ID = 'rel_3f1cafaf848842bf';

// --- Asymmetric matchers, reserved for genuinely volatile fields only ---
const anyString = expect.any(String) as unknown as string;

describe('kb CLI golden parity (in-process)', () => {
  let kb: string;
  // Ids captured from the seed run, used to BUILD payloads (a regressed id must
  // still let the seed run) and then frozen against the literals above.
  const runtime = { sourceId: '', chunkId: '', rootId: '', leafId: '', claimId: '' };
  // beforeAll populates every key before any `it` runs; the cast lets each
  // capture read back as a defined `Captured` under noUncheckedIndexedAccess.
  const cap = {} as Record<CapKey, Captured>;

  /** Run a command in-process against the seeded KB; capture exit code + envelope. */
  async function run(args: string[]): Promise<Captured> {
    let stdout = '';
    const io: CliIo = {
      stdout: (c) => (stdout += c),
      stderr: () => {},
      cwd: kb,
      env: { ...process.env, KB_DIR: kb },
    };
    const code = await runCli([...args, '--json'], io);
    return { code, env: JSON.parse(stdout || '{}') };
  }

  let payloadCounter = 0;
  async function runPayload(args: string[], payload: unknown): Promise<Captured> {
    const file = join(kb, `payload-${payloadCounter++}.json`);
    writeFileSync(file, JSON.stringify(payload));
    return run([...args, '--file', file]);
  }

  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-parity-'));
    await run(['init', kb]);

    const doc = join(kb, 'design-notes.md');
    writeFileSync(doc, SRC);
    cap.ingest = await run(['ingest', doc]);
    runtime.sourceId = cap.ingest.env.data!.sourceId as string;

    const chunksProbe = await run(['source', 'chunks', runtime.sourceId]);
    const chunks = chunksProbe.env.data!.chunks as Array<{ id: string; text: string }>;
    runtime.chunkId = chunks.find((c) => c.text.includes('caches results in Redis'))!.id;

    const root = await run(['node', 'create', '--title', 'Root', '--kind', 'root']);
    runtime.rootId = root.env.data!.nodeId as string;
    const leaf = await run(['node', 'create', '--title', 'Caching', '--kind', 'leaf', '--parent', runtime.rootId]);
    runtime.leafId = leaf.env.data!.nodeId as string;

    // claim apply — SUCCESS: an exact, unique quote. Marks leaf + root stale.
    cap.claimApplySuccess = await runPayload(['claim', 'apply'], {
      source_id: runtime.sourceId,
      claims: [
        {
          node_id: runtime.leafId,
          text: 'The widget service caches results in Redis.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: runtime.chunkId, quote: 'caches results in Redis' }],
        },
      ],
    });

    // claim apply — AMBIGUOUS-QUOTE FAILURE: the quote appears twice in the chunk.
    cap.claimApplyAmbiguous = await runPayload(['claim', 'apply'], {
      source_id: runtime.sourceId,
      claims: [
        {
          node_id: runtime.leafId,
          text: 'The cache layer stores data.',
          claim_type: 'fact',
          confidence: 0.8,
          spans: [{ chunk_id: runtime.chunkId, quote: 'The cache layer stores data' }],
        },
      ],
    });

    const shown = await run(['node', 'show', runtime.leafId]);
    runtime.claimId = (shown.env.data!.claims as Array<{ id: string }>)[0]!.id;

    // synthesize the leaf, citing the claim, which clears the leaf's stale flag.
    cap.synthesize = await runPayload(['synthesize'], {
      node_id: runtime.leafId,
      expected_body_hash: '',
      body_md: `The widget service caches results in Redis for speed.[^${runtime.claimId}]\n`,
    });

    // Re-render so `render --check` observes a clean, no-drift state.
    await run(['render']);

    // Read-only captures against the final (warning-only: 1 stale root) state.
    cap.status = await run(['status']);
    cap.sourceShow = await run(['source', 'show', runtime.sourceId]);
    cap.sourceChunks = await run(['source', 'chunks', runtime.sourceId]);
    cap.nodeTree = await run(['node', 'tree']);
    cap.nodeShow = await run(['node', 'show', runtime.leafId]);
    cap.provenance = await run(['provenance', runtime.claimId]);
    cap.search = await run(['search', 'Redis']);
    cap.askContext = await run(['ask-context', 'How does caching work?']);
    cap.answerCheck = await runPayload(['answer-check'], {
      answer: `The widget service caches results in Redis for speed.[^${runtime.claimId}]`,
    });
    cap.verify = await run(['verify']);
    cap.verifyStrict = await run(['verify', '--strict']);
    cap.renderCheck = await run(['render', '--check']);

    // graph apply — captured LAST so the read-only goldens above stay frozen against a
    // graph-free KB. Its evidence deliberately mixes one quote whose span the claim above
    // already persisted with one new quote, so the receipt's created-vs-reused split is
    // exercised rather than asserted trivially (03 §3.2).
    cap.graphApply = await runPayload(['graph', 'apply'], {
      source_id: runtime.sourceId,
      entities: [
        { type: 'Service', name: 'Widget Service', description: 'Serves widgets.', confidence: 0.9 },
        { type: 'DataStore', name: 'Redis', description: 'Cache store.', confidence: 0.9 },
      ],
      relationships: [
        {
          type: 'depends_on',
          subject: { type: 'Service', name: 'Widget Service' },
          object: { type: 'DataStore', name: 'Redis' },
          description: 'The widget service caches in Redis.',
          confidence: 0.9,
          evidence: [
            { chunk_id: runtime.chunkId, quote: QUOTE, role: 'supports' },
            { chunk_id: runtime.chunkId, quote: 'in Redis for speed', role: 'supports' },
          ],
        },
      ],
    });
  });

  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('derives the frozen deterministic ids', () => {
    // The fixed seed must derive exactly these content-addressed ids; a change in
    // id derivation breaks this before it can silently pass the goldens below.
    expect(runtime).toEqual({
      sourceId: SOURCE_ID,
      chunkId: CHUNK_ID,
      rootId: ROOT_ID,
      leafId: LEAF_ID,
      claimId: CLAIM_ID,
    });
  });

  it('status', () => {
    expect(cap.status.code).toBe(0);
    expect(cap.status.env).toMatchObject({
      ok: true,
      data: {
        root: anyString,
        sources: 1,
        chunks: 1,
        nodes: 2,
        staleNodes: 1,
        claims: 1,
        spans: 1,
        entities: 0,
        relationships: 0,
      },
      warnings: [],
      errors: [],
    });
  });

  it('ingest', () => {
    expect(cap.ingest.code).toBe(0);
    expect(cap.ingest.env).toMatchObject({
      ok: true,
      data: {
        sourceId: SOURCE_ID,
        title: 'Caching',
        status: 'new',
        updated: false,
        chunks: 1,
        // `next` is now a DEPRECATED alias mirroring nextActions[0].command verbatim
        // (03 §3 compatibility matrix); the old "Read chunks with: …" prose is dropped.
        next: `kb source chunks ${SOURCE_ID} --json`,
      },
      nextActions: [{ title: 'Read the new source chunks', command: `kb source chunks ${SOURCE_ID} --json` }],
      warnings: [],
      errors: [],
    });
  });

  it('source show', () => {
    expect(cap.sourceShow.code).toBe(0);
    expect(cap.sourceShow.env).toMatchObject({
      ok: true,
      data: {
        id: SOURCE_ID,
        sha256: SOURCE_SHA256,
        storedPath: STORED_PATH,
        originalPath: anyString,
        title: 'Caching',
        mediaType: 'text/markdown',
        byteSize: SOURCE_BYTES,
        sourceDate: null,
        author: null,
        versionLabel: null,
        supersedesSourceId: null,
        status: 'active',
        metadataJson: '{}',
        ingestedAt: anyString,
      },
      warnings: [],
      errors: [],
    });
  });

  it('source chunks', () => {
    expect(cap.sourceChunks.code).toBe(0);
    expect(cap.sourceChunks.env).toMatchObject({
      ok: true,
      data: {
        sourceId: SOURCE_ID,
        chunks: [
          {
            id: CHUNK_ID,
            chunkIndex: 0,
            headingPath: 'Caching',
            text: SRC,
          },
        ],
      },
      warnings: [],
      errors: [],
    });
  });

  it('claim apply — success', () => {
    expect(cap.claimApplySuccess.code).toBe(0);
    expect(cap.claimApplySuccess.env).toMatchObject({
      ok: true,
      data: {
        // Authoritative per-input receipt (03 §3.1).
        claims: [
          {
            inputIndex: 0,
            claimId: CLAIM_ID,
            outcome: 'created',
            spans: { submitted: 1, spansCreated: 1, spansReused: 0, linksCreated: 1, linksReused: 0 },
          },
        ],
        totals: { created: 1, updated: 0, unchanged: 0, spansCreated: 1, spansReused: 0, linksCreated: 1, linksReused: 0, linksUpdated: 0 },
        staleNodes: [LEAF_ID, ROOT_ID],
        // Deprecated aliases (compat matrix: spansCreated → spansCreatedNet).
        claimsCreated: 1,
        claimsUpdated: 0,
        affectedNodes: 1,
        spansCreatedNet: 1,
      },
      warnings: [],
      errors: [],
    });
  });

  it('graph apply — success', () => {
    expect(cap.graphApply.code).toBe(0);
    expect(cap.graphApply.env).toMatchObject({
      ok: true,
      data: {
        // Authoritative per-input receipts (03 §3.2).
        entities: [
          { inputIndex: 0, entityId: WIDGET_ENTITY_ID, outcome: 'created' },
          { inputIndex: 1, entityId: REDIS_ENTITY_ID, outcome: 'created' },
        ],
        relationships: [
          {
            inputIndex: 0,
            relationshipId: RELATIONSHIP_ID,
            outcome: 'created',
            // One evidence quote reuses the span the claim above persisted; the other is new.
            evidence: { submitted: 2, spansCreated: 1, spansReused: 1, linksCreated: 2, linksReused: 0 },
          },
        ],
        totals: {
          entitiesCreated: 2,
          entitiesUpdated: 0,
          entitiesUnchanged: 0,
          entitiesReferenced: 2,
          relationshipsCreated: 1,
          relationshipsUpdated: 0,
          relationshipsUnchanged: 0,
          spansCreated: 1,
          spansReused: 1,
          linksCreated: 2,
          linksReused: 0,
        },
        // Deprecated aggregate aliases (compat matrix); `spansCreated` is the NET new-span count.
        entitiesCreated: 2,
        entitiesUpdated: 0,
        entitiesUnchanged: 0,
        entitiesReferenced: 2,
        relationshipsCreated: 1,
        relationshipsUpdated: 0,
        relationshipsUnchanged: 0,
        spansCreated: 1,
      },
      warnings: [],
      errors: [],
    });
    // No stale chain: graph never stales nodes, so the receipt omits the field entirely
    // and steering points at the exact source-scoped relationship contribution.
    expect('staleNodes' in (cap.graphApply.env.data as object)).toBe(false);
    expect(cap.graphApply.env.nextActions).toEqual([]);
    expect(cap.graphApply.env.hints).toEqual([
      `kb relationship list --source ${SOURCE_ID} --json`,
    ]);
  });

  it('claim apply — ambiguous-quote failure', () => {
    expect(cap.claimApplyAmbiguous.code).toBe(1);
    expect(cap.claimApplyAmbiguous.env).toMatchObject({
      ok: false,
      data: null,
      warnings: [],
      errors: [
        `quote is ambiguous in chunk ${CHUNK_ID} (appears more than once); provide a longer, unique quote`,
      ],
    });
  });

  it('node tree', () => {
    expect(cap.nodeTree.code).toBe(0);
    expect(cap.nodeTree.env).toMatchObject({
      ok: true,
      data: {
        nodes: [
          {
            id: ROOT_ID,
            parentId: null,
            title: 'Root',
            kind: 'root',
            depth: 0,
            isStale: true,
            claims: 0,
          },
          {
            id: LEAF_ID,
            parentId: ROOT_ID,
            title: 'Caching',
            kind: 'leaf',
            depth: 1,
            isStale: false,
            claims: 1,
          },
        ],
      },
      warnings: [],
      errors: [],
    });
  });

  it('node show', () => {
    expect(cap.nodeShow.code).toBe(0);
    expect(cap.nodeShow.env).toMatchObject({
      ok: true,
      data: {
        node: {
          id: LEAF_ID,
          parentId: ROOT_ID,
          slug: 'caching',
          title: 'Caching',
          kind: 'leaf',
          depth: 1,
          sortOrder: 0,
          summary: '',
          bodyMd: LEAF_BODY_MD,
          bodyHash: LEAF_BODY_HASH,
          isStale: false,
          createdAt: anyString,
          updatedAt: anyString,
        },
        claims: [
          {
            id: CLAIM_ID,
            nodeId: LEAF_ID,
            text: 'The widget service caches results in Redis.',
            normalizedText: 'the widget service caches results in redis',
            claimType: 'fact',
            confidence: 0.9,
            status: 'active',
            supersededByClaimId: null,
            firstSeenSourceId: SOURCE_ID,
            createdAt: anyString,
            updatedAt: anyString,
          },
        ],
      },
      warnings: [],
      errors: [],
    });
  });

  it('synthesize', () => {
    expect(cap.synthesize.code).toBe(0);
    expect(cap.synthesize.env).toMatchObject({
      ok: true,
      data: {
        updated: true,
        unchanged: false,
        missingCitations: [],
      },
      warnings: [],
      errors: [],
    });
  });

  it('verify — non-strict on a warning-only KB', () => {
    expect(cap.verify.code).toBe(0);
    expect(cap.verify.env).toMatchObject({
      ok: true,
      data: {
        ok: true,
        errors: 0,
        warnings: 1,
        findings: [
          {
            check: 'no-stale-nodes',
            severity: 'warning',
            message: '1 node(s) are stale and need re-synthesis',
            ids: [ROOT_ID],
          },
        ],
      },
      warnings: ['no-stale-nodes: 1 node(s) are stale and need re-synthesis'],
      errors: [],
    });
    // The warning finding surfaces as exactly one warning-severity envelope issue;
    // non-strict never manufactures an error, so ok stays true (01 §2).
    expect(cap.verify.env.issues.some((i) => i.severity === 'error')).toBe(false);
    expect(cap.verify.env.issues).toEqual([
      expect.objectContaining({ severity: 'warning', message: 'no-stale-nodes: 1 node(s) are stale and need re-synthesis' }),
    ]);
    // The payload finding keeps `check` + severity and GAINS the mapped `code` (01 §3.2).
    const finding = (cap.verify.env.data as { findings: Array<{ check: string; code: string; severity: string }> }).findings[0]!;
    expect(finding).toMatchObject({ check: 'no-stale-nodes', code: 'NO_STALE_NODES', severity: 'warning' });
  });

  it('verify --strict on a warning-only KB', () => {
    expect(cap.verifyStrict.code).toBe(1);
    expect(cap.verifyStrict.env).toMatchObject({
      ok: false,
      data: {
        ok: false,
        errors: 0,
        warnings: 1,
        findings: [
          {
            check: 'no-stale-nodes',
            severity: 'warning',
            message: '1 node(s) are stale and need re-synthesis',
            ids: [ROOT_ID],
          },
        ],
      },
      warnings: ['no-stale-nodes: 1 node(s) are stale and need re-synthesis'],
      errors: ['strict: no-stale-nodes: 1 node(s) are stale and need re-synthesis'],
    });
    // data.findings severity is unchanged (still 'warning'); strict ADDITIONALLY
    // emits an error-severity envelope issue with the same code and a 'strict: '
    // prefix, which is what flips ok to false (01 §2, finding 9).
    const issues = cap.verifyStrict.env.issues;
    const warn = issues.find((i) => i.severity === 'warning' && i.message.startsWith('no-stale-nodes'));
    const err = issues.find((i) => i.severity === 'error');
    expect(warn).toBeDefined();
    expect(err?.message).toBe('strict: no-stale-nodes: 1 node(s) are stale and need re-synthesis');
    expect(err?.code).toBe(warn?.code);
    // The payload finding severity is unchanged (still 'warning') and carries `code`.
    const finding = (cap.verifyStrict.env.data as { findings: Array<{ check: string; code: string; severity: string }> }).findings[0]!;
    expect(finding).toMatchObject({ check: 'no-stale-nodes', code: 'NO_STALE_NODES', severity: 'warning' });
  });

  it('render --check', () => {
    expect(cap.renderCheck.code).toBe(0);
    expect(cap.renderCheck.env).toMatchObject({
      ok: true,
      data: {
        checked: 7,
        drift: [],
      },
      warnings: [],
      errors: [],
    });
  });

  it('search', () => {
    expect(cap.search.code).toBe(0);
    expect(cap.search.env).toMatchObject({
      ok: true,
      data: {
        query: 'Redis',
        // Single-token query: every FTS scope hits on strict AND (no fallback);
        // entities always report 'like'. (05 §1; additive `matchModes` key.)
        matchModes: { chunks: 'all', claims: 'all', nodes: 'all', entities: 'like' },
        hits: [
          {
            kind: 'chunk',
            id: CHUNK_ID,
            title: 'Caching',
            snippet:
              '# Caching The cache layer stores data. The cache layer stores data in Redis for durability. The widget service caches results in Redis for speed.',
            sourceId: SOURCE_ID,
            matchMode: 'all',
            rank: expect.any(Number),
          },
          {
            kind: 'claim',
            id: CLAIM_ID,
            title: 'fact',
            snippet: 'The widget service caches results in Redis.',
            sourceId: SOURCE_ID,
            matchMode: 'all',
            rank: expect.any(Number),
          },
          {
            kind: 'node',
            id: LEAF_ID,
            title: 'Caching',
            snippet: `The widget service caches results in Redis for speed.[^${CLAIM_ID}]`,
            matchMode: 'all',
            rank: expect.any(Number),
          },
        ],
      },
      warnings: [],
      errors: [],
    });
  });

  it('ask-context', () => {
    expect(cap.askContext.code).toBe(0);
    expect(cap.askContext.env).toMatchObject({
      ok: true,
      data: {
        question: 'How does caching work?',
        claims: [
          {
            id: CLAIM_ID,
            text: 'The widget service caches results in Redis.',
            claimType: 'fact',
            confidence: 0.9,
            status: 'active',
            nodeId: LEAF_ID,
            nodeTitle: 'Caching',
            provenance: [
              {
                sourceTitle: 'Caching',
                quote: QUOTE,
                storedPath: STORED_PATH,
              },
            ],
          },
        ],
        nodes: [
          {
            id: LEAF_ID,
            title: 'Caching',
            snippet: `The widget service caches results in Redis for speed.[^${CLAIM_ID}]`,
          },
        ],
        entities: [],
        // No filters supplied → both echoed as null (additive `applied` key, 05 §2).
        applied: { claimType: null, node: null },
      },
      warnings: [],
      errors: [],
    });
  });

  it('answer-check', () => {
    expect(cap.answerCheck.code).toBe(0);
    expect(cap.answerCheck.env).toMatchObject({
      ok: true,
      data: {
        ok: true,
        citedClaims: [CLAIM_ID],
        unknownCitations: [],
        inactiveCitations: [],
        uncited: [],
        uncitedSentences: [],
      },
      warnings: [],
      errors: [],
    });
  });

  it('provenance', () => {
    expect(cap.provenance.code).toBe(0);
    expect(cap.provenance.env).toMatchObject({
      ok: true,
      data: {
        claim: {
          id: CLAIM_ID,
          nodeId: LEAF_ID,
          text: 'The widget service caches results in Redis.',
          normalizedText: 'the widget service caches results in redis',
          claimType: 'fact',
          confidence: 0.9,
          status: 'active',
          supersededByClaimId: null,
          firstSeenSourceId: SOURCE_ID,
          createdAt: anyString,
          updatedAt: anyString,
        },
        provenance: [
          {
            quote: QUOTE,
            charStart: QUOTE_START,
            charEnd: QUOTE_END,
            sourceTitle: 'Caching',
            storedPath: STORED_PATH,
          },
        ],
      },
      warnings: [],
      errors: [],
    });
  });
});
