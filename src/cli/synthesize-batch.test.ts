import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { receiptProjection } from './receiptParity.js';

/**
 * BATCH `kb synthesize --file` (04 §3). The command still accepts the single object
 * unchanged; a `{"nodes":[…]}` payload (≤200) is prevalidated as a whole, applied
 * deepest-first in one transaction, and answered with a per-node receipt that echoes
 * each node's depth in application order. Cap and duplicate-id violations are
 * `PAYLOAD_SCHEMA` failures that touch nothing.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; severity: string; message: string; path?: string; hint?: string }>;
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

interface NodeReceipt {
  inputIndex: number;
  nodeId: string;
  depth: number;
  outcome: string;
}

let kb: string;
let sourceId: string;
let chunkId: string;

async function runIo(args: string[]): Promise<CliResult> {
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
  const r = await runIo(args);
  return (r.json.data as { nodeId: string }).nodeId;
}

/** Apply one claim under `nodeId` quoting `quote`, and return its claim id. */
async function applyClaim(nodeId: string, text: string, quote: string): Promise<string> {
  const file = writePayload({
    source_id: sourceId,
    claims: [{ node_id: nodeId, text, claim_type: 'fact', confidence: 0.9, spans: [{ chunk_id: chunkId, quote }] }],
  });
  await runIo(['claim', 'apply', '--file', file]);
  const shown = await runIo(['node', 'show', nodeId]);
  return (shown.json.data as { claims: Array<{ id: string }> }).claims[0]!.id;
}

async function bodyOf(nodeId: string): Promise<string> {
  const shown = await runIo(['node', 'show', nodeId]);
  return (shown.json.data as { node: { bodyMd: string } }).node.bodyMd;
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-batch-'));
  await runIo(['init', kb]);
  const docPath = join(kb, 'doc.md');
  writeFileSync(docPath, '# Topic\n\nThe widget service caches results in Redis for speed and durability.\n');
  const ing = await runIo(['ingest', docPath]);
  sourceId = (ing.json.data as { sourceId: string }).sourceId;
  const chunks = await runIo(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('caches results in Redis'),
  )!.id;
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('kb synthesize --file — payload shape (04 §3)', () => {
  it.each([
    { name: 'apply', dryRun: false },
    { name: 'dry-run', dryRun: true },
  ])('requires expected_body_hash on every batch entry in $name', async ({ dryRun }) => {
    const rootId = await createNode('Root', 'root');
    const file = writePayload({ nodes: [{ node_id: rootId, body_md: 'Overview.' }] });
    const r = await runIo(['synthesize', '--file', file, ...(dryRun ? ['--dry-run'] : [])]);

    expect(r.code).toBe(1);
    expect(r.json.issues).toEqual([
      expect.objectContaining({ code: 'PAYLOAD_SCHEMA', path: 'nodes[0].expected_body_hash' }),
    ]);
  });

  it('still accepts the single object unchanged (receipt shape preserved)', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.', 'caches results in Redis');

    const file = writePayload({ node_id: leafId, expected_body_hash: '', body_md: `Caches in Redis.[^${claimId}]` });
    const r = await runIo(['synthesize', '--file', file]);

    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({ nodeId: leafId, outcome: 'updated', updated: true, unchanged: false });
    // The single-object receipt keeps its flat shape — no batch array is introduced.
    expect(r.json.data!['nodes']).toBeUndefined();
  });

  it('rejects a batch over the 200-node cap with PAYLOAD_SCHEMA and applies nothing', async () => {
    const rootId = await createNode('Root', 'root');
    const oversized = {
      nodes: Array.from({ length: 201 }, (_, i) => ({
        node_id: `nod_${String(i).padStart(16, '0')}`,
        expected_body_hash: '',
        body_md: 'Filler.',
      })),
    };
    const r = await runIo(['synthesize', '--file', writePayload(oversized)]);

    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    const issue = r.json.issues.find((i) => i.code === 'PAYLOAD_SCHEMA');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('200');
    expect(await bodyOf(rootId)).toBe('');
  });

  it('rejects a duplicate node_id with PAYLOAD_SCHEMA naming BOTH indices', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.', 'caches results in Redis');

    const payload = {
      nodes: [
        { node_id: leafId, expected_body_hash: '', body_md: `First.[^${claimId}]` },
        { node_id: rootId, expected_body_hash: '', body_md: `Root.[^${claimId}]` },
        { node_id: leafId, expected_body_hash: '', body_md: `Second.[^${claimId}]` },
      ],
    };
    const r = await runIo(['synthesize', '--file', writePayload(payload)]);

    expect(r.code).toBe(1);
    const issue = r.json.issues.find((i) => i.code === 'PAYLOAD_SCHEMA');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('nodes[0]');
    expect(issue!.message).toContain('nodes[2]');
    expect(await bodyOf(leafId)).toBe('');
    expect(await bodyOf(rootId)).toBe('');
  });
});

