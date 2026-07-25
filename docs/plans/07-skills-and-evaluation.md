# Skills and Evaluation

Goal: rewrite the three skills (`.claude/skills/kb-create/SKILL.md`,
`.claude/skills/kb-ingest/SKILL.md`, `.claude/skills/kb-query/SKILL.md`) as thin,
resumable orchestrators over the improved CLI, and evaluate old vs. revised on one
shared fixture. Skills ship incrementally per phase; this document specifies the
end state and the evaluation. Revised per Codex findings 41–42 (and 16/17 wording).

Est. ~1–2 days (after Phase 4).

## 1. Shared skill skeleton

```
preflight → discover → preview → apply → resume → finish
```

| Stage | What | Commands |
|---|---|---|
| preflight | Confirm tool + KB identity before any mutation | `kb version --json`, `kb status --json` |
| discover | Contracts from the tool, never from memory | `kb <cmd> --help --json` |
| preview | Dry-run every authored payload; branch on issue `code` | `--dry-run` on exactly: `claim apply`, `graph apply`, `synthesize`, `node apply`, `ingest` (01 §6.2 — the skills use this list, never "everywhere") |
| apply | Apply the unchanged validated payload; consume the receipt | `… --json` |
| resume | Restart from state, not from step 1 | `kb status`, `kb node tree` (stale flags), receipts' `nextActions` |
| finish | Explicit terminal condition | `kb verify --strict --json` → `kb render --json` → `kb render --check --json`; then review `kb coverage --json` |

Shared rules (stated once per skill header):

- **No skill embeds a payload schema.** Shapes come from `kb <cmd> --help --json`
  (`input.example`). Skills keep only judgment examples: claim atomicity, conflict
  handling, quote-extension remediation.
- **Follow `nextActions`** (verbatim-executable); treat `hints` as optional
  guidance.
- **Recovery is keyed by issue `code`:**

| Code | Recovery |
|---|---|
| `QUOTE_AMBIGUOUS` | Reread the chunk (`kb source chunks`), extend the quote with adjacent verbatim text until unique, re-dry-run |
| `QUOTE_NOT_FOUND` | Re-copy the quote verbatim from chunk text — never retype or normalize whitespace |
| `CITATION_OUT_OF_SUBTREE` | Cite only ids from `--context`'s `allowedCitationIds`; move the claim or cite the right node |
| `CITATION_INACTIVE` | Cite the superseding claim named in the hint |
| `NODE_TITLE_MISMATCH` / `NODE_KIND_MISMATCH` | Align the manifest with the existing node or choose a new slug — do not force |
| `UNSUPPORTED_MEDIA` | Follow the recipe in the error verbatim (`--text-from` flow) |
| `INVALID_ARGUMENT` on a repeated original with a new sidecar | Follow the corrected-transcription recipe in the hint (new source + `--supersedes`) |
| `PAYLOAD_SCHEMA` | Fetch `--help --json`, fix the named `path`, re-dry-run |

## 2. Per-skill changes

### kb-create

- Drop "read the kb-ingest skill first"; state the three invariants locally (exact
  quotes; one root; bottom-up synthesis) and defer the rest to command help.
- Bootstrap: `kb init` → author `hierarchy.json` → `kb node apply --dry-run` →
  apply → use the `ref → nodeId` receipt map for claim payloads.
- Batch workflow (normative order): ingest all sources oldest-first → per source:
  claims (dry-run, apply) then graph → for each stale node deepest-first:
  `kb node show <id> --context --json` → author batch synthesis payloads →
  `kb synthesize --file … --dry-run` → apply → finish stage.
- Definition of done: `verify --strict` ok **and** `render --check` clean **and**
  every coverage finding either actioned or consciously accepted in the report to
  the user.

### kb-ingest

- Source-format decision table (mirrors 06 §1.3): native text | binary +
  `--text-from` sidecar | remote faithful export. Binaries: transcribe faithfully,
  `--verification visual`, keep the sidecar next to the original.
- Corrected transcription: the 06 §1.4 recipe verbatim (new source that
  `--supersedes` the derived source — canonical text is immutable).
- Remote-source recipe (Slack/Jira/Confluence) in a short reference section: one
  first-class source per page/issue/thread when claims will cite it;
  `--origin-system/--origin-id/--origin-url` always set; transcription preserves
  message ids, timestamps, thread structure, and states pagination/visibility
  limits in the source text itself (so the limitation is quotable).
- Conflict flow: apply new claim → `kb claim supersede old --by new` or
  `kb claim conflict a b` → follow `nextActions` to re-synthesis.
