import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end CLI wiring test: spawns the real `kb` binary against a temp KB and
 * asserts the output envelope, exit codes, and the provenance gate. This is the
 * only test that exercises argument parsing + command dispatch + the workspace.
 */

interface CliResult {
  code: number;
  json: { ok: boolean; data: unknown; warnings: string[]; errors: string[] };
}

const BIN = join(process.cwd(), 'bin', 'kb');

function makeKb(): string {
  return mkdtempSync(join(tmpdir(), 'kb-cli-'));
}

function run(kbDir: string, args: string[]): CliResult {
  const env = { ...process.env, KB_DIR: kbDir };
  try {
    const out = execFileSync(BIN, [...args, '--json'], { env, encoding: 'utf8' });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, json: JSON.parse(err.stdout ?? '{}') };
  }
}

function runStdin(kbDir: string, args: string[], stdin: string): CliResult {
  const env = { ...process.env, KB_DIR: kbDir };
  try {
    const out = execFileSync(BIN, [...args, '--json'], { env, encoding: 'utf8', input: stdin });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, json: JSON.parse(err.stdout ?? '{}') };
  }
}

describe('kb CLI (subprocess)', () => {
  let kb: string;
  let sourceId: string;
  let chunkId: string;
  let nodeId: string;

  beforeAll(() => {
    kb = makeKb();
    const init = run(kb, ['init', kb]);
    expect(init.json.ok).toBe(true);

    const docPath = join(kb, 'doc.md');
    writeFileSync(docPath, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
    const ing = run(kb, ['ingest', docPath]);
    expect(ing.json.ok).toBe(true);
    sourceId = (ing.json.data as { sourceId: string }).sourceId;

    const chunks = run(kb, ['source', 'chunks', sourceId]);
    const cs = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks;
    chunkId = cs.find((c) => c.text.includes('caches results in Redis'))!.id;

    const node = run(kb, ['node', 'create', '--title', 'Topic', '--kind', 'root']);
    nodeId = (node.json.data as { nodeId: string }).nodeId;
  });

  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('init produced a usable KB', () => {
    const status = run(kb, ['status']);
    expect(status.json.ok).toBe(true);
    expect((status.json.data as { sources: number }).sources).toBe(1);
  });

  it('applies a claim with an exact quote (exit 0)', () => {
    const payload = JSON.stringify({
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'The widget service caches in Redis.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }],
        },
      ],
    });
    const r = runStdin(kb, ['claim', 'apply'], payload);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect((r.json.data as { claimsCreated: number }).claimsCreated).toBe(1);
  });

  it('REJECTS a hallucinated quote with a non-zero exit code', () => {
    const payload = JSON.stringify({
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'Fabricated.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote: 'the service is written in Rust' }],
        },
      ],
    });
    const r = runStdin(kb, ['claim', 'apply'], payload);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.errors.join(' ')).toMatch(/quote not found/);
  });

  it('rejects an unknown command with exit 1', () => {
    const r = run(kb, ['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
  });
});
