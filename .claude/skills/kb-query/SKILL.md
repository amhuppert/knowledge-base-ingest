---
name: kb-query
description: Answer a question from a kb-ingest knowledge base with source-cited provenance. Use when the user asks a question that the knowledge base should answer, or says "what does the KB say about…", "answer from the knowledge base", "look this up in the KB". Retrieves claims with provenance and validates the answer's citations.
---

<note>Skill in active development: after use, surface friction, bugs, design issues, and suggested improvements.</note>

# Answer questions from the knowledge base (with provenance)

Answer using ONLY what the knowledge base actually contains, and cite every assertion
back to a source-backed claim. This skill is read-only: it never mutates the KB.

## Non-negotiables

- **Evidence is a claim.** Build the answer from claims the CLI returned, each of which
  carries a verified source quote. Do not add facts from memory.
- **Cite every assertion** with `[^clm_…]`. If the KB does not support a point, say so.
- **Surface conflicts.** If retrieved claims include `conflicted` ones, present both
  sides rather than picking one silently.
- **Read the quotes.** `answer-check` is a *structural* check — it confirms your
  citations resolve to usable active claims, not that a claim entails your sentence.
  Before presenting, read each cited quote and confirm it actually supports the sentence
  it is attached to.

## Working rules

- Pass `--json` to every command and parse the envelope:
  `{ ok, data, issues, errors, warnings, nextActions, hints }`.
- `ok:false` ⇒ read `issues[].code` and recover from the table below. Never retry blind.
- **Run `nextActions[].command` verbatim** — those are executable as printed. `hints` are
  advice, not commands.
- **Never write a payload from memory.** Get the shape from `kb answer-check --help --json`
  (`data.input.example`) right before you author it.
- **First action: export an absolute `KB_DIR`** (`export KB_DIR=/abs/path/to/kb`), then
  never pass `--kb` again in the session. A bare relative value is rebased by any later
  `cd`; `kb status` echoes `resolvedVia` (`flag | env | walk-up`) so preflight confirms
  which resolution actually ran.
- Provenance entries carry `sourceStatus` and `supersededBy` — a non-active anchor is
  handled by the `PROVENANCE_SOURCE_INACTIVE` recovery row, never by reading `kb/index.md`.
- Commands are written as `kb …` — the globally installed CLI. Inside a clone of the
  repo, use `./bin/kb …` instead; the preflight `kb version --json` tells you which one
  you are running.
- `--dry-run` exists on exactly five commands: `ingest`, `node apply`, `claim apply`,
  `graph apply`, `synthesize` — none of them is used here, because answering writes
  nothing.

## Stages

```
preflight → discover → preview → apply → resume → finish
```

| Stage | What | Commands |
|---|---|---|
| preflight | Confirm the tool and the KB identity before answering | `kb version --json`, `kb status --json` |
| discover | Retrieve evidence; get contracts from the tool, never from memory | `kb ask-context … --json`, `kb search … --json`, `kb <cmd> --help --json` |
| preview | Validate the drafted answer structurally before anyone sees it | `kb answer-check --file ./answer.json --json` |
| apply | Present the checked answer with a Sources block | `kb provenance <claim_id> --json` for anything you still need to trace |
| resume | Restart from state, not from step 1 — the KB has not changed | `kb status --json`, `kb node tree --json` |
| finish | Explicit terminal condition | `answer-check` is `ok:true` **and** you have read every cited quote |

## Recovery by issue code

| Code | Recovery |
|---|---|
| `UNCITED_ASSERTION` | The issue carries the offending sentence **and its line number** — add a `[^clm_…]` citation to that line, or soften the sentence so it no longer asserts a fact. A **lead-in that introduces a cited list still counts as an assertion** ("Four open questions remain about rate limiting." → flagged, even with every list item cited below it). Either cite the same claims on the lead-in, or keep it under five words (`Open questions:`) |
| `CITATION_UNKNOWN` | The cited id does not exist; find the real one with `kb search <text> --scope claims --json` or `kb node show <node_id> --json` |
| `CITATION_INACTIVE` | The claim is superseded or retracted — cite the superseding claim named in the hint (`kb provenance <claim_id> --json` shows the lineage) |
| `PROVENANCE_SOURCE_INACTIVE` | **Warning, not a failure**: the citation's quotes anchor only to a non-active source. Read the hint — if the quote survives in the active successor, the citation is usable; disclose the dated anchor in the Sources block. If it does not survive, verify against the successor (`kb provenance <claim_id> --json` shows `sourceStatus`/`supersededBy`) or drop the assertion |
| `CITATION_OUT_OF_SUBTREE` | Cite only ids from that node's `--context` `allowedCitationIds`; move the claim or cite the right node |
| `PAYLOAD_SCHEMA` | Fetch `kb answer-check --help --json`, fix the field named by the issue `path`, re-check |
| `QUOTE_AMBIGUOUS` / `QUOTE_NOT_FOUND` | Quote failures come from *writing* claims, not answering — hand them to the **kb-ingest** skill |
| `NODE_TITLE_MISMATCH` / `NODE_KIND_MISMATCH` / `UNSUPPORTED_MEDIA` | Structure and ingest failures — likewise the **kb-create** / **kb-ingest** skills |
| `INVALID_ARGUMENT` on a repeated original with a new sidecar | Canonical text is immutable; follow the corrected-transcription recipe in the hint (a new source that `--supersedes` the old one). Answering never triggers this — hand it to the **kb-ingest** skill |
| `NO_KB` | No knowledge base at the resolved path; run `kb status --json` with an absolute `--kb <dir>` |

