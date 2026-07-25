# Implementation Status — KB agent-tooling improvement

Final verification sweep of the plans in this directory (`00-overview.md` through
`07-skills-and-evaluation.md`, as revised after `review/codex-review.md`). Every row
below was **re-measured for this report**, not copied from a phase summary.

- **Measured:** 2026-07-24
- **Base commit:** `5c92012` (plus the remediation described in §4, uncommitted at
  measurement time)
- **CLI:** `kb` 0.1.0 · Node v24.16.0 · schema version 2
- **Reproduce:** `pnpm test` · `pnpm typecheck` · `bash scripts/gen-baseline.sh`

## 1. Gates

| Gate | Source | Result |
|---|---|---|
| Command count `new ≤ 0.5 × old` | `scripts/baseline-old.sh` / `scripts/baseline-new.sh`, enforced by `scripts/gen-baseline.sh` and re-measured by `src/cli/baseline.test.ts` | **PASS** — old = 54, new = 22 (40.7 %); limit was 27 |
| Semantic equivalence of both assembly paths | `scripts/kb-snapshot.ts` normalized snapshot | **PASS** — byte-identical; hash `e1a3548f98552ae6d66f431480ca5c9f4f38904a67f4af92ec69742380cf285c` |
| Retrieval fixture gate (≥7/8 recall@5, ≤1 false zero) | `src/query/retrieval-fixture.test.ts` over `fixtures/retrieval/queries.json` | **PASS, directly** — not via Phase 3b. `src/query/stopwords.ts` was never needed and does not exist; `docs/plans/retrieval-results.json` was never written (it exists only for a blocked phase, 05 §3) |
| `pnpm test` | full suite | **PASS** — 735 tests, 66 files, 0 failures |
| `pnpm typecheck` | `tsc --noEmit` | **PASS** — clean |
| Skill evaluation gate (07 §3) | `fixtures/eval/RESULTS.md` | **UNMET — not run.** See §5 |

The baseline was regenerated twice — before and after the §4 remediation — and produced
identical numbers and hash both times, so the recorded figures describe the current tree.

## 2. Per-phase acceptance

Each row is a bullet from that phase doc's **Acceptance** section.

### Phase 0 — contract and baseline (`02-…`)

| Acceptance item | Result |
|---|---|
| Parity + argument tests green; hand-rolled parser deleted; every CLI test runs in-process via `runCli` | **met** — `cli-parity.test.ts`, `router.test.ts` (48), `standard-options.test.ts`, `error-mapping.test.ts`; no `parseArgs`/`TWO_WORD`/`commandHelp` remains in `src/`; the only subprocess tests are the two documented `bin/kb` smoke tests plus the three that drive shell scripts (`baseline`, `gen-command-docs`, `eval-seed`) |
| Unknown flags/commands/values → exit 2 + registry codes; no raw Commander output | **met** — `error-mapping.test.ts` covers every mapped `CommanderError.code`; `program.test.ts` walks the tree asserting `exitOverride` + the shared discarding writers on all 30 nodes |
| Every command answers `--help --json` with a drift-passing spec; global help registry-generated | **met** — `help/spec.test.ts` (15) over all 24 leaves; `help/globalHelp.test.ts` |
| `kb version` (3 probe states) + `kb source list` as specified | **met** — `version.test.ts` (8, incl. missing/older/too-new probes), `source-list.test.ts` (6, incl. filter-vs-global counts and `(ingestedAt, id)` tie ordering) |
| Fixture corpus builds; `baseline-old.sh` green end-to-end; `baseline.md` recorded | **met** — see §1; `docs/plans/baseline.md` is generated, not hand-written |
| `pnpm test` + `pnpm typecheck` green | **met** |

Phase 0's three known-bug `test.fails` pins have all been flipped to positive
assertions — no `test.fails`/`it.fails` remains anywhere in `src/`.

### Phase 1 — preview and receipts (`03-…`)

