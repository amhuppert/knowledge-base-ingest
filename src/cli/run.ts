/**
 * LEAF-HANDLER INFRASTRUCTURE (01 §1.2, §1.4).
 *
 * Home for the Commander node configuration (`configureNode`, `standardOptions`,
 * `intOption`) and the shared leaf wrapper (`runAction` + `workspaceAction`). This
 * module imports nothing from `program.ts` or `commands/*` so command modules can
 * depend on it without a cycle.
 *
 * `runAction` implements the §1.4 contract: resolve the KB root, open the workspace,
 * run the handler (through the dry-run wrapper when previewing), merge root warnings,
 * emit through `io`, and return the exit code (closing the workspace in `finally`).
 * Every failure carries a REGISTRY code and its hint — a missing KB is `NO_KB`, a
 * doubled root is a `KB_PATH_SUSPECT` warning, a `ZodError` becomes one
 * `PAYLOAD_SCHEMA` issue per Zod issue, and anything unexpected is `INTERNAL`. The
 * Phase-0 `LEGACY` wrappers are gone: emission is forbidden from Phase 1 on
 * (01 §3.2, 03 deliverable 6), enforced suite-wide by `issue-coverage.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError, Option } from 'commander';
import { z } from 'zod';
import { emit, result, type Envelope, type Issue } from './output.js';
import { domainErrorToIssue, domainIssueToIssue, formatPath, hintFor, parseJsonPayload } from './issues.js';
import { DomainIssueError, DomainIssuesError } from '../domain/issueCodes.js';
import { shellQuoteArg } from '../domain/algorithms/shellQuote.js';
import { resolveKbRoot, kbRootWarnings, openWorkspace, type Workspace } from '../kb/workspace.js';
import { inDryRunTx } from './dryRun.js';
import { steeringFor, type CommandRegistry } from './steering.js';
import type { CliIo } from './io.js';

/**
 * The single Commander output configuration shared by every node. Both writers
 * DISCARD: `runCli` owns all emission, and Commander must never leak raw text to
 * the real streams (01 §1.2 — "no raw Commander stderr"). Kept as a stable
 * reference so the tree-walk test can assert every node uses it.
 */
const discard = (): void => {};
export const commanderOutput = { writeOut: discard, writeErr: discard };

/**
 * Apply the mandatory per-node configuration Commander copies at creation time but
 * that we set explicitly on EVERY node (root, groups, leaves) so the tree-walk test
 * holds and help/version can never reach `parseAsync`:
 * `exitOverride`, captured output, `helpOption(false)`, `helpCommand(false)`,
 * `showSuggestionAfterError(true)`.
 */
export function configureNode(cmd: Command): Command {
  cmd.exitOverride();
  cmd.configureOutput(commanderOutput);
  cmd.helpOption(false);
  cmd.helpCommand(false);
  cmd.showSuggestionAfterError(true);
  return cmd;
}

/**
 * Register the standard option set on a node (01 §1.3). `--json`, `--kb <dir>`, and
 * `--help` live on the root, every group, and every leaf so flag position never
 * matters (leaves read `optsWithGlobals()` with leaf precedence). `--help` is a
 * REGISTERED Commander option (in `cmd.options`, so drift/help specs see it) yet is
 * consumed by the pre-parse router BEFORE `parseAsync` — Commander's built-in help is
 * disabled by `configureNode`'s `helpOption(false)`, so this custom `--help` never
 * conflicts and never actually parses. `--dry-run` is added ONLY on the exact
 * dry-run-capable leaves (01 §6.2 — never root/group; the router provides its
 * position independence by validating the resolved leaf supports it).
 */
export function standardOptions(cmd: Command, opts: { dryRun?: boolean } = {}): Command {
  cmd.option('--json', 'emit the result as a JSON envelope');
  cmd.option('--kb <dir>', 'knowledge base directory (overrides KB_DIR and walk-up)');
  cmd.option('--help', 'show this command’s help as an envelope (router-owned)');
  if (opts.dryRun) cmd.option('--dry-run', 'preview the change without persisting');
  return cmd;
}

