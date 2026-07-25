import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { errorToIssues } from './run.js';
import { ingestReapplyCommand } from './commands/ingest.js';

/**
 * INGEST CLI receipts (03 §5). `--dry-run` runs `plan` only — the exact duplicate/new
 * receipt shapes, zero store and DB writes by construction. A real ingest keeps the
 * deprecated `next` string alias mirroring `nextActions[0].command`, and steers to
 * `kb source chunks <id> --json`.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; severity: string; message: string }>;
    warnings: string[];
    errors: string[];
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

let kb: string;

async function runIo(args: string[]): Promise<CliResult> {
  const out = { stdout: '', stderr: '' };
  const env: NodeJS.ProcessEnv = { ...process.env, KB_DIR: kb };
  const io: CliIo = {
    stdout: (c) => (out.stdout += c),
    stderr: (c) => (out.stderr += c),
    cwd: process.cwd(),
    env,
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(out.stdout || '{}') };
}

/** Recursively count files under a directory (0 if it does not exist). */
function countFiles(dir: string): number {
  let n = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

function writeDoc(name: string, body: string): string {
  const p = join(kb, name);
  writeFileSync(p, body);
  return p;
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-ingest-'));
  const init = await runIo(['init', kb]);
  expect(init.json.ok).toBe(true);
});
afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('kb ingest --dry-run (new source)', () => {
  it('returns the new receipt shape and writes NOTHING (zero store + DB writes)', async () => {
    const doc = writeDoc('new.md', '# Widget\n\nThe widget service caches results in Redis for speed.\n');
    const before = await runIo(['status']);
    const sourcesDir = join(kb, 'sources');

    const dry = await runIo(['ingest', doc, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json.ok).toBe(true);
    const d = dry.json.data!;
    expect(d.dryRun).toBe(true);
    expect(d.status).toBe('new');
    expect(typeof d.sourceId).toBe('string');
    expect(d.title).toBe('Widget');
    expect(d.chunks).toBeGreaterThan(0);
    expect(d.byteSize).toBe(Buffer.byteLength('# Widget\n\nThe widget service caches results in Redis for speed.\n'));
    expect(d.mediaType).toBe('text/markdown');
    // A preview never persists — no `next` alias (that is a real-receipt field).
    expect(d.next).toBeUndefined();

    // Zero store writes: no file was stored.
    expect(countFiles(sourcesDir)).toBe(0);
    // Zero DB writes: source/chunk counts unchanged.
    const after = await runIo(['status']);
    expect(after.json.data).toEqual(before.json.data);
  });

  it('steers to the same command without --dry-run (options first, path after `--`)', async () => {
    const doc = writeDoc('steer.md', '# S\n\nContent here that is long enough to chunk.\n');
    const dry = await runIo(['ingest', doc, '--dry-run']);
    expect(dry.json.nextActions[0]?.command).toBe(`kb ingest --json -- ${doc}`);
  });
});

describe('kb ingest --dry-run (duplicate source)', () => {
  it('returns the duplicate receipt with wouldUpdate and persists no metadata change', async () => {
    const doc = writeDoc('dup.md', '# Orig\n\nSome durable source content for the duplicate test.\n');
    const real = await runIo(['ingest', doc]);
    const sourceId = (real.json.data as { sourceId: string }).sourceId;

    // A dry-run re-ingest with a NEW title previews the update but must not apply it.
    const dry = await runIo(['ingest', doc, '--dry-run', '--title', 'Renamed']);
    expect(dry.code).toBe(0);
    const d = dry.json.data!;
    expect(d.dryRun).toBe(true);
    expect(d.status).toBe('duplicate');
    expect(d.sourceId).toBe(sourceId);
    expect(d.wouldUpdate).toEqual({ title: 'Renamed' });

    // The stored title is unchanged — the preview wrote nothing.
    const show = await runIo(['source', 'show', sourceId]);
    expect((show.json.data as { title: string }).title).toBe('Orig');
  });
});

describe('kb ingest (real receipt)', () => {
  it('keeps the deprecated `next` alias mirroring nextActions[0].command and steers to source chunks', async () => {
    const doc = writeDoc('real.md', '# Real\n\nThe cache is backed by Redis for low latency reads.\n');
    const r = await runIo(['ingest', doc]);
    expect(r.code).toBe(0);
    const sourceId = (r.json.data as { sourceId: string }).sourceId;
    const chunksCmd = `kb source chunks ${sourceId} --json`;
    expect(r.json.data!.status).toBe('new');
    expect(r.json.nextActions[0]?.command).toBe(chunksCmd);
    // `next` is a deprecated alias that mirrors the primary next-action verbatim.
    expect(r.json.data!.next).toBe(r.json.nextActions[0]!.command);
    expect(r.json.data!.next).toBe(chunksCmd);
  });
});

describe('kb ingest --dry-run (dash-prefixed relative path)', () => {
  it('the steered re-run replays verbatim through the real router (no unknown-option error)', async () => {
    // Absolute paths never start with `-`; the hazard is a RELATIVE path like `-notes.md`.
    // readFileSync resolves it against the process cwd, so chdir into a scratch dir holding it.
    const workdir = mkdtempSync(join(tmpdir(), 'kb-dash-'));
    const prev = process.cwd();
    try {
      writeFileSync(join(workdir, '-notes.md'), '# Notes\n\nDash-prefixed relative path content.\n');
      process.chdir(workdir);
      const env: NodeJS.ProcessEnv = { ...process.env, KB_DIR: kb };
      const runAt = async (args: string[]): Promise<CliResult> => {
        const out = { stdout: '', stderr: '' };
        const io: CliIo = { stdout: (c) => (out.stdout += c), stderr: (c) => (out.stderr += c), cwd: workdir, env };
        const code = await runCli(args, io);
        return { code, json: JSON.parse(out.stdout || '{}') };
      };
      // `--json` must precede the `--` terminator to stay in the option region.
      const dry = await runAt(['ingest', '--dry-run', '--json', '--', '-notes.md']);
      expect(dry.code).toBe(0);
      const reCmd = dry.json.nextActions[0]!.command;
      expect(reCmd).toBe('kb ingest --json -- -notes.md');

      // Replay the emitted command verbatim (drop the leading `kb`). It must be ACCEPTED —
      // reaching the handler and committing — not rejected as an unknown option.
      const replay = await runAt(reCmd.split(' ').slice(1));
      expect(replay.code).toBe(0);
      expect(replay.json.ok).toBe(true);
      expect(replay.json.issues.some((i) => i.code === 'UNKNOWN_OPTION')).toBe(false);
      expect(replay.json.data!.status).toBe('new');
    } finally {
      process.chdir(prev);
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe('kb ingest (undecodable input)', () => {
  it('surfaces a decode failure as an UNSUPPORTED_MEDIA issue (envelope ok:false)', async () => {
    const bin = join(kb, 'blob.bin');
    writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const r = await runIo(['ingest', bin]);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.issues.some((i) => i.code === 'UNSUPPORTED_MEDIA')).toBe(true);
    // A failed decode is read-only: nothing was stored.
    expect(countFiles(join(kb, 'sources'))).toBe(0);
  });
});

describe('errorToIssues — cleanup warning surfacing (03 §5)', () => {
  it('maps the commit error and its cleanupWarning to INTERNAL (never LEGACY)', () => {
    const err = Object.assign(new Error('injected tx failure'), {
      cleanupWarning: 'Failed to remove the orphaned source copy at sources/ab/x.md: EPERM',
    });
    const issues = errorToIssues(err);
    // The commit error is primary (error severity); the cleanup note is a warning. Both are
    // coded INTERNAL with the registry hint — LEGACY emission is forbidden from Phase 1 on.
    const primary = issues.find((i) => i.severity === 'error');
    const warning = issues.find((i) => i.severity === 'warning');
    expect(primary).toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/injected tx failure/) });
    expect(primary?.hint).toBeTruthy();
    expect(warning).toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/orphaned source copy/) });
    expect(issues.some((i) => i.code === 'LEGACY')).toBe(false);
  });
});

describe('ingestReapplyCommand — replayable, dash-safe re-run (verbatim-next-actions)', () => {
  it('emits options first and puts the positional path after a `--` terminator', () => {
    // A dash-prefixed path is the hazard: without `--` it parses as an unknown option.
    expect(ingestReapplyCommand('-notes.md', {})).toBe('kb ingest --json -- -notes.md');
  });

  it('preserves outcome-affecting flags before `--`, shell-quoting values', () => {
    const cmd = ingestReapplyCommand('/tmp/a b.md', { kb: '/srv/kb', title: "It's fine", sourceDate: '2026-01-01' });
    expect(cmd).toBe("kb ingest --kb=/srv/kb --title='It'\\''s fine' --source-date=2026-01-01 --json -- '/tmp/a b.md'");
  });
});