| Acceptance item | Result |
|---|---|
| Dry-run available and state-clean on the four commands; parity per the §2 projection | **met** — `dry-run.test.ts` (18), `dryRun.test.ts`, `receiptParity.test.ts` (the deterministic projection, excluding `dryRun`/steering/clock fields) |
| Per-input outcomes/IDs; `submitted = created + reused`; compatibility aliases present | **met** — `claimReceipts.test.ts`, `graphReceipts.test.ts`; aliases pinned in `cli-parity.test.ts` |
| Exact repeats are true no-ops (claims, graph, synthesize) | **met** — `claimReceipts.test.ts`, `graphReceipts.test.ts`, `services.test.ts` |
| Synthesize rejects inactive/out-of-subtree citations with §1 precedence; ambiguous-quote regression green | **met** — `synthesisValidator.test.ts` (11), `knownBugs.test.ts` |
| **`LEGACY` emission test passes suite-wide** | **met only after this context's remediation** — it did not exist and 12 production sites still emitted `LEGACY`. See §4, gap 1 |

### Phase 2 — corpus batching (`04-…`)

| Acceptance item | Result |
|---|---|
| §1–§3 tests green (replay, ordering-spy, self-reference regressions); Phase 0/1 suites green with goldens updated | **met** — `nodeContext.test.ts`, `nodeManifest.test.ts` (16), `nodeApply.test.ts`, `synthesizeBatch.test.ts`, `node-context.test.ts`, `node-apply.test.ts`, `synthesize-batch.test.ts` |
| Snapshot equivalence + ≤50 % command count | **met** — see §1 |
| Steering flip "stale-target v2" applied and asserted by the steering table test | **met** — `steering.test.ts` asserts both emitting commands and `nextActionsForStale` target `kb node show <id> --context --json` |

### Phase 3 — retrieval and answer-check (`05-…`)

| Acceptance item | Result |
|---|---|
| §3 gate passes (possibly via 3b), or the phase is blocked with `retrieval-results.json` | **met — passed directly**, no 3b, nothing blocked |
| §1–§2 tests green; `matchModes` + per-hit `matchMode`/`rank`; compat entries recorded; goldens updated | **met** — `query.test.ts`, `ask-context.test.ts`, `commands/query.test.ts` |
| §4 scanner/splitter/citation tests green; quoted-footnote regression green; `uncitedSentences` still emitted | **met** — `markdown.test.ts` (21), `citations.test.ts`; the Phase-0 `it.fails` quoted-footnote pin is now a positive assertion (`query.test.ts:485`); `uncitedSentences` asserted equal to `uncited[].text` in `cli.test.ts:281` |

### Phase 4 — lineage and coverage (`06-…`)

| Acceptance item | Result |
|---|---|
| §1 behavior matrix fully tested; recipe literals asserted; corrected-transcription recipe executed verbatim | **met** — `ingest-lineage.test.ts` (23), `media.test.ts` (14) |
| Extractor split round-trips the integer column; native path records `text-utf8/1` | **met** — `ingest-lineage.test.ts`, `normalize.test.ts` |
| Metadata passthrough/immutability/origin patch-merge/duplicate matrix; `SourceRepo.updateMetadata` added | **met** — `sourceMetadata.test.ts` (8), `ingest-lineage.test.ts` |
| Coverage: five checks per §3 semantics with all positives/negatives; always exit 0 | **met** — `coverage/coverage.test.ts`, `cli/coverage.test.ts` |
| Compatibility matrix updated; no field removals (`uncitedSentences` retained) | **met** |
| Full suite + typecheck green; `baseline-new.sh` unaffected | **met** |

### Skills and evaluation (`07-…`)