/**
 * An integer argParser bounded to `[min, max]`. Throws `InvalidArgumentError` (which
 * Commander rethrows as `commander.invalidArgument`) with an "expected integer
 * min–max" message on a non-integer or out-of-range value — no silent coercion.
 */
export function intOption(min: number, max: number): (value: string) => number {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(`expected integer ${min}–${max}`);
    }
    return n;
  };
}

/** A choices-validated string option built from a runtime const (01 §1.3, finding 28). */
export function choiceOption(flags: string, description: string, choices: readonly string[], fallback?: string): Option {
  const option = new Option(flags, description).choices([...choices]);
  return fallback === undefined ? option : option.default(fallback);
}

/**
 * A resolved-KB-root warning as its registry issue (01 §2): the doubled-path diagnostic
 * `kbRootWarnings` produces is a `KB_PATH_SUSPECT` WARNING, so it never flips `ok` or the
 * exit code (01 §2 — `info`/`warning` issues do not fail a command).
 */
export function kbPathSuspectIssue(message: string): Issue {
  return { code: 'KB_PATH_SUSPECT', severity: 'warning', message, hint: hintFor('KB_PATH_SUSPECT') };
}

/**
 * A "no such <thing>" lookup failure as its registry issue: the code the caller names,
 * the offending id in `ids`, and the code's registry hint (which points at the command
 * that lists valid ids). Used by the four id-lookup leaves (`node show`, `source show`,
 * `provenance`, `entity show`) so an agent gets a recovery route instead of bare prose.
 */
export function unknownIdIssue(
  code: 'UNKNOWN_NODE' | 'UNKNOWN_SOURCE' | 'UNKNOWN_CLAIM' | 'UNKNOWN_ENTITY',
  message: string,
  id: string,
): Issue {
  return { code, severity: 'error', message, ids: [id], hint: hintFor(code) };
}

/**
 * An `INTERNAL`-coded issue carrying the stable registry hint. An UNEXPECTED error (not a
 * `ZodError` and not a coded `DomainIssueError`) maps here — never to `LEGACY`, whose
 * emission is forbidden from Phase 1 on (01 §1.4/§3.2, 03 deliverable 6).
 */
function internalIssue(severity: 'error' | 'warning', message: string): Issue {
  return { code: 'INTERNAL', severity, message, hint: hintFor('INTERNAL') };
}

/** Map a caught handler error to issues (01 §1.4: unexpected `Error` → `INTERNAL`). */
export function errorToIssues(err: unknown): Issue[] {
  const issues: Issue[] = [];
  if (err instanceof z.ZodError) {
    // One `PAYLOAD_SCHEMA` issue per Zod issue, each carrying the canonical bracket-dot
    // `path` (01 §1.4/§3.1) so an agent can fix the named field without re-reading help.
    issues.push(
      ...err.issues.map((i) => ({
        code: 'PAYLOAD_SCHEMA' as const,
        severity: 'error' as const,
        message: i.message,
        ...(i.path.length > 0 ? { path: formatPath(i.path) } : {}),
        hint: hintFor('PAYLOAD_SCHEMA'),
      })),
    );
  } else if (err instanceof DomainIssuesError) {
    // A batch of collected coded issues (manifest prevalidation 04 §2, synthesize citations
    // 03 §1) — every carried issue maps to its own envelope Issue, so all are reported
    // together, none by message text, each keeping any dynamic hint/severity it carries.
    issues.push(...err.issues.map(domainIssueToIssue));
  } else if (err instanceof DomainIssueError) {
    issues.push(domainErrorToIssue(err));
  } else {
    issues.push(internalIssue('error', (err as Error).message));
  }
  // A failed ingest commit whose orphan-file cleanup ALSO failed carries a warning note
  // (03 §5): the commit error stays primary, the cleanup failure becomes a WARNING issue.
  // It, too, is coded INTERNAL (never LEGACY).
  const cleanupWarning = (err as { cleanupWarning?: unknown }).cleanupWarning;
  if (typeof cleanupWarning === 'string') issues.push(internalIssue('warning', cleanupWarning));
  return issues;
}

