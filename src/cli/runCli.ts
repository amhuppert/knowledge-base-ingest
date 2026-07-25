/**
 * THE dispatcher (01 §1). `runCli(argv, io)` is the only entry point; `index.ts`
 * is a thin caller. It is pure with respect to `io` (no direct `process` access),
 * so every CLI test drives it in-process with captured output and a temp-dir KB.
 *
 * Flow (01 §1.1 — every one of these is decided BEFORE Commander parses, because
 * Commander v14 validates required arguments/options before actions, treats a custom
 * `--help` as an ordinary boolean, and prints raw help/version text during parse):
 *   1. JSON mode: a literal `--json` token scan of `argv` (never `process.argv`),
 *      stopping at `--`.
 *   2. HELP router: `--help` anywhere, or `help [path...]` → the resolved command's
 *      HelpSpec / group / global help envelope.
 *   3. VERSION router: a clean leading `--version` (or first positional `version`)
 *      → the version envelope. Malformed leading options do NOT count as version.
 *   4. Greedy option-value pre-scan (01 §1.2).
 *   5. `--dry-run` scope + position independence (01 §6.2): accepted for a leaf that
 *      supports it at ANY position (root/group/leaf); UNKNOWN_OPTION everywhere else.
 *   6. BARE root/group help: the exact bare shapes, routed here — never through
 *      Commander (01 §1.2 declares `commander.help*` unreachable).
 *   7. `parseAsync`; map every reachable `CommanderError` to a registry issue, exit 2.
 */

import { CommanderError } from 'commander';
import { emit, success, result, type Issue } from './output.js';
import { commanderErrorToIssue, hintFor } from './issues.js';
import { buildProgram, resolveCommandPath, supportsDryRun, valueTakingGlobals } from './program.js';
import { helpSpecFor, renderHelpText } from './help/spec.js';
import { versionEnvelope } from './version.js';
import {
  globalHelp,
  groupHelp,
  isGroup,
  collectLeafPaths,
  renderGlobalHelpText,
  renderGroupHelpText,
} from './help/globalHelp.js';
import type { Command } from 'commander';
import type { CliIo } from './io.js';

export type { CliIo } from './io.js';

// --------------------------------------------------------------------------
// THE shared option-region tokenizer (pure; never touches process.argv)
// --------------------------------------------------------------------------

/** The long token of `tok`, stripped of any `=value` suffix (`--kb=x` → `--kb`). */
function bareFlag(tok: string): string {
  const eq = tok.indexOf('=');
  return eq === -1 ? tok : tok.slice(0, eq);
}

/** The registered option tokens (long + short) of a single command node. */
function ownOptionTokens(command: Command): Set<string> {
  const tokens = new Set<string>();
  for (const opt of command.options) {
    if (opt.long) tokens.add(opt.long);
    if (opt.short) tokens.add(opt.short);
  }
  return tokens;
}

/** The value-taking option tokens (long + short) of `command` and its ancestors. */
function valueTakingTokens(command: Command): Set<string> {
  const tokens = new Set<string>();
  let node: Command | null = command;
  while (node) {
    for (const opt of node.options) {
      if (opt.required || opt.optional) {
        if (opt.long) tokens.add(opt.long);
        if (opt.short) tokens.add(opt.short);
      }
    }
    node = node.parent;
  }
  return tokens;
}

/**
 * The result of ONE canonical left-to-right walk of `argv`, from which EVERY pre-parse
 * scanner (json/help/version/dry-run/leading-positionals) derives its view — so they can
 * never disagree about whether a given `--` is the option terminator or a consumed value.
 */
interface OptionScan {
  /** Index of the REAL option terminator (first `--` not consumed as a value), or argv.length. */
  terminator: number;
  /** Indices consumed as the value of a value-taking option (skip these when reading options). */
  consumedValues: Set<number>;
}

/**
 * Tokenize `argv` exactly as Commander v14's global pre-scan would (01 §1.1), descending
 * the subcommand tree so value-taking options are recognized at the level they belong to:
 *   - a value-taking option (`--kb`, and after descending, a leaf's `--file`/`--title`/…)
 *     written WITHOUT `=` consumes the FOLLOWING token as its value UNCONDITIONALLY — even a
 *     `--`, even another option token (that index lands in `consumedValues`; the greedy guard
 *     separately rejects the case where the consumed value is itself a registered option);
 *   - the FIRST `--` that is NOT thus consumed is the real terminator; everything after it is
 *     positional and is not scanned for options.
 * A non-option token descends into a matching subcommand so deeper value-takers become visible.
 */
