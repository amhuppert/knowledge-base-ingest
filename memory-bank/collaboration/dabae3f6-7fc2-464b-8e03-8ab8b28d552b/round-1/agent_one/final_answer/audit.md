# Negotiation Audit

## Outcome

Full agreement in one negotiation round. Final design = agent_two's round-1 merged
counter-proposal, amended by five dispositions in agent_one's resolution decision. No
user questions were required; no disagreements survived.

## How it unfolded

**Round 0 (parallel drafts).** Both agents independently converged on every
load-bearing decision: same-path `--dry-run` over separate validate subcommands,
lexical-first retrieval with AND→OR fallback, structural-only answer-check, batch
synthesis via a `{nodes:[…]}` envelope, original-binary lineage instead of an
extraction pipeline, coverage as a separate descriptive command, thin CLI-discovering
skills, and near-identical deferral lists. agent_one contributed the root-cause
diagnosis with code citations and the rejection table; agent_two contributed tool
identity (`--version`), structured issue codes, per-input receipts, and measurement
discipline (fixtures and acceptance criteria).

**Round 1 cross-review (agent_one → agent_two).** agent_one verified agent_two's
factual claims against source before accepting — `ClaimRepo.listInSubtree()`,
`SourceRepo.listAll()`, and `sources.metadata_json` all exist, which cut complexity
estimates and eliminated a proposed migration. agent_one conceded two of its own
positions on evidence: the ingest argument orientation was backwards relative to the
data model (original bytes should own source identity), and agent_two's catch that the
ingest source-store write happens outside the DB transaction invalidated a naive
rollback dry-run for ingest. agent_one proposed seven merges and held three
disagreements, chiefly shipping the hierarchy manifest in P1 rather than gating it on
a re-benchmark.

**Round 1 counter-proposal (agent_two).** Accepted all seven proposed changes with
three bounded amendments: a safety contract for `node apply` (stable refs,
compatibility checks, exact-repeat no-ops), a bounded one-flag context contract
(compact-complete, no silent truncation), and a three-stage skill eval replacing both
agents' earlier versions. Held five disagreements about claims and rationale, not
direction.

**Resolution (agent_one, resolver).** All three amendments accepted. All five
disagreements resolved autonomously after source verification:

1. **retry-idempotency** — agent_two was right: repeated claim applies re-stale nodes
   and write changelog; unchanged synthesize still writes. Verified in
   `claimService.ts` / `nodeService.ts`. Design language corrected from "idempotent" to
   "content-deduplicating"; exact-repeat no-ops became a P1 contract requirement.
2. **search-causality** — agent_one's AND-join claim downgraded from proven cause to
   primary hypothesis (original queries unpreserved; `ask-context` already OR-joins yet
   showed ranking misses). The remedial plan is unchanged; further work is
   fixture-gated.
3. **context-bounds** — resolved by the bounded-context amendment; one-flag interface
   preserved.
4. **fallback-scope** — agent_two's per-scope fallback adopted outright (entity scope
   is LIKE-based; one scope's hit must not suppress another's fallback).
5. **fixture-existence** — command-count savings relabeled as estimates; acceptance
   criteria bind to a Phase-0 captured baseline.

The resolver also added one implementation note: title-only mismatches in the
hierarchy manifest fail with their own issue code rather than being silently kept or
updated (verified: `createNode` today silently accepts title/kind mismatches on the
same parent+slug — which independently justified agent_two's compatibility-check
amendment).

## What the negotiation changed versus either initial draft

- Idempotency claims corrected against source; a stronger no-op contract replaced an
  incorrect assumption.
- Ingest interface reoriented (original-first with `--text-from` sidecar) and the
  ingest dry-run redesigned as prepare/commit rather than rollback.
- Synthesis validation strengthened (shared validator across apply/dry-run/batch/
  context) — a gap neither the report nor agent_one's draft had addressed.
- Search causality softened to a hypothesis with a measurement fixture before any
  retrieval work beyond the fallback.
- A Phase 0 (identity, strict args, baselines) was added ahead of feature work.
- Eval scope negotiated from a five-case matrix down to three stage prompts on one
  fixture.

Locked architecture decisions (SQLite truth, exact-quote verification, boolean
staleness, atomic payloads, renderer-generated footnotes) were never contested by
either agent. Category note: three disagreements were labeled "objective" but all were
code-verifiable implementation facts, not questions about the user's intent — hence
autonomous resolution rather than escalation.
