# KB Tooling & Skills Improvement Design

Response to `reports/TOOLING-REFLECTIONS.md`. Grounded in the current implementation
(`src/cli/index.ts`, `src/query/query.ts`, `src/domain/services/*`, `.claude/skills/*`).

## Diagnosis

The report's fifteen frictions reduce to five root causes:

1. **No validation without mutation.** Every apply command commits or throws; agents burn
   round-trips discovering payload errors one at a time.
2. **Command granularity mismatch.** The CLI is item-at-a-time (`node create`,
   `synthesize`) while the workflow is corpus-at-a-time (22 nodes, N claim batches).
3. **Reads don't match the writing task.** Synthesizing a parent needs the whole subtree's
   claims; `node show` returns only owned claims (`src/cli/index.ts:396`), so agents
   hand-assemble context with many calls.
4. **Recall-hostile search default.** `kb search` AND-joins every token
   (`ftsMatch(query)` default `'AND'`, `src/query/query.ts:37,155`). A five-word query
   requires all five stems to appear — this alone explains "5 of 8 multi-term searches
   returned nothing." Porter stemming is already on (`migrations.ts:200-229`), so the fix
   is query construction, not indexing.
5. **The tool's knowledge lives outside the tool.** Payload schemas exist as Zod
   (`src/domain/schemas/agent.ts`) but aren't exposed; supported formats aren't listed
   anywhere; outputs don't say what to do next (except `ingest`'s `next` hint, which is
   the right pattern applied once).

None of these require touching the locked architecture (SQLite truth, span-level quote
verification, boolean staleness, atomic Zod-validated payloads). Every proposal below
preserves those guarantees; most *reuse* them.

## Design principles for agent-first tooling

These decide the shape of each fix and are worth stating in `docs/DESIGN.md`:

- **Validation parity.** A dry-run must execute the real code path and roll back — never
  a parallel validation implementation that can drift.
- **Schemas have one home.** Zod is the source of truth; the CLI derives JSON Schema and
  templates from it; skills point at the CLI instead of embedding copies.
- **Every output names the next action.** Commands return a `next` hint (`ingest` already
  does). Agents follow breadcrumbs far more reliably than they recall a 9-step procedure.
- **Errors are documentation.** A rejection must contain the recipe: what failed, why,
  and the exact command or edit that fixes it.
- **Batch is the default shape; atomic per batch; idempotent so retries are free.**
  (`createNode` and `claim apply` are already idempotent — batching them is safe.)
- **One read per writing task.** If a task needs assembled context, there is one command
  that returns all of it.

## Tier 1 — high value, low complexity (do first)

### 1.1 `--dry-run` on every apply command (not separate `validate` subcommands)

```
kb claim apply --file claims.json --dry-run --json
kb graph apply --file graph.json --dry-run --json
kb synthesize --file node.json --dry-run --json
kb node apply --file hierarchy.json --dry-run --json
```

Implementation: all services already mutate inside `repos.tx()`
(`claimService.ts:30`, `nodeService.ts:67,103`). Add a `dryRun` option that runs the
identical transaction body and throws a rollback sentinel at the end; catch it and return
the normal result plus `"dryRun": true`. This validates schemas, IDs, quote
uniqueness/presence, citation resolution — everything the real apply checks, with zero
drift, in ~30 lines. It directly answers the report's #1 ask and removes the "partial
application anxiety" (which was never real — applies are atomic — but was unverifiable).

Rejected alternative: `kb claim validate` subcommands (report's suggestion). Doubles the
command surface and invites validation/apply divergence. `--dry-run` is one flag agents
already know from other tools. `kb ingest --dry-run` is the one place a distinct behavior
is needed: run extraction + chunking, report `wouldCreate` chunk count and title, write
nothing.

**Complexity: S.**

### 1.2 `kb schema <payload>` — schema and template discovery

```
kb schema claim-apply --json      # JSON Schema derived from ClaimApplySchema
kb schema claim-apply --template  # minimal valid example payload
kb schema                        # lists available payload names
```

Derive via Zod's JSON-Schema export; hand-write the four templates (they're small and
double as documentation). Update `commandHelp.input` strings to be generated from (or
test-asserted against) the same schemas so help text can't drift. Skills then say "run
`kb schema claim-apply --template`" instead of embedding JSONC blocks that rot.