describe('kb synthesize --file {"nodes":[…]} — apply (04 §3)', () => {
  it('applies deepest-first with a depth-echoing receipt and totals', async () => {
    const rootId = await createNode('Root', 'root');
    const topicId = await createNode('Storage', 'topic', rootId);
    const leafId = await createNode('Caching', 'leaf', topicId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.', 'caches results in Redis');

    // Submitted shallowest-first — the receipt must come back deepest-first.
    const payload = {
      nodes: [
        { node_id: rootId, expected_body_hash: '', body_md: `Root prose.[^${claimId}]` },
        { node_id: topicId, expected_body_hash: '', body_md: `Topic prose.[^${claimId}]` },
        { node_id: leafId, expected_body_hash: '', body_md: `Leaf prose.[^${claimId}]` },
      ],
    };
    const r = await runIo(['synthesize', '--file', writePayload(payload)]);

    expect(r.code).toBe(0);
    expect(r.json.data!['nodes']).toEqual([
      {
        inputIndex: 2,
        nodeId: leafId,
        depth: 2,
        outcome: 'updated',
        bodyDelta: {
          charsBefore: 0,
          charsAfter: `Leaf prose.[^${claimId}]`.length,
          citationsAdded: [claimId],
          citationsRemoved: [],
          removedCurrent: [],
        },
      },
      {
        inputIndex: 1,
        nodeId: topicId,
        depth: 1,
        outcome: 'updated',
        bodyDelta: {
          charsBefore: 0,
          charsAfter: `Topic prose.[^${claimId}]`.length,
          citationsAdded: [claimId],
          citationsRemoved: [],
          removedCurrent: [],
        },
      },
      {
        inputIndex: 0,
        nodeId: rootId,
        depth: 0,
        outcome: 'updated',
        bodyDelta: {
          charsBefore: 0,
          charsAfter: `Root prose.[^${claimId}]`.length,
          citationsAdded: [claimId],
          citationsRemoved: [],
          removedCurrent: [],
        },
      },
    ]);
    expect(r.json.data!['totals']).toEqual({ updated: 3, unchanged: 0, staleCleared: 0 });
    expect(await bodyOf(leafId)).toBe(`Leaf prose.[^${claimId}]`);
  });

  it('fails atomically on ONE bad citation among good nodes (nodes[i]-pathed issue, nothing applied)', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.', 'caches results in Redis');

    const payload = {
      nodes: [
        { node_id: leafId, expected_body_hash: '', body_md: `Good.[^${claimId}]` },
        { node_id: rootId, expected_body_hash: '', body_md: 'Bad.[^clm_deadbeefdeadbeef]' },
      ],
    };
    const r = await runIo(['synthesize', '--file', writePayload(payload)]);

    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.issues.map((i) => ({ code: i.code, path: i.path }))).toEqual([
      { code: 'CITATION_UNKNOWN', path: 'nodes[1].body_md' },
    ]);
    expect(await bodyOf(leafId)).toBe('');
    expect(await bodyOf(rootId)).toBe('');
  });

  it('a batch that clears the LAST stale node steers to kb verify --strict --json', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.', 'caches results in Redis');

    const payload = {
      nodes: [
        { node_id: rootId, expected_body_hash: '', body_md: `Root prose.[^${claimId}]` },
        { node_id: leafId, expected_body_hash: '', body_md: `Leaf prose.[^${claimId}]` },
      ],
    };
    const r = await runIo(['synthesize', '--file', writePayload(payload)]);

    expect(r.code).toBe(0);
    expect(r.json.data!['staleNodes']).toEqual([]);
    expect(r.json.nextActions).toEqual([expect.objectContaining({ command: 'kb verify --strict --json' })]);
  });

  it('--dry-run previews the batch: receipt parity on the §2 projection, nothing persisted', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.', 'caches results in Redis');

    const file = writePayload({
      nodes: [
        { node_id: rootId, expected_body_hash: '', body_md: `Root prose.[^${claimId}]` },
        { node_id: leafId, expected_body_hash: '', body_md: `Leaf prose.[^${claimId}]` },
      ],
    });
    const dry = await runIo(['synthesize', '--file', file, '--dry-run']);
    // The preview rolled back, so the real apply starts from the same state.
    expect(await bodyOf(leafId)).toBe('');
    const real = await runIo(['synthesize', '--file', file]);

    expect(dry.code).toBe(0);
    expect(real.code).toBe(0);
    expect(receiptProjection(dry.json.data)).toEqual(receiptProjection(real.json.data));
    expect((receiptProjection(dry.json.data)['nodes'] as NodeReceipt[]).map((n) => n.depth)).toEqual([1, 0]);
    expect(dry.json.data?.['dryRun']).toBe(true);
    expect(real.json.data?.['dryRun']).toBeUndefined();
    expect(dry.json.nextActions).toEqual([
      expect.objectContaining({ command: `kb synthesize --file=${file} --json` }),
    ]);
  });
});
