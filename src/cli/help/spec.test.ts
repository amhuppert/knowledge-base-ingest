import { describe, it, expect } from 'vitest';
import type { Option } from 'commander';
import { buildProgram } from '../program.js';
import { collectLeaves } from './globalHelp.js';
import { helpSpecOf, renderHelpText, WORKFLOW_GROUPS } from './spec.js';
import type { CliIo } from '../io.js';
import { NODE_KINDS, SOURCE_STATUSES, CLAIM_TYPES, TEXT_VERIFICATIONS } from '../../domain/schemas/enums.js';
import { SEARCH_SCOPES, MATCH_MODES } from '../../query/query.js';
import {
  ClaimApplySchema,
  GraphApplySchema,
  SynthesizeSchema,
  SynthesizePayloadSchema,
  AnswerCheckSchema,
  NodeApplySchema,
} from '../../domain/schemas/agent.js';

/**
 * HELP DRIFT (01 §4). Every registered command carries a colocated `HelpSpec` that
 * stays in lock-step with the Commander tree. These tests are the enforcement:
 *  - every leaf has a spec, and `spec.command` equals its resolved path;
 *  - `spec.flags` corresponds bidirectionally to the FULL `cmd.options` — one HelpFlag
 *    per registered option, INCLUDING the universal `--json`/`--kb`/`--help` and (on the
 *    payload commands) `--dry-run`, which `defineHelp` injects; nothing registered is
 *    undocumented and nothing in `spec.flags` is unregistered;
 *  - enum flags carry the exact runtime const they validate against;
 *  - each `spec.input.example` is a MINIMAL VALID payload for its named Zod schema;
 *  - `supportsDryRun` matches the §6.2 dry-run scope (true for exactly the payload
 *    commands registered this phase, false everywhere else).
 */

const NULL_IO: CliIo = { stdout: () => {}, stderr: () => {}, cwd: '/', env: {} };

/**
 * The full §6.2 dry-run scope. §6.2 lists five payload commands; `node apply` joined in
 * Phase 2, so exactly these five are dry-run-capable (kept in lock-step with
 * `program.test.ts`'s `--dry-run` registration assertion).
 */
const DRY_RUN_SCOPE: ReadonlySet<string> = new Set([
  'ingest',
  'claim apply',
  'graph apply',
  'synthesize',
  'node apply',
]);

/** The named Zod schemas an `input.schema` string may reference. */
const SCHEMAS: Record<string, { parse: (v: unknown) => unknown }> = {
  ClaimApplySchema,
  GraphApplySchema,
  SynthesizeSchema,
  SynthesizePayloadSchema,
  AnswerCheckSchema,
  NodeApplySchema,
};

const { program } = buildProgram(NULL_IO, false);
const leaves = collectLeaves(program);

/** The enum runtime consts a `flag.choices` may equal. */
const ENUM_CONSTS: Array<readonly string[]> = [
  NODE_KINDS,
  SEARCH_SCOPES,
  MATCH_MODES,
  SOURCE_STATUSES,
  CLAIM_TYPES,
  TEXT_VERIFICATIONS,
];