**Complexity: S.**

### 1.3 `kb node context <node_id>` — synthesis-ready context in one call

```
kb node context nod_x --json
```

Returns:

```jsonc
{
  "node": { "id", "title", "kind", "summary", "isStale" },
  "children": [ { "id", "title", "summary", "isStale", "claimCount" } ],
  "claims": [ /* active+conflicted claims owned by this node */ ],
  "descendantClaims": [ /* same, for the whole subtree, tagged with owning node */ ],
  "conflicts": [ /* claim pairs/groups with status conflicted in subtree */ ],
  "allowedCitations": [ "clm_…" ],   // exactly what synthesize will accept for this node
  "next": "kb synthesize --file node.json  (cite only allowedCitations)"
}
```

`allowedCitations` is the key field: it makes the parent-may-cite-subtree rule mechanical
instead of tribal knowledge. Implementation is a recursive child walk plus
`claims.listByNode` per descendant — all existing repo methods. This turns parent/root
synthesis from "gather claims from every descendant manually" (report) into one read.

Skip `--include-descendants` as a flag; always include them. Leaves have none, parents
need them — a flag is a decision the agent can get wrong.

**Complexity: S–M.**

### 1.4 Batch node creation and batch synthesis

```
kb node apply --file hierarchy.json --json     # whole tree, one atomic payload
kb synthesize --file synthesis.json --json     # accepts one node OR {"nodes":[…]}
```

`hierarchy.json` is a nested structure (`{ title, kind, children: […] }`) so parent
references are positional, not IDs the agent must thread. Node IDs are derived from
parent+slug (`deriveNodeId`), and `createNode` returns existing nodes instead of erroring
— so `node apply` is naturally idempotent and re-runnable. Output maps each title →
created/existing node ID.

Batch `synthesize` validates all bodies' citations first, then applies in a single
transaction ordered deepest-first (so a parent is never cleared before its children).
The 22-synthesis-commands complaint becomes 1–3 commands. Claim apply already batches
per source; leave it.

**Complexity: M** (payload schema + ordering; services unchanged underneath).

### 1.5 Fix search recall; keep FTS, skip embeddings

- **Auto-degrade AND → OR:** when the AND query returns zero hits, rerun with OR and
  report `"matchMode": "or-fallback"` in the output. One condition in
  `search()`; preserves precision when AND works, recovers recall when it doesn't. This
  is the direct fix for the 5-of-8 failure rate.
- **Explicit override:** `--mode and|or|phrase` for agents that know what they want.
- **Cheap filters** (WHERE clauses, no index changes): `--claim-type`, `--status`,
  `--source` on `search --scope claims`; `--claim-type` and `--node` on `ask-context`.
  Note `ask-context --limit` *already exists* (`src/cli/index.ts:447`) — the report
  asking for it is a documentation failure, fixed in the skills (below).
- **Explainability, lean version:** include each hit's `rank` (bm25 already ordering)
  and the effective `matchMode` in output. Skip custom ranking explanations.

Explicitly **defer hybrid/semantic retrieval**: it adds an embedding dependency, index
maintenance, and nondeterminism to a deterministic tool, and the observed failures are
explained by AND-joining. Revisit only if OR-fallback + filters still miss in practice —
and note the driving agent is itself the semantic layer: it can reformulate queries
cheaply, which is what `ask-context`'s OR mode already exploits.

**Complexity: S.**

### 1.6 `kb source list` + output breadcrumbs + richer global help

- `kb source list --json`: id, title, status, sourceDate, chunk count, claim count.
  Trivial; ends "render the index to enumerate sources."
