/**
 * AGENT STEERING (01 §6.1–§6.2, 03 §2).
 *
 * The per-command steering table, encoded as data. `steeringFor(command, state,
 * registry)` returns the `nextActions`/`hints` for a just-run command. Hard rules
 * that hold everywhere:
 *
 *  - `NextAction.command` is executable VERBATIM — never a placeholder. Templates
 *    that must carry a `<placeholder>` live in `hints` (charter: verbatim-next-actions).
 *  - A candidate that names a command absent from the supplied registry is DROPPED
 *    (never advertise a command this phase has not shipped) — this is what makes
 *    steering phase-aware.
 *  - A `--dry-run` receipt steers EXCLUSIVELY to its dry-run follow-up (03 §2): the
 *    same command without `--dry-run` (file payload) or the stdin hint. It never
 *    also emits the real-apply success follow-ups (the previewed writes were rolled
 *    back). Real applies steer via the normal table.
 *  - Any capped list (the stale follow-ups) states shown-vs-omitted explicitly
 *    (charter: no-silent-truncation).
 */

import type { NextAction } from './output.js';
import { SNIPPET_MAX_CHARS } from '../domain/services/nodeContext.js';

/**
 * The `node show --context` bundle size (in `approxTokens`) above which the agent is told
 * to synthesize the children first (04 §1). The bundle is still returned complete — this
 * is guidance, never truncation.
 */
export const LARGE_CONTEXT_TOKENS = 24000;

/** The command registry steering consults; a `Set<string>` satisfies it. */
export interface CommandRegistry {
  has(command: string): boolean;
}

/** Everything a row may branch on. Handlers populate the fields relevant to their command. */
export interface SteeringState {
  /** Command outcome; defaults to true (ok) when omitted. */
  ok?: boolean;
  /** Stale node ids after the command, DEEPEST FIRST (claim apply / synthesize). */
  staleIds?: string[];
  /** New source id (ingest). */
  newSourceId?: string;
  /** Source id in scope (claim apply failure → reread its chunks). */
  sourceId?: string;
  /** First entity id (graph apply). */
  firstEntityId?: string;
  /** Whether the KB already has sources (node create / node apply gating). */
  hasSources?: boolean;
  /** A claim-apply failure caused by quote issues. */
  quoteIssue?: boolean;
  /** The just-run `node show` carried `--context` (04 §1); a plain show steers nothing. */
  context?: boolean;
  /** A `--context` bundle cut at least one quote snippet → point at full provenance. */
  snippetsTruncated?: boolean;
  /** The `--context` bundle's measured size; above the threshold, synthesize children first. */
  approxTokens?: number;
  /** Present when the just-run command was a `--dry-run`; routes steering exclusively. */
  dryRun?: {
    /** The SAME command without `--dry-run`, ready to run verbatim. */
    command: string;
    /** Where the previewed payload came from. */
    payloadFrom: 'file' | 'stdin';
  };
}

/** Resolved (registry-filtered) steering. */
export interface Steering {
  nextActions: NextAction[];
  hints: string[];
}

const isOk = (s: SteeringState): boolean => s.ok !== false;

/** A next-action, emitted only if `requires` is registered. */
function actionIf(registry: CommandRegistry, requires: string, title: string, command: string): NextAction[] {
  return registry.has(requires) ? [{ title, command }] : [];
}

/** A hint, emitted only if it embeds no command or its `requires` command is registered. */
function hintIf(registry: CommandRegistry, requires: string | undefined, hint: string): string[] {
  return requires === undefined || registry.has(requires) ? [hint] : [];
}

/**
 * STALE-TARGET V2 (01 §6.1, 04 deliverable 4) — the named Phase-1 → Phase-2 flip.
 * `kb node show <id> --context` now returns the whole synthesis bundle in one read, so
 * every stale follow-up targets it instead of the bare node view. This is the single
 * place the target is spelled, so both emitting rows (`claim apply`, `synthesize`) and
 * `nextActionsForStale` flip together.
 */
const staleTarget = (id: string): string => `kb node show ${id} --context --json`;