describe('help specs (drift)', () => {
  it('every registered leaf command has a colocated spec', () => {
    for (const { path, cmd } of leaves) {
      expect(helpSpecOf(cmd), `missing HelpSpec for "${path}"`).toBeDefined();
    }
  });

  it('spec.command equals the resolved command path', () => {
    for (const { path, cmd } of leaves) {
      expect(helpSpecOf(cmd)!.command).toBe(path);
    }
  });

  it('spec.group is one of the seven workflow groups', () => {
    for (const { path, cmd } of leaves) {
      expect(WORKFLOW_GROUPS as readonly string[], path).toContain(helpSpecOf(cmd)!.group);
    }
  });

  it('spec.flags ↔ the command registered options are bijective (by flags string)', () => {
    // 01 §4: `spec.flags` corresponds bidirectionally to the FULL `cmd.options` — a
    // DIRECT comparison, not a reconstructed union. Every registered option (the universal
    // `--json`/`--kb`/`--help`, `--dry-run` on payload commands, and the command's own
    // flags) has exactly one HelpFlag, and every HelpFlag names a registered option.
    for (const { path, cmd } of leaves) {
      const specFlags = helpSpecOf(cmd)!.flags.map((f) => f.flags).sort();
      const registered = cmd.options.map((o) => o.flags).sort();
      expect(specFlags, `${path}: spec.flags ↔ cmd.options`).toEqual(registered);
    }
  });

  it('spec.flags documents the universal standard options on every command (and --dry-run on payload commands)', () => {
    // The stored spec must actually CONTAIN the standard options (so `--help --json` and
    // human help never omit them), each matching its registered Commander option's flags
    // string — `--dry-run` present iff the command is dry-run-capable (01 §6.2).
    for (const { path, cmd } of leaves) {
      const specFlags = new Set(helpSpecOf(cmd)!.flags.map((f) => f.flags));
      for (const std of ['--json', '--kb <dir>', '--help']) {
        expect(specFlags.has(std), `${path}: spec.flags lists ${std}`).toBe(true);
      }
      expect(specFlags.has('--dry-run'), `${path}: --dry-run listed iff dry-run-capable`).toBe(
        helpSpecOf(cmd)!.supportsDryRun,
      );
    }
  });

  it('every enum flag carries the exact runtime const its option validates against', () => {
    for (const { path, cmd } of leaves) {
      const spec = helpSpecOf(cmd)!;
      const byFlags = new Map(cmd.options.map((o) => [o.flags, o]));
      for (const flag of spec.flags) {
        const option = byFlags.get(flag.flags) as (Option & { argChoices?: string[] }) | undefined;
        const argChoices = option?.argChoices;
        if (argChoices) {
          // The option is an enum → the spec must list its exact choices, and those
          // choices must BE one of the shared runtime consts (never a hand-copied list).
          expect(flag.choices, `${path} ${flag.flags} choices`).toEqual(argChoices);
          expect(
            ENUM_CONSTS.some((c) => c.length === argChoices.length && c.every((v, i) => v === argChoices[i])),
            `${path} ${flag.flags} equals a runtime const`,
          ).toBe(true);
        } else {
          expect(flag.choices, `${path} ${flag.flags} is not an enum`).toBeUndefined();
        }
      }
    }
  });

  it('the known enum flags equal their exact runtime consts', () => {
    const specByCommand = new Map(leaves.map(({ path, cmd }) => [path, helpSpecOf(cmd)!]));
    const choicesOf = (command: string, flags: string): readonly string[] | undefined =>
      specByCommand.get(command)?.flags.find((f) => f.flags === flags)?.choices;
    expect(choicesOf('node create', '--kind <kind>')).toEqual(NODE_KINDS);
    expect(choicesOf('search', '--scope <scope>')).toEqual(SEARCH_SCOPES);
    expect(choicesOf('search', '--match <mode>')).toEqual(MATCH_MODES);
    expect(choicesOf('ask-context', '--claim-type <type>')).toEqual(CLAIM_TYPES);
    expect(choicesOf('source list', '--status <status>')).toEqual(SOURCE_STATUSES);
    expect(choicesOf('ingest', '--verification <mode>')).toEqual(TEXT_VERIFICATIONS);
  });

  it('every spec.input.example is a minimal VALID payload for its named schema', () => {
    for (const { path, cmd } of leaves) {
      const spec = helpSpecOf(cmd)!;
      if (!spec.input?.schema) continue;
      const schema = SCHEMAS[spec.input.schema];
      expect(schema, `${path} names an unknown schema "${spec.input.schema}"`).toBeDefined();
      expect(() => schema!.parse(spec.input!.example), `${path} input.example must parse`).not.toThrow();
    }
  });

  it('a schema-less spec.input carries notes (a payload-free input contract is still documented)', () => {
    // `ingest` consumes a FILE, not a JSON payload: its input block documents the
    // accepted formats and the `--text-from` recipe instead of a schema + example.
    for (const { path, cmd } of leaves) {
      const input = helpSpecOf(cmd)!.input;
      if (!input || input.schema) continue;
      expect(input.notes?.length, `${path}: schema-less input must carry notes`).toBeGreaterThan(0);
    }
  });

  it('supportsDryRun matches the §6.2 dry-run scope (true for the payload commands, false elsewhere)', () => {
    for (const { path, cmd } of leaves) {
      expect(helpSpecOf(cmd)!.supportsDryRun, path).toBe(DRY_RUN_SCOPE.has(path));
    }
  });

  it('a command declares supportsDryRun iff it registers the Commander --dry-run option', () => {
    for (const { path, cmd } of leaves) {
      const registersDryRun = cmd.options.some((o) => o.long === '--dry-run');
      expect(helpSpecOf(cmd)!.supportsDryRun, `${path}: supportsDryRun ↔ --dry-run registered`).toBe(registersDryRun);
    }
  });

  it('renders a human help block whose usage names the command', () => {
    for (const { path, cmd } of leaves) {
      const text = renderHelpText(helpSpecOf(cmd)!);
      expect(text, path).toContain(`usage: kb ${path}`);
    }
  });
});

