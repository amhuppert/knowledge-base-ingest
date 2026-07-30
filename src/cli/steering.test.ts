import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  steeringFor,
  nextActionsForStale,
  matchingSteeringRows,
  STEERING_TABLE,
  DRY_RUN_TABLE,
  type SteeringRow,
  type CommandRegistry,
  type SteeringState,
} from './steering.js';
import { buildProgram } from './program.js';
import { collectLeafPaths } from './help/globalHelp.js';
import type { CliIo } from './io.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A stub registry: only the named commands are "registered" this phase. */
function registry(...commands: string[]): CommandRegistry {
  return new Set(commands);
}

// The command set registered from Phase 0 on (no `node apply`, no `coverage`).
const PHASE0 = registry(
  'init',
  'ingest',
  'source chunks',
  'node create',
  'node show',
  'node tree',
  'claim apply',
  'graph apply',
  'synthesize',
  'verify',
  'render',
  'entity show',
  'provenance',
);

describe('steeringFor — table rows', () => {
  it('ingest ok → source chunks next-action + claim-apply hint', () => {
    const s = steeringFor('ingest', { ok: true, newSourceId: 'src_1' }, PHASE0);
    expect(s.nextActions).toEqual([expect.objectContaining({ command: 'kb source chunks src_1 --json' })]);
    expect(s.hints.join(' ')).toContain('kb claim apply --help --json');
  });

  it('ingest ok with stranded claims after --supersedes → re-extract + verify hints (Phase 5 §1.4)', () => {
    const s = steeringFor('ingest', { ok: true, newSourceId: 'src_2', strandedClaimCount: 3 }, PHASE0);
    const joined = s.hints.join(' ');
    expect(joined).toContain('3 claim(s)');
    expect(joined).toContain('anchored only to the superseded source');
    expect(joined).toContain('kb source chunks src_2 --json');
    expect(joined).toContain('kb verify --strict --json');
  });

  it('a plain ingest (no stranded claims) emits no supersede hint', () => {
    const s = steeringFor('ingest', { ok: true, newSourceId: 'src_1', strandedClaimCount: 0 }, PHASE0);
    expect(s.hints.join(' ')).not.toContain('superseded source');
  });

  it('claim apply ok with one stale node → single node show --context, no remainder hint', () => {
    const s = steeringFor('claim apply', { ok: true, staleIds: ['nod_9'] }, PHASE0);
    expect(s.nextActions).toEqual([expect.objectContaining({ command: 'kb node show nod_9 --context --json' })]);
    expect(s.hints).toEqual([]);
  });

  it('claim apply ok with zero stale → verify --strict', () => {
    const s = steeringFor('claim apply', { ok: true, staleIds: [] }, PHASE0);
    expect(s.nextActions).toEqual([expect.objectContaining({ command: 'kb verify --strict --json' })]);
  });

  it('claim apply dry-run with candidates emits one registry-filtered adjudication hint', () => {
    const state: SteeringState = {
      ok: true,
      dryRun: {
        command: 'kb claim apply --file c.json --json',
        payloadFrom: 'file',
      },
      hasReviewCandidates: true,
    };
    const registered = steeringFor(
      'claim apply',
      state,
      registry('claim apply', 'claim supersede', 'claim conflict'),
    );
    expect(registered.hints).toEqual([
      'Review candidates via kb claim supersede / kb claim conflict, or accept coexistence.',
    ]);

    const filtered = steeringFor(
      'claim apply',
      state,
      registry('claim apply', 'claim supersede'),
    );
    expect(filtered.hints).toEqual([]);
  });

  it('synthesize ok with zero stale (a batch cleared the last stale node) → verify --strict', () => {
    // A batch synthesize reports the post-apply stale set on the same `synthesize` row, so
    // clearing the LAST stale node in one payload lands on the terminal verify action (04 §3).
    const s = steeringFor('synthesize', { ok: true, staleIds: [] }, PHASE0);
    expect(s.nextActions).toEqual([expect.objectContaining({ command: 'kb verify --strict --json' })]);
    expect(s.hints).toEqual([]);
  });

  it('claim apply fail with quote issues → reread chunks + fix-the-quote hint', () => {
    const s = steeringFor('claim apply', { ok: false, quoteIssue: true, sourceId: 'src_1' }, PHASE0);
    expect(s.nextActions).toEqual([expect.objectContaining({ command: 'kb source chunks src_1 --json' })]);
    expect(s.hints.join(' ')).toContain('--dry-run');
  });

  it('source list ok → source show + source chunks hints (placeholders → hints, not next-actions)', () => {
    const reg = registry('source list', 'source show', 'source chunks');
    const s = steeringFor('source list', { ok: true }, reg);
    // Both carry an <id> placeholder, so they are hints and there are NO next-actions.
    expect(s.nextActions).toEqual([]);
    expect(s.hints.join(' ')).toContain('kb source show <id> --json');
    expect(s.hints.join(' ')).toContain('kb source chunks <id> --json');
  });

  it('source list steering drops a hint whose command is unregistered (phase-aware)', () => {
    // Only `source show` registered → the `source chunks` hint is withheld.
    const s = steeringFor('source list', { ok: true }, registry('source list', 'source show'));
    expect(s.hints.join(' ')).toContain('kb source show');
    expect(s.hints.join(' ')).not.toContain('kb source chunks');
  });

  it('entity list ok → entity show hint (placeholder → hint, not a next-action)', () => {
    const s = steeringFor('entity list', { ok: true }, registry('entity list', 'entity show'));
    expect(s.nextActions).toEqual([]);
    expect(s.hints.join(' ')).toContain('kb entity show <id> --json');
  });

  it('graph apply offers exactly one source-scoped relationship-list hint and registry-filters it', () => {
    const registered = steeringFor(
      'graph apply',
      { ok: true, sourceId: 'src_1' },
      registry('graph apply', 'relationship list', 'entity show', 'entity list'),
    );
    expect(registered).toEqual({
      nextActions: [],
      hints: ['kb relationship list --source src_1 --json'],
    });

    const unregistered = steeringFor(
      'graph apply',
      { ok: true, sourceId: 'src_1' },
      registry('graph apply', 'entity show', 'entity list'),
    );
    expect(unregistered).toEqual({ nextActions: [], hints: [] });
  });

  it('coverage offers the relationship review only when scoped, with no relationship-list back-pointer', () => {
    const reg = registry('coverage', 'relationship list');

    expect(steeringFor('coverage', { ok: true, scopedSourceId: 'src_1' }, reg)).toEqual({
      nextActions: [],
      hints: ['kb relationship list --source src_1 --json'],
    });
    expect(steeringFor('coverage', { ok: true }, reg)).toEqual({
      nextActions: [],
      hints: [],
    });
    expect(steeringFor('relationship list', { ok: true }, reg)).toEqual({
      nextActions: [],
      hints: [],
    });
  });

  it('verify ok → render next-action; the coverage hint is withheld until coverage ships', () => {
    const s = steeringFor('verify', { ok: true }, PHASE0);
    expect(s.nextActions).toEqual([expect.objectContaining({ command: 'kb render --json' })]);
    expect(s.hints.join(' ')).not.toContain('kb coverage');
  });

  it('answer-check failure → ask-context hint (placeholder → hint, no next-action)', () => {
    const s = steeringFor('answer-check', { ok: false }, registry('answer-check', 'ask-context'));
    expect(s.nextActions).toEqual([]);
    expect(s.hints).toEqual(['kb ask-context "<topic>" --json finds citable claims.']);
  });

  it('answer-check success emits no steering', () => {
    const s = steeringFor('answer-check', { ok: true }, registry('answer-check', 'ask-context'));
    expect(s.nextActions).toEqual([]);
    expect(s.hints).toEqual([]);
  });

  it('answer-check steering drops the hint when ask-context is unregistered (phase-aware)', () => {
    const s = steeringFor('answer-check', { ok: false }, registry('answer-check'));
    expect(s.hints).toEqual([]);
  });

  it('every emitted next-action command is verbatim (no <placeholder> tokens)', () => {
    const samples = [
      steeringFor('ingest', { ok: true, newSourceId: 'src_1' }, PHASE0),
      steeringFor('claim apply', { ok: true, staleIds: ['nod_9', 'nod_8'] }, PHASE0),
      steeringFor('verify', { ok: true }, PHASE0),
    ];
    for (const s of samples) {
      for (const na of s.nextActions) expect(na.command).not.toMatch(/[<>]/);
    }
  });
});