/** Merge root warnings ahead of an envelope's issues and re-derive ok/errors/warnings. */
function withRootIssues(env: Envelope<unknown>, rootIssues: Issue[]): Envelope<unknown> {
  return result(env.data, [...rootIssues, ...env.issues], { nextActions: env.nextActions, hints: env.hints });
}

/** Emit an envelope and return its exit code (0 ran-ok · 1 ran-and-failed). */
export function emitCode(env: Envelope<unknown>, json: boolean, io: CliIo): number {
  emit(env, json, io);
  return env.ok ? 0 : 1;
}

/**
 * A DB-only preview request (03 §2). When present, `runAction` runs the handler inside
 * `inDryRunTx` (sentinel-rollback), stamps `data.dryRun = true`, and attaches the
 * dry-run steering — file payload steers to the same command without `--dry-run`; a
 * stdin payload emits the no-replay hint (01 §6.1). The wiring is limited to the DB-only
 * dry-run scope (`claim apply`, `graph apply`, `synthesize`); `ingest` uses plan-based
 * dry-run and `node apply` arrives in Phase 2 (01 §6.2).
 */
export interface DryRunPlan {
  /** Registry command name and steering key, e.g. `'claim apply'`. */
  command: string;
  /** The verbatim same command WITHOUT `--dry-run` (file payload); `''` for stdin. */
  reapplyCommand: string;
  payloadFrom: 'file' | 'stdin';
  registry: CommandRegistry;
}

/**
 * Preview a DB-only mutation: run `handler` inside a sentinel-rollback transaction (no
 * net state change), stamp `data.dryRun = true`, and attach the dry-run steering. A
 * handler that THROWS (a validation failure) is not caught here — it propagates to
 * `runAction`'s catch, which envelopes it as `ok:false` (no dry-run steering on a
 * failed preview: the writes were rolled back, 03 §2).
 */
function runDryRun(ws: Workspace, handler: (ws: Workspace) => Envelope<unknown>, plan: DryRunPlan): Envelope<unknown> {
  const raw = inDryRunTx(ws.repos, () => handler(ws));
  // A handler that returns an ok:false envelope previewed a validation failure (e.g. a
  // quote error caught for recovery steering). Its writes were rolled back, so it must
  // NOT steer to the replay action — keep the handler's own recovery steering (03 §2).
  if (!raw.ok) {
    return result(raw.data, raw.issues, { nextActions: raw.nextActions, hints: raw.hints });
  }
  const steering = steeringFor(
    plan.command,
    { ok: true, dryRun: { command: plan.reapplyCommand, payloadFrom: plan.payloadFrom } },
    plan.registry,
  );
  const data =
    raw.data !== null && typeof raw.data === 'object'
      ? { ...(raw.data as Record<string, unknown>), dryRun: true }
      : { dryRun: true };
  return result(data, raw.issues, { nextActions: steering.nextActions, hints: steering.hints });
}

/**
 * Resolve the KB root, open the workspace, run `handler`, merge root warnings, emit,
 * and return the exit code — closing the workspace in `finally`. A workspace-open
 * failure or a thrown handler error is mapped to a `result()` envelope with the
 * root warnings preserved (coded per §1.4). When `dryRun` is supplied,
 * the handler runs through the sentinel-rollback preview path (03 §2).
 */
export function runAction(
  io: CliIo,
  json: boolean,
  kbFlag: string | undefined,
  handler: (ws: Workspace) => Envelope<unknown>,
  dryRun?: DryRunPlan,
): number {
  const root = resolveKbRoot(io.cwd, kbFlag, io.env);
  const rootIssues = kbRootWarnings(root).map(kbPathSuspectIssue);

  let ws: Workspace;
  try {
    ws = openWorkspace(root);
  } catch (e) {
    // A missing KB arrives as a coded `NO_KB` `DomainIssueError`; anything else is
    // unexpected and maps to `INTERNAL` — both through the one mapping path (§1.4).
    return emitCode(result(null, [...rootIssues, ...errorToIssues(e)]), json, io);
  }

  try {
    let env: Envelope<unknown>;
    try {
      env = dryRun ? runDryRun(ws, handler, dryRun) : handler(ws);
    } catch (e) {
      env = result(null, errorToIssues(e));
    }
    return emitCode(withRootIssues(env, rootIssues), json, io);
  } finally {
    ws.close();
  }
}

