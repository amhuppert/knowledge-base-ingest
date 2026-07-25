/**
 * HELP SPEC (01 §4) — the per-command help contract + text/JSON renderers.
 *
 * Every registered command carries a hand-authored `HelpSpec`, colocated with its
 * registration (`src/cli/commands/*`) via `defineHelp(cmd, spec)`. The pre-parse
 * router (never Commander) resolves `--help` / `help <path>` to a command and emits
 * that command's spec: as the envelope `data` in `--json` mode (`renderHelpJson`),
 * or as a human help block otherwise (`renderHelpText`).
 *
 * The spec is authored, not derived, so drift tests (`spec.test.ts`) can assert it
 * stays in lock-step with the Commander tree: every command has a spec, `spec.flags`
 * matches the command's own options bidirectionally, enum flags equal their runtime
 * consts, and `spec.input.example` parses with its named Zod schema.
 */

import type { Command, Option } from 'commander';

/**
 * The seven workflow groups, in pipeline order (01 §5). Global help (§5) lists the
 * registered commands grouped by this order: setup → ingest → structure → extract →
 * synthesize → query → maintain.
 */
export const WORKFLOW_GROUPS = [
  'setup',
  'ingest',
  'structure',
  'extract',
  'synthesize',
  'query',
  'maintain',
] as const;
export type WorkflowGroup = (typeof WORKFLOW_GROUPS)[number];

/** A positional argument as advertised in help. */
export interface HelpArg {
  name: string;
  description: string;
  /** A variadic positional (`<query...>`), collecting the rest of the operands. */
  variadic?: boolean;
  /** Optional positional (`[dir]`). Defaults to required. */
  optional?: boolean;
}

/** A single flag as documented in help — one entry per registered Commander option. */
export interface HelpFlag {
  /** The Commander flags string, e.g. `--limit <n>` — must equal the registered option. */
  flags: string;
  description: string;
  /** For an enum flag, the exact runtime const it validates against (drift-checked). */
  choices?: readonly string[];
  /** True when the option is required (Commander `requiredOption`/`makeOptionMandatory`). */
  required?: boolean;
}

/**
 * What a command accepts as INPUT. For a JSON-payload command that is a schema name
 * plus a minimal valid example; for a file-consuming command (`ingest`) there is no
 * payload schema, only `notes` — the accepted-format table and the recovery recipe
 * (06 §1.1/§1.5). At least one of `schema`+`example` or `notes` is present.
 */
export interface HelpInput {
  /** The exported Zod schema NAME (drift test parses `example` with the schema of this name). */
  schema?: string;
  /** A MINIMAL VALID payload — asserted to parse with the named schema. */
  example?: unknown;
  /** Free-form input notes rendered verbatim (format tables, recipes). */
  notes?: string[];
}

/** A worked example: a one-line description and a verbatim-runnable command. */
export interface HelpExample {
  description: string;
  command: string;
}

/** The full command help contract (01 §4). */
export interface HelpSpec {
  /** Space-joined command path from the root, e.g. `claim apply`. */
  command: string;
  /** The workflow group this command belongs to (drives global help ordering). */
  group: WorkflowGroup;
  /** Executable usage line, e.g. `kb claim apply [options]`. */
  usage: string;
  /** One-line summary (mirrors the Commander `.description()`). */
  summary: string;
  /** Positional arguments, in order. */
  args: HelpArg[];
  /**
   * EVERY flag the command accepts — one entry per registered Commander option, so the
   * stored `spec.flags` corresponds bidirectionally to `cmd.options` (01 §4). Command
   * modules AUTHOR only the command's own flags; `defineHelp` injects the universal
   * standard options (`--json`/`--kb`/`--help`, plus `--dry-run` on the §6.2 payload
   * leaves) — derived from the Commander node — so the returned/rendered spec documents
   * all of them while the authored own flags stay independently drift-checked.
   */
  flags: HelpFlag[];
  /** Present only for JSON-payload commands (claim/graph/synthesize/answer-check). */
  input?: HelpInput;
  /** The notable fields of a successful `data` payload. */
  output: string[];
  /** Persistent effects (writes). Empty for read-only commands. */
  sideEffects: string[];
  /** True when the command persists in a single all-or-nothing transaction. */
  atomic: boolean;
  /**
   * Whether the command is in the `--dry-run` scope (01 §6.2): TRUE for exactly the
   * payload commands (`ingest`, `claim apply`, `graph apply`, `synthesize`, and
   * `node apply` once it ships in Phase 2), FALSE everywhere else. This mirrors which
   * leaves register the Commander `--dry-run` option, so the drift test cross-checks
   * `supportsDryRun` against the registered options bidirectionally (01 §4). The
   * preview *wrapper* (the behavior) lands in Phase 1; the flag/scope is declared here.
   */
  supportsDryRun: boolean;
  /** One line on where this command sits in the ingest→synthesize→query workflow. */
  workflow: string;
  /** Related command paths (for cross-navigation in help). */
  related: string[];
  /** Worked examples. */
  examples: HelpExample[];
}