function scanOptions(root: Command, argv: string[]): OptionScan {
  const consumedValues = new Set<number>();
  let command = root;
  let valueTaking = valueTakingTokens(command);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') return { terminator: i, consumedValues };
    if (tok.startsWith('-')) {
      if (!tok.includes('=') && valueTaking.has(bareFlag(tok))) {
        if (i + 1 < argv.length) consumedValues.add(i + 1);
        i += 1; // consume the value token unconditionally (even `--`)
      }
      continue;
    }
    const sub = command.commands.find((c) => c.name() === tok);
    if (sub) {
      command = sub;
      valueTaking = valueTakingTokens(command);
    }
  }
  return { terminator: argv.length, consumedValues };
}

/**
 * JSON mode iff a literal `--json` token appears anywhere before the REAL terminator
 * (01 §1.1: "the literal token `--json` anywhere in argv" — deliberately liberal, since
 * JSON mode is only an output-format toggle and a greedy `--kb --json` misuse should still
 * surface its error as a JSON envelope). Only the shared real terminator bounds it, so
 * `--json` after a genuine `--` is a positional operand, not JSON mode.
 */
function jsonRequested(argv: string[], scan: OptionScan): boolean {
  for (let i = 0; i < scan.terminator; i++) {
    if (argv[i] === '--json') return true;
  }
  return false;
}

/**
 * The leading positional tokens (command-path candidates): every non-option, non-consumed
 * token before the real terminator, in order. Derived from the shared scan, so a `--`
 * consumed by a value-taking option is skipped, not treated as a boundary.
 */
function leadingPositionalTokens(argv: string[], scan: OptionScan): string[] {
  const out: string[] = [];
  for (let i = 0; i < scan.terminator; i++) {
    if (scan.consumedValues.has(i)) continue;
    const tok = argv[i]!;
    if (tok.startsWith('-')) continue;
    out.push(tok);
  }
  return out;
}

// --------------------------------------------------------------------------
// version (router-owned; never Commander — finding 4)
// --------------------------------------------------------------------------

/**
 * Version is requested when a clean leading `--version` is reached in the option region —
 * every preceding UNCONSUMED token a WELL-FORMED recognized root global (`--json`, or
 * `--kb <value>`) — or the first positional token is `version`. Derived from the shared
 * scan, so a `--` consumed as `--kb`'s value is skipped and version routing continues past
 * it (`kb --kb -- --version`). An unrecognized leading option (`kb --bogus --version`) or a
 * malformed boolean (`kb --json=bad --version`) is NOT a version request and falls through
 * to the strict-error layer. A greedy `--kb --json` is caught by the greedy pre-scan, which
 * runs BEFORE version, so version never masks it. Both flag orders route to version.
 */
function isVersionRequest(root: Command, argv: string[], scan: OptionScan): boolean {
  const valueGlobals = valueTakingGlobals(root);
  const knownRootFlags = ownOptionTokens(root);
  for (let i = 0; i < scan.terminator; i++) {
    if (scan.consumedValues.has(i)) continue; // a value consumed by a value-taking global
    const tok = argv[i]!;
    if (tok === '--version') return true;
    if (tok.startsWith('-')) {
      const flag = bareFlag(tok);
      if (!knownRootFlags.has(flag)) return false; // unknown leading option → not version
      if (tok.includes('=') && !valueGlobals.has(flag)) return false; // attached value on a boolean flag → malformed
      continue; // a value-global's value (if any) is a consumedValues index, skipped above
    }
    return tok === 'version'; // the first positional token decides
  }
  return false;
}

/**
 * The value of a `--kb` option in the option region, for the workspace-free `version`
 * envelope to report the root it resolves. Handles both `--kb <dir>` (value in the next
 * token, a `consumedValues` index) and the attached `--kb=<dir>` form. Returns undefined
 * when absent, so `version` falls back to `KB_DIR`/walk-up like every other command.
 */
function kbFlagValue(argv: string[], scan: OptionScan): string | undefined {
  for (let i = 0; i < scan.terminator; i++) {
    if (scan.consumedValues.has(i)) continue;
    const tok = argv[i]!;
    if (tok === '--kb') return argv[i + 1];
    if (tok.startsWith('--kb=')) return tok.slice('--kb='.length);
  }
  return undefined;
}

// --------------------------------------------------------------------------
// help (router-owned; never Commander — findings 1, 2)
// --------------------------------------------------------------------------