describe('steeringFor — stale rows never silently truncate (01 §6.1, no-silent-truncation)', () => {
  const staleIds = ['nod_a', 'nod_b', 'nod_c', 'nod_d', 'nod_e'];

  for (const command of ['claim apply', 'synthesize'] as const) {
    it(`${command} ok with 5 stale → ≤3 node shows + remainder hint stating 3 of 5`, () => {
      const s = steeringFor(command, { ok: true, staleIds }, PHASE0);
      expect(s.nextActions.map((n) => n.command)).toEqual([
        'kb node show nod_a --context --json',
        'kb node show nod_b --context --json',
        'kb node show nod_c --context --json',
      ]);
      // The remainder is always stated: 3 shown, 2 not listed, of 5.
      expect(s.hints).toHaveLength(1);
      expect(s.hints[0]).toContain('3 of 5');
      expect(s.hints[0]).toContain('2 not listed');
    });
  }

  it('states omitted count without referencing an unregistered command (node show present, node tree absent)', () => {
    const reg = registry('claim apply', 'node show'); // no node tree
    const s = steeringFor('claim apply', { ok: true, staleIds }, reg);
    expect(s.nextActions).toHaveLength(3);
    expect(s.hints[0]).toContain('2 not listed');
    expect(s.hints.join(' ')).not.toContain('kb node tree');
  });
});

