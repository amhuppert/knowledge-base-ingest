# KB Tooling & Skills Improvement Design

A response to `reports/TOOLING-REFLECTIONS.md`, grounded in the current implementation
(`src/cli/index.ts`, `src/query/query.ts`, `src/domain/services/*`, `.claude/skills/*`).
Every proposal preserves the locked architecture — SQLite as source of truth, exact-quote
span verification, boolean staleness, atomic Zod-validated payloads, renderer-generated
footnotes — and most proposals reuse those guarantees rather than adding new machinery.

## Diagnosis: five root causes

The report's fifteen frictions reduce to five causes, each verified against source:

1. **The tool contract is not self-describing.** Payload schemas exist as Zod
   (`src/domain/schemas/agent.ts`) but aren't exposed; supported formats aren't listed;
   there is no `--version`, and `parseArgs` silently swallows unknown flags
   (`src/cli/index.ts:30-54`) — a typo'd flag looks like success.
2. **Validation is coupled to mutation.** Every apply commits or throws, and
   `synthesize` validates less than `verify` does (citation existence only — not subtree
   ownership or active status, `nodeService.ts:93-98`), so invalid prose can persist and
   fail later.
3. **Command granularity is smaller than the workflow.** The CLI is item-at-a-time
   (`node create`, `synthesize`) while the work is corpus-at-a-time (22 nodes).
