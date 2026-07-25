import { describe, it, expect, vi } from 'vitest';
import { CommanderError } from 'commander';
import { runCli, type CliIo } from './runCli.js';
import { COMMANDER_ISSUE_CODES, commanderErrorToIssue } from './issues.js';

/**
 * EXHAUSTIVE CommanderError → issue-code mapping (01 §1.2). Every reachable code is
 * driven through the real `runCli` on a nested leaf and asserted to produce an
 * envelope-shaped failure: exit 2, the mapped registry code, no raw Commander
 * stderr, and NO `process.exit`. The full 8-code map (including the not-yet-reachable
 * `conflictingOption`, which no Phase-0 command declares) is verified at the mapping
 * layer so an unmapped code can never slip through as raw Commander text.
 */

interface Captured {
  code: number;
  stderr: string;
  env: { ok: boolean; issues: Array<{ code: string; message: string; hint?: string }> };
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
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit must never be called');
  }) as never);
  const code = await runCli([...argv, '--json'], io);
  expect(exitSpy).not.toHaveBeenCalled();
  exitSpy.mockRestore();
  return { code, stderr, env: JSON.parse(stdout || '{}') };
}

/** [label, argv, expected issue code] — one reachable CommanderError code per row. */
const REACHABLE: Array<[string, string[], string]> = [
  ['unknownCommand', ['frobnicate'], 'UNKNOWN_COMMAND'],
  ['unknownCommand (nested group)', ['node', 'frob'], 'UNKNOWN_COMMAND'],
  ['unknownOption', ['node', 'tree', '--bogus'], 'UNKNOWN_OPTION'],
  ['missingArgument (variadic)', ['claim', 'conflict'], 'MISSING_ARGUMENT'],
  ['optionMissingArgument', ['search', 'q', '--limit'], 'MISSING_ARGUMENT'],
  ['missingMandatoryOptionValue', ['node', 'create', '--title', 'x'], 'MISSING_ARGUMENT'],
  ['invalidArgument (argParser)', ['search', 'q', '--limit', 'banana'], 'INVALID_ARGUMENT'],
  ['invalidArgument (choices)', ['search', 'q', '--scope', 'bogus'], 'INVALID_ARGUMENT'],
  ['excessArguments', ['node', 'tree', 'extra'], 'INVALID_ARGUMENT'],
];

describe('CommanderError → registry issue mapping', () => {
  it.each(REACHABLE)('%s → exit 2, coded issue, no raw stderr', async (_label, argv, expectedCode) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.env.ok).toBe(false);
    expect(r.env.issues.some((i) => i.code === expectedCode)).toBe(true);
    expect(r.env.issues.every((i) => i.hint && i.hint.length > 0)).toBe(true);
    expect(r.stderr).toBe(''); // JSON mode routes everything to stdout — any stderr byte is a Commander leak
  });

  it('maps every one of the 8 documented CommanderError codes (no unmapped → raw text)', () => {
    const codes = [
      'commander.unknownCommand',
      'commander.unknownOption',
      'commander.missingArgument',
      'commander.optionMissingArgument',
      'commander.missingMandatoryOptionValue',
      'commander.invalidArgument',
      'commander.excessArguments',
      'commander.conflictingOption',
    ];
    for (const code of codes) {
      expect(COMMANDER_ISSUE_CODES[code], code).toBeTruthy();
      const issue = commanderErrorToIssue(new CommanderError(1, code, 'error: synthetic'));
      expect(issue.severity).toBe('error');
      expect(issue.code).not.toBe('INTERNAL');
      expect(issue.hint).toBeTruthy();
    }
  });

  it('strips Commander’s "error: " prefix and rewords excessArguments to lead with "unexpected argument"', () => {
    const excess = commanderErrorToIssue(new CommanderError(1, 'commander.excessArguments', "error: too many arguments for 'tree'."));
    expect(excess.message.startsWith('unexpected argument')).toBe(true);
    const unknown = commanderErrorToIssue(new CommanderError(1, 'commander.unknownOption', "error: unknown option '--x'"));
    expect(unknown.message).toBe("unknown option '--x'");
  });

  it('a truly unmapped Commander code degrades to INTERNAL, never raw text', () => {
    const issue = commanderErrorToIssue(new CommanderError(1, 'commander.somethingNew', 'error: whatever'));
    expect(issue.code).toBe('INTERNAL');
    expect(issue.hint).toBeTruthy();
  });

  it('unknownCommand keeps Commander’s suggestion ("did you mean")', async () => {
    const r = await run(['nodee', 'tree']);
    expect(r.env.issues[0]!.code).toBe('UNKNOWN_COMMAND');
    expect(r.env.issues[0]!.message.toLowerCase()).toContain('did you mean');
  });

  it('unknownOption suggests the near flag (--limt → --limit)', async () => {
    const r = await run(['search', 'q', '--limt', '5']);
    expect(r.env.issues[0]!.code).toBe('UNKNOWN_OPTION');
    expect(r.env.issues[0]!.message).toContain('--limit');
  });
});

