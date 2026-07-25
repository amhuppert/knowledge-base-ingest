# Tooling improvement design

## Recommendation

Keep the integrity model intact and make the CLI a deeper, self-describing agent interface. The current core is strong: immutable sources, exact-quote verification, atomic writes, staleness propagation, strict verification, and deterministic rendering are the right invariants. The friction comes from making agents assemble too much deterministic context and infer too much of the tool contract themselves.

I would rate the current agent-tooling design **7/10**. It reaches 10/10 by hiding more orchestration behind a small number of existing concepts—not by adding a workflow engine or moving semantic judgment into the CLI.

The division of responsibility should remain:

| CLI owns | Agent owns |
|---|---|
| Capability and schema discovery, format checks, quote resolution, ID derivation, deduplication, transactionality, stale ordering, provenance assembly, and actionable receipts | Corpus interpretation, hierarchy meaning, atomic claim wording, graph semantics, conflict adjudication, synthesis prose, and final answers |

That boundary preserves trust while reducing agent round-trips, retries, and context usage.

## Corrections and refinements to the report

The report is directionally correct, but a few points should be adjusted against the current source:

- `ask-context --limit` already exists in `src/cli/index.ts` and is documented in the user guide. The query skill simply does not show it. This is a skill/version-discoverability problem, not a missing CLI feature.
- The skills say to use a globally installed `kb`, while the README uses `./bin/kb`. There is no `--version` command. A stale global binary can therefore look like missing functionality. Tool identity should be made explicit before adding commands.
- The schemas are canonical in `src/domain/schemas/agent.ts`, but command help exposes only informal input strings and the ingest skill duplicates examples. The schema-discovery complaint is valid.
- `ClaimRepo.listInSubtree()` and `SourceRepo.listAll()` already provide most of the implementation needed for descendant context and `source list`; they are simply not exposed.
- Search behavior explains the observed failures: `search` AND-joins every raw token, while `ask-context` OR-joins raw question tokens and ranks them without stop-word handling, filters, or diversity.
- Full PDF/DOCX/OCR support is a subsystem. The immediate need is a managed original-plus-extracted-text path so the original binary and its lineage are not lost.
- `answer-check` already returns the unsupported sentence text. The first fix should be the concrete Markdown-region false positive and location metadata, not semantic entailment.

## Prioritized roadmap

| Priority | Improvement | Value | Complexity |
|---|---|---:|---:|
| P0 | Tool identity and self-describing help | High | Small |
| P0 | Same-path `--dry-run` and structured issues | Very high | Medium |
| P0 | Actionable mutation receipts, `source list`, and focused parser fixes | High | Small–medium |
| P1 | Descendant synthesis context and batch synthesis | Very high | Medium |
| P1 | Retrieval regression suite and lexical retrieval fixes | High | Medium |
| P1 | Thin, resumable skill rewrites and skill evals | High | Small–medium |
| P2 | Deterministic coverage reporting and derived-source lineage | Medium–high | Medium |
| Conditional | Declarative hierarchy and directory batching | High at large scale | Medium |
| Deferred | Native OCR, embeddings, semantic entailment, connector-specific importers | Unproven | Large |

### P0: Make the current path obvious and safe

#### 1. Identify the exact tool and expose its contract

Add:

```text
kb --version --json
```

It should return the CLI version, supported database schema version, and executable path. `kb status --json` should also include CLI and on-disk schema versions.

Enrich existing command help rather than immediately creating several schema commands:

```text
kb claim apply --help --json
kb ingest --help --json
```

The JSON help should include:

- accepted flags and whether they are required;
- supported source formats;
- canonical input schema, defaults, and enum values;
- one minimal valid example;
- side effects and atomicity;
- whether `--dry-run` is supported;
- output receipt shape.

Generate this information from the Zod boundary where practical, and validate every embedded example in tests. If the help payload later becomes unwieldy, `kb schema <payload-kind>` and `kb template <payload-kind>` can be added then; they are not needed as a first move.

Also reject unknown flags and invalid scopes/limits. Silently accepting `--limt` or a non-numeric limit is especially costly for agents because the command can appear to work while ignoring intent.

#### 2. Add one consistent `--dry-run` convention

Prefer:

```text
kb claim apply --file claims.json --dry-run --json
kb graph apply --file graph.json --dry-run --json
kb synthesize --file synthesis.json --dry-run --json
kb ingest report.md --dry-run --json
```

over separate `claim validate`, `graph validate`, and `synthesize validate` implementations. Dry-run must execute the production validation path and return the same projected IDs, deduplication outcomes, stale-node effects, and warnings that apply would return, while committing nothing.