- Extend the `next` hint pattern from `ingest` to the other outputs:
  `claim apply` → "N nodes now stale; run `kb node context <deepest>`";
  `synthesize` → "M stale nodes remaining (deepest first: …)" ;
  `verify` failure → the command that fixes each finding class.
- `kb` with no args currently returns bare command names (`globalHelp`,
  `src/cli/index.ts:210`); include the one-line summaries from `commandHelp` so one call
  orients an agent.

**Complexity: S.**

### 1.7 `answer-check` false-positive fixes

Root cause: `isAssertive` (`src/query/query.ts:309`) skips headings, list items, and `> `
quotes, but **not footnote-definition lines** (`[^…]: "…?  …?"`), and `splitSentences`
splits inside quoted text — so the second quoted question becomes an "uncited assertion."

Fixes, all structural (no NL inference):

- Treat lines matching `/^\[\^[^\]]+\]:/` as non-assertive (they *are* the citations).
- Don't split sentences inside quotation marks or backticks.
- Skip fenced code blocks.
- Output already returns the offending sentence text; add its line number so the agent
  can fix without searching.

Keep semantic entailment **out** of the CLI (matches the existing design comment,
`query.ts:326-330`): the calling agent reads the quotes — the skill already instructs
this. An LLM call inside the CLI would invert the architecture and make `answer-check`
nondeterministic.

**Complexity: S.**

### 1.8 Honest apply reporting (dedup visibility)

`spansCreated` is computed as an after-minus-before count (`claimService.ts:81`), so
deduplicated spans silently vanish. Report instead:

```jsonc
{ "claimsCreated": 3, "claimsUpdated": 1, "spansCreated": 5,
  "spansDeduplicated": 2, "affectedNodes": 2, "staleNodes": 4, "next": "…" }
```

Same for `graph apply` (entities/relationships created/updated/deduplicated). A dedup is
correct behavior; unexplained numbers are what erode agent trust.

**Complexity: S.**

## Tier 2 — high value, moderate complexity

### 2.1 Non-text sources as first-class *derived* sources (not an extraction pipeline)

The report's PDF workaround (render → transcribe → visually audit → ingest markdown) is
actually the **highest-fidelity extraction available** — the agent is a better PDF reader
than `pdftotext` for layouts, tables, and figures. The failure was that the tool didn't
support the workflow: the original binary is unmanaged, and the link between it and the
transcription is informal. Make the workflow first-class instead of replacing it:

```
kb ingest transcript.md --original report.pdf --extraction agent-transcription --json
```

- Stores the original binary in the content-addressed store (`FsSourceStore` already
  handles arbitrary bytes), records its hash, media type, and `extraction` method on the
  source row; canonical text remains the transcription, so quote verification is
  untouched.
- `kb ingest report.pdf` alone now fails with an **error that contains the recipe**:
  supported text formats, plus the two-step transcription workflow. Errors are
  documentation.
- Optional metadata for remote/indirect sources: `--origin-url`, `--external-id`
  columns on sources. This is the lean answer to the Jira/Confluence "pack vs.
  first-class source" complaint: one source per original page/issue where provenance
  matters, each carrying its origin URL — a skill-documented pattern, not a connector
  framework.

Defer native PDF/DOCX/OCR extraction. If later justified, it slots behind this same
interface (`--extraction pdftotext`) without schema changes.

**Complexity: M** (one migration, ingest-service changes, error text).

### 2.2 `kb coverage` — measurable completeness

`verify --strict` proves integrity; nothing proves *coverage*. Add read-only,
SQL-computable checks in the verify finding format:

- sources with zero claims; chunks never referenced by any span;
- active claims cited by no synthesis body;
- nodes whose claims all trace to a single source;
- `open_question` claims not surfaced in any body.

Each finding carries the IDs needed to act. Skip the report's "current vs. historical
evidence distribution" — it needs source-date semantics the data doesn't reliably have.
This gives ingestion a terminal condition beyond "verify is green" and pairs naturally
with `kb status`.

