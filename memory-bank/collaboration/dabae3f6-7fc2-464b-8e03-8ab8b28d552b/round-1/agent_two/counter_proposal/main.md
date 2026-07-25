# Counter-proposal: converged tooling design

## Position

The drafts now agree on every architectural decision. I accept all seven of Agent One’s proposed change IDs, with explicit contract amendments where the current code does not support the stated safety or idempotency rationale.

**Negotiated design score: 9/10.** It reaches 10/10 once three contracts are nailed down in tests: exact-repeat behavior, bounded synthesis context, and representative workflow/retrieval fixtures.

There are no blocking disagreements.

## Decisions on Agent One’s proposed changes

| Proposed change ID | Decision | Incorporation |
|---|---|---|
| `ingest-orientation-plus-recipe` | **Accept** | Use original-first ingestion: `kb ingest report.pdf --text-from report.extracted.md`. A bare binary ingest returns a structured `UNSUPPORTED_MEDIA` issue containing supported formats and the exact sidecar recipe. The original bytes own source identity; canonical text and extraction metadata live in `source_texts` and validated `metadata_json`. |
| `one-flag-context` | **Accept with contract amendment** | Use `kb node show <id> --context --json`. The bundle is compact and complete: one owner-tagged claim list, child summaries, eligible statuses, source summaries, and `allowedCitationIds`. It does not duplicate direct/descendant arrays or invent conflict groups. No silent truncation is allowed. |
| `promote-node-apply` | **Accept with safety amendment** | Ship `kb node apply --file hierarchy.json` in P1. Current `createNode()` behavior is not sufficient proof of safe idempotency. Require stable local refs or canonical paths, whole-manifest prevalidation, compatibility checks against existing nodes, atomic apply, exact-repeat no-ops, and per-node receipts. Keep `--dir` variants deferred. |
| `unified-issue-codes` | **Accept** | Define one additive issue base across dry-run, apply, and verify: `code`, `severity`, `message`, optional `path`, related IDs, `hint`, and structured `nextActions`. Preserve existing string errors/warnings and verify’s `check` field during compatibility migration. |
| `coverage-open-questions` | **Accept** | Include open questions absent from synthesis in the first coverage set. Implement it with SQL plus the existing citation parser; coverage remains descriptive and does not fail strict verification. |
| `docs-drift-gate` | **Accept** | Skills contain judgment examples, not copied payload schemas. Every help/template example must parse with the canonical Zod schema, and tests must keep supported flags and formats discoverable. |
| `lean-skill-evals` | **Accept with coverage amendment** | Use one shared end-to-end fixture with three stage prompts—one per skill—rather than five independent scenarios or a new eval platform. Add focused CLI regressions for ambiguous quotes and quoted footnotes. Track command count, payload retries, and terminal correctness. |

## Agreements carried into the merged design

- **Protected invariants:** SQLite remains the source of truth; immutable original bytes, exact-quote spans, atomic mutations, boolean staleness, renderer-generated footnotes, strict verification, and deterministic rendering remain unchanged.
- **Validation parity:** strengthen synthesis validation first, then make normal apply, dry-run, batch synthesis, and `allowedCitationIds` use that one validator.
- **Dry-run shape:** DB-only mutations use the real path under rollback; ingest uses a no-store prepare/commit split.
- **Tool identity:** add `kb --version --json`, executable path, supported schema version, and on-disk schema version in status.
- **Strict agent boundary:** reject unknown flags, invalid scopes, and invalid limits instead of silently ignoring them.
- **Agent-readable contracts:** return structured issue codes, per-input IDs/outcomes, honest created/reused/link counts, and copy-ready `nextActions`.
- **Schema discovery:** enrich `kb <command> --help --json` with field metadata, defaults, enums, supported formats, and a minimal Zod-validated example. Do not add a JSON-Schema dependency or separate `kb schema` command until a real consumer needs it.
- **Retrieval:** Porter stemming already exists. Test per-scope AND→OR fallback first and measure it before adding stop-word handling, filters, diversity, or embeddings.
- **Answer validation:** remove Markdown source regions before sentence segmentation; keep semantic entailment outside the deterministic CLI.
- **Derived sources:** support original-plus-text-sidecar lineage before native extraction.
- **Coverage:** keep it separate from integrity verification and avoid fuzzy quality scoring.
- **Skills:** make them thin, resumable workflows driven by CLI discovery, preview, receipts, and explicit completion checks.
- **Deferrals:** no generic workflow engine, directory-batch language, native OCR stack, connector framework, vector index, or in-CLI semantic entailment now.

## Remaining disagreements and cautions

These are disagreements with claims or rationales in the earlier drafts, not with the merged direction.

