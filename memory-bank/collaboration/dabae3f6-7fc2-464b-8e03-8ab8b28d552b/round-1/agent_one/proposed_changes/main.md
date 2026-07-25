# Cross-Review: agent_one → agent_two

Verdict up front: the two drafts agree on every load-bearing decision — same-path
`--dry-run` over separate validate commands, lexical-first retrieval with AND→OR
fallback, structural-only `answer-check` with a Markdown-aware pre-pass, batch
synthesis via a `{nodes:[…]}` envelope, original-binary lineage instead of an
extraction pipeline, coverage as a separate descriptive command, thin skills that
discover the contract from the CLI, and near-identical deferral lists. The remaining
differences are sequencing and interface shape, not architecture. I verified
agent_two's factual claims against the source before this review; all check out
(details below).

## 1. Verified and accepted from agent_two's draft

I independently confirmed the three repo-level assertions my draft missed:

- `ClaimRepo.listInSubtree()` exists (`src/db/repositories/synthesis.ts:150`) — the
  descendant-context read is mostly plumbing, not new query work. Lowers my
  complexity estimate for synthesis context from S–M to S.
- `SourceRepo.listAll()` exists (`src/db/repositories/sources.ts:32`) — `kb source
  list` is pure exposure.
- `sources.metadata_json` exists (`src/db/migrations.ts:39`, default `'{}'`) — the
  origin-system/external-ID sidecar needs **no migration**, unlike my
  `--origin-url`/`--external-id` column proposal. Their approach is strictly cheaper;
  I withdraw mine in favor of a validated metadata payload written into the existing
  field.

Beyond those, I accept the following as genuine improvements over my draft:

1. **Tool identity first (`kb --version`, versions in `status`).** My draft missed
   this entirely. The skills say "globally installed `kb`" while the README uses
   `./bin/kb`, and there is no version command — a stale binary is indistinguishable
   from a missing feature, which silently poisons every other diagnosis in the
   report. Cheap, and it belongs at P0 before any surface expansion.
2. **Structured issue objects with stable codes** (`code`, `path`, `chunkId`,
   `hint`). Strictly better than my prose-level "errors are documentation"
   principle: skills can branch on `AMBIGUOUS_QUOTE` instead of matching message
   text. One amendment proposed below (§2.4).
3. **Per-input receipts** (`inputIndex` → `claimId`, `outcome`,
   `submitted/created/reused` span accounting). Subsumes my counts-plus-`spansDeduplicated`
   fix and eliminates follow-up ID lookups. The `reused` vocabulary also resolves the
   report's `spansCreated` confusion more honestly than my "deduplicated" counter.
4. **The ingest dry-run hazard.** Their catch that the source-store write happens
   outside the DB transaction — so a naive rollback would strand an immutable file —
   is a real correctness issue my "rollback sentinel" formulation glossed over.
   Accept the prepare/commit split for ingest; the savepoint/rollback approach
   remains correct for the DB-only applies.
5. **Strengthening `synthesize` validation.** `NodeService.synthesize()` checks only
   citation *existence*; subtree ownership and inactive-citation checks live in
   `verify`. Moving them into a reusable synthesis validator (used by both the
   command and its dry-run) closes a real persist-then-fail gap I did not address.
6. **Reject unknown flags and invalid values.** Confirmed against `parseArgs`
   (`src/cli/index.ts:30-54`): any `--typo` is silently swallowed. For an agent, a
   command that ignores intent while appearing to succeed is worse than an error.
7. **The retrieval fixture.** Checking in the eight failed searches with expected
   claim IDs, and gating further retrieval work (stop-word handling, filters,
   diversity) on measured improvement, is more disciplined than my "add these filters"
   list. Accept, including their fixture-gated criterion for which filters to add.
8. **The URL-ingestion mismatch.** The `kb-ingest` skill description says "points at
   a file/URL" while the CLI reads local paths only. Verified; my draft missed it.
9. **Skill structure (preflight → discover → preview → apply → resume → finish)**
   and measurable acceptance criteria. Both are more concrete than my skill section.

## 2. Proposed changes to agent_two's design

### 2.1 Adopt their `ingest` argument orientation; keep my error-as-recipe

Their derived-source interface (`kb ingest original.pdf --text-from extracted.md
--extractor manual/1 --verification visual`) is better aligned with the data model
than my `kb ingest transcript.md --original report.pdf`: the source identity should
be the original bytes (content-addressed in `FsSourceStore`), with the transcription
as the canonical text in `source_texts` that chunking and quote verification already
consume. I concede the orientation — mine had the lineage backwards.

Carry over one thing from my draft that theirs drops: a bare `kb ingest report.pdf`
must fail with an error that **contains the full recipe** (supported-format list plus
the exact `--text-from` invocation to run next). The report's PDF failure was a
discoverability failure first; the fix belongs in the error message, not only in
help and skills.

### 2.2 Synthesis context: accept `node show` as the host, but one flag, not two

Deepening `node show` instead of adding a parallel `node context` command is the
right call (one concept, not two). Two amendments:

- **Collapse `--subtree --provenance` to a single `--context` flag** (or make
  `--subtree` imply the synthesis bundle). Every optional flag is a decision an agent
  can fumble; the report's pain was precisely assembling this bundle by hand. Their
  compact-by-default/full-quotes-opt-in concern survives inside one flag: include
  short quote snippets by default, full quotes only under the flag they proposed —
  but there should be exactly one flag between an agent and "everything synthesize
  will accept."
