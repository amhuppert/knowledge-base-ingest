import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * `kb node show <id> --context` (04 §1) — the synthesis-ready bundle, driven through the
 * real dispatcher against a temp KB. One read returns the full node (body included), its
 * children with own-claim counts, ONE owner-tagged claim list for the whole subtree, the
 * sources behind those claims, the validator's `allowedCitationIds`, and stats. Without
 * `--context` the command's behavior is unchanged.
 */

interface ContextData {
  node: { id: string; bodyMd: string; bodyHash: string; isStale: boolean; summary: string };
  children: Array<{ id: string; title: string; kind: string; summary: string; isStale: boolean; ownClaims: number }>;
  claims: Array<{
    id: string;
    text: string;
    claimType: string;
    status: string;
    confidence: number;
    nodeId: string;
    nodeTitle: string;
    provenance: Array<{ sourceId: string; sourceTitle: string; quoteSnippet: string }>;
  }>;
  sources: Array<{ id: string; title: string; claimCount: number }>;
  allowedCitationIds: string[];
  stats: { descendantNodes: number; claims: number; approxTokens: number; complete: boolean };
}

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; message: string }>;
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

let kb: string;
let sourceId = '';
let chunkId = '';
let rootId = '';
let topicId = '';
let leafId = '';
let leafClaimId = '';

const LONG_QUOTE =
  'The rate limiter enforces a rolling window of one thousand requests per second per tenant, and it sheds load at the edge before any request reaches the application tier, which keeps the origin fleet stable during bursts.';

async function run(args: string[]): Promise<CliResult> {
  let stdout = '';
  const io: CliIo = {
    stdout: (c) => (stdout += c),
    stderr: () => {},
    cwd: process.cwd(),
    env: { ...process.env, KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(stdout || '{}') };
}

let payloadCounter = 0;
function writePayload(payload: unknown): string {
  const file = join(kb, `payload-${payloadCounter++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

async function createNode(title: string, kind: string, parent?: string): Promise<string> {
  const args = ['node', 'create', '--title', title, '--kind', kind];
  if (parent) args.push('--parent', parent);
  return ((await run(args)).json.data as { nodeId: string }).nodeId;
}

/** Apply one claim and return its id (read back from the node's own claim list). */
async function applyClaim(nodeId: string, text: string, quote: string): Promise<string> {
  const file = writePayload({
    source_id: sourceId,
    claims: [{ node_id: nodeId, text, claim_type: 'fact', confidence: 0.9, spans: [{ chunk_id: chunkId, quote }] }],
  });
  const applied = await run(['claim', 'apply', '--file', file]);
  expect(applied.json.ok, JSON.stringify(applied.json.issues)).toBe(true);
  const shown = await run(['node', 'show', nodeId]);
  const claims = (shown.json.data as { claims: Array<{ id: string; text: string }> }).claims;
  return claims.find((c) => c.text === text)!.id;
}

beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-nodectx-cli-'));
  await run(['init', kb]);
  const doc = join(kb, 'doc.md');
  writeFileSync(doc, `# Limits\n\n${LONG_QUOTE}\nThe cache holds entries for sixty seconds.\n`);
  sourceId = ((await run(['ingest', doc])).json.data as { sourceId: string }).sourceId;
  const chunks = (await run(['source', 'chunks', sourceId])).json.data as {
    chunks: Array<{ id: string; text: string }>;
  };
  chunkId = chunks.chunks.find((c) => c.text.includes('sixty seconds'))!.id;

  rootId = await createNode('Root', 'root');
  topicId = await createNode('Limits', 'topic', rootId);
  leafId = await createNode('Rate limiting', 'leaf', topicId);
  leafClaimId = await applyClaim(leafId, 'The cache holds entries for a minute.', 'holds entries for sixty seconds');
  await applyClaim(topicId, 'The limiter sheds load at the edge.', 'sheds load at the edge');
});

afterAll(() => rmSync(kb, { recursive: true, force: true }));

describe('kb node show --context — the 04 §1 bundle', () => {
  it('returns the full node (body + hash), children with ownClaims, subtree claims, sources, allowed ids and stats', async () => {
    const r = await run(['node', 'show', rootId, '--context']);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    const data = r.json.data as unknown as ContextData;

    expect(Object.keys(data)).toEqual(['node', 'children', 'claims', 'sources', 'allowedCitationIds', 'stats']);
    expect(data.node).toMatchObject({ id: rootId, isStale: true });
    expect(typeof data.node.bodyMd).toBe('string');
    expect(typeof data.node.bodyHash).toBe('string');

    expect(data.children).toEqual([
      expect.objectContaining({ id: topicId, title: 'Limits', kind: 'topic', ownClaims: 1 }),
    ]);

    // ONE claim list for the WHOLE subtree, each entry owner-tagged with its node.
    expect(data.claims.map((c) => c.nodeId).sort()).toEqual([leafId, topicId].sort());
    const leafClaim = data.claims.find((c) => c.id === leafClaimId)!;
    expect(leafClaim).toMatchObject({ nodeTitle: 'Rate limiting', status: 'active', claimType: 'fact' });
    expect(leafClaim.provenance).toEqual([
      { sourceId, sourceTitle: expect.any(String), quoteSnippet: 'holds entries for sixty seconds' },
    ]);

    expect(data.sources).toEqual([{ id: sourceId, title: expect.any(String), claimCount: 2 }]);
    expect(data.allowedCitationIds).toEqual([...data.claims.map((c) => c.id)].sort());
    expect(data.stats).toEqual({
      descendantNodes: 2,
      claims: 2,
      approxTokens: expect.any(Number),
      complete: true,
    });
  });

  it('scopes the bundle to the requested subtree (leaf sees only its own claims)', async () => {
    const data = (await run(['node', 'show', leafId, '--context'])).json.data as unknown as ContextData;
    expect(data.children).toEqual([]);
    expect(data.claims.map((c) => c.id)).toEqual([leafClaimId]);
    expect(data.stats).toMatchObject({ descendantNodes: 0, claims: 1, complete: true });
  });

  it('steers with the synthesis authoring TEMPLATE as a hint, never as a next-action (01 §2)', async () => {
    const r = await run(['node', 'show', leafId, '--context']);
    expect(r.json.nextActions).toEqual([]);
    expect(r.json.hints.join(' ')).toContain('kb synthesize --file <payload.json> --dry-run --json');
    // Nothing carrying a placeholder may appear as a next-action.
    for (const na of r.json.nextActions) expect(na.command).not.toMatch(/[<>]/);
  });

  it('reports an unknown node with the structured UNKNOWN_NODE code and its registry hint', async () => {
    const r = await run(['node', 'show', 'nod_missing', '--context']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.data).toBeNull();
    expect(r.json.issues).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_NODE',
        severity: 'error',
        path: 'node_id',
        ids: ['nod_missing'],
        hint: expect.stringContaining('kb node tree'),
      }),
    ]);
  });

  it('reports a malformed node id with INVALID_ARGUMENT', async () => {
    const r = await run(['node', 'show', 'not-an-id', '--context']);
    expect(r.code).toBe(1);
    expect(r.json.issues).toEqual([expect.objectContaining({ code: 'INVALID_ARGUMENT', path: 'node_id' })]);
  });

  // 01 §3.2: `LEGACY` emission is forbidden from Phase 1 on. Every diagnostic this
  // Phase-2 path can produce must carry a real registry code.
  it('never emits LEGACY from the --context path', async () => {
    for (const id of ['nod_missing', 'not-an-id', leafId]) {
      const r = await run(['node', 'show', id, '--context']);
      expect(r.json.issues.map((i) => i.code)).not.toContain('LEGACY');
    }
  });
});