| ID | Category | Severity | Position |
|---|---|---|---|
| `retry-idempotency` | Objective | Major | Existing retries are content-deduplicating, not side-effect-free. Claim reapply updates timestamps, stales nodes, and logs; unchanged synthesis also writes and logs. Exact repeats must become true no-ops before the design calls retries free or idempotent without qualification. |
| `search-causality` | Objective | Major | AND joining is a strong hypothesis for zero-result searches, not proof of all five failures. The original eight queries are not checked in, and `ask-context` already OR-joins while showing ranking omissions. Capture or reconstruct a representative fixture and report measured results. |
| `context-bounds` | Implementation | Major | A context bundle must remain token-efficient. P1 should return every eligible claim once in compact form and report `complete: true`. Add pagination/cursors only if the recorded corpus exceeds the agreed context budget; never truncate silently. |
| `fallback-scope` | Implementation | Minor | AND→OR fallback must run per requested FTS scope. An irrelevant hit in one scope must not suppress a useful fallback in claims or chunks. |
| `fixture-existence` | Objective | Minor | The report describes a 22-node run, but that corpus is not a checked-in fixture. Capture it if available or create a deterministic representative fixture before quoting before/after command counts. |

## Merged counter-proposal

### Root causes

The report’s friction reduces to five causes:

1. The executable contract is not self-describing enough.
2. Validation is coupled to mutation, and synthesis validation is weaker than final verification.
3. Command granularity is smaller than corpus workflows.
4. Read operations do not return the context required by the corresponding write task.
5. Retrieval behavior is not measured and has recall-hostile defaults.

The solution is to deepen existing CLI concepts so deterministic complexity is handled once by tested code while agents retain semantic judgment.

### Phase 0: establish the contract and baseline

Ship the small, independent changes first:

- capture the report workflow’s command count and payload-retry baseline;
- capture the eight retrieval queries if available, otherwise create a representative fixture with expected claim IDs;
- add `kb --version --json` and version fields to status;
- reject unknown flags and invalid values;
- add `kb source list --json`;
- enrich command help with Zod-validated examples and supported formats;
- define the shared structured `Issue` and `NextAction` types;
- add the quoted-footnote and ambiguous-quote regression fixtures.

This phase prevents stale binaries, silent flag typos, and undocumented contracts from contaminating later measurements.

### Phase 1: make mutations previewable and receipts actionable

#### Reusable synthesis validation

One validator must compute citation eligibility:

- every citation resolves;
- the cited claim belongs to the target node’s subtree;
- its status is `active` or `conflicted`;
- inactive or outside-subtree claims are rejected with stable issue codes.

Normal synthesis, dry-run, batch synthesis, final verification, and context’s `allowedCitationIds` use the same rule. Verification remains defense in depth.

#### Same-path preview

Support:

```text
kb claim apply --file claims.json --dry-run --json
kb graph apply --file graph.json --dry-run --json
kb synthesize --file synthesis.json --dry-run --json
kb node apply --file hierarchy.json --dry-run --json
kb ingest report.md --dry-run --json
```

Database previews return the would-be receipt and roll back all logical changes. Ingest preview performs decode/extraction preparation, normalization, title derivation, hashing, and chunking without writing the source store or database.

The acceptance condition is unchanged logical domain state and changelog, plus no new or changed source-store files—not byte-identical SQLite/WAL files.

#### Receipts

Mutation output retains aggregate counts and adds:

- one outcome per input (`created`, `updated`, `unchanged`, `reused`);
- generated IDs;
- evidence references submitted, unique spans created/reused, and provenance links created/reused;
- stale nodes ordered deepest-first;
- structured, copy-ready next commands.

Exact repeated payloads should return `unchanged` without changing timestamps, staleness, or changelog entries.

### Phase 2: collapse corpus orchestration

#### Synthesis context

```text
kb node show nod_x --context --json
```

Return:

- node metadata and immediate child summaries;
- one deterministic claim list tagged with owner node and status;
- compact source/provenance summaries;
- conflicted claims as statuses, not fabricated pairs;
- `allowedCitationIds` from the synthesis validator;
- completeness and estimated-size metadata;
- the exact next synthesis command.

Use the compact complete response for the measured corpus. Add continuation only if the fixture demonstrates a context-budget problem.

#### Hierarchy manifest

Use a nested manifest with stable refs:

```json
{
  "nodes": [
    {
      "ref": "root",
      "title": "Knowledge Base",
      "kind": "root",
      "children": [
        { "ref": "security", "title": "Security", "kind": "topic" }
      ]
    }
  ]
}
```

Before writing, validate refs, one-root rules, parent relationships, duplicate paths/slugs, and compatibility with existing nodes. Apply the entire tree atomically and return `ref → {nodeId, outcome}`. A conflicting existing node fails the batch; an exact repeat is a no-op.

