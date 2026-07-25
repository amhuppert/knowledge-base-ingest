import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { openDb } from '../db/connection.js';
import { DB_FILENAME } from '../kb/workspace.js';

/**
 * `kb coverage` (06 §3). Read-only completeness report: one aggregated INFO issue
 * per check (ids capped at 20 with '(shown of total shown)' in the message),
 * `data.summary` with the exact per-code totals, and ALWAYS ok:true / exit 0 —
 * info severity never fails the run.
 */

interface Summary {
  SOURCE_NO_CLAIMS: { total: number; shown: number };
  CHUNK_UNCITED: { total: number; shown: number };
  CLAIM_NOT_SYNTHESIZED: { total: number; shown: number };
  NODE_SINGLE_SOURCE: { total: number; shown: number };
  OPEN_QUESTION_NOT_SYNTHESIZED: { total: number; shown: number };
}
interface Issue {
  code: string;
  severity: string;
  message: string;
  ids?: string[];
  hint?: string;
}
interface Env {
  ok: boolean;
  data: { summary: Summary } | null;
  issues: Issue[];
  nextActions: unknown[];
  hints: string[];
}
interface Captured {
  code: number;
  env: Env;
}

let kb: string;

async function run(args: string[]): Promise<Captured> {
  let stdout = '';
  const io: CliIo = { stdout: (c) => (stdout += c), stderr: () => {}, cwd: kb, env: { KB_DIR: kb } };
  const code = await runCli([...args, '--json'], io);
  return { code, env: JSON.parse(stdout || '{}') };
}

/** Insert a claimless active source directly (for the cap-boundary fixture). */
function insertSource(id: string): void {
  const db = openDb(join(kb, DB_FILENAME));
  db.prepare(
    `INSERT INTO sources(id,sha256,stored_path,title,media_type,byte_size,ingested_at) VALUES(?,?,?,?,?,?,?)`,
  ).run(id, `sha-${id}`, `sources/${id}.md`, id, 'text/markdown', 1, '2026-07-23T00:00:00.000Z');
  db.close();
}

describe('kb coverage — clean KB', () => {
  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-coverage-clean-'));
    await run(['init', kb]);
  });
  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('reports all-zero totals, no issues, and exits 0 ok', async () => {
    const r = await run(['coverage']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(r.env.issues).toEqual([]);
    expect(r.env.data!.summary).toEqual({
      SOURCE_NO_CLAIMS: { total: 0, shown: 0 },
      CHUNK_UNCITED: { total: 0, shown: 0 },
      CLAIM_NOT_SYNTHESIZED: { total: 0, shown: 0 },
      NODE_SINGLE_SOURCE: { total: 0, shown: 0 },
      OPEN_QUESTION_NOT_SYNTHESIZED: { total: 0, shown: 0 },
    });
  });

  it('emits no next-actions and a descriptive tail hint, never a source-retire suggestion', async () => {
    const r = await run(['coverage']);
    expect(r.env.nextActions).toEqual([]);
    const hints = r.env.hints.join(' ');
    expect(hints).toContain('kb verify --strict --json');
    expect(hints.toLowerCase()).not.toContain('retire');
  });
});

describe('kb coverage — findings never fail the run', () => {
  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-coverage-findings-'));
    await run(['init', kb]);
    const doc = join(kb, 'lonely.md');
    writeFileSync(doc, '# Lonely\n\nThis source is ingested but never given any claims.\n');
    await run(['ingest', doc]);
  });
  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('an uncited source yields an INFO issue but ok:true / exit 0', async () => {
    const r = await run(['coverage']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    const src = r.env.issues.find((i) => i.code === 'SOURCE_NO_CLAIMS');
    expect(src).toBeDefined();
    expect(src!.severity).toBe('info');
    expect(src!.message).toContain('(1 of 1 shown)');
    expect(r.env.data!.summary.SOURCE_NO_CLAIMS).toEqual({ total: 1, shown: 1 });
  });
});

describe('kb verify / kb render steer to coverage (01 §6.1 wired into the handlers)', () => {
  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-coverage-steer-'));
    await run(['init', kb]);
  });
  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('kb verify success emits the kb coverage --json hint and a kb render next-action', async () => {
    const r = await run(['verify']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(r.env.hints.join(' ')).toContain('kb coverage --json');
    const commands = (r.env.nextActions as Array<{ command: string }>).map((n) => n.command);
    expect(commands).toContain('kb render --json');
  });

  it('kb render success emits the kb coverage --json hint', async () => {
    const r = await run(['render']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(r.env.hints.join(' ')).toContain('kb coverage --json');
  });

  it('kb render --check (clean) also emits the coverage hint', async () => {
    await run(['render']); // ensure no drift
    const r = await run(['render', '--check']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(r.env.hints.join(' ')).toContain('kb coverage --json');
  });
});

describe('kb coverage — ids cap at 20 with exact totals (no silent truncation)', () => {
  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-coverage-cap-'));
    await run(['init', kb]);
    for (let i = 0; i < 21; i++) insertSource(`src_${String(i).padStart(4, '0')}`);
  });
  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('shows 20 of 21 ids with the exact total in data.summary', async () => {
    const r = await run(['coverage']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(r.env.data!.summary.SOURCE_NO_CLAIMS).toEqual({ total: 21, shown: 20 });
    const issue = r.env.issues.find((i) => i.code === 'SOURCE_NO_CLAIMS')!;
    expect(issue.ids).toHaveLength(20);
    expect(issue.ids![0]).toBe('src_0000'); // lexicographic
    expect(issue.message).toContain('(20 of 21 shown)');
  });
});
