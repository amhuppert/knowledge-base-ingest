# Phase 5 — Source Currency and Query Polish

Goal: close the source-status blind spot in the read path (docs/ISSUES.md #1–#2)
and remove three documented frictions in the kb-query contract (#3–#5). The
feedback came from an agent running the kb-query skill against a KB that had been
re-ingested with `--supersedes`; the central finding is that a citation can ride
on a superseded source while every check reports `ok:true`.

**Status: implemented (2026-07-27), red-green TDD throughout.** Every acceptance
item below is covered by a test that was watched fail first; `pnpm test`
(778 tests / 68 files) and `pnpm typecheck` are green, and
`scripts/gen-command-docs.mjs` has been regenerated.

## Background (verified against the current tree)

- A `--supersedes` ingest sets ONLY `sources.status = 'superseded'`
  (`src/domain/services/ingestService.ts:373–375`). Claims extracted from the old
  source keep their spans against its (immutable) canonical text and stay
  `active`. Nothing downstream ever reads source status on the query path.
- `answer-check` validates claim existence and claim status only
  (`src/query/query.ts:553–563`); `verify` has no source-currency check
  (`VERIFY_CHECKS`, `src/verify/verify.ts:30–39`). So ISSUES #1 is a real gap:
  an answer citing a claim stranded on a superseded source passes both.
- Span projections exist in three places, none of which exposes source status:
  `ask-context` (`enrichClaim`, `src/query/query.ts:304–324` —
  `{sourceTitle, quote, storedPath}`), `kb provenance`
  (`src/cli/commands/query.ts:263–267` — same plus offsets), and the
  `node show --context` bundle (`src/domain/services/nodeContext.ts:49–53` —
  `{sourceId, sourceTitle, quoteSnippet}`).
- `AnswerCheckSchema.claim_ids` is ALREADY optional
  (`src/domain/schemas/agent.ts:274–279`) and `answerCheck` unions it with the
  citations it parses out of the answer text — ISSUES #4 is a help-example
  problem, not an engine gap.
- KB root resolution is `--kb` > `KB_DIR` > walk-up (`src/kb/workspace.ts:30–35`),
  with `KB_PATH_SUSPECT` already guarding relative-`KB_DIR` rebasing. The
  kb-query skill mentions the export as a working rule but does not make it the
  first preflight action — hence ISSUES #5's "practical workaround" framing.
- Envelope `ok` derives from error-severity issues only
  (`src/cli/output.ts:101–104`), so warning-severity issues surface without
  flipping `ok` — the mechanism #1 needs. `verify --strict` already fails on
  warnings, which gives the post-supersede forcing function #1 asks for.

## 1. Stranded provenance: new code `PROVENANCE_SOURCE_INACTIVE` (#1)

**Definition.** A claim is *stranded* when it has ≥1 supporting span and NONE of
its supporting spans resolves to a source with status `active`. Mixed provenance
(at least one active span) is not stranded — the claim still has a current
anchor. Non-active covers all of `superseded | retracted | duplicate`; the
supersession chain (below) tells the two apart in the hint wording.

**Severity: warning, everywhere.** The quote still verifies against the old
source's immutable canonical text, so provenance integrity is intact — it is
*dated*, not broken. Whether the claim still holds against the successor needs
judgment (or the survival probe below). Warnings keep `answer-check` `ok:true`
(the reporter asked for a warn, not a fail) while `verify --strict` fails —
exactly the split the two halves of #1 request.

Registry changes (append-only, charter `registry-additive`):

- `ISSUE_CODES` += `PROVENANCE_SOURCE_INACTIVE` (citations group).
- `HINTS` entry: `The claim's supporting quotes anchor only to non-active
  sources. Check the lineage with kb provenance <claim_id> --json; confirm the
  quote survives in the active successor, or re-extract the claim from it.`

### 1.1 Successor resolution + quote-survival probe

The eval agent judged its stale citation "sound — but that's luck" by manually
checking that the quoted line survives verbatim in the re-ingested source. Make
that check the CLI's job:

- `SourceRepo.supersederOf(id)` — `SELECT * FROM sources WHERE
  supersedes_source_id = ?`, newest by `(ingested_at, id)` if several.
- `SourceRepo.activeSuccessorOf(id)` — follow superseder edges (cycle-guarded)
  to the first `active` source; `undefined` when the chain dies out.
- Survival probe: the stranded span's `quote` occurs verbatim in the successor's
  canonical text (`source_texts`), via the existing quote machinery. Uniqueness
  is NOT required — this is an advisory currency signal, not span verification.

### 1.2 answer-check

- `AnswerCheckResult` gains
  `staleSourceCitations: Array<{ claimId, sourceIds, successorId, quoteSurvives }>`
  — one row per stranded cited claim, first-occurrence order. `successorId` is
  the active successor (or `null`); `quoteSurvives` is true iff EVERY stranded
  supporting quote survives in its successor (`null` when there is no successor).
  `ok` and the existing arrays are unchanged; envelope `ok` still equals
  `report.ok` because the new issues are warnings.
- `answerCheckIssues` appends one warning-severity `PROVENANCE_SOURCE_INACTIVE`
  issue per row, after the three error blocks, with a DYNAMIC hint (the existing
  `DomainIssue.hint` override mechanism) naming ids so it stays executable:
  - survives: `clm_x's quotes anchor to superseded src_a but survive verbatim in
    active successor src_b — usable; re-anchor or re-extract on the next ingest
    pass.`
  - does not survive / no successor: `clm_x's quote does not appear in src_b, the
    active successor of src_a — the claim may be outdated; verify before citing,
    or hand re-extraction to the kb-ingest skill.`

### 1.3 verify

- `VERIFY_CHECKS` += `claim-source-current`; `VERIFY_CHECK_CODES` maps it to
  `PROVENANCE_SOURCE_INACTIVE` (the `Record` type makes the map total at compile
  time; the existing totality test covers the finding path).
- Implementation: for every `active` claim with ≥1 supporting span (mirroring
  `claim-has-provenance`'s scope), collect the stranded ones; emit ONE
  warning-severity finding with `ids` = the claim ids, like the other aggregated
  checks. Plain `verify` stays green; `verify --strict` fails until the stranded
  claims are re-anchored, re-extracted, or superseded/retracted.

### 1.4 ingest steering — close the loop at the moment it opens

A `--supersedes` ingest is the only event that creates stranded claims, so say so
in that receipt rather than waiting for the next `verify`:

- The ingest handler counts claims stranded on the just-superseded source (its
  distinct claim set minus those with another active anchor) and passes it to
  steering state.
- New `STEERING_TABLE` row (`ingest`, ok, count > 0), hint (placeholder-free
  parts only, charter `verbatim-next-actions` — the count and ids are concrete):
  `N claim(s) are now anchored only to the superseded source — re-extract from
  kb source chunks <newSourceId> --json; kb verify --strict --json lists them.`
  Emitted as a hint (it embeds two commands), registry-filtered as usual.

### 1.5 skills

- kb-query recovery table gains the row:
  `PROVENANCE_SOURCE_INACTIVE` → *warning, not a failure. Read the hint: if the
  quote survives in the active successor the citation is usable — disclose the
  dated anchor in the Sources block; if not, verify against the successor before
  presenting or drop the assertion.*
- Add the code to `REQUIRED_CODES` in `skills-drift.test.ts` so all three skills
  carry the row (supersession is created by kb-ingest and consumed by kb-query).

## 2. `sourceStatus` in every span projection (#2)

Every payload that projects a span gains the pair
`sourceStatus` (always present) and `supersededBy` (active successor id, `null`
when the source is active or the chain has no active head):

- `ask-context` provenance entries (`enrichClaim`).
- `kb provenance` span rows.
- `node show --context` provenance snippets (`nodeContext.ts` — it already
  carries `sourceId`/`sourceTitle`).

Help-spec `output` lines for the three commands update in the same change (the
spec drift tests force this). This closes #2 the right way around: the CLI is
the source of truth, and the "generated markdown is read-only" rule needs no
exception — the agent never has to read `kb/index.md` to learn a source's
status. One working-rules line in kb-query points at the field:
`provenance entries carry sourceStatus — non-active anchoring follows the
PROVENANCE_SOURCE_INACTIVE recovery row.`

## 3. Name the provenance payload key in the skill (#3)

The output *shape* is already documented in `kb provenance --help --json`; the
eval agent guessed `data.spans` because the skill never says where the array
lives. Two one-line fixes, no schema copied into the skill (the drift guard's
whole point):

- kb-query §5 (apply) gains: `kb provenance --json returns the claim under
  data.claim and the spans under data.provenance (not data.spans); the field
  list comes from kb provenance --help --json.`
- `skills-drift.test.ts` pins the literal token `data.provenance` in kb-query
  (same mechanism as the pinned stage names), so a future rename of the payload
  key must touch the skill in the same change.

## 4. Stop teaching the redundant `claim_ids` array (#4)

The engine already derives citations from the answer text and treats `claim_ids`
as an optional out-of-band supplement — the friction is that the help example
shows it populated, teaching agents to hand-maintain a duplicate list that can
drift from the text. Documentation-only fix:

- `answer-check` help `input.example` becomes
  `{ answer: 'The service is written in Rust [^clm_1a2b3c].' }` (no
  `claim_ids`; the spec test that parses the example against `AnswerCheckSchema`
  stays green because the field is optional).
- `input.notes` (the existing verbatim-notes slot) gains: `claim_ids is optional
  and normally omitted — citations are parsed from the answer text. Supply it
  only to validate ids that do not appear in the text.`
- kb-query §4 (preview) gains one line: `The payload needs only { answer } —
  citations are parsed from the text; claim_ids exists for out-of-band ids
  only.`

No engine change; the union semantics stay for back-compat (charter
`compat-aliases` spirit: never break a caller that still sends the array).

## 5. `KB_DIR` as the preflight, not a workaround (#5)

The CLI already has the right resolution order (`--kb` > `KB_DIR` > walk-up) and
the right guard (`KB_PATH_SUSPECT`). The friction is that the skill frames the
export as an either/or working rule, so agents default to repeating `--kb`.

- kb-query preflight becomes (mirrored in kb-create / kb-ingest):

  ```
  export KB_DIR=/abs/path/to/kb   # once, absolute; all later commands omit --kb
  kb version --json
  kb status --json
  ```

- The working-rules line rewords from "Export an absolute `KB_DIR` or pass
  `--kb`" to "First action: export an absolute `KB_DIR`; never pass `--kb`
  again in the session."
- Additive CLI nicety: `kb status` gains `resolvedVia: 'flag' | 'env' | 'walk-up'`
  beside `root`, so a wrong-KB mistake is visible in preflight instead of
  surfacing later as empty retrievals.
- Rejected: a persisted default-KB pointer file or config. The CLI is
  deliberately stateless; the env var already scopes the setting to exactly the
  session that wants it, and persistent state would make two concurrent KBs (the
  eval harness case) ambiguous.

## Acceptance

- Red-first tests, then green (project methodology):
  - `query.test`: stranded citation → warning issue + `staleSourceCitations` row
    with `ok:true`; mixed provenance → no warning; `quoteSurvives` true/false/
    `null` (no successor) paths; supersession chain A→B→C resolves to the active
    head.
  - `verify.test`: `claim-source-current` finding appears after a simulated
    supersede; plain `verify` ok, `--strict` fails; check→code totality already
    enforced.
  - `ask-context` / `provenance` / `node-context` tests: `sourceStatus` +
    `supersededBy` present and correct for active and superseded sources.
  - steering test: `--supersedes` ingest receipt carries the stranded-claims
    hint; a plain ingest does not.
  - `spec.test`: new example parses; notes render.
  - `skills-drift.test`: new `REQUIRED_CODES` entry and the pinned
    `data.provenance` token.
- No schema migration: everything derives from existing tables
  (`sources.status`, `supersedes_source_id`, `source_texts`).
- `pnpm test`, `pnpm typecheck`, `scripts/gen-command-docs.mjs` regenerated.

## Explicitly out of scope

- Semantic entailment in `answer-check` (unchanged honest scope, DESIGN.md §9).
- Automatic span re-anchoring / migration commands. Recovery stays
  agent-proposed via the existing write path (`claim apply` with a span quoting
  the successor, or re-extraction through kb-ingest) — the CLI reports currency,
  it does not rewrite provenance.
- Fuzzy quote matching in the survival probe (verbatim only; normalization would
  reintroduce the anti-hallucination risk quote verification exists to prevent).
