/**
 * PROGRAM ASSEMBLY (01 §1.2).
 *
 * `buildProgram` assembles the whole Commander tree: the root is fully configured
 * first (exitOverride, captured output, help disabled, suggestions), then every
 * child is created via `parent.command(...)` so Commander copies those settings at
 * creation time. Groups (`source`, `node`, `claim`, `graph`, `entity`) are parent
 * commands with NO action handler, so an unknown subcommand (`kb node frob`) falls
 * through to Commander as `unknownCommand` with suggestions intact (finding 2).
 *
 * `addCommand(new Command())` is deliberately never used — a tree-walk test enforces
 * this by asserting every node carries the inherited configuration.
 */

import { Command } from 'commander';
import { configureNode, group, standardOptions, type RunContext } from './run.js';
import { collectLeafPaths } from './help/globalHelp.js';
import type { CliIo } from './io.js';
import { registerOps } from './commands/ops.js';
import { registerIngest } from './commands/ingest.js';
import { registerSynthesize } from './commands/synthesize.js';
import { registerQuery } from './commands/query.js';
import { registerSource } from './commands/source.js';
import { registerNode } from './commands/node.js';
import { registerClaim } from './commands/claim.js';
import { registerGraph } from './commands/graph.js';
import { registerEntity } from './commands/entity.js';

export interface BuiltProgram {
  program: Command;
  ctx: RunContext;
}

/**
 * Build the fully-configured Commander tree. `json` is threaded into the run
 * context so every leaf action emits with the same JSON mode the router resolved
 * from the literal `--json` scan (01 §1.1).
 */
export function buildProgram(io: CliIo, json: boolean): BuiltProgram {
  const program = new Command('kb');
  configureNode(program);
  // `--dry-run` is deliberately NOT registered on the root or on any group: 01 §6.2
  // limits it to exactly the five payload LEAVES, and "dry-run everywhere" is banned.
  // Position independence (`kb --dry-run claim apply`) is provided by the pre-parse
  // router in `runCli`, which validates that the resolved leaf supports dry-run and
  // rejects it (UNKNOWN_OPTION) on every other command.
  standardOptions(program);
  program.description('Agent-driven knowledge base CLI.');

  // The registry starts empty and is populated once the whole tree is built (below).
  // Handlers capture `ctx` and read `ctx.registry` at action time, so the empty seed is
  // never observed — it exists only so `steeringFor` has a stable `CommandRegistry`.
  const ctx: RunContext = { io, json, dryRun: false, outcome: { code: 0 }, registry: new Set() };

  // Root-level leaves.
  registerOps(program, ctx);
  registerIngest(program, ctx);
  registerSynthesize(program, ctx);
  registerQuery(program, ctx);

  // Groups (parent commands, no action handlers) + their leaves. Groups carry only the
  // universal standard options (`--json`/`--kb`/`--help`); `--dry-run` lives on the
  // supported leaves alone (01 §6.2).
  registerSource(group(program, 'source', 'Inspect ingested sources.'), ctx);
  registerNode(group(program, 'node', 'Build and inspect the synthesis hierarchy.'), ctx);
  registerClaim(group(program, 'claim', 'Persist and manage claims.'), ctx);
  registerGraph(group(program, 'graph', 'Persist the knowledge graph.'), ctx);
  registerEntity(group(program, 'entity', 'Inspect graph entities.'), ctx);

  // Populate the registry now that every command is registered, so steering can drop any
  // hint/next-action naming a command this phase has not shipped (01 §6.1).
  ctx.registry = new Set(collectLeafPaths(program));

  return { program, ctx };
}

/** True iff `command` registers `--dry-run` (the 01 §6.2 payload-command surface). */
export function supportsDryRun(command: Command): boolean {
  return command.options.some((opt) => opt.long === '--dry-run');
}

/** Long flags of root options that consume a following value (for path resolution). */
export function valueTakingGlobals(root: Command): Set<string> {
  const flags = new Set<string>();
  for (const opt of root.options) {
    if (opt.required || opt.optional) {
      if (opt.long) flags.add(opt.long);
      if (opt.short) flags.add(opt.short);
    }
  }
  return flags;
}

export interface ResolvedPath {
  /** The deepest command matched (the root when no leading token names a command). */
  command: Command;
  /** The matched command names, e.g. `['claim', 'apply']`. */
  path: string[];
  /** True when a non-option token remains that did NOT match a subcommand. */
  hasTrailingPositional: boolean;
}

/**
 * Resolve the longest known command path from the OPERAND tokens of `argv`, walking
 * the subcommand tree exactly as Commander does. Option tokens are skipped (and the
 * value of a value-taking global like `--kb`, consumed unconditionally — even a `--`).
 *
 * A `--` is the option TERMINATOR, not a resolution boundary: Commander keeps matching
 * every post-`--` token as a positional operand against the subcommand tree, so
 * `kb -- node` resolves the `node` group and `kb node -- create` resolves the `create`
 * leaf. After the terminator, tokens starting with `-` are operands too, never options.
 * Resolution stops at the first operand that does not name a subcommand — reported via
 * `hasTrailingPositional` so the caller can tell a bare group (`kb node`, `kb -- node`)
 * from an unknown subcommand (`kb node frob`, `kb -- frob`).
 */
export function resolveCommandPath(root: Command, argv: string[]): ResolvedPath {
  const valueGlobals = valueTakingGlobals(root);
  let command = root;
  const path: string[] = [];
  let afterTerminator = false;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (!afterTerminator && tok === '--') {
      afterTerminator = true;
      i += 1;
      continue;
    }
    if (!afterTerminator && tok.startsWith('-')) {
      i += valueGlobals.has(tok) && !tok.includes('=') ? 2 : 1;
      continue;
    }
    // A positional operand (any post-`--` token, or a pre-`--` non-option token).
    const sub = command.commands.find((c) => c.name() === tok);
    if (!sub) return { command, path, hasTrailingPositional: true };
    command = sub;
    path.push(tok);
    i += 1;
  }
  return { command, path, hasTrailingPositional: false };
}