4. **Reads don't match the writing task.** `node show` returns only directly owned
   claims (`src/cli/index.ts:396-403`); synthesizing a parent means hand-assembling the
   subtree. (`ClaimRepo.listInSubtree()` already exists — it's just not exposed.)
5. **Retrieval defaults are recall-hostile and unmeasured.** `kb search` AND-joins every
   token (`src/query/query.ts:37,155`) — the primary hypothesis for the five zero-result
   searches. Porter stemming is already enabled (`migrations.ts:200-229`), so the fix is
   query construction, not indexing. Separately, `ask-context` already OR-joins yet
   showed ranking omissions, so retrieval work must be measured, not assumed.

Two report asks turn out to already exist: `ask-context --limit`
(`src/cli/index.ts:447`) and porter stemming. Both are documentation failures — evidence
for the docs-drift gate below.

## Division of responsibility (design principle)

| The CLI owns | The agent owns |
|---|---|
| Capability/schema discovery, format checks, quote resolution, ID derivation, dedup, transactionality, stale ordering, provenance assembly, actionable receipts | Corpus interpretation, hierarchy meaning, claim wording, graph semantics, conflict adjudication, synthesis prose, final answers |

Supporting principles: **validation parity** (dry-run runs the real code path, never a
parallel implementation); **schemas have one home** (Zod, surfaced through help; skills
point at the CLI); **every output names the next action** as a copy-pasteable command;
**errors contain the recipe**; **no silent truncation** anywhere; **exact repeats are
true no-ops** (a contract to be established — today repeated claim applies re-stale
nodes and write changelog entries, so current behavior is content-deduplicating, not
idempotent).

## Phase 0 — establish the contract and baseline (est. ~1 day)

Small, independent, and prerequisite to honest measurement:

- **Tool identity:** `kb --version --json` (CLI version, schema version, executable
  path); versions also in `kb status`. The skills say "globally installed `kb`" while
  the README uses `./bin/kb` — a stale binary is currently indistinguishable from a
  missing feature.
- **Strict arguments:** reject unknown flags and invalid scopes/limits with structured
  issues instead of silently ignoring them.
- **`kb source list --json`** (id, title, status, date, chunk/claim counts) — pure
  exposure of the existing `SourceRepo.listAll()`.
- **Self-describing help:** enrich `kb <command> --help --json` with flags, defaults,
  enums, supported formats, side effects, and one minimal example — generated from or
  test-validated against the Zod boundary. (A standalone `kb schema` command and a
  JSON-Schema dependency are deferred until help proves insufficient.)
- **Shared vocabulary:** define the structured `Issue` type used everywhere — `code`
  (stable, e.g. `AMBIGUOUS_QUOTE`, `UNSUPPORTED_MEDIA`), `severity`, `message`, optional
  `path`/related IDs, `hint`, and `nextActions` as complete command strings. One
  vocabulary across dry-run, apply, and verify findings, so skills learn one recovery
  table.
- **Baselines:** capture the report's workflow command count and, if recoverable, the
  eight failed retrieval queries as a checked-in fixture (otherwise a representative
  fixture with expected claim IDs). All before/after claims bind to these baselines.
- **Regression fixtures:** the ambiguous-quote and quoted-footnote cases from the report.

## Phase 1 — previewable mutations, actionable receipts (est. ~2–3 days)

**Reusable synthesis validator.** One validator computes citation eligibility (resolves,
in target node's subtree, status active/conflicted) with stable issue codes. Normal
`synthesize`, its dry-run, batch synthesis, verify, and the context command's
`allowedCitationIds` all use it — closing the current persist-then-fail gap.

**Same-path `--dry-run` on every apply** (`claim apply`, `graph apply`, `synthesize`,
`node apply`, `ingest`) — chosen over the report's separate `validate` subcommands,
which would double the surface and drift. DB-only commands run the real service path
inside a rolled-back transaction and return the would-be receipt plus `dryRun: true`.
Ingest is the exception: its source-store write happens outside the DB transaction, so
it gets a prepare/commit split — decode, normalize, hash, and chunk without writing
store or DB. Acceptance: a failed preview leaves domain state, changelog, and source
files unchanged.

**Receipts that end follow-up calls.** Keep aggregate counts; add per-input outcomes
(`created`/`updated`/`unchanged`/`reused`) with generated IDs, honest span accounting
(`submitted`/`created`/`reused`/`linksCreated` — this explains the report's confusing
`spansCreated` dedup mystery instead of hiding it), stale nodes deepest-first, and
copy-ready `nextActions`. Establish the exact-repeat no-op contract: resubmitting an
identical payload returns `unchanged` without touching timestamps, staleness, or
changelog.

## Phase 2 — collapse corpus orchestration (est. ~2–3 days)

**Synthesis-ready context, one flag:**

```
kb node show <node_id> --context --json
```

Returns node metadata, immediate child summaries, one compact owner-tagged claim list
for the subtree (conflicted claims flagged by status — no fabricated conflict groups),
compact provenance summaries, `allowedCitationIds` from the shared validator,
completeness/size metadata (`complete: true`, never silent truncation), and the exact
next synthesize command. This turns parent/root synthesis from manual descendant
assembly into one read. Pagination is added only if the measured corpus exceeds a
context budget.

**Hierarchy manifest:**

```
kb node apply --file hierarchy.json [--dry-run] --json
```

A nested manifest with stable local refs (`{ "ref": "security", "title": "Security",
"kind": "topic", "children": [...] }`). The CLI prevalidates the whole tree (refs,
one-root rule, parents, duplicate slugs, compatibility with existing nodes), applies
atomically, and returns `ref → {nodeId, outcome}` — receipts feed node IDs straight
into claim payloads. A kind or title mismatch with an existing node fails the batch
with its own issue code (today `createNode` silently accepts such mismatches); an exact
repeat is a no-op. The report's 22 `node create` calls become one command.

**Batch synthesis.** `kb synthesize --file` accepts the current single object or
`{"nodes": [...]}`: prevalidate all, order deepest-first, apply atomically, one receipt
per node. The 22 synthesis commands become 1–3.

Claim/graph payloads already batch per source; the report's `--dir` variants stay
deferred until the P2 batching is measured and file discovery — not payload authoring —
proves to be the remaining bottleneck.

## Phase 3 — measured retrieval and answer-check fixes (est. ~1–2 days)

**Search:** per-FTS-scope AND→OR fallback — run significant tokens with AND; when a
scope has zero hits, retry that scope with OR; report `matchMode` per scope (per-scope
matters because `--scope all` concatenates results and the entity scope is LIKE-based —
a hit in one scope must not suppress fallback in another). Add `--match all|any|phrase`
as explicit override. Then evaluate the retrieval fixture **before** adding stop-word
handling, filters (`--claim-type`, `--node`, `--source`), or diversity — add only what
the fixture shows improves precision. `ask-context` ranking (which already OR-joins) is
measured separately. Embeddings/hybrid retrieval are gated on the lexical fixture still
missing its target — they add a model dependency, nondeterminism, and index lifecycle
to a deliberately local, deterministic tool.

**answer-check:** exclude complete footnote-definition blocks and continuations, fenced
code, blockquotes, and source-note regions *before* sentence splitting (the reported
false positive comes from `isAssertive` not skipping `[^…]:` lines and the splitter
breaking inside quoted text, `src/query/query.ts:305-318`). Report the exact offending
text with line/column offsets. Semantic entailment stays out of the CLI — the calling
agent is the semantic layer and the kb-query skill already instructs it to read the
quotes; an in-CLI LLM call would make a deterministic gate nondeterministic.

## Phase 4 — source lineage and coverage (est. ~2–3 days)

**Derived sources (PDF and friends) without an extraction pipeline:**

```
kb ingest report.pdf --text-from report.extracted.md \
  --extractor manual/1 --verification visual --json
```

The original bytes own source identity (stored, hashed, content-addressed in the
existing `FsSourceStore`); the transcription becomes the canonical text in
`source_texts`, so chunking and quote verification are untouched. Extraction method,
verification status, and origin metadata (system, external ID/URL, capture time,
pagination coverage) go in the existing `sources.metadata_json` field — no migration.
A bare `kb ingest report.pdf` fails with `UNSUPPORTED_MEDIA` whose message contains the
supported-format list **and this exact recipe** — the report's PDF failure was a
discoverability failure first, and errors are documentation. The agent-transcription
workflow the report described as a "workaround" is in fact the highest-fidelity
extraction available; this makes it first-class. Native PDF/DOCX/OCR extraction is
deferred and, if ever justified, slots behind this same interface.

This is also the lean answer to the Jira/Confluence/Slack "evidence pack" problem:
prefer one first-class source per original page/issue/thread where provenance matters,
each carrying validated origin metadata — a documented pattern, not a connector
framework.

**`kb coverage --json`** — five deterministic, descriptive checks (never failing
`verify --strict`): sources with no claim provenance; chunks with no claim or graph
evidence; active claims absent from all synthesis; nodes supported by ≤1 distinct
source; `open_question` claims absent from synthesis. Each finding carries actionable
IDs. Fuzzy duplicate detection and historical-evidence scoring are excluded — they need
product definitions the data doesn't support.

## Skill redesign (ships alongside each phase)

All three skills become thin, resumable orchestrators over the improved CLI:

```
preflight → discover → preview → apply → resume → finish
```

Preflight resolves binary/version and the KB root; discover reads command help instead
of copied schemas; preview dry-runs once and branches on issue codes; apply consumes
per-input receipts; resume restarts from status/stale-work/coverage instead of
repeating; finish requires `verify --strict`, `render`, and `render --check`.

Specific changes:

- **No skill embeds a payload schema** (replace JSONC blocks with help/template calls;
  keep only judgment-teaching examples: claim atomicity, conflict handling). Drift has
  already happened once — `ask-context --limit` exists, undocumented.
- **kb-ingest:** supported-format decision table (native text / binary + text sidecar /
  remote faithful export); the `--text-from` recipe; one ambiguous-quote recovery
  branch (reread the named chunk → shortest unique verbatim quote → re-dry-run); remote
  source guidance (one source per logical original, metadata preservation checklist) in
  a short reference, not the main path.
- **kb-create:** bootstrap via the hierarchy manifest; batch workflow for large corpora
  (ingest all → claims per source → `--context` per stale node deepest-first → batch
  synthesize); remove "read kb-ingest first" in favor of locally-stated invariants.
- **kb-query:** document `--limit`, match modes, and the zero-result fallback sequence;
  troubleshooting block for empty results.

**Lean evaluation, not an eval platform:** one shared fixture with three paired
old-vs-revised stage prompts (create the corpus / ingest conflicting evidence with an
ambiguous-quote recovery / answer an open-question query answer-check-clean), recording
only command count, payload retries, and terminal correctness. Retrieval recall lives
in the deterministic retrieval fixture, not the skill eval.

## Deliberately not building

| Report ask | Decision | Why |
|---|---|---|
| Hybrid/semantic retrieval | Defer, fixture-gated | Model dep + nondeterminism; zero-result failures have a cheap lexical fix to try first; the driving agent reformulates queries for free |
| Semantic entailment in `answer-check` | Reject for CLI | Inverts the architecture — the agent is the semantic layer; structural check + read-the-quotes rule covers it |
| Native PDF/DOCX/OCR pipeline | Defer | Heavy deps; agent transcription is higher fidelity; the sidecar contract captures provenance without it |
| Jira/Confluence/Slack connectors | Defer | Unbounded surface; validated origin metadata + skill recipes capture the need |
| `--dir` / generic batch language | Defer until P2 measured | Claims/graphs already batch per source; shell substitutes |
| JSON-Schema export dependency | Defer | Validated help examples serve agents; add only when a real consumer needs it |
| Skill-eval platform | Defer | Three stage prompts on one fixture give the signal |

## Acceptance criteria

- A fresh agent constructs valid claim/graph/synthesis payloads from command help alone.
- Unknown flags and invalid values fail with structured issues.
- Every successful dry-run applies cleanly on unchanged state; every failed preview
  leaves domain state, changelog, and source store untouched.
- `allowedCitationIds` exactly equals active/conflicted subtree claims.
- Exact payload/hierarchy repeats are true no-ops; incompatible existing nodes fail
  explicitly.
- The captured corpus workflow uses ≥50% fewer CLI invocations with no manual
  descendant traversal (baseline from Phase 0; the ~70 → ~25 command projection is an
  estimate until measured).
- ≥7 of 8 retrieval fixtures return an expected claim in the top five; ≤1 false
  zero-result.
- The quoted-footnote case passes answer-check; genuinely uncited prose still fails.
- No skill embeds a payload schema; every help/template example parses against its Zod
  schema (the docs-drift gate).
- All existing provenance, atomicity, strict-verification, and deterministic-render
  tests continue to pass.

## Summary

The report's closing ask was "reducing payload authoring and command count while
preserving those guarantees." This design does that by deepening existing concepts —
previewable applies, receipts with IDs and next actions, one context read per synthesis
write, two batch payloads, a sidecar lineage contract, and five coverage checks —
while explicitly deferring every subsystem-sized ask (embeddings, OCR, connectors,
entailment) behind a measured need. Three of the changes (dry-run, `allowedCitationIds`,
derived-source lineage) make the provenance guarantees *easier* to satisfy, not weaker.