describe('workspace-free handler failures are enveloped (envelope-discipline)', () => {
  it('kb init <undreatable-dir> emits a failure envelope, never a raw stack trace', async () => {
    // A path under a non-directory cannot be created; the thrown Node error must be
    // converted through the envelope constructors, not leaked as a stack trace.
    const r = await run(['init', '/dev/null/not-a-directory']);
    expect(r.code).toBe(1); // ran-and-failed (not a usage error)
    expect(r.env.ok).toBe(false);
    expect(r.env.issues.length).toBeGreaterThan(0);
    expect(r.env.issues.every((i) => typeof i.code === 'string')).toBe(true);
    expect(r.stderr).toBe(''); // JSON mode → whole envelope on stdout; nothing raw
  });
});

describe('strict argument layer reaches ROOT and GROUP scope (not bypassed by bare-help)', () => {
  // Regression: an option-only root/group invocation must NOT short-circuit to help.
  // Unknown options and greedy missing values at root/group scope reach the mapped
  // exit-2 envelope; only the exact valid bare shapes render help at exit 0.
  // A RAW runner (no appended --json) is used so `--json` placement is exact and never
  // accidentally becomes the swallowed value of a trailing value-option.
  async function raw(argv: string[]): Promise<Captured> {
    let stdout = '';
    let stderr = '';
    const io: CliIo = { stdout: (c) => (stdout += c), stderr: (c) => (stderr += c), cwd: '/nonexistent-kb-root', env: {} };
    const code = await runCli(argv, io);
    return { code, stderr, env: JSON.parse(stdout || '{}') };
  }

  const ERRORS: Array<[string, string[], string]> = [
    ['root unknown option', ['--json', '--bogus'], 'UNKNOWN_OPTION'],
    ['group unknown option', ['node', '--bogus', '--json'], 'UNKNOWN_OPTION'],
    ['root greedy missing value', ['--kb', '--json'], 'MISSING_ARGUMENT'],
    ['group greedy missing value', ['node', '--kb', '--json'], 'MISSING_ARGUMENT'],
    ['root value option missing at end', ['--json', '--kb'], 'MISSING_ARGUMENT'],
    // Post-`--` operand is positional, never swallowed as bare help (`--json` before `--`
    // so the envelope is JSON; a `--json` after the terminator would be a literal operand).
    ['root operand after --', ['--json', '--', 'frob'], 'UNKNOWN_COMMAND'],
    ['group operand after --', ['--json', 'node', '--', 'frob'], 'UNKNOWN_COMMAND'],
    // Attached value on a boolean standard flag is malformed everywhere.
    ['root boolean flag with attached value', ['--json', '--json=bad'], 'UNKNOWN_OPTION'],
    ['root --help with attached value', ['--json', '--help=bad'], 'UNKNOWN_OPTION'],
  ];

  it.each(ERRORS)('%s → exit 2, %s (not help)', async (_label, argv, code) => {
    const r = await raw(argv);
    expect(r.code).toBe(2);
    expect(r.env.ok).toBe(false);
    expect(r.env.issues.some((i) => i.code === code)).toBe(true);
    expect(r.stderr).toBe('');
  });

  it('the exact valid bare shapes still render help at exit 0', async () => {
    const root = await raw(['--json']);
    expect(root.code).toBe(0);
    expect(root.env.ok).toBe(true);
    const group = await raw(['node', '--json']);
    expect(group.code).toBe(0);
    expect(group.env.ok).toBe(true);
  });

  it('a malformed leading option is NOT masked as a version success (01 §1.1, §1.2)', async () => {
    // Version routing must not swallow an unknown or greedy leading option: these reach
    // the mapped exit-2 envelope, never a version envelope.
    const bogus = await raw(['--bogus', '--version', '--json']);
    expect(bogus.code).toBe(2);
    expect(bogus.env.issues.some((i) => i.code === 'UNKNOWN_OPTION')).toBe(true);

    const greedy = await raw(['--kb', '--json', '--version']);
    expect(greedy.code).toBe(2);
    expect(greedy.env.issues.some((i) => i.code === 'MISSING_ARGUMENT')).toBe(true);

    // A malformed boolean flag with an attached value must not be masked as version either.
    const attached = await raw(['--json=bad', '--version', '--json']);
    expect(attached.code).toBe(2);
    expect(attached.env.issues.some((i) => i.code === 'UNKNOWN_OPTION')).toBe(true);
  });

  it('commander.help* is unreachable: a bare group with an unknown option maps to a strict error, never help', async () => {
    // The bare shapes are routed to help BEFORE Commander, so Commander never emits
    // help. Proof: adding an unknown option to a bare group flips it from help (exit 0)
    // to UNKNOWN_OPTION (exit 2) — Commander's help path was never reached, and no
    // issue is a translated `commander.help*` (which would degrade to INTERNAL).
    const bareGroup = await raw(['node', '--json']);
    expect(bareGroup.code).toBe(0);

    const badGroup = await raw(['node', '--nope', '--json']);
    expect(badGroup.code).toBe(2);
    expect(badGroup.env.issues.some((i) => i.code === 'UNKNOWN_OPTION')).toBe(true);
    expect(badGroup.env.issues.some((i) => i.code === 'INTERNAL')).toBe(false);
  });

  it('commander.help* stays unreachable when a value-taking option is adjacent to `--`', async () => {
    // Regression: `--kb --` makes Commander swallow `--` as the option VALUE and then
    // raise `commander.help` for the actionless root/group — which would surface as an
    // INTERNAL `(outputHelp)` issue at exit 2. The pre-parse router must own these exact
    // bare shapes (exit 0, ok=true), so Commander's help path is never reached.
    const rootValueTerm = await raw(['--json', '--kb', '--']);
    expect(rootValueTerm.code).toBe(0);
    expect(rootValueTerm.env.ok).toBe(true);
    expect(rootValueTerm.env.issues.some((i) => i.code === 'INTERNAL')).toBe(false);
    expect(rootValueTerm.stderr).toBe('');

    const groupValueTerm = await raw(['--json', 'node', '--kb', '--']);
    expect(groupValueTerm.code).toBe(0);
    expect(groupValueTerm.env.ok).toBe(true);
    expect(groupValueTerm.env.issues.some((i) => i.code === 'INTERNAL')).toBe(false);
    expect(groupValueTerm.stderr).toBe('');

    // But a value-option missing its value at the very end is still MISSING_ARGUMENT,
    // never bare help — the `--` distinction is exactly what separates the two.
    const missingValue = await raw(['--json', '--kb']);
    expect(missingValue.code).toBe(2);
    expect(missingValue.env.issues.some((i) => i.code === 'MISSING_ARGUMENT')).toBe(true);
  });

  it.each(['source', 'node', 'claim', 'graph', 'entity'])(
    'commander.help* stays unreachable for a KNOWN group operand after a real `--` (`-- %s`)',
    async (grp) => {
      // Regression: `kb --json -- node` — the `--` is a real terminator and Commander
      // resolves the post-`--` `node` operand as the actionless group's subcommand, raising
      // `commander.help` (→ INTERNAL `(outputHelp)`). The pre-parse router must own this
      // shape: known group operand after `--` → that group's help (exit 0), no INTERNAL.
      const r = await raw(['--json', '--', grp]);
      expect(r.code, grp).toBe(0);
      expect(r.env.ok).toBe(true);
      expect(r.env.issues.some((i) => i.code === 'INTERNAL')).toBe(false);
      expect(r.stderr).toBe('');
    },
  );
});