For database-only mutations, implement this with a savepoint/rollback around the real service path. Ingest needs a deliberate prepare/commit split because the source store write currently occurs outside the database transaction; a nominal rollback must not leave an immutable file behind.

Synthesis validation should be strengthened at the same time. `NodeService.synthesize()` currently checks citation existence, while subtree ownership and inactive citations are detected later by `verify`. Move those checks into a reusable synthesis validator so invalid prose cannot be persisted through the normal command; retain `verify` as defense in depth.

Dry-run failures should be machine-actionable. Preserve `errors: string[]` for compatibility, but add structured issues such as:

```json
{
  "code": "AMBIGUOUS_QUOTE",
  "path": "claims[2].spans[0].quote",
  "chunkId": "chk_…",
  "message": "Quote appears more than once",
  "hint": "Expand the quote with adjacent verbatim text and retry"
}
```

Stable codes let skills recover directly instead of matching prose.

#### 3. Return receipts that eliminate follow-up calls

Count-only responses hide the IDs the services already compute and caused the confusing `spansCreated` report. Keep aggregate counts, but add per-input outcomes:

```json
{
  "claims": [
    {
      "inputIndex": 0,
      "claimId": "clm_…",
      "outcome": "created",
      "spanIds": ["spn_…"]
    }
  ],
  "spans": {
    "submitted": 4,
    "created": 3,
    "reused": 1,
    "linksCreated": 4
  },
  "staleNodes": ["nod_leaf", "nod_topic", "nod_root"],
  "nextActions": ["synthesize nod_leaf", "synthesize nod_topic", "synthesize nod_root"]
}
```

Graph apply should use the same submitted/created/reused/link terminology. This makes deduplication explicit and gives the agent everything needed for the next step.

Add the inexpensive missing primitive:

```text
kb source list [--status active|superseded] --json
```

It can directly expose the existing repository query.

Fix `answer-check` with a focused Markdown-aware pre-pass: exclude GFM footnote definitions and their continuation lines, fenced code, blockquotes, and explicitly supported source-note regions. Return line/column or character offsets with each unsupported assertion, and add the exact quoted-question case from the report as a regression test. Keep semantic entailment out of the deterministic gate.

### P1: Remove orchestration and context assembly

#### 4. Extend an existing read concept for synthesis-ready context

Avoid a parallel shallow command if `node show` can become the deeper interface:

```text
kb node show <node_id> --subtree --provenance --json
```

The response should contain:

- the target node and descendant structure;
- current child summaries/bodies;
- active and conflicted claims in scope;
- owning node for every claim;
- exact provenance needed to assess support;
- conflicts and open questions;
- `allowedCitationIds`;
- stale nodes in deepest-first order.

Use a compact default representation and make full quotes opt-in with `--provenance` so large roots do not unnecessarily consume context. The implementation can reuse `listInSubtree()` and existing provenance repositories.

For writes, allow `kb synthesize --file` to accept either the current single object or a versioned batch envelope:

```json
{ "nodes": [/* existing synthesis objects */] }
```

Prevalidate the entire batch, order it deepest-first, apply it atomically, and return one receipt per node. This removes 22 command invocations without creating a general workflow language.

Do not add every proposed `--dir` operation immediately. Claims and graphs already batch within a source. After context and synthesis batching land, rerun the 22-node benchmark. If node creation is still material, add one declarative hierarchy manifest with local aliases and an alias-to-node-ID receipt. Add directory traversal only if real workflows show that file discovery—not payload authoring—is the remaining bottleneck.

#### 5. Fix lexical retrieval before introducing embeddings

Turn the eight observed searches into a checked-in retrieval fixture with expected claim IDs. Then:

- remove or down-weight common question words;
- add `--match all|any|phrase`;
- use an automatic AND-to-OR fallback when strict search returns zero;
- boost phrase and distinct significant-term coverage;
- exclude inactive claims consistently;
- expose matched terms when `--explain` is requested.

Update `kb-query` to use the existing `--limit` option and an explicit fallback sequence. Add `--node`, `--claim-type`, and `--source` filters only where the fixture shows they improve precision; avoid a large configuration surface preemptively.

Embeddings, semantic hybrid ranking, and sophisticated diversity should be gated on the lexical benchmark. They introduce model dependencies, nondeterminism, index lifecycle, and more operational states into a deliberately local tool.

### P2: Improve quality visibility and source lineage