describe('steeringFor — stale-target v2 (the named 01 §6.1 flip, 04 deliverable 4)', () => {
  // Phase 2 registers `kb node show --context`, so EVERY stale follow-up now targets the
  // synthesis-ready bundle instead of the bare node read. The flip is asserted verbatim
  // across both emitting commands and both entry points.
  for (const command of ['claim apply', 'synthesize'] as const) {
    it(`${command} stale follow-ups request the --context bundle`, () => {
      const s = steeringFor(command, { ok: true, staleIds: ['nod_deep'] }, PHASE0);
      expect(s.nextActions).toEqual([
        { title: 'Re-synthesize stale node nod_deep', command: 'kb node show nod_deep --context --json' },
      ]);
      expect(s.nextActions.map((n) => n.command)).not.toContain('kb node show nod_deep --json');
    });
  }

  it('nextActionsForStale uses the same v2 target', () => {
    const s = nextActionsForStale({ nodes: { listStaleDeepestFirst: () => [{ id: 'nod_deep' }] } }, PHASE0, 3);
    expect(s.nextActions.map((n) => n.command)).toEqual(['kb node show nod_deep --context --json']);
  });
});

describe('steeringFor — node show --context (04 §1)', () => {
  it('emits the authoring TEMPLATE as a hint (placeholders never reach nextActions)', () => {
    const s = steeringFor('node show', { ok: true, context: true }, PHASE0);
    expect(s.nextActions).toEqual([]);
    expect(s.hints.join(' ')).toContain('kb synthesize --file <payload.json> --dry-run --json');
  });

  it('adds the provenance hint only when a snippet was truncated', () => {
    const plain = steeringFor('node show', { ok: true, context: true }, PHASE0);
    expect(plain.hints.join(' ')).not.toContain('kb provenance');

    const truncated = steeringFor('node show', { ok: true, context: true, snippetsTruncated: true }, PHASE0);
    expect(truncated.hints.join(' ')).toContain('kb provenance <claim_id> --json');
  });

  it('adds the synthesize-children-first hint only above the 24000-token threshold', () => {
    const small = steeringFor('node show', { ok: true, context: true, approxTokens: 24000 }, PHASE0);
    expect(small.hints.join(' ')).not.toMatch(/children first/i);

    const large = steeringFor('node show', { ok: true, context: true, approxTokens: 24001 }, PHASE0);
    expect(large.hints.join(' ')).toMatch(/children first/i);
  });

  it('emits nothing for a plain node show (no --context)', () => {
    expect(steeringFor('node show', { ok: true }, PHASE0)).toEqual({ nextActions: [], hints: [] });
  });

  it('drops hints whose command is unregistered (phase-aware)', () => {
    const reg = registry('node show'); // neither synthesize nor provenance shipped
    const s = steeringFor('node show', { ok: true, context: true, snippetsTruncated: true }, reg);
    expect(s.hints).toEqual([]);
  });
});

