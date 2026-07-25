import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildProgram } from './program.js';
import { commanderOutput } from './run.js';
import { collectLeafPaths, isGroup, commandPath } from './help/globalHelp.js';
import type { CliIo } from './io.js';

/**
 * TREE-WALK lint (01 §1.2, acceptance item 1). Every node in the assembled tree —
 * root, groups, and leaves — must carry the mandatory configuration Commander needs
 * so help/version never reach `parseAsync` and errors never hit the real streams:
 * `exitOverride`, captured (discarding) output, `helpOption(false)`, and
 * `helpCommand(false)`. Children are created only via `parent.command(...)`; a node
 * created with `addCommand(new Command())` would miss this config and fail here.
 */

const NULL_IO: CliIo = { stdout: () => {}, stderr: () => {}, cwd: '/', env: {} };

function allNodes(root: Command): Command[] {
  const nodes: Command[] = [root];
  const walk = (cmd: Command): void => {
    for (const child of cmd.commands) {
      nodes.push(child);
      walk(child);
    }
  };
  walk(root);
  return nodes;
}

describe('program tree configuration', () => {
  const { program } = buildProgram(NULL_IO, false);
  const nodes = allNodes(program);

  it('registers exactly 25 leaf commands and the 5 groups', () => {
    // 21 migrated commands + `source list` (Phase 0) + `node apply` (Phase 2)
    // + `coverage` (Phase 4) + `entity list` (eval run 1, finding 3).
    expect(collectLeafPaths(program)).toHaveLength(25);
    const groups = program.commands.filter(isGroup).map((c) => c.name()).sort();
    expect(groups).toEqual(['claim', 'entity', 'graph', 'node', 'source']);
  });

  it('every node has exitOverride set (a callback function)', () => {
    for (const node of nodes) {
      expect(typeof (node as unknown as { _exitCallback: unknown })._exitCallback, commandPath(node) || 'kb').toBe('function');
    }
  });

  it('every node routes output through the shared capturing (discarding) writers', () => {
    for (const node of nodes) {
      const cfg = (node as unknown as { _outputConfiguration: { writeOut: unknown; writeErr: unknown } })._outputConfiguration;
      expect(cfg.writeOut).toBe(commanderOutput.writeOut);
      expect(cfg.writeErr).toBe(commanderOutput.writeErr);
    }
  });

  it('every node has helpOption(false) and helpCommand(false)', () => {
    for (const node of nodes) {
      const n = node as unknown as { _helpOption: unknown; _addImplicitHelpCommand: unknown };
      expect(n._helpOption, `${commandPath(node) || 'kb'} helpOption`).toBe(null);
      expect(n._addImplicitHelpCommand, `${commandPath(node) || 'kb'} helpCommand`).toBe(false);
    }
  });

  it('groups have no action handler (so unknown subcommands surface as unknownCommand)', () => {
    for (const group of program.commands.filter(isGroup)) {
      expect((group as unknown as { _actionHandler: unknown })._actionHandler).toBeFalsy();
    }
  });

  it('registers --json, --kb, and --help as standard options on EVERY node (01 §1.3)', () => {
    // --help is a registered Commander option (present in cmd.options for drift/help
    // specs) even though the pre-parse router consumes it before Commander parses.
    for (const node of nodes) {
      const longs = node.options.map((o) => o.long);
      const where = commandPath(node) || 'kb';
      expect(longs, `${where} --json`).toContain('--json');
      expect(longs, `${where} --kb`).toContain('--kb');
      expect(longs, `${where} --help`).toContain('--help');
    }
  });

  it('registers --dry-run on EXACTLY the payload leaves — never root or a group (01 §6.2)', () => {
    const withDryRun = nodes
      .filter((n) => n.options.some((o) => o.long === '--dry-run'))
      .map((n) => commandPath(n))
      .sort();
    // The full §6.2 dry-run surface (node apply joined in Phase 2). "dry-run everywhere"
    // is banned; the root and all five groups must NOT carry --dry-run.
    expect(withDryRun).toEqual(['claim apply', 'graph apply', 'ingest', 'node apply', 'synthesize']);
    expect(program.options.some((o) => o.long === '--dry-run'), 'root has no --dry-run').toBe(false);
    for (const group of program.commands.filter(isGroup)) {
      expect(group.options.some((o) => o.long === '--dry-run'), `${group.name()} has no --dry-run`).toBe(false);
    }
  });
});