describe('greedy option-value pre-scan (finding 6)', () => {
  /** [label, argv, first token, swallowed token]. */
  const CASES: Array<[string, string[], string, string]> = [
    ['--kb --json', ['status', '--kb', '--json'], '--kb', '--json'],
    ['--file --json', ['claim', 'apply', '--file', '--json'], '--file', '--json'],
    ['node create --title --json', ['node', 'create', '--title', '--json', '--kind', 'root'], '--title', '--json'],
    ['ingest --text-from --dry-run', ['ingest', 'x', '--text-from', '--dry-run'], '--text-from', '--dry-run'],
  ];

  it.each(CASES)('%s → MISSING_ARGUMENT naming both tokens, exit 2', async (_label, argv, first, swallowed) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    const issue = r.env.issues.find((i) => i.code === 'MISSING_ARGUMENT');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain(first);
    expect(issue!.message).toContain(swallowed);
    expect(r.stderr).toBe('');
  });

  it('sees past a `--` consumed by --kb: `--json --kb -- claim apply --file --json` → MISSING_ARGUMENT naming both', async () => {
    // `--kb` consumes the `--` as its VALUE (not a terminator), so the greedy pre-scan must
    // keep walking and catch `--file --json` on the resolved leaf — the same consumed-value
    // tokenization the router uses. Otherwise it stops at the `--` and Commander reports only
    // its own bare optionMissingArgument, not the required greedy MISSING_ARGUMENT.
    let stdout = '';
    const io: CliIo = { stdout: (c) => (stdout += c), stderr: () => {}, cwd: '/nonexistent-kb-root', env: {} };
    await runCli(['--json', '--kb', '--', 'claim', 'apply', '--file', '--json'], io);
    const env = JSON.parse(stdout) as { issues: Array<{ code: string; message: string }> };
    const issue = env.issues.find((i) => i.code === 'MISSING_ARGUMENT');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('--file');
    expect(issue!.message).toContain('--json');
  });

  it('--title=--literal is taken literally (the documented escape), never a MISSING_ARGUMENT', async () => {
    const r = await run(['node', 'create', '--title=--literal', '--kind', 'root']);
    // Parsing succeeds; it then fails only because there is no KB here (exit 1, ran-and-failed),
    // proving the `=` value escaped the greedy scan and the usage layer entirely.
    expect(r.code).toBe(1);
    const usageCodes = new Set(['MISSING_ARGUMENT', 'INVALID_ARGUMENT', 'UNKNOWN_OPTION', 'UNKNOWN_COMMAND']);
    expect(r.env.issues.some((i) => usageCodes.has(i.code))).toBe(false);
  });
});