/**
 * Up to `limit` deepest-first `node show` follow-ups for the stale set, plus a
 * remainder hint that states shown-vs-total whenever anything is omitted. The
 * shown count is the number of actions ACTUALLY emitted: if `node show` is not
 * registered, zero are emitted and the hint reports all of them as omitted (never
 * a false "N shown"). The `kb node tree` pointer is appended only when that
 * command is registered. Shared by the stale steering rows and `nextActionsForStale`.
 */
function staleFollowUps(staleIds: string[], registry: CommandRegistry, limit: number): Steering {
  const nextActions: NextAction[] = registry.has('node show')
    ? staleIds.slice(0, limit).map((id) => ({ title: `Re-synthesize stale node ${id}`, command: staleTarget(id) }))
    : [];
  const shown = nextActions.length; // shown == emitted, not the slice length
  const omitted = staleIds.length - shown;
  const hints: string[] = [];
  if (omitted > 0) {
    const base = `${shown} of ${staleIds.length} stale-node action(s) shown; ${omitted} not listed`;
    hints.push(registry.has('node tree') ? `${base} — kb node tree --json lists them.` : `${base}.`);
  }
  return { nextActions, hints };
}

/**
 * A single steering-table row. Exported (with the two tables and `matchingSteeringRows`)
 * so the phase-boundary test can prove EVERY row — normal and dry-run — is exercised.
 */
export interface SteeringRow {
  /** The command this row fires after. */
  command: string;
  /** Whether this row applies to `state`. */
  when: (s: SteeringState) => boolean;
  /** Registry-filtered next-actions/hints for `state`. */
  build: (s: SteeringState, registry: CommandRegistry) => Steering;
}

const verifyNextAction = (registry: CommandRegistry): Steering => ({
  nextActions: actionIf(registry, 'verify', 'Verify provenance integrity', 'kb verify --strict --json'),
  hints: [],
});

/**
 * The NORMAL steering table (01 §6.1) — used for real (non-dry-run) commands. Rows
 * are matched by command + condition; a command may have several rows.
 */
