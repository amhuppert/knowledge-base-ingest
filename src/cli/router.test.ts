import { describe, it, expect } from 'vitest';
import { runCli, COMMAND_NAMES, type CliIo } from './runCli.js';

/**
 * PRE-PARSE ROUTER table (01 §1.1). Every one of these argv shapes is handled by
 * `runCli` BEFORE Commander parses: bare `kb`, bare group tokens, `--help`
 * anywhere, `help [path...]`, and `--version` (both flag orders). All exit 0 with an
 * envelope on stdout and — the load-bearing assertion — ZERO raw Commander output on
 * stderr (JSON mode routes the whole envelope to stdout, so any stderr byte would be
 * a Commander leak).
 */

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  env: { ok: boolean; data: Record<string, unknown> | null; issues: Array<{ code: string }> };
}

async function run(argv: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (c) => (stdout += c),
    stderr: (c) => (stderr += c),
    cwd: '/nonexistent-kb-root',
    env: {},
  };
  const code = await runCli(argv, io);
  // `--json` invocations emit a JSON envelope on stdout; the human-help path (no `--json`)
  // emits a text block instead, so parse tolerantly and let text-only tests read `stdout`.
  let env: Captured['env'] = { ok: false, data: null, issues: [] };
  try {
    env = JSON.parse(stdout || '{}');
  } catch {
    /* non-JSON (human help text) — env stays the empty default */
  }
  return { code, stdout, stderr, env };
}