## Procedure

### 1. preflight

```
export KB_DIR=/abs/path/to/kb   # once, absolute; all later commands omit --kb
kb version --json
kb status --json
```

`status` tells you whether the KB has anything to answer from (claim and node counts),
which root you are pointed at, and `resolvedVia` — how that root was resolved
(`flag | env | walk-up`), so a wrong-KB mistake surfaces here, not as empty retrievals.

### 2. discover — the retrieval sequence

Work down this ladder; stop as soon as you have enough evidence.

1. **Start with `ask-context`.** It is the retrieval command: it returns claims *with
   provenance* (source title + exact quote), plus related nodes and entities.
   ```
   kb ask-context "<the user's question>" --json
   ```
2. **Thin or off-target results ⇒ narrow, do not guess.** `ask-context` takes
   `--limit <n>` (how many claims come back), `--claim-type <type>`
   (`fact`, `definition`, `decision`, `requirement`, `constraint`, `procedure`,
   `warning`, `example`, `open_question`), and `--node <node_id>` (restrict to one
   part of the tree). The receipt echoes the filters back as `applied`, so you can see
   what actually ran.
   ```
   kb ask-context "<question>" --claim-type open_question --json
   kb ask-context "<question>" --node <node_id> --limit 30 --json
   ```
3. **Still thin ⇒ broaden with `search`.** `search` covers more surface than
   `ask-context`: `--scope chunks|claims|nodes|entities|all`, `--match auto|all|any|phrase`,
   `--limit <n>`. Loosening the match is the usual fix:
   ```
   kb search <terms> --match any --json
   kb search <terms> --scope claims --json
   ```
4. **Asking for a *category* of claim ⇒ go through the node, not the terms.** "What open
   questions remain…", "what decisions were made about…", "what constraints apply…" are
   questions about a part of the tree. Term matching will only return the claims that
   happen to share wording with the question, so find the node and read it:
   ```
   kb search <terms> --scope nodes --json
   kb node show <node_id> --json
   ```
   `node show` lists **every** claim that node owns, with its `claimType` and `status` —
   including the ones no synthesis prose mentions. `kb node tree --json` shows the whole
   hierarchy if the search does not land.
5. **Zero results ⇒ say the knowledge base does not cover it.** Do not fabricate, and do
   not answer from your own knowledge. Offer what the KB *does* have nearby if that is
   useful.

### 3. Interpret `matchModes`

`search` reports `matchModes` — the strategy it actually applied, per scope — and each
hit carries its own `matchMode`. Read it before you trust a hit:

| Mode | What it means for your answer |
|---|---|
| `all` | Every term matched. Strongest signal. |
| `phrase` | The exact phrase matched. Strongest signal. |
| `any` | You asked for any-term matching; hits may be topically loose. |
| `any-fallback` | **Weaker evidence.** All-terms matching found nothing, so the CLI fell back to any-term. Treat these hits as leads to verify, not as answers. |
| `like` | Substring fallback — weakest; confirm by reading the text. |

To *verify* that a specific term really appears rather than just exploring, re-run with
`--match all`. `rank` is raw BM25 and is comparable only within a scope (and is `null`
for entity hits) — never compare a chunk rank against a claim rank.

### 4. preview — draft, then check

Draft the answer from the retrieved claims, placing the citation of the supporting claim
immediately after each assertion:

`Bucket state is stored in Redis.[^clm_37c84b164ab86154]`

Then validate it before showing it to anyone:

```
kb answer-check --file ./answer.json --json
```

(`kb answer-check --help --json` shows the payload shape.) The payload needs only
`{ answer }` — citations are parsed from the text; `claim_ids` exists for out-of-band
ids only, and hand-maintaining it just lets it drift from the text. The result reports
`citedClaims`, `unknownCitations`, `inactiveCitations`, `staleSourceCitations`, and
`uncited` — each uncited entry carries the sentence `text` **and its `line`**, so fix
the exact line rather than rewriting the answer. Loop until `ok:true`. A
`PROVENANCE_SOURCE_INACTIVE` warning does not block `ok:true` — handle it per the
recovery table before presenting.

### 5. apply — present with provenance

Present the answer, then a **Sources** block mapping each `[^clm_…]` to its source title
and exact quote so the user can trace it. The quotes come from the `ask-context`
provenance you already have; for anything you still need, use:

```
kb provenance <claim_id> --json
```

Its payload is the claim under `data.claim` and the spans under `data.provenance`
(not `data.spans`); the full field list comes from `kb provenance --help --json`.

Before you present it: read each cited quote and confirm it supports the sentence it is
attached to. `answer-check` cannot do this for you.

### 6. resume / finish

Answering changes nothing, so an interrupted run just re-runs the retrieval ladder from
step 2. You are finished when `answer-check` is `ok:true` **and** you have read every
cited quote. If the KB only partly covers the question, say which part it covers and
which it does not.

## Judgment (the part the CLI cannot do)

- **Entailment.** A claim that mentions your topic is not necessarily a claim that
  supports your sentence. If the quote does not say it, do not cite it.
- **Conflicts.** Two conflicting claims are an answer: "the sources disagree — X says …,
  Y says …". Do not silently prefer the newer one.
- **Open questions.** A question the KB records as unresolved (`open_question`) is worth
  surfacing even when the user asked something narrower; it is often the real answer.
- **Scope honesty.** "The knowledge base does not cover this" is a correct, useful
  answer. A fabricated one is not.