/**
 * The help-target path tokens when `argv` requests help, else `null`. Per 01 §1.1 a literal
 * `--help` ANYWHERE before the real terminator emits help and ignores all other tokens — even
 * when a preceding value-taking option (`--kb`, `--file`, `--title`) would otherwise greedily
 * consume the `--help` token as its value. Detection is therefore liberal (like `--json`, and
 * NOT skipping `consumedValues`); because `helpRequest` runs before the greedy-value pre-scan,
 * help keeps precedence over MISSING_ARGUMENT. The command path is still extracted with
 * `leadingPositionalTokens`, which DOES skip consumed values so a value-taking option's value
 * (e.g. `--kb`'s directory) is never mistaken for a command token. Only the real terminator
 * bounds detection, so a `--help` after a genuine `--` is a literal operand, not a help request.
 */
function helpRequest(argv: string[], scan: OptionScan): string[] | null {
  const positionals = leadingPositionalTokens(argv, scan);
  for (let i = 0; i < scan.terminator; i++) {
    if (argv[i] === '--help') return positionals;
  }
  if (positionals[0] === 'help') return positionals.slice(1);
  return null;
}

/**
 * Emit the workflow-grouped root help. The help payload is ALWAYS built through the
 * `success()` envelope constructor (envelope-discipline): in `--json` mode it is the
 * envelope `data`; otherwise `emit` renders it as a human help block (whose `usage`
 * line keeps bare `kb` greppable and quiet) — never bypassing the constructors.
 */
function emitGlobalHelp(root: Command, json: boolean, io: CliIo): void {
  const help = globalHelp(root);
  emit(success(help), json, io, () => renderGlobalHelpText(help));
}

/** Emit a group's subcommand help through the `success()` envelope (JSON data or human render). */
function emitGroupHelp(command: Command, json: boolean, io: CliIo): void {
  const help = groupHelp(command);
  emit(success(help), json, io, () => renderGroupHelpText(help));
}

/**
 * Resolve help tokens to the longest known command path and emit its help. The payload
 * (global help / group help / the leaf's HelpSpec) is ALWAYS wrapped in a `success()`
 * envelope; in `--json` mode it is the envelope `data`, otherwise `emit` renders the
 * corresponding human help block. No help path writes to `io` directly.
 */
function emitHelp(root: Command, tokens: string[], json: boolean, io: CliIo): void {
  const { command, path } = resolveCommandPath(root, tokens);
  if (command === root) {
    emitGlobalHelp(root, json, io);
    return;
  }
  if (isGroup(command)) {
    emitGroupHelp(command, json, io);
    return;
  }
  const spec = helpSpecFor(command, path.join(' '));
  emit(success(spec), json, io, () => renderHelpText(spec));
}

// --------------------------------------------------------------------------
// greedy option-value pre-scan (finding 6)
// --------------------------------------------------------------------------

/** The value-taking and all-registered option tokens of `command` and its ancestors. */
function optionTokenSets(command: Command): { valueTaking: Set<string>; all: Set<string> } {
  const valueTaking = new Set<string>();
  const all = new Set<string>();
  let node: Command | null = command;
  while (node) {
    for (const opt of node.options) {
      if (opt.long) all.add(opt.long);
      if (opt.short) all.add(opt.short);
      if (opt.required || opt.optional) {
        if (opt.long) valueTaking.add(opt.long);
        if (opt.short) valueTaking.add(opt.short);
      }
    }
    node = node.parent;
  }
  return { valueTaking, all };
}

/**
 * Detect a greedy option-value misuse: a value-taking string option whose following
 * token is itself a registered option of the same command (Commander would silently
 * swallow it as the value). Uses the SAME consumed-value tokenization as the shared scan —
 * a value-taking option consumes its following token (even a `--`, which is NOT a misuse
 * since `--` is not a registered option), so the walk continues past a `--kb`-consumed `--`
 * and still reaches (e.g.) a later `--file --json`. Only a `--` NOT so consumed ends the
 * option region. The `--flag=value` form is the documented escape and is never flagged.
 * Returns a `MISSING_ARGUMENT` issue naming both tokens, or `null`.
 */
