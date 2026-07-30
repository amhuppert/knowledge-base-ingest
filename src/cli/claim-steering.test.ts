import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * `claim apply` steering wired end-to-end (03 §2/§6, 01 §6.1, acceptance criterion 7).
 * A real apply steers per the stale rows: stale > 0 → up to 3 verbatim deepest-first
 * `node show` next-actions + a remainder hint; stale = 0 → `kb verify --strict --json`;
 * a quote failure → `kb source chunks <sourceId> --json`.
 *
 * The stale TARGET is the named flip (01 §6.1): Phase 1 emitted `kb node show <id> --json`,
 * Phase 2 flips it to the `--context` bundle. This suite asserts the flipped target because
 * `node show --context` has shipped; the rows themselves (order, cap, remainder) are
 * unchanged by the flip.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; message: string }>;
    errors: string[];
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

let kb: string;
let sourceId: string;
let chunkId: string;
let nodeId: string;
let rootId: string;

async function runIo(args: string[]): Promise<CliResult> {
  const out = { stdout: '' };
  const io: CliIo = {
    stdout: (c) => (out.stdout += c),
    stderr: () => {},
    cwd: process.cwd(),
    env: { ...process.env, KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(out.stdout || '{}') };
}

let counter = 0;
function writePayload(payload: unknown): string {
  const file = join(kb, `payload-${counter++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

function claimPayload(quote = 'caches results in Redis'): unknown {
  return {
    source_id: sourceId,
    claims: [
      { node_id: nodeId, text: 'The widget service caches in Redis.', claim_type: 'fact', confidence: 0.9, spans: [{ chunk_id: chunkId, quote }] },
    ],
  };
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-steer-'));
  await runIo(['init', kb]);
  const docPath = join(kb, 'doc.md');
  writeFileSync(docPath, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
  const ing = await runIo(['ingest', docPath]);
  sourceId = (ing.json.data as { sourceId: string }).sourceId;
  const chunks = await runIo(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('caches results in Redis'),
  )!.id;
  const root = await runIo(['node', 'create', '--title', 'Root', '--kind', 'root']);
  rootId = (root.json.data as { nodeId: string }).nodeId;
  const leaf = await runIo(['node', 'create', '--title', 'Caching', '--kind', 'leaf', '--parent', rootId]);
  nodeId = (leaf.json.data as { nodeId: string }).nodeId;
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('claim apply steering (criterion 7)', () => {
  it('stale > 0 → deepest-first kb node show next-actions (leaf before root), no remainder under the cap', async () => {
    const res = await runIo(['claim', 'apply', '--file', writePayload(claimPayload())]);
    expect(res.code).toBe(0);
    expect(res.json.nextActions.map((n) => n.command)).toEqual([
      `kb node show ${nodeId} --context --json`,
      `kb node show ${rootId} --context --json`,
    ]);
    // Only two stale nodes, both shown — no remainder hint.
    expect(res.json.hints).toEqual([]);
  });

  it('stale = 0 → kb verify --strict --json', async () => {
    // Apply, then synthesize both stale nodes so a subsequent exact repeat leaves nothing stale.
    await runIo(['claim', 'apply', '--file', writePayload(claimPayload())]);
    const shown = await runIo(['node', 'show', nodeId]);
    const claimId = (shown.json.data as { claims: Array<{ id: string }> }).claims[0]!.id;
    await runIo(['synthesize', '--file', writePayload({ node_id: nodeId, expected_body_hash: '', body_md: `Caches.[^${claimId}]` })]);
    await runIo(['synthesize', '--file', writePayload({ node_id: rootId, expected_body_hash: '', body_md: 'Overview.' })]);

    const repeat = await runIo(['claim', 'apply', '--file', writePayload(claimPayload())]);
    expect(repeat.code).toBe(0);
    expect((repeat.json.data as { totals: { unchanged: number } }).totals.unchanged).toBe(1);
    expect(repeat.json.nextActions).toEqual([expect.objectContaining({ command: 'kb verify --strict --json' })]);
  });

  it('a quote failure steers to kb source chunks <sourceId> --json', async () => {
    const res = await runIo(['claim', 'apply', '--file', writePayload(claimPayload('this text is absent from the source'))]);
    expect(res.code).toBe(1);
    expect(res.json.ok).toBe(false);
    expect(res.json.issues.map((i) => i.code)).toContain('QUOTE_NOT_FOUND');
    expect(res.json.nextActions).toEqual([expect.objectContaining({ command: `kb source chunks ${sourceId} --json` })]);
  });
});
