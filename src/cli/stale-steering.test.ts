import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * STALE-TARGET V2 IN PRODUCTION (01 §6.1, 04 deliverable 4).
 *
 * The flip is only real if a REAL command emits it, so this drives `kb claim apply`
 * through the actual dispatcher and asserts the emitted envelope carries
 * `kb node show <id> --context --json`, deepest-first. A `--dry-run` preview must still
 * steer exclusively to its replay (03 §2) — the stale follow-ups belong to a real apply.
 */

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

function claimPayload(nodeId: string, text: string): string {
  return writePayload({
    source_id: sourceId,
    claims: [
      { node_id: nodeId, text, claim_type: 'fact', confidence: 0.9, spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }] },
    ],
  });
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-stale-steering-'));
  await run(['init', kb]);
  const doc = join(kb, 'doc.md');
  writeFileSync(doc, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
  sourceId = ((await run(['ingest', doc])).json.data as { sourceId: string }).sourceId;
  const chunks = (await run(['source', 'chunks', sourceId])).json.data as { chunks: Array<{ id: string; text: string }> };
  chunkId = chunks.chunks.find((c) => c.text.includes('caches results in Redis'))!.id;
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('kb claim apply — stale steering (production call path)', () => {
  it('points at the remaining stale nodes with the v2 --context target, deepest first', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);

    const r = await run(['claim', 'apply', '--file', claimPayload(leafId, 'The widget service caches in Redis.')]);

    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    // Deepest first: the leaf that now owns the claim, then its stale ancestor.
    expect(r.json.nextActions.map((n) => n.command)).toEqual([
      `kb node show ${leafId} --context --json`,
      `kb node show ${rootId} --context --json`,
    ]);
    // Both stale nodes are listed, so nothing is reported as omitted.
    expect(r.json.hints).toEqual([]);
  });

  it('caps the follow-ups at three and states shown-vs-total for the rest', async () => {
    const rootId = await createNode('Root', 'root');
    const leaves = [
      await createNode('Alpha', 'leaf', rootId),
      await createNode('Bravo', 'leaf', rootId),
      await createNode('Charlie', 'leaf', rootId),
    ];
    for (const [i, leafId] of leaves.entries()) {
      await run(['claim', 'apply', '--file', claimPayload(leafId, `Claim number ${i} about Redis.`)]);
    }

    const r = await run(['claim', 'apply', '--file', claimPayload(leaves[0]!, 'One more claim about Redis.')]);

    expect(r.json.nextActions).toHaveLength(3);
    for (const na of r.json.nextActions) expect(na.command).toMatch(/^kb node show nod_\w+ --context --json$/);
    // 4 nodes are stale (3 leaves + root): 3 shown, 1 stated as not listed.
    expect(r.json.hints).toHaveLength(1);
    expect(r.json.hints[0]).toContain('3 of 4');
    expect(r.json.hints[0]).toContain('1 not listed');
  });

  it('a --dry-run preview steers ONLY to the replay, never to the stale follow-ups (03 §2)', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const file = claimPayload(leafId, 'The widget service caches in Redis.');

    const dry = await run(['claim', 'apply', '--file', file, '--dry-run']);

    expect(dry.json.nextActions).toEqual([
      expect.objectContaining({ command: `kb claim apply --file=${file} --json` }),
    ]);
    expect(dry.json.nextActions.some((n) => n.command.startsWith('kb node show'))).toBe(false);
    expect(dry.json.hints).toEqual([]);
  });
});