export const STEERING_TABLE: SteeringRow[] = [
  {
    command: 'init',
    when: () => true,
    build: (_s, r) => ({
      nextActions: [],
      hints: [
        ...hintIf(r, 'ingest', 'Ingest a source: kb ingest <path> --json'),
        ...hintIf(r, 'node apply', 'Plan the hierarchy: kb node apply --help --json'),
      ],
    }),
  },
  {
    command: 'ingest',
    when: isOk,
    build: (s, r) => ({
      nextActions: s.newSourceId
        ? actionIf(r, 'source chunks', 'Read the new source chunks', `kb source chunks ${s.newSourceId} --json`)
        : [],
      hints: hintIf(r, 'claim apply', 'kb claim apply --help --json shows the claim payload shape'),
    }),
  },
  {
    // `source list` steers to the per-source inspection commands (02 §3). Both hints
    // carry an `<id>` placeholder, so they are HINTS, never verbatim next-actions
    // (charter: verbatim-next-actions); each is dropped when its command is unregistered.
    command: 'source list',
    when: isOk,
    build: (_s, r) => ({
      nextActions: [],
      hints: [
        ...hintIf(r, 'source show', 'Inspect a source: kb source show <id> --json'),
        ...hintIf(r, 'source chunks', 'Read a source’s chunks: kb source chunks <id> --json'),
      ],
    }),
  },
  // node create, no sources yet → guidance hint (no embedded command).
  {
    command: 'node create',
    when: (s) => isOk(s) && s.hasSources === false,
    build: () => ({ nextActions: [], hints: ['Ingest sources before extracting claims.'] }),
  },
  // node apply always points the agent at the ref→nodeId map for the next (claim) payload;
  // the second hint branches on whether the KB has sources yet (04 §2). Both branch hints
  // embed a `<placeholder>`/command, so they are hints, never verbatim next-actions, and are
  // registry-filtered so an unshipped command is never advertised.
  {
    command: 'node apply',
    when: isOk,
    build: () => ({
      nextActions: [],
      hints: ['Map claim payload node_id values from the ref→nodeId list above'],
    }),
  },
  {
    command: 'node apply',
    when: (s) => isOk(s) && s.hasSources === false,
    build: (_s, r) => ({
      nextActions: [],
      hints: hintIf(r, 'ingest', 'No sources yet — ingest before extracting claims: kb ingest <path> --json'),
    }),
  },
  {
    command: 'node apply',
    when: (s) => isOk(s) && s.hasSources === true,
    build: (_s, r) => ({
      nextActions: [],
      hints: hintIf(r, 'claim apply', 'kb claim apply --help --json shows the payload shape'),
    }),
  },
  {
    // `node show --context` (04 §1). The synthesis authoring step needs a payload file the
    // CLI cannot know, so it is a HINT (a template), never a NextAction — NextActions are
    // verbatim-only (01 §2, finding 25). The provenance and oversized-bundle hints fire
    // only on the conditions the bundle reports, so a small, untruncated bundle stays quiet.
    command: 'node show',
    when: (s) => isOk(s) && s.context === true,
    build: (s, r) => ({
      nextActions: [],
      hints: [
        ...hintIf(
          r,
          'synthesize',
          'Author a synthesis payload citing only allowedCitationIds, then: kb synthesize --file <payload.json> --dry-run --json',
        ),
        ...(s.snippetsTruncated
          ? hintIf(r, 'provenance', `Full quotes: kb provenance <claim_id> --json (snippets over ${SNIPPET_MAX_CHARS} chars are truncated)`)
          : []),
        ...((s.approxTokens ?? 0) > LARGE_CONTEXT_TOKENS
          ? [
              `This bundle is large (approxTokens ${s.approxTokens} > ${LARGE_CONTEXT_TOKENS}) — synthesize this node’s children first, then re-read it.`,
            ]
          : []),
      ],
    }),
  },
  {
    command: 'claim apply',
    when: (s) => isOk(s) && (s.staleIds?.length ?? 0) > 0,
    build: (s, r) => staleFollowUps(s.staleIds ?? [], r, 3),
  },
  {
    command: 'claim apply',
    when: (s) => isOk(s) && s.staleIds?.length === 0,
    build: (_s, r) => verifyNextAction(r),
  },
  {
    command: 'claim apply',
    when: (s) => !isOk(s) && s.quoteIssue === true,
    build: (s, r) => ({
      nextActions: s.sourceId
        ? actionIf(r, 'source chunks', 'Reread the source chunks', `kb source chunks ${s.sourceId} --json`)
        : [],
      hints: ['Fix the quote, then re-run with --dry-run.'],
    }),
  },
  {
    // graph apply never stales nodes → no stale chain (finding 15). `entity list` is
    // offered alongside `entity show` so the agent can enumerate rather than guess at
    // ids (eval run 1, finding 3); each hint drops out if its command is unregistered.
    command: 'graph apply',
    when: isOk,
    build: (s, r) => ({
      nextActions: [],
      hints: [
        ...(s.firstEntityId ? hintIf(r, 'entity show', `kb entity show ${s.firstEntityId} --json`) : []),
        ...hintIf(r, 'entity list', 'Survey the graph: kb entity list --json'),
      ],
    }),
  },
  {
    // `entity list` steers to per-entity inspection. The command carries an `<id>`
    // placeholder, so it is a HINT, never a verbatim next-action (charter:
    // verbatim-next-actions).
    command: 'entity list',
    when: isOk,
    build: (_s, r) => ({
      nextActions: [],
      hints: hintIf(r, 'entity show', 'Inspect one entity: kb entity show <id> --json'),
    }),
  },
  {
    command: 'synthesize',
    when: (s) => isOk(s) && (s.staleIds?.length ?? 0) > 0,
    build: (s, r) => staleFollowUps(s.staleIds ?? [], r, 3),
  },
  {
    command: 'synthesize',
    when: (s) => isOk(s) && s.staleIds?.length === 0,
    build: (_s, r) => verifyNextAction(r),
  },
  {
    command: 'verify',
    when: isOk,
    build: (_s, r) => ({
      nextActions: actionIf(r, 'render', 'Render the markdown', 'kb render --json'),
      hints: hintIf(r, 'coverage', 'kb coverage --json reports completeness'),
    }),
  },
  {
    command: 'render',
    when: isOk,
    build: (_s, r) => ({
      nextActions: [],
      hints: [
        ...hintIf(r, 'render', 'kb render --check --json confirms determinism'),
        ...hintIf(r, 'coverage', 'kb coverage --json reports completeness'),
      ],
    }),
  },
  {
    // answer-check failure (unknown/inactive citation or an uncited assertion) →
    // point at the retrieval command that surfaces citable claims. The `<topic>`
    // placeholder keeps this a HINT, not a verbatim next-action (05 §4.3), and it
    // is dropped when `ask-context` is not registered this phase.
    command: 'answer-check',
    when: (s) => !isOk(s),
    build: (_s, r) => ({
      nextActions: [],
      hints: hintIf(r, 'ask-context', 'kb ask-context "<topic>" --json finds citable claims.'),
    }),
  },
];