describe('steeringFor — dry-run rows are EXCLUSIVE (03 §2)', () => {
  // Representative receipt state that WOULD trigger real-apply follow-ups if the
  // normal rows fired: a new source id, stale nodes, graph source id. A dry-run must
  // steer only to the replay action for each of the five dry-run commands.
  const receiptState: Record<string, SteeringState> = {
    'claim apply': { ok: true, staleIds: ['nod_a', 'nod_b'] },
    graph: { ok: true, sourceId: 'src_1' },
    synthesize: { ok: true, staleIds: ['nod_a'] },
    'node apply': { ok: true, hasSources: false },
    ingest: { ok: true, newSourceId: 'src_1' },
  };

  const cases: Array<[command: string, replay: string, extra: SteeringState]> = [
    ['claim apply', 'kb claim apply --file c.json --json', receiptState['claim apply']!],
    ['graph apply', 'kb graph apply --file g.json --json', receiptState['graph']!],
    ['synthesize', 'kb synthesize --file n.json --json', receiptState['synthesize']!],
    ['ingest', 'kb ingest doc.md --json', receiptState['ingest']!],
  ];

  for (const [command, replay, extra] of cases) {
    it(`${command} dry-run(file) steers ONLY to the same command without --dry-run`, () => {
      const s = steeringFor(command, { ...extra, dryRun: { command: replay, payloadFrom: 'file' } }, PHASE0);
      expect(s.nextActions).toEqual([expect.objectContaining({ command: replay })]);
      // No real-apply follow-ups leaked in.
      expect(s.nextActions.map((n) => n.command)).not.toContain('kb verify --strict --json');
      expect(s.nextActions.some((n) => n.command.startsWith('kb node show'))).toBe(false);
      expect(s.nextActions.some((n) => n.command.startsWith('kb source chunks'))).toBe(false);
      expect(s.hints).toEqual([]);
    });
  }

  it('node apply dry-run(file) emits nothing while node apply is unregistered', () => {
    const s = steeringFor(
      'node apply',
      { ...receiptState['node apply']!, dryRun: { command: 'kb node apply --file m.json --json', payloadFrom: 'file' } },
      PHASE0,
    );
    expect(s.nextActions).toEqual([]);
  });

  it('dry-run(stdin) → hint only, no auto-replay next-action', () => {
    const s = steeringFor('claim apply', { ok: true, dryRun: { command: 'kb claim apply --json', payloadFrom: 'stdin' } }, PHASE0);
    expect(s.nextActions).toEqual([]);
    expect(s.hints.join(' ')).toMatch(/stdin payloads cannot be replayed/i);
  });

  // A FAILED dry-run must NOT be routed exclusively to the dry-run table (whose rows
  // are all `--dry-run ok`, 01 §6.1). It falls through to the normal failure rows so
  // recovery steering still fires — otherwise a failed preview returns nothing.
  it('FAILED dry-run(file) with quote issues falls through to normal quote-recovery steering', () => {
    const s = steeringFor(
      'claim apply',
      { ok: false, quoteIssue: true, sourceId: 'src_1', dryRun: { command: 'kb claim apply --file c.json --json', payloadFrom: 'file' } },
      PHASE0,
    );
    expect(s.nextActions).toEqual([expect.objectContaining({ command: 'kb source chunks src_1 --json' })]);
    expect(s.hints.join(' ')).toContain('--dry-run');
    // No replay action — a failed preview wrote nothing, so there is nothing to apply.
    expect(s.nextActions.map((n) => n.command)).not.toContain('kb claim apply --file c.json --json');
  });
});

describe('steeringFor — phase-aware registry filtering', () => {
  it('init: the Phase-2 "node apply" hint appears only once node apply is registered', () => {
    const withoutApply = steeringFor('init', {}, PHASE0);
    expect(withoutApply.hints.join(' ')).toContain('kb ingest'); // present-command hint stays
    expect(withoutApply.hints.join(' ')).not.toContain('kb node apply');

    const withApply = steeringFor('init', {}, registry('init', 'ingest', 'node apply'));
    expect(withApply.hints.join(' ')).toContain('kb node apply');
  });

  it('a row referencing an unregistered command degrades to nothing', () => {
    // Registry lacks `node show`: the claim-apply stale row emits no next-action but
    // STILL states that every stale node was omitted (no false "shown" count).
    const s = steeringFor('claim apply', { ok: true, staleIds: ['nod_9', 'nod_8'] }, registry('claim apply', 'node tree', 'verify'));
    expect(s.nextActions).toEqual([]);
    expect(s.hints[0]).toContain('0 of 2');
    expect(s.hints[0]).toContain('2 not listed');
  });
});