describe('pre-parse router', () => {
  it('bare `kb` → global help, exit 0', async () => {
    const r = await run(['--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(Array.isArray((r.env.data as { groups: unknown[] }).groups)).toBe(true);
    expect(r.stderr).toBe('');
  });

  it('bare `kb` (no args at all) renders human help containing "usage"', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage');
    expect(r.stderr).toBe('');
  });

  it.each(['source', 'node', 'claim', 'graph', 'entity'])('bare group `%s` → group help, exit 0', async (g) => {
    const r = await run([g, '--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect((r.env.data as { group: string }).group).toBe(g);
    expect(Array.isArray((r.env.data as { commands: unknown[] }).commands)).toBe(true);
    expect(r.stderr).toBe('');
  });

  it('exposes exactly 29 leaf commands (the current registry)', () => {
    // 21 migrated commands + `source list` (Phase 0) + `node apply` (Phase 2)
    // + `coverage` (Phase 4) + `entity list` (eval run 1, finding 3)
    // + `relationship list` (source-scoped QA Phase A4)
    // + `claim candidates` (candidate review Phase B)
    // + `source impact` (source-impact hub Phase C)
    // + `vocabulary list` (vocabulary discovery Phase E).
    expect(COMMAND_NAMES).toHaveLength(29);
  });

  it.each(COMMAND_NAMES)('`kb %s --help --json` (required inputs omitted) → HelpSpec envelope, exit 0', async (path) => {
    const r = await run([...path.split(' '), '--help', '--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect((r.env.data as { command: string }).command).toBe(path);
    expect((r.env.data as { usage: string }).usage).toContain(`kb ${path}`);
    expect(r.stderr).toBe('');
  });

  it('`--help` is resolved from the leading command path, ignoring other tokens', async () => {
    // claim apply with NO --file (a required payload) still yields help, never a parse error.
    const r = await run(['claim', 'apply', '--help', '--json']);
    expect(r.code).toBe(0);
    expect((r.env.data as { command: string }).command).toBe('claim apply');
  });

  it('`kb help` → global help; `kb help <path>` → that command help', async () => {
    const global = await run(['help', '--json']);
    expect(global.code).toBe(0);
    expect(Array.isArray((global.env.data as { groups: unknown[] }).groups)).toBe(true);

    const leaf = await run(['help', 'claim', 'apply', '--json']);
    expect(leaf.code).toBe(0);
    expect((leaf.env.data as { command: string }).command).toBe('claim apply');

    const group = await run(['help', 'node', '--json']);
    expect(group.code).toBe(0);
    expect((group.env.data as { group: string }).group).toBe('node');
  });

  it('`--version` in both flag orders → one version envelope, no raw text, exit 0', async () => {
    for (const argv of [['--version', '--json'], ['--json', '--version'], ['version', '--json']]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.env.ok).toBe(true);
      expect((r.env.data as { cli: string }).cli).toBeTruthy();
      expect(r.stderr).toBe('');
    }
  });

  it('`kb nodee tree` → UNKNOWN_COMMAND with a suggestion, exit 2 (falls through to Commander)', async () => {
    const r = await run(['nodee', 'tree', '--json']);
    expect(r.code).toBe(2);
    expect(r.env.ok).toBe(false);
    expect(r.env.issues[0]!.code).toBe('UNKNOWN_COMMAND');
    expect(JSON.stringify(r.env)).toContain('Did you mean node');
    expect(r.stderr).toBe('');
  });

  it('`kb node frob` → UNKNOWN_COMMAND, exit 2 (group has no action; finding 2)', async () => {
    const r = await run(['node', 'frob', '--json']);
    expect(r.code).toBe(2);
    expect(r.env.ok).toBe(false);
    expect(r.env.issues[0]!.code).toBe('UNKNOWN_COMMAND');
    expect(r.stderr).toBe('');
  });

  it('`kb --json --kb --` / `kb --json node --kb --` → bare help, exit 0 (value-option eats the `--`)', async () => {
    // The `--` is `--kb`'s value, not a terminator, so both are bare root/group shapes
    // routed here BEFORE Commander (which would otherwise raise `commander.help`).
    const root = await run(['--json', '--kb', '--']);
    expect(root.code).toBe(0);
    expect(root.env.ok).toBe(true);
    expect(Array.isArray((root.env.data as { groups: unknown[] }).groups)).toBe(true);
    expect(root.stderr).toBe('');

    const group = await run(['--json', 'node', '--kb', '--']);
    expect(group.code).toBe(0);
    expect(group.env.ok).toBe(true);
    expect((group.env.data as { group: string }).group).toBe('node');
    expect(group.stderr).toBe('');
  });

  it.each(['source', 'node', 'claim', 'graph', 'entity'])(
    '`kb --json -- %s` (known group after real `--`) → group help, exit 0 (positional subcommand resolution)',
    async (grp) => {
      // A real `--` terminator followed by a known group name: Commander resolves it as
      // that group's (actionless) subcommand. The router mirrors that resolution BEFORE
      // Commander → group help, never a leaked `commander.help`.
      const r = await run(['--json', '--', grp]);
      expect(r.code, grp).toBe(0);
      expect(r.env.ok).toBe(true);
      expect((r.env.data as { group: string }).group).toBe(grp);
      expect(r.stderr).toBe('');
    },
  );

  // A value-taking global (`--kb`) written without `=` consumes the FOLLOWING token as
  // its value UNCONDITIONALLY — even a `--` (Commander v14; 01 §1.1). That `--` is then
  // NOT the option terminator, so help/version routing must scan PAST it. Every pre-parse
  // scanner derives from the same consumed-value-aware tokenization, so they never
  // disagree about whether the `--` in `--kb --` is a terminator or a value.
  it('`kb --kb -- ingest --help --json` → ingest HelpSpec, exit 0 (help sees past the consumed `--`)', async () => {
    const r = await run(['--kb', '--', 'ingest', '--help', '--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect((r.env.data as { command: string }).command).toBe('ingest');
    expect((r.env.data as { usage: string }).usage).toContain('kb ingest');
    expect(r.stderr).toBe('');
  });

  it('`kb --kb -- --version --json` → version envelope, exit 0 (version sees past the consumed `--`)', async () => {
    const r = await run(['--kb', '--', '--version', '--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect((r.env.data as { cli: string }).cli).toBeTruthy();
    expect(r.stderr).toBe('');
  });

  // 01 §1.1: an invocation containing `--help` ANYWHERE (before the real terminator) emits
  // help and ignores all other tokens — even when a preceding value-taking option (`--kb`,
  // `--file`, `--title`) would otherwise greedily consume the `--help` token as its value.
  // Help routing recognizes the exact `--help` token liberally and keeps precedence over the
  // greedy-value pre-scan (help is routed before greedy, so these never become MISSING_ARGUMENT).
  it('`kb --json --kb --help` → global help, exit 0 (help beats greedy consumption of `--help`)', async () => {
    const r = await run(['--json', '--kb', '--help']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(Array.isArray((r.env.data as { groups: unknown[] }).groups)).toBe(true);
    expect(r.env.issues.some((i) => i.code === 'MISSING_ARGUMENT')).toBe(false);
    expect(r.stderr).toBe('');
  });

  it('`kb claim apply --file --help --json` → claim apply HelpSpec, exit 0 (leaf value-option would consume `--help`)', async () => {
    const r = await run(['claim', 'apply', '--file', '--help', '--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect((r.env.data as { command: string }).command).toBe('claim apply');
    expect(r.env.issues.some((i) => i.code === 'MISSING_ARGUMENT')).toBe(false);
    expect(r.stderr).toBe('');
  });

  it('`kb node create --title --help --kind root --json` → node create HelpSpec, exit 0 (mid-argv `--help` consumed by `--title`)', async () => {
    const r = await run(['node', 'create', '--title', '--help', '--kind', 'root', '--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect((r.env.data as { command: string }).command).toBe('node create');
    expect(r.env.issues.some((i) => i.code === 'MISSING_ARGUMENT')).toBe(false);
    expect(r.stderr).toBe('');
  });
});