function greedyMisuse(command: Command, argv: string[]): Issue | null {
  const { valueTaking, all } = optionTokenSets(command);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') break; // a real terminator (not consumed as a value below)
    if (!tok.startsWith('-') || tok.includes('=') || !valueTaking.has(tok)) continue;
    const next = argv[i + 1];
    if (next !== undefined && next !== '--' && all.has(next)) {
      return {
        code: 'MISSING_ARGUMENT',
        severity: 'error',
        message: `${tok} expects a value; got ${next}`,
        hint: hintFor('MISSING_ARGUMENT'),
      };
    }
    i += 1; // consume the value token (even `--`) so a later `--` reads as a real terminator
  }
  return null;
}

// --------------------------------------------------------------------------
// --dry-run (router-owned position independence + §6.2 scope)
// --------------------------------------------------------------------------

/** True iff a literal `--dry-run` appears as an unconsumed option before the real terminator. */
function dryRunRequested(argv: string[], scan: OptionScan): boolean {
  for (let i = 0; i < scan.terminator; i++) {
    if (scan.consumedValues.has(i)) continue;
    if (argv[i] === '--dry-run') return true;
  }
  return false;
}

/** `argv` with every unconsumed `--dry-run` before the real terminator removed (router-consumed). */
function stripDryRun(argv: string[], scan: OptionScan): string[] {
  return argv.filter((tok, i) => !(i < scan.terminator && !scan.consumedValues.has(i) && tok === '--dry-run'));
}

// --------------------------------------------------------------------------
// bare root/group help (rows 1, 2 — routed BEFORE Commander)
// --------------------------------------------------------------------------

/**
 * `isCleanBareInvocation` answers ONE question for a root/group whose command path
 * `resolveCommandPath` already resolved with `hasTrailingPositional === false`: are all
 * the OPTION tokens well-formed, so Commander would reach its actionless-help state
 * rather than a usage error? It is the router's bijection with Commander: return `true`
 * IFF Commander would emit help, so `commander.help*` is routed here and never reached
 * (01 §1.2). When it returns `false`, some option token is malformed and Commander maps
 * it to a strict error instead:
 *   - an unknown option (`kb --bogus`) → UNKNOWN_OPTION;
 *   - an attached value on a boolean flag (`kb --json=bad`, `kb --help=bad`) → UNKNOWN_OPTION;
 *   - a value-taking option missing its value at the end (`kb --json --kb`) → MISSING_ARGUMENT;
 *   - a greedy value (`kb --kb --json`) → MISSING_ARGUMENT (caught earlier).
 *
 * `--` handling mirrors Commander (verified against v14):
 *   - a `--` IMMEDIATELY following a value-taking option is that option's VALUE, consumed
 *     unconditionally, NOT a terminator (`kb --json --kb --` sets `--kb` to `--` → bare root);
 *   - a real `--` terminator only ends OPTION parsing — every post-`--` token is a positional
 *     operand that `resolveCommandPath` already matched (known group → this stays clean and
 *     routes to that group's help; unknown token → `hasTrailingPositional` short-circuited the
 *     caller before we run). So post-terminator operands never make an invocation unclean here.
 */
function isCleanBareInvocation(command: Command, argv: string[]): boolean {
  const { valueTaking, all } = optionTokenSets(command);
  let afterTerminator = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (afterTerminator) continue; // a positional operand (resolved by resolveCommandPath)
    if (tok === '--') {
      afterTerminator = true; // a REAL terminator — only ends option parsing, never unclean
      continue;
    }
    if (!tok.startsWith('-')) continue; // a command-path positional operand (skipped)
    const flag = bareFlag(tok);
    if (!all.has(flag)) return false; // unknown option
    if (tok.includes('=')) {
      if (!valueTaking.has(flag)) return false; // attached value on a boolean flag → malformed
      continue; // a value-taking option with an attached value (`--kb=/dir`) is well-formed
    }
    if (valueTaking.has(flag)) {
      if (i + 1 >= argv.length) return false; // value-taking option missing its value at the end
      i += 1; // consume the value token unconditionally (even `--`), never a terminator
    }
  }
  return true;
}