**Complexity: M.**

## Tier 3 — deliberately not building (over-engineering guardrails)

| Report ask | Decision | Why |
| --- | --- | --- |
| Hybrid semantic search | Defer | Embedding dep + nondeterminism; observed failures explained by AND-join (fixed in 1.5); the agent reformulates queries for free |
| Semantic entailment in `answer-check` | Reject for CLI | Inverts the architecture — the agent is the semantic layer; structural check + "read the quotes" skill rule covers it |
| Built-in PDF/DOCX/OCR pipeline | Defer | Heavy deps, fidelity worse than agent transcription; 2.1 captures the provenance without it |
| Jira/Confluence/Slack connectors | Reject for V1 | Connector surface is unbounded; `--origin-url`/`--external-id` + skill recipes capture the provenance need |
| Explainable ranking | Lean version only | `rank` + `matchMode` in output (1.5); full explanations are UI, not agent, features |

## Skill updates (ship alongside each tier)

The skills are procedure-heavy and reference-poor. Changes:

1. **Point at the tool, don't copy it.** Replace embedded JSONC payload examples with
   `kb schema <payload> --template` (keep one worked example per skill). Embedded copies
   already drifted once (`ask-context --limit` exists but no skill mentions it).
2. **kb-ingest**: add a supported-formats table + the `--original` transcription recipe;
   an ambiguous-quote remediation example (error → extend the quote until unique within
   the chunk — currently learned by trial); dry-run-first guidance ("validate every
   payload with `--dry-run`, then apply"); a remote-source recipe (Slack/Jira): one
   source per logical original where provenance matters, `--origin-url`/`--external-id`,
   preserve message IDs/timestamps/pagination in the transcription body.
3. **kb-create**: replace the node-by-node bootstrap with `node apply --file
   hierarchy.json`; batch workflow for large corpora (ingest all → claims per source →
   synthesize with `kb node context` per stale node, deepest first → batch synthesize);
   add "definition of done": `verify --strict` green **and** `coverage` reviewed.
4. **kb-query**: document `ask-context` flags; add a troubleshooting block ("0 hits →
   check `matchMode`, retry `--mode or`, broaden scope"); note that footnote-style source
   lists are safe for `answer-check` (after 1.7).
5. **All three**: replace step-list prose with a short "command → when → next" table up
   top; agents navigate tables better than narratives, and the `next` breadcrumbs (1.6)
   reinforce the same path at runtime.

## Sequencing and effort

| Phase | Items | Effort | Unblocks |
| --- | --- | --- | --- |
| 1 | 1.1 dry-run, 1.2 schema, 1.6 source list/help/hints, 1.7 answer-check, 1.8 reporting, 1.5 search | ~2–3 days | Every current friction with an S fix |
| 2 | 1.3 node context, 1.4 batch apply/synthesize + skill rewrite | ~2–3 days | The 22-node workflow: ~70+ commands → ~25 |
| 3 | 2.1 derived sources + metadata, 2.2 coverage | ~3–4 days | PDFs, remote sources, completeness signal |

Phases 1–2 are pure additions plus one behavioral change (search fallback) — no schema
migrations, no locked-decision changes. Phase 3 has one additive migration. Each phase
ends with its skill updates so documentation and tool never describe different worlds.

## What this buys, concretely

For the report's 22-node corpus: node creation 22 → 1 command; synthesis 22 commands +
manual context assembly → 1 context read per node + 1–3 batch writes; payload errors
found by `--dry-run` before any state change; searches that fail on AND silently recover
via OR fallback; every rejection tells the agent the fix. The provenance guarantees the
report praised — immutable sources, exact quotes, atomicity, strict verify — are not
weakened anywhere; three of the fixes (dry-run, node context's `allowedCitations`,
derived sources) make those guarantees *easier* to satisfy, which is the report's closing
ask: "reducing payload authoring and command count while preserving those guarantees."