// --------------------------------------------------------------------------
// registry — specs are attached to their Command node at registration time
// --------------------------------------------------------------------------

/**
 * The universal option longs (01 §1.3): `--json`/`--kb`/`--help` on EVERY node, plus
 * `--dry-run` on exactly the §6.2 payload leaves. `defineHelp` recognizes these to inject
 * them into `spec.flags` from the Commander node, so command modules never re-author the
 * universal flags yet the stored spec still documents every registered option (01 §4).
 */
export const STANDARD_FLAG_LONGS: ReadonlySet<string> = new Set(['--json', '--kb', '--help', '--dry-run']);

/** A live Commander `Option` exposes its enum choices under the internal `argChoices`. */
type OptionWithChoices = Option & { argChoices?: string[] };

/**
 * Build a `HelpFlag` from a live Commander `Option`, preserving its flags string,
 * description, enum choices (`argChoices`), and mandatory-ness (`option.mandatory` —
 * set by `requiredOption`/`makeOptionMandatory`; NOT `option.required`, which merely
 * means the option takes a value). Used to inject the standard options and to derive the
 * defensive fallback spec so both mirror the Commander tree exactly.
 */
export function helpFlagFromOption(option: Option): HelpFlag {
  const argChoices = (option as OptionWithChoices).argChoices;
  return {
    flags: option.flags,
    description: option.description ?? '',
    ...(argChoices ? { choices: argChoices } : {}),
    ...(option.mandatory ? { required: true } : {}),
  };
}

/** The universal standard options registered on `cmd`, in registration order, as `HelpFlag`s. */
function standardFlagsOf(cmd: Command): HelpFlag[] {
  return cmd.options.filter((o) => o.long !== undefined && STANDARD_FLAG_LONGS.has(o.long)).map(helpFlagFromOption);
}

/**
 * WeakMap keyed by the Command node. `buildProgram` builds a fresh tree per call and
 * each command module attaches its spec during registration, so entries are recreated
 * per build and old trees are collected. Keyed by the node (not the path) so a test can
 * register a fake command with its own spec and have it resolve like any other.
 */
const SPECS = new WeakMap<Command, HelpSpec>();

/**
 * Attach `spec` to `cmd` (colocated with registration) and return `cmd` for chaining.
 * Command modules author only the command's OWN flags; `defineHelp` prepends the
 * universal standard options (`--json`/`--kb`/`--help`, and `--dry-run` on the §6.2
 * payload leaves) derived from the Commander node, so the STORED spec's `flags`
 * corresponds bidirectionally to `cmd.options` (01 §4) — it documents every registered
 * option in `--help`/`--help --json`, while the authored own flags remain drift-checked
 * against their registered options.
 */
export function defineHelp(cmd: Command, spec: HelpSpec): Command {
  SPECS.set(cmd, { ...spec, flags: [...standardFlagsOf(cmd), ...spec.flags] });
  return cmd;
}