Add a separate descriptive command rather than mixing subjective quality rules into integrity verification:

```text
kb coverage --json
```

Start with four deterministic outputs:

- sources with no claim-span provenance;
- chunks with no cited/evidence span;
- active claims absent from all synthesis bodies;
- nodes supported by zero or one distinct source.

Also include stale nodes and uncited open questions if they are cheap to compute. Do not initially fail the command on “weak support,” infer duplicates, or score historical evidence quality; those require product definitions and thresholds.

For binary and derived sources, first support:

```text
kb ingest original.pdf \
  --text-from extracted.md \
  --extractor manual/1 \
  --verification visual \
  --json
```

Store and hash the original bytes, persist the canonical extracted text and its hash, and record extractor/version, verification status, and lineage. An optional anchor map can later add page references. This solves the auditability problem without immediately bundling PDF, DOCX, rendering, and OCR stacks.

Expose the supported-format table in both ingest help and the ingest skill. The current skill description also implies URL ingestion, while the CLI reads local paths; either remove that promise or give remote sources a documented capture path. A small validated metadata sidecar can use the existing `metadata_json` field for origin system, external ID/URL, capture time, pagination/thread coverage, and visibility limitations. Prefer one first-class source per original Jira page, Confluence page, or Slack thread when export fidelity permits; keep connector-specific instructions in optional references rather than the core skill.

## Skill redesign

The skills should become thin, resumable orchestrators over the improved CLI.

For all three skills:

1. **Preflight:** resolve the intended KB, verify the binary/version, and inspect current status before mutation.
2. **Discover:** use command help for schemas, capabilities, and supported formats instead of copied payload contracts.
3. **Preview once:** build a payload, dry-run it, and recover by structured issue code.
4. **Apply once:** apply the unchanged validated payload and consume IDs/stale work from its receipt.
5. **Resume safely:** if interrupted, start from status/coverage and the stale worklist rather than repeating completed work.
6. **Finish explicitly:** require `verify --strict` with zero findings, render, and `render --check` with zero drift.

Specific changes:

- Remove “read the kb-ingest skill first” from `kb-create`. Keep the few critical invariants locally and put genuinely shared detail in one compact project reference.
- Replace embedded claim/graph schemas with CLI help calls. Retain examples only where they teach judgment, such as claim atomicity or conflict handling.
- Add a short source-format decision table: native text, binary with text sidecar, or remote faithful export.
- Add one ambiguous-quote recovery branch: reread the named chunk, expand to the shortest unique verbatim quote, rerun dry-run.
- Teach `kb-query` the existing `--limit`, match modes, filters, and zero-result fallback.
- Keep remote-source preservation, evidence-pack trade-offs, and binary extraction in context-specific references so ordinary text ingestion stays concise.

The revised skills should be evaluated, not just reviewed. Use representative cases:

1. ambiguous quote in a multi-claim payload;
2. a newer source conflicting with an older claim;
3. a roughly 20-node corpus;
4. an original binary plus manually verified text sidecar;
5. a natural-language query for an open question.

Compare old and revised skills on successful strict verification, command count, payload retries, tool round-trips, tokens, elapsed time, invalid writes, retrieval recall at five, and citation correctness.

## Explicit deferrals

Do not build yet:

- a monolithic “agent workflow” or generic batch DSL;
- native OCR/DOCX/PDF extraction before the sidecar contract proves insufficient;
- embeddings before measured lexical retrieval remains inadequate;
- semantic NLI inside `answer-check`;
- connector-specific ingestion code before a portable source metadata contract;
- fuzzy duplicate/conflict scoring in coverage.

These are plausible future extensions, but none has enough evidence to justify its complexity now.

## Acceptance criteria

- A fresh agent can construct valid claim, graph, and synthesis payloads from command help without reading source code or copying an old payload.
- Every successful dry-run applies without a validation error on an unchanged KB; every failed dry-run leaves both SQLite and the source store byte-identical.
- Mutation receipts expose all created/reused IDs and the ordered stale-node worklist without follow-up lookup calls.
- The 22-node benchmark uses at least 50% fewer CLI invocations and requires no manual descendant traversal.
- At least seven of the eight retrieval fixtures return an expected claim in the top five, with no more than one false zero-result.
- The quoted-footnote question produces no `answer-check` false positive, while genuinely uncited prose still fails.
- All existing provenance, atomicity, strict verification, and deterministic-render tests continue to pass.

This sequence preserves what makes the project trustworthy while concentrating complexity inside the CLI, where it can be tested once and hidden from every future agent run.
