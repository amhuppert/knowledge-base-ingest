# Codex Review — Finding Dispositions

Review: `codex-review.md` (gpt-5.6-sol, ultra effort; 42 findings — 6 blockers,
35 major, 1 minor). Every finding is **accepted and resolved** in the plan
revisions dated with this file; none was rejected. Where the fix location isn't
obvious, it is noted. "01 §1.1" = `01-shared-contracts.md` section 1.1, etc.

| # | Sev | Disposition |
|---|---|---|
| 1 | blocker | Pre-parse help router: `--help` never reaches Commander (which validates required inputs before actions). 01 §1.1 + help-from-every-leaf test table (02 §1). |
| 2 | blocker | Router handles bare root/groups and `help`; groups/root stay actionless so `unknownCommand` + suggestions survive; `.helpCommand(false)` everywhere. 01 §1.1. |
| 3 | major | Standard options registered at root+group+leaf, read via `optsWithGlobals()`, leaf precedence; position matrix + `--` tests. 01 §1.3. |
| 4 | major | Commander `.version()` prohibited; root `--version` is a router rule; both flag orders tested. 01 §1.1, 02 §2. |
| 5 | major | Exhaustive `CommanderError.code → IssueCode` table (incl. excess/conflicting/optionMissingArgument; argParser errors via `commander.invalidArgument`, no `instanceof` trap); root configured before child creation; `addCommand(new Command())` banned + tree-walk test. 01 §1.2. |
| 6 | major | Greedy option-value pre-scan (`--kb --json` ⇒ MISSING_ARGUMENT); `--flag=value` documented escape; four listed tests. 01 §1.2. |
| 7 | major | Variadic `<query...>`/`<question...>`/`<claim_id...>`; `--file` optional with stdin/`-` default preserved. 01 §1.2, 02 §1. |
| 8 | major | `runCli(argv, io)` extracted first (step 1 of migration); all tests in-process; one `bin/kb` subprocess smoke test. 01 §1, 02 §1. |
| 9 | blocker | Strict verify: data findings keep legacy severity; strict mode adds error-severity envelope issue copies (`strict:` prefix); invariant preserved; both modes tested on warning-only KB. 01 §2. |
| 10 | major | `success()`/`result()` constructors (failure-with-data supported); every plan example rewritten as a complete envelope; coverage findings homed in `issues` + `data.summary`. 01 §2, examples throughout 03–06. |
| 11 | major | Compatibility policy: Phase 0 strictly additive; Phases 1+ keep deprecated aliases for all of envelope v2 + per-phase compatibility matrix; goldens updated per commit; `uncitedSentences` retained (Phase 4 removal rescinded). 01 §2, 03 §3, 05 §4.3, 06 acceptance. |
| 12 | major | `LEGACY` registered (emission forbidden after Phase 1, test-asserted); explicit verify-check map reusing semantic citation codes; `DomainIssueError` in `src/domain/issueCodes.ts` (domain owns codes — dependency direction fixed); no message matching. 01 §3, 03 §1. |
| 13 | major | Per-code hint registry incl. `INTERNAL`; hints reference only existing commands (no `claim list`/`entity list`) + hint-validity test; canonical `formatPath`; parse errors report character offset (byte-offset promise dropped); non-ASCII test. 01 §3. |
| 14 | major | Steering + global help generated from the live command registry (phase-aware); the Phase 1→2 stale-target flip is named ("stale-target v2"); Phase 4 depends on 1–3. 01 §5–6, 00, 04 §Deliverables, 06 header. |
| 15 | major | Global zero-stale rule replaced by the per-command steering table; graph apply removed from stale steering; unreachable "first render" condition dropped (coverage hint unconditional). 01 §6.1, 06 §4. |
| 16 | major | `NextAction.command` verbatim-only; placeholder templates moved to `hints`; stdin dry-runs get a hint, not a replay action. 01 §2/§6.1, examples in 03–06. |
| 17 | major | Dry-run scope fixed to the exact five-command list (01 §6.2); "dry-run everywhere" banned; HelpSpec `supportsDryRun` drift-tested. 00, 03 goal, 07 §1. |
| 18 | major | Dry-run/real receipt parity defined on a deterministic projection (outcomes, ids, accounting, staleNodes); steering asserted separately. 01 §7, 03 §2. |
| 19 | blocker | `SourceStore.store()` returns `{storedPath, created}` (atomic `wx`); `remove()` added to both stores; commit re-checks sha inside `BEGIN IMMEDIATE`; cleanup only when `created`; concurrency + cleanup-failure tests. 03 §5. |
| 20 | major | Ingest split is `prepareContent` (pure) / `plan` (read-only) / `commit`; duplicate-before-decode ordering preserved explicitly; dry-run = `plan`; in-tx duplicate recheck. 03 §5. |
| 21 | major | `resolveSpanCandidate` (read-only) / `persistSpan` split kills the circular check; link identity `(claim_id, span_id)`; confidence monotone (max), `linksUpdated` counter; lower-confidence replay test. 03 §4.1. |
| 22 | major | Entity `evidence` removed from schema (was silently dropped); relationship evidence loses `confidence` (`RelEvidenceSchema`) — both breaking-with-hint, in the compatibility matrix; evidence-only ⇒ `updated`; changelog only when created+updated>0; `staleNodes` omitted from graph receipts. 03 §3.2. |
| 23 | major | Citation-issue precedence UNKNOWN > INACTIVE > OUT_OF_SUBTREE, one issue per cited id, first-occurrence order; `NodeRepo.clearStale` with explicit `updated_at = now`; title/summary changes stale ancestors, body-only does not; cross-product test. 03 §1/§4. |
| 24 | major | `DUPLICATE_SLUG` manifest-internal only; DB collision resolves to existing/mismatch outcomes; `MULTIPLE_ROOTS` counts distinct logical root ids (root replay legal); full-replay-incl-root test. 04 §2. |
| 25 | major | Context includes `bodyMd`/`bodyHash`; `approxTokens` measured on a defined subset before `stats` (self-reference regression test); total ordering keys for claims/provenance/children/sources; one batched provenance query. 04 §1. |
| 26 | major | Baselines: render before `render --check`; equivalence via `scripts/kb-snapshot.ts` normalized semantic snapshot (not bytes); deepest-first asserted by repo-call spy + receipt order (parent-cites-child test acknowledged vacuous and replaced). 02 §4.2, 04 §3–4. |
| 27 | major | Match modes: `auto` (default, AND→OR per scope) / `all` (strict) / `any` / `phrase`; fallback hint points to `--match all`; zero-hit hint no longer suggests the already-run OR. 05 §1. |
| 28 | major | `SearchResult {query, matchModes, hits}`; entity `rank: null`; ranks comparable within scope only; scope-major ordering; runtime `SEARCH_SCOPES`/`MATCH_MODES` consts feed Commander choices. 05 §1. |
| 29 | major | ask-context filters pushed into SQL before ORDER BY/LIMIT (kills the over-fetch false zero; regression test at >4×limit); `--node` validated first (`UNKNOWN_NODE`); hints built from supplied filters only. 05 §2. |
| 30 | major | Retrieval gate is hard; one pre-specified increment (Phase 3b stop-words, list + rules given); still-failing ⇒ phase blocked with `docs/plans/retrieval-results.json` (schema given) — never "passes with evidence". 05 §3. |
| 31 | major | Region scanner state machine with exact fence/footnote-continuation/blockquote/inline-code/EOF rules; `splitSentenceSpans` returns offsets (no lineMap indirection); quote-suppression rules incl. escapes/unmatched/blank-line reset; inline-quotation-still-assertive scoped explicitly; full test list. 05 §4.1–4.2. |
| 32 | major | Citations extracted from non-code regions only (footnote defs included); stateful shared regex fixed in Phase 0 (moved up — it is a two-line fix) with reverse-call-order regression. 05 §4.3, 02 §4.4. |
| 33 | major | Complete failing answer-check envelope specified (nested legacy `ok` kept in sync); issue cardinality one-per-id/one-per-sentence with defined order; `uncitedSentences` retained for all of envelope v2. 05 §4.3. |
| 34 | blocker | `--extractor` constrained to `name/<integer>` and split into the existing `extractor TEXT` + `extractor_version INTEGER` columns (no migration); native extractor corrected to `text-utf8/1`. 06 §1.2. |
| 35 | blocker | Same-original + different sidecar always rejected (identity derives from original bytes; canonical text immutable); executable recovery recipe = ingest the corrected transcription itself with `--supersedes`; recipe tested verbatim. 06 §1.4. |
| 36 | major | Exact media policy: known-binary extension list requires sidecar; everything else `TextDecoder(fatal:true)` + NUL check (replaces lossy toString — compat-matrix entry); complete MIME map table. 06 §1.1. |
| 37 | major | `--verification` default `none`; extractor/verification without sidecar = pre-workspace exit-2 usage error; `textHash` (normalized) is the immutability key; extraction immutable after first write; origin patch-merge; `.passthrough()` preserves unknown keys; `SourceRepo.updateMetadata` added; duplicate-update matrix test. 06 §1.3/§2. |
| 38 | major | Exact coverage queries via live links (orphan spans never cover); half-open overlap predicate; per-check status treatment stated; `NODE_SINGLE_SOURCE` measured on body-cited claims; stable ordering + `{shown,total}` caps; orphan/inactive/relationship-only/cap-boundary tests. 06 §3. |
| 39 | major | Fixture gains a fourth, claim-less source (press-release) for `SOURCE_NO_CLAIMS`; coverage findings homed in `issues` + `data.summary` with a complete example; nonexistent "retire" advice removed. 02 §4.1, 06 §3. |
| 40 | major | Leaf-command count corrected to 21 (and derived from the registry, not hand-counted); version example shows dynamic schema value (currently 1); `source list` counts defined as global regardless of `--status`; ordering `(ingestedAt, id)`; version probe + tie tests. 02 §2–3. |
| 41 | major | Old skills pinned as files (`fixtures/eval/skills-v0/`), no git tag; per-stage script-built seeds shared by both variants; model/settings pinned in RESULTS.md; correctness gates first, efficiency compared only between passing runs (≤+20 %); gate blocks only the skill-done declaration. 07 §3. |
| 42 | minor | Generator shells out to `./bin/kb … --help --json` (no TS imports from .mjs); exact skill paths named; idempotent marker block in USER_GUIDE.md; `docs/index.html` rebuilt via existing `pnpm docs:html`. 07 §4. |

## Notes

- Codex independently **verified** three load-bearing mechanisms (savepoint-nested
  dry-run rollback incl. FTS triggers; per-scope fallback feasibility;
  `repos.tx` implementation) — those parts of the plan are unchanged.
- Two findings caused decisions to move phases: the citation-regex statefulness fix
  moved into Phase 0 (finding 32), and Phase 4's `uncitedSentences` removal was
  rescinded entirely (findings 11/33).
- No finding required reopening a locked architecture decision.
