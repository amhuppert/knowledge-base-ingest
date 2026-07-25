# Skill evaluation — old (v0) vs. revised

> **RUN 1 COMPLETE (subagent harness) — 2026-07-24.** All six runs executed; the
> correctness gate is **met** and the efficiency comparison **passes**. See
> §Outcome for what this does and does not license, and §Harness for the one
> fidelity gap that keeps the `<note>Skill in active development…>` header in
> place for now.

The governing spec for this eval is `docs/plans/07 §3`. Paired agent sessions cannot be
driven by a human from inside this repo, but they *can* be driven by subagents; run 1
used that harness (§Harness). What is mechanical — the prompts, the source, and both
seeded stages — is checked in and gated by `src/cli/eval-seed.test.ts`.

## Pinned settings

Both variants of a stage shared every value here; a mismatch invalidates the comparison.

| Setting | Value |
|---|---|
| Model | Claude Sonnet 5 (`claude-sonnet-5`) — all six runs |
| Settings (thinking / effort / tools) | Default subagent config, `general-purpose` type, full tool access, fresh context per run, no mid-run steering |
| Date | 2026-07-24 |
| CLI version (`kb version --json` → `data.cli`) | 0.1.0 |
| Commit (`git rev-parse --short HEAD`) | `ba029fd` |

**Why Sonnet, not the session model.** A stronger model can paper over a vague skill
and hide the very differences being measured, so Sonnet is the more discriminating
test: a revised-variant pass here is a *stronger* result than a pass on Opus. The
tradeoff is that a *failure* would have been ambiguous between "skill defect" and
"model ceiling". No stage failed, so that ambiguity never arose.

## Harness (run 1)

Six subagents, one per cell, launched concurrently, each in its own directory under
`/tmp/kbeval/<run>/` with its own seed KB, its own copy of the corpus, and **only its
variant's three skill files** — read from disk by the agent, not pasted into the
prompt. Each agent was barred from writing to the repository.

Metrics are **ground truth, not self-reported**: each run's `kb` was a wrapper script
logging `EXEC|<args>` and `EXIT|<code>|<args>` to a per-run file before delegating to
the real binary. Counts come from that log. Terminal checks were re-run afterwards by
the parent against each run's KB using the *real* binary, so verification never
touched the metric logs.

Both variants received all three skill files, because v0's `kb-create` instructs the
agent to read `kb-ingest` first while the revised one does not; withholding the others
would have handicapped v0 on a difference that is not the one under test.

**Fidelity gap (the reason the gate is not yet fully discharged):** this harness tests
skill *content*, not skill *triggering*. The skill was read from an assigned path
rather than discovered by description-matching, and a subagent is not a top-level
session. Discovery is part of what the rewrite changed, so run 2 — three real
sessions on the revised variant — is still required before the note comes off.

**Confound to keep in mind when reading the counts:** both variants ran against the
**new** CLI. The v0 agents used `--claim-type` and `--limit` flags their own skill text
never documents, discovering them from `--help --json`. So this measures skill-text
quality *with CLI improvements held constant* — not old-world vs. new-world. It
compresses the gap between variants, and suggests the self-describing CLI is doing
much of the work the skill rewrite also targeted.

## Variants

| Variant | Skill text |
|---|---|
| **v0 (old)** | `fixtures/eval/skills-v0/{kb-create,kb-ingest,kb-query}.md` — the pinned pre-rewrite baselines |
| **revised** | `.claude/skills/{kb-create,kb-ingest,kb-query}/SKILL.md` |

## Procedure

There are **six runs**: 3 stages × 2 variants. Every one of them starts from a freshly
built, script-built seed — never a previous run's output, and never the other variant's
output. So **rebuild the seed immediately before each run**, including before the second
variant of a stage you just ran.

The reset is part of the command. Run exactly one of these lines, then start the session:

```bash
rm -rf ./eval-kb && pnpm exec tsx scripts/eval-seed.ts stage1 ./eval-kb   # stage 1: empty directory
rm -rf ./eval-kb && pnpm exec tsx scripts/eval-seed.ts stage2 ./eval-kb   # stage 2: the deterministic fixture KB
rm -rf ./eval-kb && pnpm exec tsx scripts/eval-seed.ts stage3 ./eval-kb   # stage 3: fixture + update-memo applied BY SCRIPT
```

Do not drop the `rm -rf`, and do not chain the three lines expecting them to stack: each
stage builds its own KB from scratch (stage 3 rebuilds the stage-2 fixture before
applying the memo), and `stage2`/`stage3` **refuse to build into a non-empty directory**
rather than silently seeding on top of leftovers. If you would rather keep the seeds
side by side, give each run its own path (`./eval-kb-stage2-v0`, `./eval-kb-stage2-revised`, …)
and point the agent at that path instead of `./eval-kb`.

