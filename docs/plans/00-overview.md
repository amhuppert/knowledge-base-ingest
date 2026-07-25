# KB Tooling Improvement — Implementation Plan Overview

Implementation plans for the negotiated design (see
`memory-bank/collaboration/dabae3f6-7fc2-464b-8e03-8ab8b28d552b/round-1/agent_one/final_answer/answer.md`,
source report `reports/TOOLING-REFLECTIONS.md`). These documents are
**decision-complete**: an implementer should not need to make design choices — exact
command signatures, payload schemas, output shapes, issue codes, file locations, and
test lists are specified. Where a decision was contested during design review, the
resolution is stated, not reopened.

Reviewed by Codex (gpt-5.6-sol, ultra effort): `review/codex-review.md` (42
findings). All findings are resolved in the current revision; the disposition of
each is recorded in `review/resolution.md`.

## Plan documents

| Doc | Scope | Est. effort |
|---|---|---|
| [01-shared-contracts.md](01-shared-contracts.md) | Cross-cutting: Commander.js architecture, output envelope v2, issue-code registry, help system, agent-steering conventions, exit codes, testing conventions | (absorbed into Phase 0) |
| [02-phase-0-contract-and-baseline.md](02-phase-0-contract-and-baseline.md) | `runCli` extraction, Commander migration, tool identity, strict arguments, `source list`, self-describing help, fixtures & baselines | ~2 days |
| [03-phase-1-preview-and-receipts.md](03-phase-1-preview-and-receipts.md) | Shared synthesis validator, `--dry-run` on the payload-authoring commands (exact scope in 01 §6.2), per-input receipts, exact-repeat no-ops | ~3 days |
| [04-phase-2-corpus-batching.md](04-phase-2-corpus-batching.md) | `node show --context`, hierarchy manifest (`node apply`), batch `synthesize` | ~2–3 days |
| [05-phase-3-retrieval-and-answer-check.md](05-phase-3-retrieval-and-answer-check.md) | Per-scope AND→OR fallback, `--match` modes, ask-context filters, answer-check Markdown pre-pass | ~2 days |
| [06-phase-4-lineage-and-coverage.md](06-phase-4-lineage-and-coverage.md) | `ingest --text-from` (derived sources), source metadata, `kb coverage` | ~2–3 days |
| [07-skills-and-evaluation.md](07-skills-and-evaluation.md) | Rewrites of the three skills, three-stage evaluation | ~1–2 days (docs) |

Dependency order: Phase 0 is prerequisite for everything (it re-platforms the CLI).
Phases 1 → 2 are sequential (2 reuses the validator and dry-run runner). Phase 3 is
independent of Phases 1–2 in code and may run in parallel after Phase 0 (it shares
only the envelope/issue conventions). Phase 4 depends on Phases 1–3 (ingest
`plan`/`commit` split from 1; steering finalization against Phase 2 commands;
answer-check/search shapes from 3). Skill rewrites ship incrementally alongside the
phase that delivers each capability; the final rewrite and evaluation land after
Phase 4.

## Design frame: the CLI is a progressive-disclosure and steering surface

The `kb` CLI's primary consumer is an AI agent. Agents do not read manuals up front;
they discover capability incrementally and follow whatever the tool tells them next.
The CLI therefore exposes three disclosure layers, each answering one question:

1. **`kb` (bare) / `kb --help`** — *"what can I do here?"* A workflow-grouped command
   map with one-line summaries and a "start here" pointer. Never a bare name list.
2. **`kb <command> --help [--json]`** — *"how do I call this one?"* The full
   machine-readable contract: flags, defaults, enums, payload schema example
   (test-validated against the Zod boundary), side effects, atomicity, dry-run
   support, and related commands.
3. **Command output** — *"what happened, and what should I do next?"* Every result is
   a receipt: per-input outcomes and IDs, structured issues with stable codes and
   recovery hints on failure, and `nextActions` containing complete, copy-pasteable
   commands for the required next workflow step (e.g. after `claim apply`: the
   `node show --context` invocations for the now-stale nodes, deepest first).

Rules that follow from this frame (normative for every command; details in
[01-shared-contracts.md](01-shared-contracts.md)):

- Every command supports `--help` and `--json`; `--help --json` returns the contract
  as data, not prose.
- Every mutation returns a receipt that eliminates follow-up lookup calls.
- Every failure is an `Issue` with a stable `code`, an actionable `hint`, and, where
  applicable, the exact command to run next. Errors are documentation.
- Unknown flags, unknown commands, and invalid values are rejected loudly (a command
  that silently ignores intent while appearing to succeed is the worst agent outcome).
- `nextActions` name only legal next steps; `hints` are capped at 3 per response.
- No silent truncation anywhere; anything bounded reports what was omitted.

## Protected invariants (do not touch)

- SQLite is the source of truth; `kb/` markdown is a deterministic read-only render.
- Immutable, content-addressed source copies under `sources/`.
- Span-level exact-quote verification before persist; no flag bypasses it.
- Boolean staleness (`nodes.is_stale`) with ancestor propagation; bottom-up synthesis.
- Agent proposes Zod-validated JSON; the CLI persists in one `BEGIN IMMEDIATE`
  transaction.
- Inline `[^clm_<id>]` citations; the renderer generates footnote definitions.
- Entity names are not fuzzy-merged; version suffixes are preserved.

## Explicitly deferred (decided; do not implement)

Hybrid/vector retrieval (gated on the Phase 0 retrieval fixture missing its target);
semantic entailment inside `answer-check`; native PDF/DOCX/OCR extraction (the
`--text-from` sidecar contract covers lineage); Jira/Confluence/Slack connectors
(validated origin metadata + skill recipes instead); `--dir` batch variants and any
generic workflow language (re-evaluate after Phase 2 is measured); a JSON-Schema
export dependency (help metadata + validated examples serve agents); a dedicated
skill-eval platform (one fixture, three stage prompts).

## Methodology

Red-green TDD throughout: every behavior change lands as a failing test first, then
the minimum implementation, then refactor. Each phase doc lists its test additions in
implementation order. Known-broken current behaviors (quoted-footnote answer-check,
ambiguous-quote messaging) are checked in during Phase 0 as `test.fails` cases and
flipped to positive assertions by the phase that fixes them.
