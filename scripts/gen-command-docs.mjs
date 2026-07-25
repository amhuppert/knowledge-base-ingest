#!/usr/bin/env node
// Generate the CLI reference in docs/USER_GUIDE.md FROM THE CLI (07 §4).
//
//   node scripts/gen-command-docs.mjs
//
// Discovery and contracts both come from the tool: `./bin/kb --help --json` lists the
// commands and their workflow grouping, `./bin/kb <command> --help --json` prints one
// command's HelpSpec. Nothing is imported from src/ — an .mjs script must not depend on
// the TypeScript build, and shelling out is what makes the CLI (not a type) the contract.
//
// Only the block between `<!-- generated:commands:start -->` and
// `<!-- generated:commands:end -->` is rewritten; everything else in the guide is
// human-owned prose. Running twice is a no-op (asserted by src/cli/gen-command-docs.test.ts).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KB = join(ROOT, 'bin/kb');
const GUIDE = join(ROOT, 'docs/USER_GUIDE.md');
const START = '<!-- generated:commands:start -->';
const END = '<!-- generated:commands:end -->';

/** Run the CLI and return the parsed envelope; a non-ok envelope is a hard failure. */
function help(args) {
  const stdout = execFileSync(KB, [...args, '--help', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) throw new Error(`kb ${args.join(' ')} --help --json returned ok:false`);
  return envelope.data;
}

/** Escape the pipes and newlines that would break a markdown table cell. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const fence = (body, lang = '') => ['```' + lang, body, '```'].join('\n');

/** One command's section, rendered from its HelpSpec. */
function renderCommand(spec) {
  const out = [];
  out.push(`#### \`kb ${spec.command}\``, '');
  out.push(spec.summary, '');
  out.push(fence(spec.usage, 'text'), '');

  if (spec.workflow) out.push(`*When:* ${spec.workflow}`, '');

  if (spec.args?.length) {
    out.push('| Argument | Description |', '|---|---|');
    for (const arg of spec.args) out.push(`| \`${cell(arg.name)}\` | ${cell(arg.description)} |`);
    out.push('');
  }

  if (spec.flags?.length) {
    out.push('| Flag | Description |', '|---|---|');
    for (const flag of spec.flags) {
      const choices = flag.choices?.length ? ` (one of: ${flag.choices.map((c) => `\`${c}\``).join(', ')})` : '';
      out.push(`| \`${cell(flag.flags)}\` | ${cell(flag.description)}${choices} |`);
    }
    out.push('');
  }

  if (spec.input) {
    out.push('**Input**', '');
    if (spec.input.notes?.length) {
      out.push(fence(spec.input.notes.join('\n'), 'text'), '');
    }
    if (spec.input.example) {
      out.push(fence(JSON.stringify(spec.input.example, null, 2), 'json'), '');
    }
  }

  if (spec.output?.length) {
    out.push('**Output**', '');
    for (const line of spec.output) out.push(`- ${line}`);
    out.push('');
  }

  if (spec.sideEffects?.length) {
    out.push('**Side effects**', '');
    for (const line of spec.sideEffects) out.push(`- ${line}`);
    out.push('');
  }

  const traits = [];
  if (spec.atomic) traits.push('atomic (one transaction; all-or-nothing)');
  if (spec.supportsDryRun) traits.push('supports `--dry-run`');
  if (traits.length) out.push(`*${traits.join(' · ')}*`, '');

  if (spec.examples?.length) {
    out.push('**Examples**', '');
    out.push(fence(spec.examples.map((e) => `# ${e.description}\n${e.command}`).join('\n\n'), 'bash'), '');
  }

  if (spec.related?.length) {
    out.push(`*Related:* ${spec.related.map((r) => `\`kb ${r}\``).join(' · ')}`, '');
  }

  return out;
}

function render(global, specs) {
  const byCommand = new Map(specs.map((s) => [s.command, s]));
  const dryRun = specs.filter((s) => s.supportsDryRun).map((s) => `\`kb ${s.command}\``);

  const out = [];
  out.push('');
  out.push(`Generated from the CLI by \`pnpm docs:commands\` — do not edit this block by hand.`, '');
  out.push(
    `Every command accepts \`--json\` (the envelope \`{ ok, data, issues, errors, warnings, nextActions, hints }\`)`,
    `and \`--kb <dir>\`. Exit code is \`1\` when \`ok:false\`. \`--dry-run\` is accepted by exactly ${dryRun.length}`,
    `commands: ${dryRun.join(', ')}.`,
    '',
  );
  out.push(`Start here: \`${global.start}\`. Workflow order: ${global.workflow.map((w) => `**${w}**`).join(' → ')}.`, '');

  for (const group of global.groups) {
    out.push(`### ${group.group} — ${group.summary}`, '');
    for (const { command } of group.commands) {
      const spec = byCommand.get(command);
      if (!spec) throw new Error(`no help spec for advertised command "${command}"`);
      out.push(...renderCommand(spec));
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const global = help([]);
const specs = global.commands.map((command) => help(command.split(' ')));

const guide = readFileSync(GUIDE, 'utf8');
const from = guide.indexOf(START);
const to = guide.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(`gen-command-docs FAILED: docs/USER_GUIDE.md must contain ${START} … ${END}`);
  process.exit(1);
}

const next = `${guide.slice(0, from + START.length)}\n${render(global, specs)}\n${guide.slice(to)}`;
const changed = next !== guide;
if (changed) writeFileSync(GUIDE, next);
console.log(
  `gen-command-docs: ${specs.length} commands rendered into docs/USER_GUIDE.md (${changed ? 'updated' : 'no change'})`,
);