- Every authored payload is dry-run before apply — non-negotiable.

### kb-query

- Retrieval sequence: `kb ask-context "<question>" --json` → thin results: retry
  with `--claim-type`/`--node`, or `kb search … --match any` → zero results ⇒ say
  the KB does not cover it (never fabricate).
- Interpret `matchModes`: `any-fallback` = weaker evidence (all-terms matched
  nothing); `--match all` for strict verification of term presence.
- Answer flow: draft with `[^clm_…]` per assertion → `kb answer-check --file` →
  fix by `code` (`UNCITED_ASSERTION` carries the line number) → present with a
  Sources block (footnote definitions are safe post-Phase 3).
- Standing instruction kept: answer-check is structural; read the quotes to confirm
  each claim actually supports its sentence.

## 3. Evaluation — three stages, one fixture, no platform (finding 41)

**Pinning:** the current skill texts are copied verbatim to
`fixtures/eval/skills-v0/{kb-create,kb-ingest,kb-query}.md` in the Phase 0 commit —
immutable baselines (no reliance on a git tag that does not exist).

**Seeding:** every stage starts from a **script-built seed**, identical for both
variants — never the other variant's prior output:

- Stage 1 seed: empty directory.
- Stage 2 seed: `scripts/build-fixture.ts` output (the deterministic fixture KB).
- Stage 3 seed: the same fixture KB **plus** the stage-2 memo applied by script
  (so stage 3 does not depend on any agent run).

| Stage | Skill | Prompt (verbatim, `fixtures/eval/prompts/`) | Terminal check |
|---|---|---|---|
| 1 | kb-create | "Build a knowledge base at ./eval-kb from the four documents in fixtures/corpus/sources, organized by topic." | `verify --strict` ok + `render --check` clean |
| 2 | kb-ingest | "Ingest fixtures/eval/sources/update-memo.md into ./eval-kb." (memo: one conflicting claim + one ambiguous-quote trap) | conflict recorded (supersede or conflict), staleness cleared, `verify --strict` ok |
| 3 | kb-query | "Answer from ./eval-kb: what open questions remain about rate limiting?" | `answer-check` ok **and** the planted open-question claim cited |

**Recording** (`fixtures/eval/RESULTS.md`, template checked in): header pins model
id, settings, date, CLI version; per run: CLI/tool-call count (count of `kb `
invocations in the transcript), payload validation retries (= failed `apply` +
failed `--dry-run` invocations), terminal check pass/fail.

**Scoring rules** (finding 41 — success first, efficiency second):

1. **Correctness gate:** all three revised-skill stages pass their terminal checks.
2. **Efficiency comparison only between passing runs:** if the old skill fails a
   stage, the revised pass wins outright — no count comparison. Where both pass,
   revised command count and retries must not exceed old by more than 20 %
   (regressions beyond that are investigated and fixed or explained in
   RESULTS.md).
3. **What the gate blocks:** removing the "skill in active development" note and
   declaring the skill rewrite done. It does not block shipping CLI phases.

Tokens/wall-time may be noted; they are not gates. Retrieval recall is measured by
the Phase 3 fixture test, not here.

## 4. Documentation sync (finding 42)

- **Generator:** `scripts/gen-command-docs.mjs` shells out to the CLI
  (`./bin/kb <command> --help --json` for every command listed by
  `./bin/kb --help --json`) — no TypeScript imports from an .mjs script; the CLI
  is the contract source. It rewrites the block between
  `<!-- generated:commands:start -->` / `<!-- generated:commands:end -->` markers
  in `docs/USER_GUIDE.md` (idempotent; running twice is a no-op).
- `docs/index.html` is regenerated afterwards via the existing
  `pnpm docs:html` (`scripts/build-docs.mjs`), same commit.
- `README.md` quickstart: `kb version` preflight + `--help --json` discovery.
- Drift guard: a test greps the three skill files for embedded payload-schema
  blocks (JSON bodies containing `"claims"` / `"relationships"` / `"nodes"` keys) —
  allowed only under `fixtures/`.

## Acceptance

- Three skills rewritten per §1–§2; drift-guard test green.
- `fixtures/eval/skills-v0/` pinned; seeds script-built; eval executed;
  `RESULTS.md` complete per §3; gate outcome recorded (met, or misses explained
  with the specific stage evidence — the "active development" note stays until
  met).
- `USER_GUIDE.md` regenerated between markers; `docs/index.html` rebuilt; README
  updated.