describe('steeringFor — EVERY row against the FULL current registry (01 §6.1, phase boundary)', () => {
  // The real, fully-assembled registry (every leaf this phase ships, `coverage` included).
  const NULL_IO: CliIo = { stdout: () => {}, stderr: () => {}, cwd: '/', env: {} };
  const FULL_PATHS = collectLeafPaths(buildProgram(NULL_IO, false).program);
  const FULL: CommandRegistry = new Set(FULL_PATHS);

  /** True iff a verbatim `kb …` command string names a registered leaf command. */
  function namesRegisteredCommand(command: string): boolean {
    const rest = command.replace(/^kb /, '');
    return FULL_PATHS.some((path) => rest === path || rest.startsWith(`${path} `));
  }

  // A state that triggers EACH row: one normal case per normal row and one dry-run
  // case per dry-run row — BOTH the `file` and `stdin` variant for all five dry-run
  // commands. The row-coverage assertion below fails if any table row goes untouched,
  // which is what surfaced the Phase-2/3 rows (`node apply` hasSources branches,
  // `node show --context`, `answer-check` failure) when those phases merged in.
  const dryRun = (command: string, payloadFrom: 'file' | 'stdin', replay: string): { command: string; state: SteeringState } => ({
    command,
    state: { ok: true, dryRun: { command: replay, payloadFrom } },
  });
  const CASES: Array<{ command: string; state: SteeringState }> = [
    { command: 'init', state: {} },
    { command: 'ingest', state: { ok: true, newSourceId: 'src_1' } },
    // The supersede row (Phase 5 §1.4) fires only when the receipt reports stranded claims.
    { command: 'ingest', state: { ok: true, newSourceId: 'src_2', strandedClaimCount: 2 } },
    { command: 'source list', state: { ok: true } },
    {
      command: 'source impact',
      state: { ok: true, sourceId: 'src_1', staleIds: ['nod_deepest'] },
    },
    { command: 'node create', state: { ok: true, hasSources: false } },
    // `node apply` has three rows: the unconditional ref→nodeId hint plus BOTH
    // hasSources branches (04 §2), so each branch needs its own case.
    { command: 'node apply', state: { ok: true, hasSources: false } },
    { command: 'node apply', state: { ok: true, hasSources: true } },
    // `node show --context` (04 §1) — a plain show steers nothing, so context must be set.
    { command: 'node show', state: { ok: true, context: true, snippetsTruncated: true, approxTokens: 100_000 } },
    // `answer-check` steers only on FAILURE (05 §4.3).
    { command: 'answer-check', state: { ok: false } },
    { command: 'claim apply', state: { ok: true, staleIds: ['nod_a', 'nod_b'] } },
    { command: 'claim apply', state: { ok: true, staleIds: [] } },
    { command: 'claim apply', state: { ok: false, quoteIssue: true, sourceId: 'src_1' } },
    { command: 'graph apply', state: { ok: true, sourceId: 'src_1' } },
    { command: 'coverage', state: { ok: true, scopedSourceId: 'src_1' } },
    // `entity list` (eval run 1, finding 3) — its hint carries an <id> placeholder.
    { command: 'entity list', state: { ok: true } },
    { command: 'synthesize', state: { ok: true, staleIds: ['nod_a'] } },
    { command: 'synthesize', state: { ok: true, staleIds: [] } },
    { command: 'verify', state: { ok: true } },
    { command: 'render', state: { ok: true } },
    // Dry-run rows: file + stdin for every one of the five payload commands.
    dryRun('claim apply', 'file', 'kb claim apply --file c.json --json'),
    {
      command: 'claim apply',
      state: {
        ok: true,
        dryRun: {
          command: 'kb claim apply --file c.json --json',
          payloadFrom: 'file',
        },
        hasReviewCandidates: true,
      },
    },
    dryRun('claim apply', 'stdin', 'kb claim apply --json'),
    dryRun('graph apply', 'file', 'kb graph apply --file g.json --json'),
    dryRun('graph apply', 'stdin', 'kb graph apply --json'),
    dryRun('synthesize', 'file', 'kb synthesize --file n.json --json'),
    dryRun('synthesize', 'stdin', 'kb synthesize --json'),
    dryRun('node apply', 'file', 'kb node apply --file m.json --json'),
    dryRun('node apply', 'stdin', 'kb node apply --json'),
    dryRun('ingest', 'file', 'kb ingest doc.md --json'),
    dryRun('ingest', 'stdin', 'kb ingest --json'),
  ];

  it('the walk exercises EVERY row in both tables (normal + dry-run), none escaping', () => {
    // Collect the rows the cases actually fire, via the SAME selection production uses.
    const fired = new Set<SteeringRow>();
    for (const { command, state } of CASES) for (const row of matchingSteeringRows(command, state)) fired.add(row);
    for (const row of STEERING_TABLE) {
      expect(fired.has(row), `normal steering row for "${row.command}" is never exercised`).toBe(true);
    }
    for (const row of DRY_RUN_TABLE) {
      expect(fired.has(row), `dry-run steering row for "${row.command}" is never exercised`).toBe(true);
    }
    // Nothing outside the tables can fire, so equal counts ⇒ full coverage.
    expect(fired.size).toBe(STEERING_TABLE.length + DRY_RUN_TABLE.length);
  });

  it('every emitted next-action names a registered command verbatim, with no placeholder tokens', () => {
    for (const { command, state } of CASES) {
      const { nextActions } = steeringFor(command, state, FULL);
      for (const na of nextActions) {
        // verbatim-next-actions: a placeholder template must live in hints, never here.
        expect(na.command, `${command}: "${na.command}" carries a placeholder`).not.toMatch(/[<>]/);
        expect(namesRegisteredCommand(na.command), `${command}: "${na.command}" names no registered command`).toBe(true);
      }
    }
  });

  it('verify success and render success both emit the kb coverage --json hint (coverage now ships)', () => {
    expect(steeringFor('verify', { ok: true }, FULL).hints.join(' ')).toContain('kb coverage --json');
    expect(steeringFor('render', { ok: true }, FULL).hints.join(' ')).toContain('kb coverage --json');
  });

  /**
   * The row walk above proves every STEERING-BUILT next-action is verbatim and registered.
   * That is only a proof about the whole CLI while steering remains the SOLE producer of
   * next-actions: a handler that hand-rolled a `{ title, command }` would escape both the
   * registry filter and the placeholder check. This guard keeps that funnel closed.
   */
  it('steering.ts is the only producer of next-actions (no handler hand-rolls one)', () => {
    const cliRoot = join(here, '..', 'cli');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        // `steering.ts` is the sanctioned producer; `output.ts` merely DECLARES the
        // `NextAction` interface (`{ title: string; command: string }`), which the
        // literal-shaped pattern below cannot distinguish from a construction.
        if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        if (full.endsWith('steering.ts') || full.endsWith('output.ts')) continue;
        // A next-action may only be PASSED THROUGH (`nextActions: steering.nextActions`),
        // never constructed: an object literal carrying both keys is a hand-rolled action.
        const src = readFileSync(full, 'utf8');
        if (/\{[^{}]*\btitle\s*:[^{}]*\bcommand\s*:/s.test(src)) offenders.push(full.slice(cliRoot.length + 1));
      }
    };
    walk(cliRoot);
    expect(offenders, 'next-actions must come from steeringFor(), not be built in a handler').toEqual([]);
  });
});