| Acceptance item | Result |
|---|---|
| Three skills rewritten per §1–§2; drift-guard test green | **met** — `skills-drift.test.ts` (21) |
| `fixtures/eval/skills-v0/` pinned; seeds script-built | **met** — three pinned v0 files; `scripts/eval-seed.ts` gated by `eval-seed.test.ts` (12) |
| **Eval executed; `RESULTS.md` complete; gate outcome recorded** | **UNMET — not run.** See §5 |
| `USER_GUIDE.md` regenerated between markers; `docs/index.html` rebuilt; README updated | **met** — idempotent `<!-- generated:commands:start/end -->` block at `docs/USER_GUIDE.md:143–1210`, enforced by `gen-command-docs.test.ts`; `pnpm docs:html` reproduces the tracked `docs/index.html` with no diff |

## 3. Cross-context wiring review

Six bounded surfaces checked against `01-shared-contracts.md` and `review/resolution.md`.

| Surface | Result |
|---|---|
| Steering ↔ registry | **clean.** `steering.test.ts` walks every row of both tables through the same `matchingSteeringRows()` production uses, against the real 24-leaf registry; asserts every emitted `NextAction.command` is placeholder-free and names a registered leaf |
| Issue-code emission + hint validity | **two gaps, fixed** (§4 gaps 1–3). Hint validity was already enforced by `issues.test.ts` |
| Compatibility aliases vs matrices | **clean.** Spot-checked all five named commands; each alias is present in output *and* pinned by a test: `claim apply` (`cli-parity.test.ts:319`), `graph apply` (`:350`), `synthesize` (`synthesize.test.ts:81`), `ingest` `next` (`ingest.test.ts:138`), `answer-check` `uncitedSentences` (`cli.test.ts:281`) |
| HelpSpec drift | **clean.** All 24 leaves incl. `node apply` and `coverage`; `spec.flags` ↔ `cmd.options` bijective (so `--context`, `--match`, `--text-from` are covered); `supportsDryRun` matches the exact five-command scope *and* the registered `--dry-run` option bidirectionally |
| Dry-run scope exactness | **clean.** Exactly `ingest`, `claim apply`, `graph apply`, `synthesize`, `node apply` |
| Deferrals honored | **clean.** No embeddings/vector code; no OCR or native PDF/DOCX extraction (`pdf`/`docx` appear only as known-binary extensions that *require* a sidecar); no connectors (Slack/Jira/Confluence only as `--origin-*` skill recipes); no `--dir` flag anywhere; no semantic entailment (`query.ts:465` documents it as out of scope) |

## 4. Gaps found and remediated in this context

`cctl workflow task add` is disabled for this context (`mutability.allowAgentTaskAdd`),
so each gap was remediated inline under its own bounded criterion, red-green TDD.

**Gap 1 — `LEGACY` was still emitted from 12 production sites**, against 01 §3.2, 03
deliverable 6 and 03 acceptance. The most agent-visible symptom: running any command
outside a KB returned an uncoded, hint-less `LEGACY` issue while the `NO_KB` registry
hint was unreachable dead code. *Criterion:* every formerly-`LEGACY` path emits the
registry code 01 §1.4/§2 assigns it, with the registry hint; the `legacyError`/
`legacyWarning` wrappers are deleted; a suite-wide source scan proves no production
module can construct `LEGACY`. *Fixed in:* `src/kb/workspace.ts` (missing KB now throws
`DomainIssueError('NO_KB')`), `src/cli/run.ts` (root warnings → `KB_PATH_SUSPECT`
warnings; workspace-open failures through `errorToIssues`; `ZodError` → one
`PAYLOAD_SCHEMA` issue per Zod issue with a `formatPath` path), and
`src/cli/commands/{claim,entity,node,ops,query,source}.ts` (the six id-lookup paths →
`UNKNOWN_NODE`/`UNKNOWN_SOURCE`/`UNKNOWN_CLAIM`/`UNKNOWN_ENTITY` with `ids` + hint).

**Gap 2 — `render --check` drift had no registry code.** Added `RENDER_DRIFT` (the
registry only grows — charter `registry-additive`; nothing was renamed or removed) with
a hint that says to regenerate rather than hand-edit, emitting one issue per drifted
file with the path in `ids`. *Criterion:* a hand-edited rendered file yields
`RENDER_DRIFT` with hint + `ids`, and the drift report survives on the failed envelope.

