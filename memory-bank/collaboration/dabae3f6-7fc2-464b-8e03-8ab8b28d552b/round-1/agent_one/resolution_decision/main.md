# Resolution Decision — Round 1

## Decision: FINAL — agreement reached

Agent_two's round-1 counter-proposal accepts all seven of my proposed changes
(`ingest-orientation-plus-recipe`, `one-flag-context`, `promote-node-apply`,
`unified-issue-codes`, `coverage-open-questions`, `docs-drift-gate`,
`lean-skill-evals`) with three bounded amendments, and states explicitly that no
blocking disagreements remain. I accept all three amendments, and I resolve all five
of their remaining disagreements below — each is either a code-verifiable fact
(which I verified) or a contract detail on which both sides already agree about the
remedial action. Nothing left open concerns the user's objective, requires a user
preference, or changes scope; no further negotiation round is needed.

**The final design is agent_two's merged counter-proposal**
(`round-1/agent_two/counter_proposal/main.md`: Phase 0 contract/baseline → Phase 1
previewable mutations and receipts → Phase 2 corpus batching and context → Phase 3
measured retrieval and answer parsing → Phase 4 lineage and coverage, plus the skill
redesign, acceptance criteria, and deferral table), **as amended by the five
resolutions recorded here.** Those resolutions are part of the final design.

## Amendments accepted

1. **`safe-node-apply-contract`** — accepted. It strengthens rather than reverses my
   `promote-node-apply`: the hierarchy manifest ships in P1 (per the merged Phase 2)
   with stable refs, whole-manifest prevalidation, compatibility checks against
   existing nodes, atomic apply, exact-repeat no-ops, and per-node `ref → {nodeId,
   outcome}` receipts. My own verification supports their caution: `createNode`
   returns an existing node *before* the transaction (`nodeService.ts:44-45`) — a
   true no-op, but one that silently accepts a title/kind mismatch on the same
   parent+slug. That silent-mismatch hole is exactly what their compatibility check
   closes. One implementation note carried in: a kind mismatch fails the batch; a
   title-only mismatch should fail with its own stable code (e.g. `TITLE_MISMATCH`)
   rather than being silently kept or silently updated — the manifest author must
   state intent explicitly (a rename is a different operation from a create).
2. **`bounded-context-contract`** — accepted. `kb node show <id> --context --json`
   stays one flag; the bundle is a single owner-tagged claim list, child summaries,
   compact provenance summaries, validator-derived `allowedCitationIds`,
   completeness/size metadata, and the exact next command. No duplicated
   direct/descendant arrays, no fabricated conflict groups, no silent truncation.
   This is my one-flag position plus their bounds discipline; both survive intact.
3. **`three-stage-skill-eval`** — accepted. One shared fixture, three paired
   old-vs-revised stage prompts (create / ingest / query), focused CLI regressions
   for the ambiguous-quote and quoted-footnote cases, and only three recorded
   metrics (command count, payload retries, terminal correctness). Better than both
   my single-case version (which under-covered kb-query) and the original five-case
   matrix (which was platform-shaped).

## Resolution of agent_two's five remaining disagreements

### 1. `retry-idempotency` — resolved: agent_two is correct; design language amended

Verified against source. Repeated `claim apply` on an existing claim updates
`updatedAt`, raises confidence via max, re-marks the node and ancestors stale, and
appends a changelog entry (`claimService.ts:47,79,82-88`). `synthesize` with an
unchanged body still writes the row and a changelog entry (`nodeService.ts:103-118`).
So my draft's unqualified "idempotent, retries are free" was wrong for those two
operations; only `createNode` repeats are true no-ops today. **Resolution:** the
final design describes current behavior as *content-deduplicating*, and adopts
"exact repeated payloads are true no-ops — no timestamp, staleness, or changelog
changes" as a P1 receipt-contract requirement with its acceptance criterion
("exact hierarchy and payload repeats are true no-ops"). This was already in the
merged counter-proposal; I confirm it as resolver.

### 2. `search-causality` — resolved: causal claim downgraded to primary hypothesis

Agent_two is epistemically right: AND-joining is the obvious mechanism for
multi-term natural-language queries returning zero results, but the eight original
queries are not preserved, and the report's *second* retrieval complaint —
`ask-context` ranking omissions — cannot be explained by AND-joining because
`ask-context` already OR-joins (`query.ts:241`). **Resolution:** the final design
states AND-joining as the primary hypothesis for the five zero-result failures, not
proven cause of all retrieval issues. Consequences are unchanged and already merged:
the per-scope AND→OR fallback ships regardless (cheap, safe, `matchMode` reported),
Phase 0 captures or reconstructs the retrieval fixture, and all further retrieval
work (stop-words, filters, diversity, embeddings) is fixture-gated. `ask-context`
ranking is measured separately, per the merged Phase 3.

### 3. `context-bounds` — resolved: bounded-context-contract adopted

Resolved by accepting amendment 2 above. Compact-complete response with
`complete: true` metadata for the measured corpus; continuation/pagination added
only if the fixture demonstrates a real context-budget problem; silent truncation
prohibited (consistent with the no-silent-caps principle both drafts held).

### 4. `fallback-scope` — resolved: per-scope fallback confirmed

Technically correct and I adopt it outright: `search --scope all` concatenates
per-scope result sets, and the entity scope is LIKE-based rather than FTS — a hit in
one scope must not suppress the AND→OR fallback in another. The fallback decision is
made independently per FTS scope, and each scope's results carry their own
`matchMode`. Already reflected in the merged Phase 3; confirmed.

### 5. `fixture-existence` — resolved: estimates labeled, baseline captured first

Correct: the 22-node corpus is described in the report but not checked in, so my
"~70+ → ~25 commands" figure is an estimate, not a measurement. **Resolution:**
Phase 0 captures the original corpus if available, otherwise a deterministic
representative fixture; all before/after command-count and retry claims are labeled
estimates until measured against it; the ≥50%-fewer-invocations acceptance
criterion binds against the captured baseline, not my estimate.

## Category note

Agent_two labeled `retry-idempotency`, `search-causality`, and `fixture-existence`
as "objective" disagreements. Under the collaboration policy's meaning of the
category (about the *user's objective* vs implementation), all three are
implementation-level factual disputes — about code behavior and evidence quality,
not about what the user wants. All were verifiable against the repository or
resolvable by agreed process (fixtures before claims), which is why autonomous
resolution is appropriate and `ask_user` is not triggered: no open question requires
a user preference or changes the requested scope.

## Final state

- All 7 proposed changes: accepted (by agent_two, round 1).
- All 3 alternative amendments: accepted (by me, this decision).
- All 5 remaining disagreements: resolved above; none survive.
- Locked architecture decisions: untouched throughout (SQLite truth, exact-quote
  verification, boolean staleness, atomic Zod payloads, renderer-generated
  footnotes).
- Over-engineering guardrails: intact — the deferral table (vector retrieval,
  in-CLI entailment, native OCR/extraction, connectors, `--dir`/workflow batching,
  JSON-Schema dependency, eval platform) stands as merged.

The deliverable for the user is the merged design in
`round-1/agent_two/counter_proposal/main.md` plus this resolution's five
dispositions and the title-mismatch implementation note. No user questions.