describe('nextActionsForStale', () => {
  function repos(staleIds: string[]) {
    return { nodes: { listStaleDeepestFirst: () => staleIds.map((id) => ({ id })) } };
  }

  it('emits up to `limit` deepest-first node shows and states shown-vs-total in a hint', () => {
    const s = nextActionsForStale(repos(['nod_a', 'nod_b', 'nod_c', 'nod_d', 'nod_e']), PHASE0, 3);
    expect(s.nextActions.map((n) => n.command)).toEqual([
      'kb node show nod_a --context --json',
      'kb node show nod_b --context --json',
      'kb node show nod_c --context --json',
    ]);
    expect(s.hints[0]).toContain('3 of 5');
    expect(s.hints[0]).toContain('2 not listed');
  });

  it('no remainder hint when everything fits under the limit', () => {
    const s = nextActionsForStale(repos(['nod_a']), PHASE0, 3);
    expect(s.nextActions).toHaveLength(1);
    expect(s.hints).toEqual([]);
  });

  it('emits no action when node show is unregistered, and reports all as omitted', () => {
    const s = nextActionsForStale(repos(['nod_a', 'nod_b']), registry('node tree', 'verify'), 3);
    expect(s.nextActions).toEqual([]);
    expect(s.hints[0]).toContain('0 of 2');
    expect(s.hints[0]).toContain('2 not listed');
  });
});