/** The five `--dry-run`-capable commands (01 §6.2). */
const DRY_RUN_COMMANDS = ['claim apply', 'graph apply', 'synthesize', 'node apply', 'ingest'] as const;

/**
 * The DRY-RUN table (01 §6.1, 03 §2) — used EXCLUSIVELY when a dry-run receipt is
 * being steered. file → re-run the same command verbatim (dropping if that command
 * is not yet shipped); stdin → the non-replayable hint.
 */
export const DRY_RUN_TABLE: SteeringRow[] = DRY_RUN_COMMANDS.flatMap((command): SteeringRow[] => [
  {
    command,
    when: (s) => isOk(s) && s.dryRun?.payloadFrom === 'file',
    build: (s, r) => ({ nextActions: actionIf(r, command, 'Apply the previewed change', s.dryRun!.command), hints: [] }),
  },
  {
    command,
    when: (s) => isOk(s) && s.dryRun?.payloadFrom === 'stdin',
    build: () => ({
      nextActions: [],
      hints: ['Re-run without --dry-run using the same payload file; stdin payloads cannot be replayed automatically.'],
    }),
  },
]);

/**
 * The steering rows that fire for `command` given `state` — the SINGLE selection
 * used by both production (`steeringFor`) and the phase-boundary test, so the test
 * proves row coverage against the exact matching production performs (no duplicated
 * logic). A SUCCESSFUL dry-run receipt (`state.dryRun` set and `ok`) is routed
 * exclusively to the dry-run table so it never emits real-apply follow-ups (03 §2).
 * A FAILED dry-run falls through to the NORMAL table: the 01 §6.1 dry-run rows are
 * all `--dry-run ok`, so a failed preview must still reach its ordinary failure rows
 * (e.g. `claim apply` fail + quote issue → reread the source chunks).
 */
export function matchingSteeringRows(command: string, state: SteeringState): SteeringRow[] {
  const table = state.dryRun && isOk(state) ? DRY_RUN_TABLE : STEERING_TABLE;
  return table.filter((row) => row.command === command && row.when(state));
}

/**
 * Steering (next-actions + hints) for a just-run `command`, filtered by the
 * registry — the concatenation of every matching row's registry-filtered build.
 */
export function steeringFor(command: string, state: SteeringState, registry: CommandRegistry): Steering {
  const nextActions: NextAction[] = [];
  const hints: string[] = [];
  for (const row of matchingSteeringRows(command, state)) {
    const built = row.build(state, registry);
    nextActions.push(...built.nextActions);
    hints.push(...built.hints);
  }
  return { nextActions, hints };
}

/** Minimal repos surface the stale readers need (structural, for easy injection). */
export interface StaleNodesSource {
  nodes: { listStaleDeepestFirst(): Array<{ id: string }> };
}

/**
 * The current stale set as ids, DEEPEST FIRST — the `staleIds` a handler feeds to
 * `steeringFor` when its receipt does not already carry them (e.g. `claim apply`).
 * One definition, so every command reports the same order the stale rows assume.
 */
export function staleIdsDeepestFirst(repos: StaleNodesSource): string[] {
  return repos.nodes.listStaleDeepestFirst().map((n) => n.id);
}

/**
 * Build up to `limit` deepest-first `node show` next-actions for the current stale
 * set, plus a remainder hint stating shown-vs-total (no silent truncation). The
 * shown count reflects the actions actually emitted. Emits no action when
 * `node show` is unregistered — and then reports every stale node as omitted.
 */
export function nextActionsForStale(repos: StaleNodesSource, registry: CommandRegistry, limit = 3): Steering {
  return staleFollowUps(staleIdsDeepestFirst(repos), registry, limit);
}