Then start a fresh agent session with only the variant's skill available, paste the
stage prompt **verbatim** from `fixtures/eval/prompts/`, and let it run to completion
without further steering. Record the transcript.

| # | Stage | Variant | Seed command to run first |
|---|---|---|---|
| 1 | 1 | v0 | `rm -rf ./eval-kb && pnpm exec tsx scripts/eval-seed.ts stage1 ./eval-kb` |
| 2 | 1 | revised | same line again — rebuild, do not reuse run 1's KB |
| 3 | 2 | v0 | `rm -rf ./eval-kb && pnpm exec tsx scripts/eval-seed.ts stage2 ./eval-kb` |
| 4 | 2 | revised | same line again |
| 5 | 3 | v0 | `rm -rf ./eval-kb && pnpm exec tsx scripts/eval-seed.ts stage3 ./eval-kb` |
| 6 | 3 | revised | same line again |

| Stage | Skill | Prompt file | Seed | Terminal check |
|---|---|---|---|---|
| 1 | kb-create | `prompts/stage-1-kb-create.txt` | `stage1` (empty dir) | `kb verify --strict --json` ok **and** `kb render --check --json` clean |
| 2 | kb-ingest | `prompts/stage-2-kb-ingest.txt` | `stage2` | conflict recorded (supersede **or** conflict), staleness cleared, `kb verify --strict --json` ok |
| 3 | kb-query | `prompts/stage-3-kb-query.txt` | `stage3` | `kb answer-check` ok **and** the answer cites `clm_b818b407b87ec929` (the planted "burst credits roll over" open question) |

The stage-2 memo (`fixtures/eval/sources/update-memo.md`) plants two things: a claim that
conflicts with the fixture's rate-limit decision, and an ambiguous-quote trap (one
sentence repeated inside a single chunk) that fires `QUOTE_AMBIGUOUS` for any agent that
quotes it bare.

## Metrics

Per run, from the transcript:

- **kb-invocation count** — number of `kb ` invocations in the transcript.
- **payload-retry count** — failed `apply` invocations + failed `--dry-run` invocations.
- **terminal check** — pass/fail against the stage's row above.

Tokens and wall-time may be noted in the notes column; they are **not** gates.
Retrieval recall is measured by the Phase 3 fixture test, not here.

**Metric definitions as applied.** `payload-retry` counts a failed invocation of any
payload-authoring command (`claim apply`, `graph apply`, `node apply`, `synthesize`,
`ingest`), including `--dry-run` forms. The literal wording above says "failed `apply`
invocations"; `synthesize` is apply-shaped and is counted, which is the reading of
intent. `usage-error` (exit 2 — bad flag or command, never reached the domain) is
reported separately: it measures discoverability friction, not payload authoring.

### Stage 1 — kb-create

| Variant | kb-invocation count | payload-retry count | terminal check | Notes |
|---|---|---|---|---|
| v0 | 59 | 1 | **PASS** — `verify --strict` ok (0/0); `render --check` clean, 18 files, 0 drift | 1 failed `synthesize`; 13 nodes; superseded the 100 rps design claim |
| revised | 59 | 0 | **PASS** — `verify --strict` ok (0/0); `render --check` clean, 17 files, 0 drift | 0 usage errors; 12 nodes; assigned `--source-date` to order sources oldest-first |

### Stage 2 — kb-ingest

| Variant | kb-invocation count | payload-retry count | terminal check | Notes |
|---|---|---|---|---|
| v0 | 48 | 1 | **PASS** — supersession recorded (2 claims → `clm_f0eecd67acf0d4d9`); 0/21 stale; `verify --strict` ok | 1 failed `synthesize`; 4 usage errors, all `entity show --name <x>` (invented flag) |
| revised | 49 | 0 | **PASS** — supersession recorded (1 claim → `clm_f0eecd67acf0d4d9`); 0/21 stale; `verify --strict` ok | 1 usage error: `entity list` (command does not exist; not mentioned by any skill) |

### Stage 3 — kb-query

| Variant | kb-invocation count | payload-retry count | terminal check | Notes |
|---|---|---|---|---|
| v0 | 13 | 0 | **PASS** — `answer-check` ok; cites `clm_b818b407b87ec929`; 4/4 citations resolve, 0 uncited | 1 failed `answer-check` (framing sentence tripped `UNCITED_ASSERTION`) |
| revised | 12 | 0 | **PASS** — `answer-check` ok; cites `clm_b818b407b87ec929`; 4/4 citations resolve, 0 uncited | 0 failures; recovered from thin `ask-context` results via the skill's node fallback |

