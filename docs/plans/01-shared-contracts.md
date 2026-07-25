# Shared Contracts

Cross-cutting decisions used by every phase. This document is the single source of
truth for the CLI architecture, output envelope, issue codes, help system, and
agent-steering conventions. Implemented in Phase 0; later phases only add entries to
the registries defined here. Revised to address Codex review findings 1–16
(`docs/plans/review/codex-review.md`).

## 1. CLI architecture: Commander.js

**Dependency:** `commander@^14` (requires Node ≥ 20, matching `engines`). No other new
runtime dependencies.

**File layout** (replaces the single `src/cli/index.ts` dispatcher):

```
src/cli/
  index.ts          # 4 lines: process.exitCode = await runCli(process.argv.slice(2), processIo)
  runCli.ts         # THE dispatcher: pre-parse router, Commander parse, error mapping, emission.
                    #   runCli(argv: string[], io: { stdout, stderr, cwd, env }): Promise<number>
  program.ts        # buildProgram(): assembles the Command tree from command modules
  run.ts            # runAction(): shared leaf-handler wrapper (workspace, envelope, dry-run)
  output.ts         # envelope v2 (extended in place)
  issues.ts         # CLI Issue shape, hint registry, CommanderError→code map, domain-error mapping
  steering.ts       # NextAction/hint builders + per-command steering table
  help/
    spec.ts         # HelpSpec type + renderers (text + JSON)
    globalHelp.ts   # workflow-grouped root help
  commands/         # one module per group; each exports register(parent) + HelpSpecs adjacent
    ingest.ts source.ts node.ts claim.ts graph.ts synthesize.ts query.ts entity.ts ops.ts
src/domain/
  issueCodes.ts     # IssueCode const + DomainIssueError — domain layer owns codes (no CLI import)
```

**`runCli(argv, io)` is the only dispatcher** (finding 8). `index.ts` never contains
logic; all tests call `runCli` in-process with captured io and a temp-dir `cwd`/env.
One subprocess smoke test (`bin/kb version --json`) guards the launcher itself.

### 1.1 Pre-parse router (findings 1, 2, 4)

Commander v14 validates required arguments/options *before* invoking actions and
treats a custom `--help` as an ordinary boolean, so help must never reach
`parseAsync`. `runCli` routes these argv shapes **before** Commander:

| argv shape | Handling | Exit |
|---|---|---|
| `[]` (bare `kb`) | global help envelope (§5) | 0 |
| exactly a known group token (`node`, `source`, `claim`, `graph`, `entity`) | group help: subcommand list with summaries | 0 |
| contains `--help` anywhere | resolve the longest known command path from the leading tokens; emit that command's HelpSpec (global help if none); ignore all other tokens | 0 |
| `help` / `help <path...>` | alias of the two rows above | 0 |
| first token `--version` or path resolves to `version` | version envelope (workspace-free) | 0 |

- JSON mode for the router (and for parse errors, where options were never
  resolved): the literal token `--json` anywhere in `argv`.
- Commander's `.version()` is **prohibited** (it prints raw text and exits during
  parsing); root `--version` exists only as a router rule. Test both flag orders
  (`kb --version --json`, `kb --json --version`) → one envelope, no raw text.
- Commander's implicit help command is disabled with `.helpCommand(false)` on the
  root **and** every group, plus `.helpOption(false)` everywhere (finding 2 —
  omitting `addHelpCommand` is not enough).
- Groups and the root have **no action handlers**, so `kb nodee tree` and
  `kb node frob` fall through to Commander and surface as
  `commander.unknownCommand` with suggestions intact (finding 2).
- Required test table: help-from-every-leaf-without-required-inputs (e.g.
  `kb ingest --help --json`, `kb claim apply --help`), `kb`, `kb node`,
  `kb nodee tree`, `kb node frob`, `kb help`, `kb help claim apply` — asserting
  envelope shape, exit codes, and zero raw Commander output.

### 1.2 Commander configuration (findings 5, 6, 7)

- **Construction API:** children are created exclusively via `parent.command(...)`
  *after* the root is fully configured (`exitOverride`, `configureOutput` with
  io-capturing writers, `helpOption(false)`, `helpCommand(false)`,
  `showSuggestionAfterError(true)`) — Commander copies these settings at creation
  time and does not retro-inherit. `addCommand(new Command())` is prohibited
  (a lint-style test walks the tree and asserts every node has exitOverride set).
- **Exhaustive error mapping** (`issues.ts`): every reachable
  `CommanderError.code` maps to an issue; unmapped codes fail a test:

| CommanderError code | IssueCode |
|---|---|
| `commander.unknownCommand` | `UNKNOWN_COMMAND` |
| `commander.unknownOption` | `UNKNOWN_OPTION` |
| `commander.missingArgument` | `MISSING_ARGUMENT` |
| `commander.optionMissingArgument` | `MISSING_ARGUMENT` |
| `commander.missingMandatoryOptionValue` | `MISSING_ARGUMENT` |
| `commander.invalidArgument` | `INVALID_ARGUMENT` (covers argParser `InvalidArgumentError` — Commander rethrows it under this code, so no `instanceof` trap) |
| `commander.excessArguments` | `INVALID_ARGUMENT` (message: "unexpected argument …") |
| `commander.conflictingOption` | `INVALID_ARGUMENT` |
| `commander.help*` | unreachable (help never reaches Commander); asserted by test |

  All mapped errors emit a `fail()` envelope and exit **2**; a test per code proves
  no `process.exit` call and no raw Commander stderr.
- **Greedy option values** (finding 6): Commander consumes a following option token
  as a string option's value (`--kb --json` ⇒ `kb === "--json"`). `runCli` pre-scans
  the argv after resolving the leaf path: for each space-separated value of a
  registered string option of that command, if the value token exactly matches a
  registered option token of the same command, emit `MISSING_ARGUMENT`
  ("--kb expects a value; got --json") and exit 2. The `--flag=value` form is always
  taken literally and is the documented escape hatch for dash-prefixed values.
  Tests: `--kb --json`, `--file --json`, `node create --title --json --kind root`,
  `ingest x --text-from --dry-run`, and `--title=--literal` (accepted).