**Gap 3 — nothing proved the registry codes were exercised.** *Criterion:* `EMITTED_BY`
(code → test file, read back and required to still mention the code) and `RESERVED`
(code → documented reason) partition `ISSUE_CODES` exactly and disjointly. Added
`src/cli/issue-coverage.test.ts` (15 tests) with end-to-end emission proofs for the
previously untested `NO_KB`, `KB_PATH_SUSPECT`, `UNKNOWN_ENTITY`, `CLAIM_HAS_PROVENANCE`
(reached via a `context`-role-only span) and `RENDER_DRIFT`. Only two codes are
`RESERVED`: `LEGACY` (emission forbidden, entry retained forever) and `FTS_INTEGRITY`
(needs real FTS5 corruption; reachable only through `VERIFY_CHECK_CODES`, whose totality
`issues.test.ts` asserts).

**Gap 4 — steering was the sole `NextAction` producer only by convention.**
*Criterion:* no module under `src/cli` (except `steering.ts`, and `output.ts` which
merely declares the interface) constructs a `{ title, command }` literal. Added that
guard to `steering.test.ts`, so the "every emitted next-action is verbatim and
registered" claim holds suite-wide rather than only for steering-built ones.

Net effect on the suite: 720 → 735 tests, 65 → 66 files, all green.

## 5. Unmet gates

**The Phase-7 skill evaluation gate has not been run.** This is not a deferral chosen
here — it is structurally impossible from inside the repo, and `07 §3` says so: the gate
requires **six paired agent sessions** (3 stages × 2 skill variants), each a fresh
human-driven session started against a freshly rebuilt seed, with the transcript scored
for kb-invocation and payload-retry counts.

What is mechanical **is** done and gated: the pinned v0 skills
(`fixtures/eval/skills-v0/`), the three stage prompts, the update-memo source, and the
script-built stage-1/2/3 seeds — all verified by `src/cli/eval-seed.test.ts` (12 tests,
including that the stage-3 seed stays `verify --strict` clean, records the memo conflict
as a supersession, keeps the planted open question citable, and that the ambiguous-quote
trap really fires `QUOTE_AMBIGUOUS`).

What is outstanding, and is the **user's** to run:

1. Fill the pinned-settings table in `fixtures/eval/RESULTS.md` (model, settings, date,
   CLI version, commit) before the first run.
2. Execute the six runs per the procedure table in that file.
3. Record the per-stage metrics and the scoring outcome.

Per `07 §3` this gate blocks exactly one thing: removing the
`<note>Skill in active development…</note>` header from the three skills and declaring
the skill rewrite done. It does **not** block the CLI phases. The note is currently
present in all three of `.claude/skills/{kb-create,kb-ingest,kb-query}/SKILL.md`, which
is the correct state while the gate is unmet.

No other gate is unmet.

## 6. Recorded source conflict

`02-phase-0-contract-and-baseline.md` §2 states the schema version is "currently 1 …
no planned phase adds a migration". The tree ships **two** migrations —
`1 init` and `2 claim_span_link_identity` (`src/db/migrations.ts:274–277`), the latter
required by `03-…` §4's link-identity decision (`(claim_id, span_id)`, Codex finding 21).

- **Prevailing source:** `03-…` §4 (both docs are rank 1 — implementation plans — but
  §4 is a normative deliverable, while the 02 §2 phrase is a descriptive aside about a
  worked example).
- **Resolution:** no violation. 02 §2's actual requirement was that the version
  envelope report the **dynamic** value rather than a hard-coded number, and it does:
  `src/cli/version.ts:63` reads `currentSchemaVersion()`, and `version.test.ts` asserts
  against that function rather than a literal. Only the parenthetical "currently 1" is
  stale; the mechanism it constrained is correct.