/** The spec attached to `cmd`, or `undefined` when none was defined. */
export function helpSpecOf(cmd: Command): HelpSpec | undefined {
  return SPECS.get(cmd);
}

/**
 * The spec for a resolved leaf `cmd` at `path`. Returns the attached spec; if a
 * command is (defensively) missing one, derives a minimal spec from the Commander
 * node so the router never crashes — the drift test guarantees this never happens
 * for a registered command.
 */
export function helpSpecFor(cmd: Command, path: string): HelpSpec {
  const attached = SPECS.get(cmd);
  if (attached) return attached;
  const usageTail = cmd.usage();
  return {
    command: path,
    group: 'maintain',
    usage: `kb ${path}${usageTail ? ` ${usageTail}` : ''}`,
    summary: cmd.description(),
    args: [],
    flags: cmd.options.map(helpFlagFromOption),
    output: [],
    sideEffects: [],
    atomic: false,
    supportsDryRun: false,
    workflow: '',
    related: [],
    examples: [],
  };
}

// --------------------------------------------------------------------------
// renderers (text + JSON)
// --------------------------------------------------------------------------

/** The JSON renderer: the spec IS the envelope `data` for `kb <cmd> --help --json`. */
export function renderHelpJson(spec: HelpSpec): HelpSpec {
  return spec;
}

function argToken(arg: HelpArg): string {
  const inner = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.optional ? `[${inner}]` : `<${inner}>`;
}

/**
 * The text renderer: a compact human help block for `kb <cmd> --help` (no `--json`).
 * Section labels are lowercase (matching the envelope's `next:`/`tip:` convention),
 * so the output stays greppable and quiet.
 */
export function renderHelpText(spec: HelpSpec): string {
  const lines: string[] = [];
  lines.push(`usage: ${spec.usage}`);
  lines.push('');
  lines.push(spec.summary);
  lines.push('');
  lines.push(`group: ${spec.group}`);

  if (spec.args.length > 0) {
    lines.push('');
    lines.push('arguments:');
    for (const a of spec.args) lines.push(`  ${argToken(a)}  ${a.description}`);
  }

  lines.push('');
  lines.push('options:');
  // `spec.flags` already includes the universal standard options (injected by
  // `defineHelp`), so every registered flag — `--json`/`--kb`/`--help`, `--dry-run` on
  // payload commands, and the command's own flags — is listed here, once, in order.
  for (const f of spec.flags) {
    const choices = f.choices ? ` (one of: ${f.choices.join('|')})` : '';
    const req = f.required ? ' [required]' : '';
    lines.push(`  ${f.flags}  ${f.description}${choices}${req}`);
  }

  if (spec.input?.schema) {
    lines.push('');
    lines.push(`input (${spec.input.schema}), a JSON payload via --file <path> or stdin:`);
    for (const l of JSON.stringify(spec.input.example, null, 2).split('\n')) lines.push(`  ${l}`);
  }

  if (spec.input?.notes?.length) {
    lines.push('');
    lines.push('input:');
    for (const note of spec.input.notes) lines.push(`  ${note}`);
  }

  if (spec.output.length > 0) {
    lines.push('');
    lines.push('output:');
    for (const o of spec.output) lines.push(`  - ${o}`);
  }

  if (spec.sideEffects.length > 0) {
    lines.push('');
    lines.push('side effects:');
    for (const s of spec.sideEffects) lines.push(`  - ${s}`);
    lines.push(`  atomic: ${spec.atomic ? 'yes (single transaction)' : 'no'}`);
  }

  lines.push('');
  lines.push(`workflow: ${spec.workflow}`);
  if (spec.related.length > 0) lines.push(`related: ${spec.related.map((r) => `kb ${r}`).join(', ')}`);

  if (spec.examples.length > 0) {
    lines.push('');
    lines.push('examples:');
    for (const ex of spec.examples) {
      lines.push(`  ${ex.description}`);
      lines.push(`    ${ex.command}`);
    }
  }

  return lines.join('\n');
}