describe('kb node show without --context is unchanged', () => {
  it('emits exactly the legacy { node, claims } payload and no context steering', async () => {
    const r = await run(['node', 'show', leafId]);
    expect(r.code).toBe(0);
    expect(Object.keys(r.json.data!)).toEqual(['node', 'claims']);
    expect(r.json.hints).toEqual([]);
    expect(r.json.nextActions).toEqual([]);
  });
});

describe('kb node show --context — snippet truncation hint', () => {
  it('names kb provenance whenever any quoteSnippet was truncated', async () => {
    const truncNode = await createNode('Long quotes', 'leaf', topicId);
    await applyClaim(truncNode, 'The limiter enforces a rolling window.', LONG_QUOTE);

    const r = await run(['node', 'show', truncNode, '--context']);
    const data = r.json.data as unknown as ContextData;
    const snippet = data.claims[0]!.provenance[0]!.quoteSnippet;
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toHaveLength(161);
    expect(r.json.hints.join(' ')).toContain('kb provenance');

    // A node whose snippets all fit gets no provenance hint.
    const short = await run(['node', 'show', leafId, '--context']);
    expect(short.json.hints.join(' ')).not.toContain('kb provenance');
  });
});

describe('kb node show --context — oversized bundle', () => {
  it('adds the synthesize-children-first hint when approxTokens exceeds 24000', async () => {
    const bigKb = mkdtempSync(join(tmpdir(), 'kb-nodectx-big-'));
    const previous = kb;
    kb = bigKb;
    try {
      await run(['init', kb]);
      const doc = join(kb, 'big.md');
      writeFileSync(doc, '# Big\n\nThe queue drains in ten seconds.\n');
      sourceId = ((await run(['ingest', doc])).json.data as { sourceId: string }).sourceId;
      const chunks = (await run(['source', 'chunks', sourceId])).json.data as {
        chunks: Array<{ id: string; text: string }>;
      };
      chunkId = chunks.chunks.find((c) => c.text.includes('ten seconds'))!.id;

      const bigRoot = await createNode('Root', 'root');
      const bigLeaf = await createNode('Queueing', 'leaf', bigRoot);
      // ~110k characters of claim text ⇒ approxTokens well over the 24000 threshold.
      await applyClaim(bigLeaf, `The queue drains in ten seconds. ${'Backpressure is applied upstream. '.repeat(3000)}`, 'drains in ten seconds');

      const r = await run(['node', 'show', bigRoot, '--context']);
      const data = r.json.data as unknown as ContextData;
      expect(data.stats.approxTokens).toBeGreaterThan(24000);
      expect(r.json.hints.join(' ')).toMatch(/synthesize .*children first/i);
    } finally {
      rmSync(bigKb, { recursive: true, force: true });
      kb = previous;
    }
  });
});

describe('kb node show --help documents --context', () => {
  it('lists the --context flag and a --context example', async () => {
    const r = await run(['node', 'show', '--help']);
    expect(r.code).toBe(0);
    const spec = r.json.data as unknown as {
      flags: Array<{ flags: string }>;
      examples: Array<{ command: string }>;
    };
    expect(spec.flags.map((f) => f.flags)).toContain('--context');
    expect(spec.examples.some((e) => e.command.includes('--context'))).toBe(true);
  });
});
