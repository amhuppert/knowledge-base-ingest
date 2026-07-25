/**
 * GLOBAL + GROUP HELP (01 §5) — registry-generated.
 *
 * The command list is derived from the registered Commander tree at RUNTIME
 * (finding 14), so help can never advertise a command this phase has not shipped.
 * Global (root) help is the workflow-grouped progressive-disclosure surface: every
 * registered leaf is placed under its `HelpSpec.group` and the groups are emitted in
 * the fixed pipeline order (setup → ingest → structure → extract → synthesize →
 * query → maintain). An empty group is omitted entirely. A test proves there is no
 * hardcoded command list: registering a fake command makes it appear.
 */

import type { Command } from 'commander';
import { helpSpecFor, WORKFLOW_GROUPS, type WorkflowGroup } from './spec.js';

/** A command node is a GROUP iff it has subcommands (leaves have none). */
export function isGroup(cmd: Command): boolean {
  return cmd.commands.length > 0;
}

/** Space-joined path from (but excluding) the root down to `cmd`. */
export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let node: Command | null = cmd;
  while (node && node.parent) {
    parts.unshift(node.name());
    node = node.parent;
  }
  return parts.join(' ');
}

/** Every leaf command path under `root`, sorted (the phase's command registry, rendered). */
export function collectLeafPaths(root: Command): string[] {
  const paths: string[] = [];
  const walk = (cmd: Command): void => {
    for (const child of cmd.commands) {
      if (isGroup(child)) walk(child);
      else paths.push(commandPath(child));
    }
  };
  walk(root);
  return paths.sort();
}

/** A leaf command node paired with its space-joined path. */
export interface Leaf {
  path: string;
  cmd: Command;
}

/** Every leaf command under `root` with its Command node, sorted by path. */
export function collectLeaves(root: Command): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (cmd: Command): void => {
    for (const child of cmd.commands) {
      if (isGroup(child)) walk(child);
      else leaves.push({ path: commandPath(child), cmd: child });
    }
  };
  walk(root);
  return leaves.sort((a, b) => a.path.localeCompare(b.path));
}

/** A single command row in help (path + one-line summary). */
export interface CommandSummary {
  command: string;
  summary: string;
}

/** One workflow group and the registered commands under it. */
export interface HelpGroup {
  group: WorkflowGroup;
  /** What this stage of the workflow is for. */
  summary: string;
  commands: CommandSummary[];
}

/** Workflow-grouped root help (01 §5) — the progressive-disclosure entry point. */
export interface GlobalHelp {
  /** A verbatim-runnable first command. */
  start: string;
  /** The workflow, as the ordered NAMES of the groups that actually have commands. */
  workflow: WorkflowGroup[];
  /** The registered commands, grouped by `HelpSpec.group`, in workflow order (empty groups omitted). */
  groups: HelpGroup[];
  /** How to get per-command help. */
  help: string;
  /**
   * @deprecated envelope-v2 compatibility alias (01 §2, strictly-additive Phase-0 policy).
   * The pre-migration global help exposed a FLAT sorted command list; retained here (the
   * sorted registered leaf paths) so existing consumers keep working. Prefer `groups`.
   */
  commands: string[];
  /**
   * @deprecated envelope-v2 compatibility alias (01 §2). The pre-migration global help's
   * one-line usage string; retained verbatim. Prefer `start`/`help`.
   */
  usage: string;
}

/** One-line purpose of each workflow group (for the grouped root help). */
const GROUP_SUMMARIES: Record<WorkflowGroup, string> = {
  setup: 'Create and open the knowledge base',
  ingest: 'Register sources and read their chunks',
  structure: 'Build the synthesis hierarchy',
  extract: 'Extract claims and the knowledge graph',
  synthesize: 'Write node prose that cites claims',
  query: 'Search and answer with provenance',
  maintain: 'Inspect, verify, and render',
};

/**
 * Build the workflow-grouped root help by placing every REGISTERED leaf under its
 * `HelpSpec.group` and emitting the groups in the fixed pipeline order. A group with
 * no registered commands is omitted, so help never advertises an unshipped stage.
 */
export function globalHelp(root: Command): GlobalHelp {
  const byGroup = new Map<WorkflowGroup, CommandSummary[]>();
  for (const { path, cmd } of collectLeaves(root)) {
    const spec = helpSpecFor(cmd, path);
    const list = byGroup.get(spec.group) ?? [];
    list.push({ command: path, summary: spec.summary });
    byGroup.set(spec.group, list);
  }

  const groups: HelpGroup[] = [];
  for (const group of WORKFLOW_GROUPS) {
    const commands = byGroup.get(group);
    if (!commands || commands.length === 0) continue;
    commands.sort((a, b) => a.command.localeCompare(b.command));
    groups.push({ group, summary: GROUP_SUMMARIES[group], commands });
  }

  return {
    start: 'kb init --json',
    workflow: groups.map((g) => g.group),
    groups,
    help: 'Run kb <command> --help --json for command-specific usage.',
    // Deprecated envelope-v2 aliases (01 §2): the restructure from the pre-migration
    // flat `{ commands, usage, help }` shape to `{ start, workflow, groups, help }`
    // retains `commands` (sorted registered leaf paths) and `usage` for the life of
    // envelope v2, so no consumer breaks. Recorded in the Phase-0 compatibility matrix.
    commands: collectLeafPaths(root),
    usage: 'kb <command> [args] [--json]',
  };
}

/** The human render of the workflow-grouped root help (`kb` / `kb help`, no `--json`). */
export function renderGlobalHelpText(help: GlobalHelp): string {
  const lines: string[] = [];
  lines.push('usage: kb <command> [args] [--json]');
  lines.push('');
  lines.push(`start: ${help.start}`);
  lines.push(`workflow: ${help.workflow.join(' → ')}`);
  for (const g of help.groups) {
    lines.push('');
    lines.push(`${g.group} — ${g.summary}`);
    for (const c of g.commands) lines.push(`  kb ${c.command}  ${c.summary}`);
  }
  lines.push('');
  lines.push(help.help);
  return lines.join('\n');
}

/** Group help — the subcommands of one group with their summaries. */
export interface GroupHelp {
  group: string;
  usage: string;
  commands: CommandSummary[];
}

export function groupHelp(group: Command): GroupHelp {
  const path = commandPath(group);
  return {
    group: path,
    usage: `kb ${path} <subcommand> [--json]`,
    commands: group.commands.map((child) => ({
      command: commandPath(child),
      summary: child.description(),
    })),
  };
}

/** The human render of a group's subcommand list (`kb <group>`, no `--json`). */
export function renderGroupHelpText(help: GroupHelp): string {
  const lines: string[] = [];
  lines.push(`usage: ${help.usage}`);
  lines.push('');
  lines.push(`kb ${help.group} subcommands:`);
  for (const c of help.commands) lines.push(`  kb ${c.command}  ${c.summary}`);
  return lines.join('\n');
}