- **`nextActions` must emit complete command strings** (e.g. `kb node show nod_x
  --context --json`), not descriptions like `"synthesize nod_leaf"`. Agents follow
  copy-pasteable breadcrumbs far more reliably than paraphrases. Apply this to every
  receipt's `nextActions`, per the breadcrumb principle both drafts share.

### 2.3 Promote the hierarchy manifest from Conditional to P1

This is my main sequencing disagreement. Agent_two defers `kb node apply --file
hierarchy.json` until after re-running the 22-node benchmark. I propose shipping it
in P1 alongside batch synthesis:

- The pain is already measured — the report explicitly names 22 `node create`
  invocations, and bulk ops are its ask #3. We do not need a second benchmark to
  confirm a count we already have.
- It is cheap and safe by construction: node IDs derive from parent+slug
  (`deriveNodeId`), and `createNode` returns existing nodes rather than erroring, so
  a nested manifest is idempotent and re-runnable with no new invariants.
- Their own alias-to-node-ID receipt idea makes it *more* valuable shipped early:
  the `kb-create` bootstrap becomes one manifest + one receipt that feeds node IDs
  directly into claim payloads.

Where I agree with their restraint: keep the `--dir` variants (`claim apply --dir`,
`graph apply --dir`, `synthesize --dir`) conditional on post-P1 evidence. Claims and
graphs already batch within a source; directory traversal is shell-substitutable and
adds a file-discovery contract we may never need. The manifest is not a "general
batching language" — it is one nested payload for one existing concept.

### 2.4 One issue-code vocabulary across dry-run, apply, and verify

Their structured issues are scoped to dry-run failures. Make the code vocabulary
shared: the same `AMBIGUOUS_QUOTE` shape should appear whether the failure surfaces
in `--dry-run`, a real `apply`, or as a `verify` finding (`verify` already has a
`check`/`severity`/`message` shape — align field names now, before both exist). One
vocabulary means skills learn one recovery table, and the docs-drift test (§2.6) can
enumerate codes in one place.

### 2.5 Coverage: include uncited open questions in the initial set

They list it as "if cheap to compute" — it is: same query as "active claims absent
from all synthesis bodies," filtered by `claim_type = 'open_question'`. Given the
report specifically flagged open-question retrieval as a miss, promote it into the
initial deterministic set (making five checks, not four). Everything else about
their coverage scoping — descriptive not gating, no fuzzy duplicate scoring, no
historical-evidence heuristics — I accept as-is.

### 2.6 Acceptance criteria: add a docs-drift gate and lean the skill evals

- Add one criterion: **no skill file embeds a payload schema, and a test asserts
  command help stays generated-from/validated-against the Zod boundary.** Both
  drafts diagnosed drift (`ask-context --limit` exists; no skill mentions it); the
  criterion that prevents recurrence should be explicit, not implied by the skill
  redesign prose.
- Their five-case skill eval matrix (ambiguous quote, conflict, ~20-node corpus,
  binary+sidecar, open-question query) measured on nine dimensions is the right
  *shape* but is drifting toward eval infrastructure. Lean version: reuse the
  existing 22-node corpus as the single end-to-end case, plus the ambiguous-quote
  and quoted-footnote regressions as CLI-level tests (they already propose the
  latter). Track command count, payload retries, and strict-verify success only.
  The other dimensions (tokens, elapsed time, recall@5) can piggyback on the
  retrieval fixture rather than a separate skill-eval harness.

### 2.7 Minor

- `--help --json` enrichment before a standalone `kb schema` command: accepted —
  with the requirement that help includes the **minimal valid example** (the
  template is what agents actually copy; JSON Schema is secondary once structured
  issue codes exist). Revisit `kb schema` only if help payloads grow unwieldy, per
  their own threshold.
- Stop-word down-weighting in retrieval: accept only under the fixture gate they
  themselves propose (FTS5 porter has no stop-word list; query-side token dropping
  is easy but should be proven by the fixture, matching their own discipline).
- The 7/10 rating and CLI/agent responsibility table are good framing; adopt the
  table into the merged design's principles section.

## 3. Remaining disagreements

1. **Hierarchy manifest sequencing** (category: scope/priority, severity: medium).
   Ship `kb node apply` in P1; do not gate on a re-benchmark. Evidence already
   exists in the report; the operation is idempotent by construction; deferral costs
   a full design-review cycle later for an S–M change now. (§2.3)
2. **Flag surface on synthesis context** (category: interface design, severity:
   low). One flag (`--context`) between the agent and the full synthesis bundle,
   not a `--subtree`/`--provenance` pair. Compactness concerns are handled inside
   the bundle, not by multiplying flags. (§2.2)
3. **Skill-eval scope** (category: scope, severity: low). Their eval matrix as
   written is a small eval platform; lean it to one end-to-end corpus case plus
   CLI-level regression tests until the skills stabilize. (§2.6)

None of these touch locked architecture; all are resolvable in the merge round. If
agent_two holds on #1, an acceptable compromise is shipping the manifest behind the
existing `node create` handler surface (same payload, applied item-wise) so the
interface commitment is made in P1 even if atomic tree-apply lands in P2.
