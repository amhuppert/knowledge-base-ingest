import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * CLI wiring test: drives the real dispatcher (`runCli`) in-process against a
 * temp KB with captured io, asserting the output envelope, exit codes, and the
 * provenance gate. This is the only test that exercises argument parsing +
 * command dispatch + the workspace. Exactly one subprocess smoke test guards the
 * `bin/kb` launcher itself.
 */

interface CliResult {
  code: number;
  json: { ok: boolean; data: unknown; warnings: string[]; errors: string[] };
  stdout: string;
  stderr: string;
}

const BIN = join(process.cwd(), 'bin', 'kb');

function makeKb(): string {
  return mkdtempSync(join(tmpdir(), 'kb-cli-'));
}

interface RunOpts {
  kbDir?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** Invoke the dispatcher in-process with captured streams and always in --json mode. */
async function runIo(args: string[], opts: RunOpts = {}): Promise<CliResult> {
  const out = { stdout: '', stderr: '' };
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.KB_DIR;
  if (opts.kbDir) env.KB_DIR = opts.kbDir;
  if (opts.env) Object.assign(env, opts.env);
  const io: CliIo = {
    stdout: (chunk) => {
      out.stdout += chunk;
    },
    stderr: (chunk) => {
      out.stderr += chunk;
    },
    cwd: opts.cwd ?? process.cwd(),
    env,
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(out.stdout || '{}'), stdout: out.stdout, stderr: out.stderr };
}

function run(kbDir: string, args: string[]): Promise<CliResult> {
  return runIo(args, { kbDir });
}

let payloadCounter = 0;
/** Persist a payload to a temp file and apply it via `--file` (the in-process stdin substitute). */
function runPayload(kbDir: string, args: string[], payload: string): Promise<CliResult> {
  const file = join(kbDir, `payload-${payloadCounter++}.json`);
  writeFileSync(file, payload);
  return runIo([...args, '--file', file], { kbDir });
}

describe('kb CLI (in-process)', () => {
  let kb: string;
  let sourceId: string;
  let chunkId: string;
  let nodeId: string;

  beforeAll(async () => {
    kb = makeKb();
    const init = await run(kb, ['init', kb]);
    expect(init.json.ok).toBe(true);

    const docPath = join(kb, 'doc.md');
    writeFileSync(docPath, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
    const ing = await run(kb, ['ingest', docPath]);
    expect(ing.json.ok).toBe(true);
    sourceId = (ing.json.data as { sourceId: string }).sourceId;

    const chunks = await run(kb, ['source', 'chunks', sourceId]);
    const cs = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks;
    chunkId = cs.find((c) => c.text.includes('caches results in Redis'))!.id;

    const node = await run(kb, ['node', 'create', '--title', 'Topic', '--kind', 'root']);
    nodeId = (node.json.data as { nodeId: string }).nodeId;
  });

  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('init produced a usable KB', async () => {
    const status = await run(kb, ['status']);
    expect(status.json.ok).toBe(true);
    expect((status.json.data as { sources: number }).sources).toBe(1);
  });

  it('applies a claim with an exact quote (exit 0)', async () => {
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
    const r = await runPayload(kb, ['claim', 'apply'], payload);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect((r.json.data as { claimsCreated: number }).claimsCreated).toBe(1);
  });

  it('marks unresolved claims as conflicted from the CLI', async () => {
    const payload = JSON.stringify({
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'The widget service has an unresolved Redis caching question.',
          claim_type: 'open_question',
          confidence: 0.7,
          spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }],
        },
      ],
    });
    const applied = await runPayload(kb, ['claim', 'apply'], payload);
    expect(applied.json.ok).toBe(true);

    const shown = await run(kb, ['node', 'show', nodeId]);
    const claim = (shown.json.data as { claims: Array<{ id: string; text: string; status: string }> }).claims.find((c) =>
      c.text.includes('unresolved Redis caching question'),
    );
    expect(claim).toBeDefined();

    const conflicted = await run(kb, ['claim', 'conflict', claim!.id]);
    expect(conflicted.code).toBe(0);
    expect(conflicted.json.ok).toBe(true);
    expect((conflicted.json.data as { conflicted: string[] }).conflicted).toContain(claim!.id);

    const after = await run(kb, ['node', 'show', nodeId]);
    const updated = (after.json.data as { claims: Array<{ id: string; status: string }> }).claims.find((c) => c.id === claim!.id);
    expect(updated?.status).toBe('conflicted');
  });

  it('returns command-specific help', async () => {
    const help = await run(kb, ['claim', 'conflict', '--help']);
    expect(help.code).toBe(0);
    expect(help.json.ok).toBe(true);
    expect((help.json.data as { command: string; usage: string }).command).toBe('claim conflict');
    expect((help.json.data as { usage: string }).usage).toContain('kb claim conflict');
  });

  it('warns when a relative KB_DIR repeats the current KB path suffix', async () => {
    const root = makeKb();
    try {
      const realKb = join(root, 'memory-bank', 'fedramp');
      const init = await runIo(['init', realKb], { cwd: root });
      expect(init.json.ok).toBe(true);

      const status = await runIo(['status'], { cwd: realKb, env: { KB_DIR: 'memory-bank/fedramp' } });
      expect(status.code).toBe(1);
      expect(status.json.ok).toBe(false);
      expect(status.json.warnings.join(' ')).toMatch(/repeated path suffix "memory-bank\/fedramp"/);
      expect(status.json.warnings.join(' ')).toMatch(/absolute KB_DIR/);
      expect(status.json.errors.join(' ')).toMatch(/missing kb\.sqlite/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REJECTS a hallucinated quote with a non-zero exit code', async () => {
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
    const r = await runPayload(kb, ['claim', 'apply'], payload);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.errors.join(' ')).toMatch(/quote not found/);
  });

  it('rejects an unknown command with exit 2 (usage error) and a UNKNOWN_COMMAND issue', async () => {
    // Post-Commander: an unknown command is a usage error (never ran) → exit 2, not 1.
    const r = await run(kb, ['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.json.ok).toBe(false);
    const env = r.json as unknown as { issues: Array<{ code: string }> };
    expect(env.issues.some((i) => i.code === 'UNKNOWN_COMMAND')).toBe(true);
  });

  it('every emitted envelope satisfies ok === !issues.some(error)', async () => {
    // A battery spanning success, warning-only, and error envelopes. The v2 invariant
    // (01 §2) must hold for each one exactly as emitted by the real dispatcher.
    const batch = await Promise.all([
      run(kb, ['status']), // success
      run(kb, ['verify']), // warning-only (stale nodes) → ok:true
      run(kb, ['verify', '--strict']), // strict → error issue → ok:false
      run(kb, ['node', 'show', 'nod_deadbeef']), // unknown id → error
      run(kb, ['frobnicate']), // unknown command → error
    ]);
    for (const r of batch) {
      const env = r.json as unknown as { ok: boolean; issues: Array<{ severity: string }> };
      expect(Array.isArray(env.issues)).toBe(true);
      expect(env.ok).toBe(!env.issues.some((i) => i.severity === 'error'));
      // Exit 0 iff ok. A failure is exit 1 (ran-and-failed) or exit 2 (usage error,
      // e.g. the unknown command `frobnicate` — never ran).
      expect(r.code === 0).toBe(env.ok);
      if (!env.ok) expect([1, 2]).toContain(r.code);
    }
  });

  it('a malformed JSON payload surfaces a coded PAYLOAD_PARSE_ERROR with a character offset', async () => {
    const r = await runPayload(kb, ['claim', 'apply'], '{"café":1 2}');
    expect(r.code).toBe(1);
    const env = r.json as unknown as { issues: Array<{ code: string; message: string; hint?: string }> };
    const parseIssue = env.issues.find((i) => i.code === 'PAYLOAD_PARSE_ERROR');
    expect(parseIssue).toBeDefined();
    expect(parseIssue!.message).toContain('character 10');
    expect(parseIssue!.hint).toBeTruthy();
  });

  it('verify emits the mapped semantic issue code (not LEGACY) with a hint', async () => {
    // The seeded KB is warning-only (a claim was applied but never synthesized), so
    // verify surfaces the stale-node warning under its semantic code with a hint.
    const r = await run(kb, ['verify']);
    const env = r.json as unknown as { issues: Array<{ code: string; severity: string; hint?: string }> };
    const stale = env.issues.find((i) => i.code === 'NO_STALE_NODES');
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe('warning');
    expect(stale!.hint).toBeTruthy();
    expect(env.issues.some((i) => i.code === 'LEGACY')).toBe(false);
  });

  it('answer-check emits coded citation/assertion issues, keeps its report on failure, and retains uncitedSentences', async () => {
    const shown = await run(kb, ['node', 'show', nodeId]);
    const claims = (shown.json.data as { claims: Array<{ id: string; status: string }> }).claims;
    const active = claims.find((c) => c.status === 'active')!;
    expect(active).toBeDefined();

    const answer = [
      `The widget service caches results in Redis for speed.[^${active.id}]`,
      '',
      'It also stores every user session in a relational database without any citation here.',
      '',
      'This next line cites a claim that does not exist.[^clm_deadbeef]',
    ].join('\n');
    const r = await runPayload(kb, ['answer-check'], JSON.stringify({ answer }));

    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    const env = r.json as unknown as {
      data: { ok: boolean; uncited: Array<{ text: string; line: number }>; uncitedSentences: string[]; citedClaims: string[] };
      issues: Array<{ code: string; hint?: string }>;
      hints: string[];
    };
    // Nested ok mirrors the envelope ok and the report survives on failure.
    expect(env.data.ok).toBe(false);
    expect(env.data.citedClaims).toContain(active.id);
    // Coded issues (never LEGACY): an unknown citation and an uncited assertion, each hinted.
    const codes = env.issues.map((i) => i.code);
    expect(codes).toContain('CITATION_UNKNOWN');
    expect(codes).toContain('UNCITED_ASSERTION');
    expect(codes).not.toContain('LEGACY');
    for (const i of env.issues) expect(i.hint).toBeTruthy();
    // The deprecated alias is still emitted and mirrors uncited[].text.
    expect(env.data.uncitedSentences).toEqual(env.data.uncited.map((u) => u.text));
    // A guidance hint points at ask-context.
    expect(env.hints.join(' ')).toContain('ask-context');
  });

  it('bin/kb launcher runs bare `kb` and exits 0 (subprocess smoke test)', () => {
    const out = execFileSync(BIN, [], { encoding: 'utf8' });
    expect(out).toContain('usage');
  });
});