// --------------------------------------------------------------------------
// dispatcher
// --------------------------------------------------------------------------

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  // Build the tree first, then derive JSON mode from the ONE shared scan (a leaf action
  // reads `ctx.json` only at parse time, so setting it after construction is safe). Every
  // pre-parse decision below reads this same `scan`, so no two scanners can disagree about
  // whether a `--` is the terminator or a value consumed by a value-taking option.
  const { program, ctx } = buildProgram(io, false);
  const scan = scanOptions(program, argv);
  const json = jsonRequested(argv, scan);
  ctx.json = json;

  // 1. help — `--help` anywhere in the option region, or `help [path...]`. Router-owned
  //    because Commander's --help option is disabled everywhere and `help` is not a command.
  const helpTokens = helpRequest(argv, scan);
  if (helpTokens !== null) {
    emitHelp(program, helpTokens, json, io);
    return 0;
  }

  // Resolve the longest known command path from the leading tokens (used by the
  // greedy scan, the version predicate, the dry-run scope check, and the bare-help shape).
  const resolved = resolveCommandPath(program, argv);

  // 2. Greedy option-value pre-scan on the resolved command (finding 6). Runs BEFORE
  //    version so a value-taking option that swallowed a registered option (`--kb --json`)
  //    is reported as MISSING_ARGUMENT and never masked as a version success.
  const greedy = greedyMisuse(resolved.command, argv);
  if (greedy) {
    emit(result(null, [greedy]), json, io);
    return 2;
  }

  // 3. version — router-owned (Commander's .version() is prohibited). Strict predicate,
  //    scan-derived, so a malformed leading option is NOT masked as a version success and a
  //    `--` consumed by `--kb` is scanned past (`kb --kb -- --version`).
  if (isVersionRequest(program, argv, scan)) {
    emit(versionEnvelope(io, kbFlagValue(argv, scan)), json, io);
    return 0;
  }

  // 4. `--dry-run` scope + position independence (01 §6.2). `--dry-run` is registered
  //    on exactly the payload leaves, so at a root/group position it is NOT a Commander
  //    option. The router therefore owns it: accept it (strip it, thread ctx.dryRun)
  //    when the resolved command is a leaf that supports it — at any position — and
  //    reject it (UNKNOWN_OPTION, exit 2) on every other command.
  let parseArgv = argv;
  if (dryRunRequested(argv, scan)) {
    const leaf = resolved.command;
    const isLeaf = leaf !== program && !isGroup(leaf);
    if (isLeaf && supportsDryRun(leaf)) {
      ctx.dryRun = true;
      parseArgv = stripDryRun(argv, scan);
    } else {
      const label = resolved.path.length ? `kb ${resolved.path.join(' ')}` : 'kb';
      emit(
        result(null, [
          {
            code: 'UNKNOWN_OPTION',
            severity: 'error',
            message: `${label} does not support --dry-run; it applies only to the payload commands (01 §6.2)`,
            hint: hintFor('UNKNOWN_OPTION'),
          },
        ]),
        json,
        io,
      );
      return 2;
    }
  }

  // 5. Bare root/group help (rows 1, 2). The exact bare shapes — the root or a group
  //    with no trailing (unknown) subcommand and only recognized options — are answered
  //    here, BEFORE Commander. Anything with an unknown option or an unknown subcommand
  //    falls through to Commander as UNKNOWN_OPTION / UNKNOWN_COMMAND, so Commander's
  //    own help path is never reached (01 §1.2: `commander.help*` unreachable).
  const isRootOrGroup = resolved.command === program || isGroup(resolved.command);
  if (isRootOrGroup && !resolved.hasTrailingPositional && isCleanBareInvocation(resolved.command, parseArgv)) {
    if (resolved.command === program) emitGlobalHelp(program, json, io);
    else emitGroupHelp(resolved.command, json, io);
    return 0;
  }

  // 6. Parse. The root and every group are action-less, and every bare shape was routed
  //    above, so all remaining invocations either run a leaf action or produce a mapped
  //    CommanderError (exit 2) — never `commander.help*` (asserted unreachable by tests).
  try {
    await program.parseAsync(parseArgv, { from: 'user' });
    return ctx.outcome.code;
  } catch (e) {
    if (e instanceof CommanderError) {
      emit(result(null, [commanderErrorToIssue(e)]), json, io);
      return 2;
    }
    // Defensive: an unexpected non-Commander throw is enveloped as INTERNAL, never a
    // raw stack trace (charter: envelope-discipline).
    emit(result(null, [{ code: 'INTERNAL', severity: 'error', message: (e as Error).message, hint: hintFor('INTERNAL') }]), json, io);
    return 1;
  }
}

/**
 * The registered leaf command paths — the phase's command registry, derived from
 * the built tree (asserted to be 22 in Phase 0: 21 migrated + `source list`). Consumed
 * by the issue-hint test to validate that every `kb …` command named in a hint exists.
 */
const NULL_IO: CliIo = { stdout: () => {}, stderr: () => {}, cwd: '/', env: {} };
export const COMMAND_NAMES: readonly string[] = collectLeafPaths(buildProgram(NULL_IO, false).program);