/** Shared state a leaf action reports its exit code into (read back by `runCli`). */
export interface RunContext {
  io: CliIo;
  json: boolean;
  /**
   * The phase's command registry (the set of registered leaf paths), populated by
   * `buildProgram` after the whole tree is assembled. Handlers pass it to
   * `steeringFor(...)` so steering stays phase-aware — a hint/next-action naming an
   * unshipped command is dropped (01 §6.1). Read at action time, after population.
   */
  registry: CommandRegistry;
  /**
   * Set by the pre-parse router when `--dry-run` was given for a leaf that supports
   * it (01 §6.2), position-independently. The dry-run wrapper reads this in Phase 1;
   * Phase 0 only needs it parsed and scope-checked. The router owns `--dry-run` so it
   * can accept it at root/group position (where it is NOT a Commander option) while
   * still rejecting it on unsupported commands.
   */
  dryRun: boolean;
  outcome: { code: number };
}

/** The parsed inputs a leaf handler receives. */
export interface LeafInput {
  /** Processed positionals (a variadic positional arrives as a nested array). */
  args: unknown[];
  /** Merged options with leaf precedence (`cmd.optsWithGlobals()`). */
  opts: Record<string, unknown>;
}

/** The Command a Commander action always receives as its final argument. */
function actionCommand(args: unknown[]): Command {
  return args[args.length - 1] as Command;
}

/** Per-command wiring for `workspaceAction`. */
export interface WorkspaceActionOptions {
  /**
   * The registry command name (e.g. `'claim apply'`). Its presence OPTS this command
   * into the DB-only `--dry-run` preview path (03 §2): when the router set `ctx.dryRun`,
   * the handler runs inside `inDryRunTx`. Omit it for commands outside the DB-only scope
   * (`ingest` uses plan-based dry-run; `node apply` arrives in Phase 2).
   */
  dryRunCommand?: string;
}

/**
 * POSIX-shell-quote a dynamic argument so a re-run command is executable VERBATIM
 * (charter: verbatim-next-actions) even when a path holds spaces or shell metacharacters.
 * The implementation lives in the domain layer (`algorithms/shellQuote.ts`) because the
 * domain's recovery recipes render runnable `kb …` commands too and cannot import the
 * CLI; it is re-exported here so CLI callers keep importing it from `run.js`.
 */
export { shellQuoteArg };

/**
 * Build the DB-only dry-run plan from the parsed options: the payload source (a real
 * `--file <path>` vs. stdin) and the verbatim re-run command the file-payload steering
 * offers. The re-run is the SAME command without `--dry-run`, and it must be executable
 * verbatim (charter: verbatim-next-actions): the execution-critical `--kb` target is
 * PRESERVED when it was given explicitly (so a replay never silently retargets a
 * different KB), and every dynamic argument is `shellQuoteArg`-quoted (so paths with
 * spaces/metacharacters stay one safe argument). Matches the 03 §2 steering rows.
 */
export function dryRunPlanFor(command: string, opts: Record<string, unknown>, registry: CommandRegistry): DryRunPlan {
  const file = optStr(opts, 'file');
  const fromFile = file !== undefined && file !== '-';
  return {
    command,
    payloadFrom: fromFile ? 'file' : 'stdin',
    reapplyCommand: fromFile ? buildReapplyCommand(command, file, optStr(opts, 'kb')) : '',
    registry,
  };
}

/**
 * Assemble the verbatim re-run: `kb <command> [--kb=<dir>] --file=<path> --json`. Dynamic
 * option values use the ATTACHED `--opt=value` form (01 §1.2's documented escape for
 * dash-prefixed values) rather than the space-separated `--opt <value>` form: a value that
 * itself begins with `-` (e.g. a payload passed as `--file=--json`) would, in the space
 * form, be swallowed by the router's greedy-value guard (`greedyMisuse` → MISSING_ARGUMENT)
 * or misparsed as the next option. Shell quoting cannot prevent that — it only survives the
 * SHELL, not option parsing after expansion. The attached form binds the value to its option
 * unconditionally; `shellQuoteArg` still quotes so spaces/metacharacters reach the CLI as one
 * argument (the shell strips the quotes, leaving `--file=<value>` as a single token).
 */