The payload-retry metric is structurally zero for stage 3 (no payload commands), so
failed `answer-check` invocations are recorded in Notes as the only retry signal there.

### Observations that outrank the counts

1. **A real retrieval gap (CLI, not skill).** In stage 3 the revised run found
   `ask-context --claim-type open_question` returned 1 of 4 open questions on one
   phrasing and 0 on a broader one, though all four sit on one node. It recovered via
   the skill's node fallback. The Phase 3 retrieval fixture tests term-matching recall,
   not *category* queries, so this class was never gated. Worth a follow-up.
2. **`answer-check` rejects framing sentences.** A lead-in ("Four open questions
   remain…") tripped `UNCITED_ASSERTION` even with every list item below it cited. The
   v0 run resolved it by stapling all four citations onto the lead-in — valid but
   redundant. Candidate refinement to the assertive-sentence heuristic.
3. **The ambiguous-quote trap did not discriminate.** Both stage-2 runs produced the
   *identical* 97-char extended quote and neither hit `QUOTE_AMBIGUOUS`. Both extended
   proactively; the trap tests something both variants already get right on this model.
   Recorded as a null result — it is not evidence for either variant.
4. **Both variants guessed at nonexistent entity commands** (`entity show --name`,
   `entity list`). Neither skill mentions them, so this is CLI surface shape, not skill
   text: `kb entity` exposes only `show`, and agents expect a list. A cheap
   `kb entity list` would remove a whole class of guessing.
5. **Divergent supersession judgment, both defensible.** v0 superseded both the 100 rps
   and 1000 rps claims; revised superseded only the 1000 rps one, explicitly leaving the
   100 rps design-notes claim as historical context because the memo never references
   that figure. The revised call is the more provenance-faithful of the two.

## Scoring

1. **Correctness gate (first).** All three revised-skill stages pass their terminal
   checks. This is the gate; nothing else can substitute for it.
2. **Efficiency compared only between passing runs.** If the old skill fails a stage,
   the revised pass wins outright — no count comparison is made. Where **both** pass,
   the revised run's kb-invocation count and payload-retry count must not exceed the old
   run's by more than **20 %**. A regression beyond 20 % is investigated and either
   fixed or explained here, with the specific stage evidence.
3. **What the gate blocks.** Removing the "skill in active development" note and
   declaring the skill rewrite done. It does **not** block shipping CLI phases.

## Outcome

**Correctness gate: MET.** All three revised-skill stages pass their terminal checks,
each re-verified by the parent with the real binary against the run's own KB:

| Stage | Revised terminal check |
|---|---|
| 1 | `verify --strict` ok (0 errors, 0 warnings) · `render --check` 17 files, 0 drift |
| 2 | supersession recorded · 0/21 stale · `verify --strict` ok |
| 3 | `answer-check` ok · cites the planted `clm_b818b407b87ec929` · 0 uncited |

All six runs passed, so the efficiency rule applies in every stage (comparison is made
only where both variants pass).

**Efficiency comparison: PASSES.** The revised variant must not exceed v0 by more
than 20 % on either metric.

| Stage | Invocations (v0 → revised) | Δ | Payload retries (v0 → revised) | Verdict |
|---|---|---|---|---|
| 1 | 59 → 59 | 0.0 % | 1 → 0 | pass |
| 2 | 48 → 49 | +2.1 % | 1 → 0 | pass |
| 3 | 13 → 12 | −7.7 % | 0 → 0 | pass |

Invocation counts are effectively a wash (worst case +2.1 %, far inside the 20 %
allowance). The real separation is in failures: the revised variant recorded **0
payload retries across all three stages** against v0's 2, and 1 usage error against
v0's 4. Read honestly, that is a modest result — and the §Harness confound explains
much of why it is modest: v0 was running against the improved, self-describing CLI,
which supplies a good deal of what the skill rewrite was also meant to supply.

**Active-development note removed: NO — deliberately retained.**

The gate as written is met, but run 1 tested skill *content* only. Skill *discovery*
by description-match is part of what the rewrite changed and this harness cannot
exercise it. Before the note comes off, run 2 should repeat stages 1–3 for the
**revised variant only** as three real Command Center sessions — mount the revised
skills (they are already the working-tree state), rebuild each seed, paste the prompt
verbatim, and confirm the same three terminal checks. If those pass, the note can be
removed and this file updated to record run 2.

### Follow-ups raised by this eval (not blockers)

- `ask-context --claim-type` under-returns on category-style questions; the retrieval
  fixture does not cover that query class (Observation 1).
- `answer-check` flags citation-bearing lead-in sentences (Observation 2).
- No `kb entity list`; both variants invented one (Observation 4).