#### Batch synthesis

Allow the existing single object or:

```json
{ "nodes": [/* synthesis payloads */] }
```

Prevalidate the whole set, order deepest-first for understandable receipts, apply atomically, and return one result per node. Claims and graphs already batch within a source; directory variants remain conditional.

### Phase 3: fix measured retrieval and answer parsing

For each FTS scope:

1. run significant query tokens with AND;
2. when that scope has zero hits, retry with OR;
3. return `matchMode` with that scope’s results.

Evaluate the fixture before adding query-side stop-word handling, filters, or diversity. For `ask-context`, which already uses OR, measure ranking and significant-term coverage separately. Add embeddings only if lexical retrieval still misses the agreed threshold.

For `answer-check`, exclude complete footnote-definition blocks and continuations, fenced code, blockquotes, and supported source-note regions before sentence splitting. Return exact text plus line/column offsets. Do not build a general quote-aware parser until a regression requires it.

### Phase 4: lineage and completeness

Support:

```text
kb ingest report.pdf \
  --text-from report.extracted.md \
  --extractor manual/1 \
  --verification visual \
  --json
```

The source row describes and stores the original bytes. `source_texts` holds canonical extracted text and its hash; validated metadata records verification and external origin. A bare PDF returns `UNSUPPORTED_MEDIA` plus this recipe. Native extractors remain deferred.

Add `kb coverage --json` with five descriptive checks:

1. sources with no claim-span provenance;
2. chunks with no claim or graph evidence, reported separately;
3. active claims absent from synthesis;
4. nodes supported by zero or one distinct source;
5. `open_question` claims absent from synthesis.

Coverage uses SQL plus the existing citation parser and never changes `verify --strict`.

## Skill changes and lean evaluation

Each skill follows:

```text
preflight → discover → preview → apply → resume → finish
```

- Preflight resolves the binary/version and KB.
- Discover calls command help rather than reading copied schemas.
- Preview runs once and branches on issue codes.
- Apply consumes per-input receipts.
- Resume starts from status, stale work, and coverage instead of repeating work.
- Finish requires `verify --strict`, render, and `render --check`.

No skill embeds a canonical payload schema. Context-specific binary and remote-source guidance lives behind short references.

Use one shared fixture with three paired old-versus-revised stage prompts:

1. `kb-create`: build the representative multi-source hierarchy through strict verification and render check;
2. `kb-ingest`: add conflicting evidence, recover from an ambiguous quote, and clear staleness;
3. `kb-query`: retrieve an open question and produce an `answer-check`-clean cited answer.

Record only:

- CLI/tool-call count;
- payload validation retries;
- terminal correctness (`verify --strict`, `render --check`, and answer-check).

Retrieval recall belongs to the separate deterministic retrieval fixture. Tokens and elapsed time may be observed but do not justify a new eval platform yet.

## Acceptance criteria

- A fresh agent can construct valid payloads from command help without reading source code or copying an old payload.
- Unknown flags and invalid values fail with structured issues.
- Dry-run and apply produce equivalent receipts on unchanged logical state; failed previews leave domain state, changelog, and source files unchanged.
- `allowedCitationIds` equals active/conflicted subtree claims and excludes inactive/out-of-scope claims.
- Exact hierarchy and payload repeats are true no-ops; incompatible existing nodes fail explicitly.
- The captured corpus workflow uses at least 50% fewer CLI invocations and no manual descendant traversal.
- Expected claims appear in the top five for at least seven of eight retrieval fixtures, with no more than one false zero-result.
- Quoted footnote questions produce no false positive while genuinely uncited assertions still fail.
- No skill embeds a payload schema; every help/template example passes its Zod schema.
- All three revised-skill stages reach their terminal checks with fewer commands or retries than baseline.
- Existing tests, typecheck, strict verification, and deterministic rendering continue to pass.

## Explicit deferrals

| Proposal | Decision |
|---|---|
| Hybrid/vector retrieval | Defer until the lexical fixture misses its target |
| Semantic entailment inside `answer-check` | Reject for the deterministic CLI |
| Native PDF/DOCX/OCR extraction | Defer until sidecar usage demonstrates demand |
| Jira/Confluence/Slack connectors | Defer; use validated origin metadata and faithful exports |
| `--dir` and generic workflow batching | Defer until P1 batching is measured |
| Full JSON-Schema generation dependency | Defer; validated help metadata/examples are sufficient initially |
| Dedicated skill-eval platform | Defer; use one shared fixture and three stage prompts |

This counter-proposal keeps the report’s trusted integrity core, removes the observed orchestration cost, and puts every added interface behind a measured need or a concrete regression.
