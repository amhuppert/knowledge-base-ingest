import { describe, it, expect } from 'vitest';
import { buildProgram } from '../program.js';
import { globalHelp, renderGlobalHelpText, collectLeafPaths } from './globalHelp.js';
import { defineHelp, WORKFLOW_GROUPS } from './spec.js';
import type { CliIo } from '../io.js';

/**
 * GLOBAL HELP (01 §5) — the workflow-grouped root help is GENERATED from the
 * registered command tree (finding 14): every leaf is placed under its
 * `HelpSpec.group`, groups are emitted in the fixed pipeline order, and empty groups
 * are omitted. The load-bearing test is derivation: registering a fake command makes
 * it appear in the grouped help, proving there is no hardcoded command list.
 */

const NULL_IO: CliIo = { stdout: () => {}, stderr: () => {}, cwd: '/', env: {} };

function findGroup(help: ReturnType<typeof globalHelp>, group: string) {
  return help.groups.find((g) => g.group === group);
}

describe('global help (registry-generated)', () => {
  it('exposes start/workflow/groups/help fields', () => {
    const { program } = buildProgram(NULL_IO, false);
    const help = globalHelp(program);
    expect(help.start).toBe('kb init --json');
    expect(Array.isArray(help.workflow)).toBe(true);
    expect(Array.isArray(help.groups)).toBe(true);
    expect(help.help).toContain('--help --json');
  });

  it('retains the deprecated pre-migration commands/usage aliases (envelope-v2 additive policy)', () => {
    // 01 §2 (strictly-additive Phase-0): the restructure to start/workflow/groups/help must
    // KEEP the pre-migration flat `commands` (sorted registered leaf paths) and `usage`.
    const { program } = buildProgram(NULL_IO, false);
    const help = globalHelp(program);
    expect(help.commands).toEqual(collectLeafPaths(program));
    expect(help.commands).toEqual([...help.commands].sort()); // sorted, as before
    expect(help.commands).toContain('source list');
    expect(help.usage).toBe('kb <command> [args] [--json]');
  });

  it('emits groups in the fixed workflow order, omitting empty groups', () => {
    const { program } = buildProgram(NULL_IO, false);
    const help = globalHelp(program);
    const order = help.groups.map((g) => g.group);
    // The emitted order is a subsequence of the canonical pipeline order…
    const canonicalIdx = order.map((g) => WORKFLOW_GROUPS.indexOf(g));
    expect(canonicalIdx).toEqual([...canonicalIdx].sort((a, b) => a - b));
    // …every emitted group is non-empty (empty groups omitted)…
    expect(help.groups.every((g) => g.commands.length > 0)).toBe(true);
    // …and `workflow` mirrors the emitted group order.
    expect(help.workflow).toEqual(order);
  });

  it('places known commands under their workflow group', () => {
    const { program } = buildProgram(NULL_IO, false);
    const help = globalHelp(program);
    const commandsIn = (group: string): string[] => findGroup(help, group)?.commands.map((c) => c.command) ?? [];
    expect(commandsIn('setup')).toContain('init');
    expect(commandsIn('ingest')).toEqual(expect.arrayContaining(['ingest', 'source show', 'source chunks']));
    expect(commandsIn('structure')).toEqual(expect.arrayContaining(['node create', 'node tree', 'node show']));
    expect(commandsIn('query')).toEqual(expect.arrayContaining(['search', 'ask-context', 'answer-check', 'provenance']));
    expect(commandsIn('maintain')).toEqual(expect.arrayContaining(['status', 'verify', 'render', 'propagate']));
  });

  it('is derived from the registry: a newly registered command appears in the grouped help', () => {
    // Register a fake leaf with its own HelpSpec (group `query`). If the group list were
    // hardcoded, this command could never appear — it does, so it is registry-derived.
    const { program } = buildProgram(NULL_IO, false);
    const before = globalHelp(program);
    expect(findGroup(before, 'query')!.commands.map((c) => c.command)).not.toContain('frobnicate');

    const fake = program.command('frobnicate');
    defineHelp(fake, {
      command: 'frobnicate',
      group: 'query',
      usage: 'kb frobnicate',
      summary: 'A fake command for the derivation test.',
      args: [],
      flags: [],
      output: [],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'n/a',
      related: [],
      examples: [],
    });

    const after = globalHelp(program);
    const queryCommands = findGroup(after, 'query')!.commands;
    expect(queryCommands.map((c) => c.command)).toContain('frobnicate');
    expect(queryCommands.find((c) => c.command === 'frobnicate')!.summary).toBe(
      'A fake command for the derivation test.',
    );
  });

  it('renders a human help block whose usage line names the workflow', () => {
    const { program } = buildProgram(NULL_IO, false);
    const text = renderGlobalHelpText(globalHelp(program));
    expect(text).toContain('usage: kb <command>');
    expect(text).toContain('workflow:');
    expect(text).toContain('kb init');
  });
});
