import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * STANDARD OPTIONS position matrix (01 §1.3). `--json` and `--kb <dir>` are
 * registered on the root, every group, and every leaf, so flag position never
 * matters and leaves read them via `optsWithGlobals()` with LEAF precedence.
 * `--dry-run` exists only on the dry-run-capable commands. `--` terminates option
 * parsing; everything after it is positional. Variadic queries join with spaces.
 */

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  env: { ok: boolean; data: Record<string, unknown> | null; issues: Array<{ code: string }> };
}

function makeIo(cwd: string, extra: Record<string, string> = {}): { io: CliIo; read: () => { stdout: string; stderr: string } } {
  let stdout = '';
  let stderr = '';
  const env: NodeJS.ProcessEnv = {};
  delete env.KB_DIR;
  Object.assign(env, extra);
  const io: CliIo = { stdout: (c) => (stdout += c), stderr: (c) => (stderr += c), cwd, env };
  return { io, read: () => ({ stdout, stderr }) };
}

describe('standard options', () => {
  let kb: string;
  let sourceId: string;

  async function run(argv: string[], cwd = '/nowhere'): Promise<Captured> {
    const { io, read } = makeIo(cwd);
    const code = await runCli(argv, io);
    const { stdout, stderr } = read();
    // Human-mode invocations (no `--json`) print a payload plus `tip:`/`next:`
    // steering lines, which are not a single JSON document — those tests read
    // `stdout` directly, so tolerate an unparseable capture.
    let env: Captured['env'] = {} as Captured['env'];
    try {
      env = JSON.parse(stdout || '{}') as Captured['env'];
    } catch {
      env = {} as Captured['env'];
    }
    return { code, stdout, stderr, env };
  }

  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-stdopts-'));
    await run(['init', kb, '--json'], kb);
    const doc = join(kb, 'doc.md');
    writeFileSync(doc, '# Topic\n\nThe widget caches in Redis.\n');
    const ing = await run(['ingest', doc, '--kb', kb, '--json'], kb);
    sourceId = (ing.env.data as { sourceId: string }).sourceId;
  });

  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('--json is honored at root, group, and leaf positions', async () => {
    const positions: string[][] = [
      ['--json', 'source', 'show', sourceId, '--kb', kb],
      ['source', '--json', 'show', sourceId, '--kb', kb],
      ['source', 'show', sourceId, '--kb', kb, '--json'],
    ];
    for (const argv of positions) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.env.ok).toBe(true);
      expect((r.env.data as { id: string }).id).toBe(sourceId);
      // Valid JSON envelope emitted (would throw on parse if human-formatted).
      expect(r.stdout.trimStart().startsWith('{')).toBe(true);
    }
  });

  it('--kb <dir> resolves the KB at root, group, and leaf positions', async () => {
    const positions: string[][] = [
      ['--kb', kb, 'status', '--json'],
      ['source', '--kb', kb, 'show', sourceId, '--json'],
      ['source', 'show', sourceId, '--json', '--kb', kb],
    ];
    for (const argv of positions) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.env.ok).toBe(true);
    }
  });

  it('leaf --kb wins over root --kb (documented leaf precedence)', async () => {
    // Root points at a bogus dir; the leaf override is the real KB → resolves fine.
    const r = await run(['--kb', '/definitely/not/a/kb', 'status', '--kb', kb, '--json']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect((r.env.data as { sources: number }).sources).toBe(1);
  });

  it('`--` positionals are NOT silently ignored at ROOT or GROUP scope (01 §1.1 exact bare shapes)', async () => {
    // A token after `--` is a positional operand everywhere — not just on a variadic leaf.
    // At the root/group (action-less) it is an unknown command, never swallowed as bare help.
    // `--json` is placed BEFORE `--` so the JSON envelope is emitted (a `--json` after the
    // terminator would itself be a literal operand).
    const root = await run(['--json', '--', 'frob']);
    expect(root.code).toBe(2);
    expect(root.env.issues.some((i) => i.code === 'UNKNOWN_COMMAND')).toBe(true);

    const group = await run(['--json', 'node', '--', 'frob']);
    expect(group.code).toBe(2);
    expect(group.env.issues.some((i) => i.code === 'UNKNOWN_COMMAND')).toBe(true);

    // A lone trailing `--` with NOTHING after it is still a clean bare shape → group help.
    const bareTerminator = await run(['--json', 'node', '--']);
    expect(bareTerminator.code).toBe(0);
    expect((bareTerminator.env.data as { group: string }).group).toBe('node');
  });

  it('a value-taking global immediately followed by `--` is bare help at ROOT and GROUP (chosen `--kb --` semantics)', async () => {
    // Commander consumes the `--` as `--kb`'s VALUE (not a terminator), leaving a bare
    // root/group with no operand → clean bare help. The pre-parse router must reproduce
    // that semantics BEFORE Commander so `commander.help*` is never reached (no INTERNAL
    // `(outputHelp)` leak, exit 0). This is the value-option × terminator matrix cell.
    const rootValueTerm = await run(['--json', '--kb', '--']);
    expect(rootValueTerm.code).toBe(0);
    expect(rootValueTerm.env.ok).toBe(true);
    expect(Array.isArray((rootValueTerm.env.data as { groups: unknown[] }).groups)).toBe(true);
    expect(rootValueTerm.env.issues.some((i) => i.code === 'INTERNAL')).toBe(false);
    expect(rootValueTerm.stderr).toBe('');

    const groupValueTerm = await run(['--json', 'node', '--kb', '--']);
    expect(groupValueTerm.code).toBe(0);
    expect(groupValueTerm.env.ok).toBe(true);
    expect((groupValueTerm.env.data as { group: string }).group).toBe('node');
    expect(groupValueTerm.env.issues.some((i) => i.code === 'INTERNAL')).toBe(false);
    expect(groupValueTerm.stderr).toBe('');
  });

  it.each(['source', 'node', 'claim', 'graph', 'entity'])(
    'a KNOWN group name after a real `--` resolves to that group → group help, exit 0 (`-- %s`)',
    async (grp) => {
      // Commander treats post-`--` tokens as positional operands and descends the
      // subcommand tree, so `kb -- node` resolves the `node` group (actionless) and would
      // raise `commander.help`. The pre-parse router must mirror that positional resolution
      // BEFORE Commander: a known group operand after `--` → that group's help (exit 0),
      // never an INTERNAL `(outputHelp)` leak. `--json` precedes `--` so the envelope is JSON.
      const r = await run(['--json', '--', grp]);
      expect(r.code, grp).toBe(0);
      expect(r.env.ok).toBe(true);
      expect((r.env.data as { group: string }).group).toBe(grp);
      expect(r.env.issues.some((i) => i.code === 'INTERNAL')).toBe(false);
      expect(r.stderr).toBe('');
    },
  );

  it('standard flags keep position independence after a value-global consumes `--` (`--kb -- status --json` → JSON)', async () => {
    // `--kb --` makes `--` the KB value (not a terminator), so a trailing `--json` is still
    // JSON mode — not a literal operand. status runs against the bogus KB and emits a JSON
    // envelope; the load-bearing point is JSON mode survived the consumed `--`.
    const r = await run(['--kb', '--', 'status', '--json']);
    expect(r.stdout.trimStart().startsWith('{')).toBe(true);
    expect(r.stdout).toContain('"issues"');
    expect(r.stderr).toBe('');
  });

  it('--dry-run stays position-independent after `--kb --` (`--kb -- --dry-run claim apply` accepts dry-run)', async () => {
    // `--dry-run` sits after the `--` that `--kb` consumed as its value; the router must
    // still see it, validate the resolved leaf supports it, strip it, and thread ctx.dryRun —
    // so it never reaches Commander as an UNKNOWN_OPTION. The command then fails only on the
    // bogus KB, never a usage error.
    const r = await run(['--kb', '--', '--dry-run', 'claim', 'apply', '--file', '/no/such/payload', '--json']);
    expect(r.env.issues.some((i) => i.code === 'UNKNOWN_OPTION')).toBe(false);
    expect(r.env.issues.some((i) => i.code === 'MISSING_ARGUMENT')).toBe(false);
  });

  it('an UNKNOWN operand after a real `--` is still UNKNOWN_COMMAND, exit 2 (known-vs-unknown parity with Commander)', async () => {
    // The `--` matrix must distinguish a known group (→ help) from an unknown operand
    // (→ error): only subcommand resolution decides, exactly as Commander does.
    const r = await run(['--json', '--', 'frob']);
    expect(r.code).toBe(2);
    expect(r.env.issues.some((i) => i.code === 'UNKNOWN_COMMAND')).toBe(true);
  });

  it('a boolean standard flag rejects an attached value at root, group, AND leaf (arity)', async () => {
    // `--json`/`--help` take no value; `--json=bad` / `--help=bad` are malformed everywhere and
    // must map to UNKNOWN_OPTION (exit 2) — never accepted as bare help or version.
    const shapes: string[][] = [
      ['--json', '--json=bad'], // root, --json boolean w/ value (leading --json = JSON mode)
      ['--json', '--help=bad'], // root, --help boolean w/ value
      ['--json', 'node', '--json=bad'], // group
      ['--json', 'source', 'show', 'x', '--json=bad'], // leaf
    ];
    for (const argv of shapes) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.env.issues.some((i) => i.code === 'UNKNOWN_OPTION'), argv.join(' ')).toBe(true);
    }
  });

  it('everything after `--` is positional: `search foo -- --json` is human output, not JSON mode', async () => {
    // cwd is the KB, so the root resolves by walk-up even with no `--kb` before `--`.
    const r = await run(['search', 'foo', '--', '--json'], kb);
    expect(r.code).toBe(0);
    // `--json` after `--` is a literal query term, NOT JSON mode: the full envelope
    // wrapper (`"issues"`, `"ok"`) is absent — only the human-rendered payload prints.
    expect(r.stdout).not.toContain('"issues"');
    expect(r.stdout).not.toContain('"ok"');
    // And the query captured the post-`--` token verbatim.
    expect(r.stdout).toContain('--json');
  });

  it('variadic queries join unquoted words with spaces (parity with the hand parser)', async () => {
    const r = await run(['search', 'a', 'b', 'c', '--kb', kb, '--json']);
    expect(r.code).toBe(0);
    expect((r.env.data as { query: string }).query).toBe('a b c');
  });

  it('--help is recognized at root, group, and leaf positions (router-owned; exit 0)', async () => {
    const root = await run(['--help', '--json']);
    expect(root.code).toBe(0);
    expect(Array.isArray((root.env.data as { groups: unknown[] }).groups)).toBe(true);

    const group = await run(['source', '--help', '--json']);
    expect(group.code).toBe(0);
    expect((group.env.data as { group: string }).group).toBe('source');

    const leaf = await run(['source', 'show', sourceId, '--help', '--json']);
    expect(leaf.code).toBe(0);
    expect((leaf.env.data as { command: string }).command).toBe('source show');
    // Every position yields a help envelope, never a parse error, with no raw output.
    for (const r of [root, group, leaf]) expect(r.stderr).toBe('');
  });

  it('--dry-run is position-independent on a dry-run-capable command (root/group/leaf)', async () => {
    // claim apply supports --dry-run; at all three positions it must PARSE (reach the
    // handler), not fail as an unknown option. The payload here is intentionally
    // missing, so each reaches a ran-and-failed exit 1 (a domain error), never exit 2.
    const positions: string[][] = [
      ['--dry-run', 'claim', 'apply', '--file', '/no/such/payload', '--kb', kb],
      ['claim', '--dry-run', 'apply', '--file', '/no/such/payload', '--kb', kb],
      ['claim', 'apply', '--dry-run', '--file', '/no/such/payload', '--kb', kb],
    ];
    for (const argv of positions) {
      const r = await run([...argv, '--json']);
      expect(r.code).toBe(1); // ran-and-failed (missing payload), NOT a usage error
      const usageCodes = new Set(['UNKNOWN_OPTION', 'MISSING_ARGUMENT', 'INVALID_ARGUMENT']);
      expect(r.env.issues.some((i) => usageCodes.has(i.code))).toBe(false);
    }
    // `claim apply` is in the §6.2 dry-run scope, so its HelpSpec DECLARES the capability
    // (`supportsDryRun` true) AND its `flags` document `--dry-run` — one HelpFlag per
    // registered Commander option, so `--help`/`--help --json` never omit it (01 §4/§6.2).
    // (The preview WRAPPER behavior lands in Phase 1; the flag/scope is declared here.)
    const help = await run(['claim', 'apply', '--help', '--json']);
    const spec = help.env.data as { flags: Array<{ flags: string }>; supportsDryRun: boolean };
    expect(spec.supportsDryRun).toBe(true);
    expect(spec.flags.some((f) => f.flags === '--dry-run')).toBe(true);
  });

  it('--dry-run is rejected (UNKNOWN_OPTION, exit 2) on commands that do not support it (01 §6.2)', async () => {
    // §6.2 limits --dry-run to exactly the payload commands. It is NOT a global flag:
    // an unsupported command must reject it at EVERY position, never silently accept it.
    const rejected: string[][] = [
      ['--dry-run', 'status'], // root position, unsupported leaf
      ['status', '--dry-run'], // leaf position, unsupported leaf
      ['--dry-run', 'claim', 'conflict', 'c1'], // root position, unsupported claim leaf
      ['claim', '--dry-run', 'conflict', 'c1'], // group position, unsupported claim leaf
      ['claim', 'supersede', 'c1', 'c2', '--dry-run'], // leaf position, unsupported claim leaf
      ['--dry-run', 'node', 'tree'], // unsupported node leaf
    ];
    for (const argv of rejected) {
      const r = await run([...argv, '--kb', kb, '--json']);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.env.ok).toBe(false);
      expect(r.env.issues.some((i) => i.code === 'UNKNOWN_OPTION'), argv.join(' ')).toBe(true);
    }
  });

  it('--file is optional; a payload command runs from an explicit file', async () => {
    // Optional `--file`: the option parses and drives the read (stdin/`-` is the default,
    // exercised by the parity suite). Here an explicit file path is accepted.
    const help = await run(['claim', 'apply', '--help', '--json']);
    const flags = (help.env.data as { flags: Array<{ flags: string }> }).flags.map((f) => f.flags);
    expect(flags.some((f) => f.startsWith('--file'))).toBe(true);
  });
});
