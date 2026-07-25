import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { initWorkspace, DB_FILENAME } from '../kb/workspace.js';
import { openDb } from '../db/connection.js';
import { currentSchemaVersion } from '../db/migrate.js';

/**
 * `kb version` / `kb --version` (02 §2). Router-owned and WORKSPACE-FREE: it resolves
 * the KB root only to report it and probes the on-disk schema READ-ONLY — never running
 * migrations and never throwing on a too-new schema. The three probe states (no KB,
 * older, too-new) and both `--version` flag orders are the acceptance surface.
 */

interface VersionData {
  cli: string;
  node: string;
  entry: string | null;
  schema: { supported: number; onDisk: number | null };
  kbRoot: string | null;
}
interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  env: { ok: boolean; data: VersionData | null; issues: Array<{ code: string }> };
}

const SUPPORTED = currentSchemaVersion();

async function run(argv: string[], opts: { cwd?: string; entry?: string } = {}): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (c) => (stdout += c),
    stderr: (c) => (stderr += c),
    cwd: opts.cwd ?? '/nonexistent-kb-root',
    env: {},
    ...(opts.entry ? { entry: opts.entry } : {}),
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr, env: JSON.parse(stdout || '{}') };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'kb-version-'));
}
function initKb(dir: string): void {
  const { ws } = initWorkspace(dir);
  ws.close();
}
/** Force the recorded on-disk schema version WITHOUT running a migration. */
function setOnDiskSchema(dir: string, version: number): void {
  const db = openDb(join(dir, DB_FILENAME));
  db.prepare("UPDATE meta SET v = ? WHERE k='schema_version'").run(String(version));
  db.close();
}

describe('kb version (workspace-free, read-only schema probe)', () => {
  it('reports cli/node/entry/schema/kbRoot with no KB → onDisk and kbRoot null', async () => {
    const dir = makeDir();
    try {
      const r = await run(['version', '--json'], { cwd: dir, entry: '/abs/bin/kb/src/cli/index.ts' });
      expect(r.code).toBe(0);
      expect(r.env.ok).toBe(true);
      const d = r.env.data!;
      expect(d.cli).toBeTruthy();
      expect(d.node).toBe(process.version);
      expect(d.entry).toBe('/abs/bin/kb/src/cli/index.ts');
      expect(d.schema.supported).toBe(SUPPORTED);
      expect(d.schema.onDisk).toBeNull();
      expect(d.kbRoot).toBeNull();
      expect(r.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an OLDER on-disk schema verbatim — never migrating it forward', async () => {
    const dir = makeDir();
    try {
      initKb(dir); // records schema_version = SUPPORTED
      const older = SUPPORTED - 1;
      setOnDiskSchema(dir, older);
      const r = await run(['version', '--json'], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.env.ok).toBe(true);
      // Reported as-is: if `version` had run migrations, onDisk would be SUPPORTED.
      expect(r.env.data!.schema.onDisk).toBe(older);
      expect(r.env.data!.kbRoot).toBe(dir);
      // And the probe did NOT migrate the DB (it is still `older` on disk).
      const db = openDb(join(dir, DB_FILENAME));
      const row = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get() as { v: string };
      db.close();
      expect(Number(row.v)).toBe(older);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REPORTS a too-new on-disk schema (does not throw), even though a workspace open would', async () => {
    const dir = makeDir();
    try {
      initKb(dir);
      const tooNew = SUPPORTED + 1;
      setOnDiskSchema(dir, tooNew);
      const r = await run(['version', '--json'], { cwd: dir });
      expect(r.code).toBe(0);
      expect(r.env.ok).toBe(true);
      expect(r.env.data!.schema.onDisk).toBe(tooNew);
      expect(r.env.data!.schema.supported).toBe(SUPPORTED);
      // Contrast: a command that OPENS the workspace (status) refuses the too-new schema.
      const status = await run(['status', '--json'], { cwd: dir });
      expect(status.env.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors --kb to resolve the reported root', async () => {
    const dir = makeDir();
    try {
      initKb(dir);
      const r = await run(['version', '--kb', dir, '--json'], { cwd: '/nonexistent-kb-root' });
      expect(r.code).toBe(0);
      expect(r.env.data!.kbRoot).toBe(dir);
      expect(r.env.data!.schema.onDisk).toBe(SUPPORTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles both flag orders (and the `version` positional) with one envelope, no raw text', async () => {
    for (const argv of [['--version', '--json'], ['--json', '--version'], ['version', '--json']]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(0);
      expect(r.env.ok).toBe(true);
      expect(r.env.data!.cli).toBeTruthy();
      expect(r.env.data!.schema.supported).toBe(SUPPORTED);
      expect(r.stderr).toBe('');
    }
  });

  it('reports entry: null when the launcher entry is unknown (in-process)', async () => {
    const r = await run(['version', '--json']);
    expect(r.env.data!.entry).toBeNull();
  });
});

describe('kb status (version fields)', () => {
  it('additionally reports cli and schema {supported, onDisk}', async () => {
    const dir = makeDir();
    try {
      initKb(dir);
      const r = await run(['status', '--json'], { cwd: dir });
      expect(r.code).toBe(0);
      const d = r.env.data as unknown as { cli: string; schema: { supported: number; onDisk: number | null } };
      expect(d.cli).toBeTruthy();
      expect(d.schema.supported).toBe(SUPPORTED);
      expect(d.schema.onDisk).toBe(SUPPORTED); // the open migrated it up to supported
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bin/kb version --json (launcher smoke test)', () => {
  it('runs the real launcher and reports a resolved entry path', () => {
    const dir = makeDir();
    try {
      const bin = join(process.cwd(), 'bin', 'kb');
      const out = execFileSync(bin, ['version', '--json'], { encoding: 'utf8', cwd: dir });
      const env = JSON.parse(out) as { ok: boolean; data: VersionData };
      expect(env.ok).toBe(true);
      expect(env.data.entry).toContain('src/cli/index.ts');
      expect(env.data.cli).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