describe('value validation at the edge (intOption + choices)', () => {
  it('search --limit banana → INVALID_ARGUMENT, "expected integer" with the range', async () => {
    const r = await run(['search', 'q', '--limit', 'banana']);
    expect(r.code).toBe(2);
    const issue = r.env.issues.find((i) => i.code === 'INVALID_ARGUMENT');
    expect(issue!.message).toContain('expected integer');
    expect(issue!.message).toContain('200');
  });

  it.each([['0'], ['201']])('search --limit %s (out of 1–200) → INVALID_ARGUMENT', async (v) => {
    const r = await run(['search', 'q', '--limit', v]);
    expect(r.code).toBe(2);
    expect(r.env.issues.some((i) => i.code === 'INVALID_ARGUMENT')).toBe(true);
  });

  it('search --scope bogus → INVALID_ARGUMENT listing the allowed choices', async () => {
    const r = await run(['search', 'q', '--scope', 'bogus']);
    expect(r.code).toBe(2);
    const issue = r.env.issues.find((i) => i.code === 'INVALID_ARGUMENT');
    for (const choice of ['chunks', 'claims', 'nodes', 'entities', 'all']) {
      expect(issue!.message).toContain(choice);
    }
  });

  it('ask-context --limit 51 (out of 1–50) → INVALID_ARGUMENT', async () => {
    const r = await run(['ask-context', 'why', '--limit', '51']);
    expect(r.code).toBe(2);
    const issue = r.env.issues.find((i) => i.code === 'INVALID_ARGUMENT');
    expect(issue!.message).toContain('50');
  });
});