- **Positionals preserved from the current CLI** (finding 7): `search <query...>`
  and `ask-context <question...>` are variadic (joined with spaces, matching
  today's behavior); `claim conflict <claim_id...>` is variadic. Payload commands
  declare `--file <path>` as **optional**; absent or `-` reads stdin (today's
  `readPayload` semantics, kept).

### 1.3 Standard options (finding 3)

The standard set — `--json`, `--kb <dir>`, `--help`, and `--dry-run` (only where
supported) — is registered on the **root, every group, and every leaf**. Leaves read
options via `cmd.optsWithGlobals()`; when the same option appears at multiple
levels, the **leaf value wins** (Commander's documented precedence). This preserves
the current hand-parser property that flag position does not matter:
`kb --json source list`, `kb source --json list`, and `kb source list --json` are
all valid. Everything after a literal `--` is positional. A position-matrix test
covers all four standard flags at all three positions plus `--` handling.

Value validation at the edge: numeric flags use a shared `intOption(min, max)`
argParser (throws `InvalidArgumentError` with the allowed range); enum flags use
`Option.choices(...)` sourced from **runtime consts** (`SOURCE_STATUSES`,
`CLAIM_TYPES`, and a new exported `SEARCH_SCOPES`/`MATCH_MODES` — TypeScript-only
unions cannot feed Commander; finding 28). Nothing is silently coerced or ignored.

### 1.4 `runAction()` contract (`run.ts`)

Every leaf action is `runAction(spec, handler)`:

1. Resolve KB root (`--kb` > `KB_DIR` > walk-up) unless the command is
   workspace-free (`version`, `init`). Missing KB → `NO_KB` issue.
2. Open workspace; run handler (with the dry-run wrapper when `--dry-run`,
   Phase 1); merge root warnings; emit through `io`; return exit code
   (`ok ? 0 : 1`); close workspace in `finally`.
3. Catch: `ZodError` → one `PAYLOAD_SCHEMA` issue per Zod issue;
   `DomainIssueError` (§3) → its code + registry hint; unexpected `Error` →
   `INTERNAL`.

## 2. Output envelope v2

`src/cli/output.ts` is extended **in place**. Same `emit` entry point.

```ts
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
  code: string;             // stable SCREAMING_SNAKE id from the registry
  severity: IssueSeverity;
  message: string;
  path?: string;            // canonical serialization, §3.1
  ids?: string[];
  hint?: string;
}

export interface NextAction {
  title: string;
  command: string;          // MUST be executable verbatim — no placeholders (finding 16)
}

export interface Envelope<T> {
  ok: boolean;
  data: T | null;           // command payload ONLY — never issues/steering (finding 10)
  issues: Issue[];
  errors: string[];         // derived: error-severity issue messages
  warnings: string[];       // derived: warning-severity issue messages
  nextActions: NextAction[];
  hints: string[];          // guidance strings; placeholder-bearing command templates live HERE
}
```

**Constructors** (the only ways to build an envelope; finding 10):

```ts
success<T>(data: T, extras?: { issues?: Issue[]; nextActions?: NextAction[]; hints?: string[] }): Envelope<T>
// ok forced true; passing an error-severity issue throws (programming error).

result<T>(data: T | null, issues: Issue[], extras?: { nextActions?: NextAction[]; hints?: string[] }): Envelope<T>
// ok := !issues.some(i => i.severity === 'error'). Failures MAY carry non-null data
// (verify, render --check, answer-check keep their reports on failure).
```

Rules:

- `errors`/`warnings` are derived from `issues` inside the constructors; nothing
  writes them directly. Invariant (test-asserted on every emitted envelope):
  `ok === !issues.some(i => i.severity === 'error')`.
- **`verify --strict` semantics** (finding 9, blocker): `data.findings[].severity`
  keeps its legacy meaning. In strict mode, each warning finding **additionally**
  produces an error-severity envelope issue (same code, message prefixed
  `"strict: "`), so strict failure and the invariant coexist. Non-strict: warning
  findings → warning issues, `ok: true`. Tests: warning-only KB under both modes.
- Root warnings (`kbRootWarnings`) become `KB_PATH_SUSPECT` warning issues merged by
  `runAction`.
- `info` issues never affect `ok` or exit codes.
- Human rendering: issues `✗/!/ℹ [CODE] message` (+ `  ↳ hint`), `nextActions` as a
  `next:` block, `hints` as `tip:` lines.
- **Exit codes:** 0 success · 1 ran-and-failed · 2 usage error (never ran).
- **Compatibility policy** (finding 11): Phase 0 is strictly additive over current
  outputs (parity via `toMatchObject`). Phases 1+ may restructure `data`, but every
  removed/renamed data field is retained as a deprecated alias for the life of
  envelope v2 and listed in that phase's **compatibility matrix** section; parity
  goldens are updated in the same commit. Nothing is removed before a major
  version. (Consequence: `answer-check`'s `uncitedSentences` stays; Phase 4's
  removal item is rescinded.)

## 3. Issue codes

### 3.1 Ownership and shape (finding 12)

- `src/domain/issueCodes.ts` owns the **code list** and
  `DomainIssueError extends Error { code; path?; ids?; details? }`. Domain services
  throw it; they never import CLI modules (dependency direction preserved).
- `src/cli/issues.ts` owns the **hint registry** (`code → hint template`) and all
  mapping (CommanderError table §1.2, `ZodError`, `DomainIssueError`, verify-check
  map). Existing plain error classes (`ProvenanceError`, `NodeError`) are migrated
  to `DomainIssueError` subtypes in Phase 1 — never mapped by message text.
- **Canonical path serialization** (finding 13): one helper
  `formatPath(segments: (string|number)[])` → bracket-dot style
  (`claims[2].spans[0].quote`, `nodes[3].body_md`). Zod paths and batch prefixes
  both go through it.
- `PAYLOAD_PARSE_ERROR` reports a **character offset** (what `JSON.parse` gives),
  not a byte offset; message says "character". Non-ASCII malformed-JSON test.

### 3.2 Registry

As in the original table (§3 of the previous revision) with these corrections:

- `LEGACY` **is registered** with the note *"transitional; emission forbidden after
  Phase 1"* — the registry stays additive-only while a test asserts the suite emits
  no `LEGACY` from Phase 1 on (finding 12).
- **Verify map reuses semantic codes** (finding 12): an explicit table in
  `issues.ts`, e.g. `citation-resolves → CITATION_UNKNOWN`,
  `citation-ownership → CITATION_OUT_OF_SUBTREE`, `citation-active →
  CITATION_INACTIVE`, `claim-has-provenance → CLAIM_HAS_PROVENANCE`,
  `fts-integrity → FTS_INTEGRITY`, `no-stale-nodes → NO_STALE_NODES` (completed
  against the actual check list during implementation; a test asserts every finding
  produced by `verify()` has a mapping — no mechanical kebab→snake generation).
  Findings keep the legacy `check` field and gain `code`.
- **Every code has a hint registry entry** (finding 13), including:
  `INTERNAL` → "This is a bug in kb — re-run with --json and report this envelope.";
  `UNKNOWN_CLAIM` → "kb search <text> --scope claims --json or kb node show <node>
  --json list claim ids." (only commands that exist; there is no `claim list`);
  `UNKNOWN_ENTITY` → "kb search <name> --scope entities --json." A test renders
  every hint and asserts any embedded `kb …` command names a registered command.

## 4. Help system

`HelpSpec` type unchanged from the previous revision (command, group, usage,
summary, args, flags, input example, output fields, sideEffects, atomic,
supportsDryRun, workflow, related, examples), with:

- `--help` handled **only** by the pre-parse router (§1.1) — never by Commander.
- Drift tests (Phase 0): every registered command has a spec; `spec.flags` ↔
  Commander `cmd.options` bidirectionally; enum flags equal their runtime consts;
  `spec.input.example` parses with the named Zod schema; `supportsDryRun` matches
  the dry-run scope list (§6.2).

## 5. Global help (progressive-disclosure root)

As previously specified (workflow-grouped commands with `start`, `workflow`,
`groups`, `help` fields) with one correction (finding 14): the group list is
**generated from the registered command tree at runtime**, so help can never
advertise a command a given phase has not shipped.

## 6. Steering conventions (`steering.ts`)

### 6.1 Per-command steering table (findings 14, 15, 16)

The global "zero-stale ⇒ verify+render" rule is replaced by one normative,
phase-aware table (the single source; phase docs reference rows, tests assert them).
`nextActions` are verbatim-executable or absent; templates with placeholders are
`hints`. Commands named in steering must exist in the registry at the emitting
phase — `steeringFor(command, state)` looks up the registry and a test walks every
row of this table at every phase boundary.

| After | Condition | nextActions (verbatim) | hints |
|---|---|---|---|
| `init` | — | — | "Ingest a source: kb ingest <path> --json" (template → hint); from Phase 2: "Plan the hierarchy: kb node apply --help --json" |
| `ingest` ok | — | `kb source chunks <newSourceId> --json` | "kb claim apply --help --json shows the claim payload shape" |
| `node create` / `node apply` ok | no sources yet | — | "Ingest sources before extracting claims" |
| `claim apply` ok | stale > 0 | Phase 1: `kb node show <deepestStaleId> --json` · Phase 2+: `kb node show <deepestStaleId> --context --json` (≤3 actions; remaining count always stated in a hint) | — |
| `claim apply` ok | stale = 0 | `kb verify --strict --json` | — |
| `claim apply` fail | quote issues | `kb source chunks <sourceId> --json` | "Fix the quote, then re-run with --dry-run" |
| `graph apply` ok | — | — (graph never stales nodes — no stale chain, finding 15) | `kb entity show <firstEntityId> --json` |
| `synthesize` ok | stale > 0 | next stale per claim-apply row | — |
| `synthesize` ok | stale = 0 | `kb verify --strict --json` | — |
| `verify` ok | — | `kb render --json` | "kb coverage --json reports completeness" (Phase 4+) |
| `render` ok | — | — | "kb render --check --json confirms determinism"; Phase 4+: coverage hint |
| any `--dry-run` ok | payload came from a file | `<same command without --dry-run>` | — |
| any `--dry-run` ok | payload came from stdin | — | "Re-run without --dry-run using the same payload file; stdin payloads cannot be replayed automatically" (finding 16) |

The Phase 1 → Phase 2 change of the stale row is an explicit, named flip
(“stale-target v2”), not an implicit placeholder (finding 14).

### 6.2 Dry-run scope (finding 17)

`--dry-run` exists on exactly: `claim apply`, `graph apply`, `synthesize`
(single + batch), `node apply`, `ingest`. All other mutations (`init`,
`node create`, `claim conflict`, `claim supersede`, `propagate`, `render`) do not
support it — they are single-effect commands whose receipts fully describe the
change. `HelpSpec.supportsDryRun`, the overview, and the skills use this exact
list; the phrase "dry-run everywhere" is banned.

## 7. Testing conventions

- All CLI tests call `runCli(argv, io)` in-process (finding 8) with a temp-dir KB;
  one subprocess smoke test for `bin/kb`.
- **Envelope parity:** golden envelopes captured against the current dispatcher
  before migration; after migration, `toMatchObject` with only the additive fields
  new. From Phase 1 on, goldens update per the compatibility policy (§2).
- Every issue code: ≥1 test triggering it, asserting `code`, `hint`, exit code.
- **Dry-run receipt parity** is asserted on a defined projection (finding 18):
  deterministic domain fields only (per-input outcomes, ids, accounting,
  staleNodes) — `dryRun`, `nextActions`, `hints`, and clock-derived fields
  excluded. Steering is asserted separately per §6.1.