function buildReapplyCommand(command: string, file: string, kb: string | undefined): string {
  const parts = ['kb', command];
  if (kb !== undefined) parts.push(`--kb=${shellQuoteArg(kb)}`);
  parts.push(`--file=${shellQuoteArg(file)}`, '--json');
  return parts.join(' ');
}

/**
 * Wrap a workspace handler as a Commander `.action(...)`. Reads positionals from
 * `cmd.processedArgs` and options from `cmd.optsWithGlobals()`, runs the handler
 * through `runAction`, and stores the exit code in `ctx.outcome`. When the command
 * opts into the DB-only dry-run scope (`options.dryRunCommand`) and the router set
 * `ctx.dryRun`, the handler runs through the sentinel-rollback preview path (03 §2).
 */
export function workspaceAction(
  ctx: RunContext,
  handler: (ws: Workspace, input: LeafInput) => Envelope<unknown>,
  options: WorkspaceActionOptions = {},
) {
  return (...actionArgs: unknown[]): void => {
    const cmd = actionCommand(actionArgs);
    const opts = cmd.optsWithGlobals();
    const input: LeafInput = { args: cmd.processedArgs, opts };
    const dryRun =
      ctx.dryRun && options.dryRunCommand !== undefined
        ? dryRunPlanFor(options.dryRunCommand, opts, ctx.registry)
        : undefined;
    ctx.outcome.code = runAction(
      ctx.io,
      ctx.json,
      opts['kb'] as string | undefined,
      (ws) => handler(ws, input),
      dryRun,
    );
  };
}

/**
 * Wrap a workspace-free handler (only `init`) as a Commander `.action(...)`. Like
 * `runAction`, a thrown handler error is converted through the envelope
 * constructors (coded per §1.4) so a workspace-free failure — e.g.
 * `kb init /dev/null/x` where the directory cannot be created — still emits a proper
 * envelope and never leaks a raw stack trace (charter: envelope-discipline).
 */
export function bareAction(ctx: RunContext, handler: (input: LeafInput) => Envelope<unknown>) {
  return (...actionArgs: unknown[]): void => {
    const cmd = actionCommand(actionArgs);
    const input: LeafInput = { args: cmd.processedArgs, opts: cmd.optsWithGlobals() };
    let env: Envelope<unknown>;
    try {
      env = handler(input);
    } catch (e) {
      env = result(null, errorToIssues(e));
    }
    ctx.outcome.code = emitCode(env, ctx.json, ctx.io);
  };
}

/** Create + configure a leaf command under `parent` with the standard options applied. */
export function leaf(
  parent: Command,
  nameAndArgs: string,
  summary: string,
  opts: { dryRun?: boolean } = {},
): Command {
  const cmd = parent.command(nameAndArgs);
  configureNode(cmd);
  standardOptions(cmd, opts);
  cmd.description(summary);
  return cmd;
}

/**
 * Create + configure a GROUP parent command (no action handler) under `parent`.
 * `dryRun` registers `--dry-run` on the group too, so a dry-run-capable leaf's
 * `--dry-run` is accepted at the group position as well (position independence).
 */
export function group(parent: Command, name: string, summary: string, opts: { dryRun?: boolean } = {}): Command {
  const cmd = parent.command(name);
  configureNode(cmd);
  standardOptions(cmd, opts);
  cmd.description(summary);
  return cmd;
}

/** Read an optional string option value (undefined when absent). */
export function optStr(opts: Record<string, unknown>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Read a JSON payload from `--file <path>` (or stdin when absent or `-`), preserving
 * the hand parser's `readPayload` semantics, and parse it into a coded
 * `PAYLOAD_PARSE_ERROR` on malformed JSON.
 */
export function readPayload(opts: Record<string, unknown>): unknown {
  const file = optStr(opts, 'file');
  const raw = file && file !== '-' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  return parseJsonPayload(raw);
}