/**
 * RECEIPT-SURFACE DRIFT (03 §3.1–§3.2 + the compatibility matrix). The two receipt
 * commands changed their `data` shape this phase, so their HelpSpec `output` must
 * advertise the new per-input receipt, the totals, AND the retained aliases — which the
 * matrix requires to be marked deprecated in HelpSpec. An agent that reads only `--help
 * --json` must be able to tell the authoritative accounting from the compat aliases,
 * and must never be told about a field the receipt does not carry.
 */
describe('receipt-surface drift (03 §3)', () => {
  /** Terms every one of the command's `output` lines, joined, must contain. */
  const REQUIRED_OUTPUT_TERMS: Record<string, string[]> = {
    'claim apply': [
      'claims[]',
      'inputIndex',
      'outcome',
      'submitted',
      'spansCreated',
      'spansReused',
      'linksCreated',
      'linksReused',
      'totals',
      'linksUpdated',
      'staleNodes',
      // Retained aliases, explicitly flagged deprecated (compat matrix).
      'claimsCreated',
      'claimsUpdated',
      'affectedNodes',
      'spansCreatedNet',
      'deprecated',
    ],
    'graph apply': [
      'entities[]',
      'relationships[]',
      'entityId',
      'relationshipId',
      'outcome',
      'evidence',
      'submitted',
      'spansCreated',
      'spansReused',
      'linksCreated',
      'linksReused',
      'totals',
      'entitiesReferenced',
      'deprecated',
    ],
  };

  const outputOf = (path: string): string => {
    const leaf = leaves.find((l) => l.path === path);
    expect(leaf, `${path} must be registered`).toBeDefined();
    return helpSpecOf(leaf!.cmd)!.output.join('\n');
  };

  for (const [path, terms] of Object.entries(REQUIRED_OUTPUT_TERMS)) {
    it(`${path} documents its per-input receipt, totals and deprecated aliases`, () => {
      const output = outputOf(path);
      for (const term of terms) expect(output, `${path} output must document "${term}"`).toContain(term);
    });
  }

  it('graph apply advertises no staleNodes output field (graph mutations never stale nodes)', () => {
    // The receipt OMITS the field entirely (03 §3.2), so no output line may offer it.
    const leaf = leaves.find((l) => l.path === 'graph apply')!;
    for (const line of helpSpecOf(leaf.cmd)!.output) {
      expect(line.startsWith('staleNodes'), `graph apply must not advertise "${line}"`).toBe(false);
    }
  });
});
