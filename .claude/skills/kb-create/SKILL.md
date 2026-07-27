---
name: kb-create
description: Create a new kb-ingest knowledge base from a set of source documents (a corpus). Use when the user says "build a knowledge base from these docs", "create a KB", "ingest this folder into a new knowledge base", or provides multiple sources to organize. Bootstraps the SQLite-backed KB and its synthesis hierarchy.
---

<note>Skill in active development: after use, surface friction, bugs, design issues, and suggested improvements.</note>

# Create a knowledge base from a corpus

Build a new knowledge base from a set of source documents, with strict provenance and a
hierarchical synthesis. **SQLite (`kb.sqlite`) is the source of truth; the markdown under
`kb/` is a read-only render.** You change the KB only through `kb` commands — never by
editing files under `kb/` or `sources/`.

## Three invariants

The CLI enforces these; knowing them keeps you from fighting it.

1. **Exact quotes.** Every claim cites a chunk id plus a quote that is a verbatim,
   unique substring of that chunk. Paraphrases are rejected before anything persists.
2. **One root.** A KB has exactly one `root` node; every other node hangs under it as
   `topic` or `leaf`. A claim is owned by exactly one node.
3. **Bottom-up synthesis.** Applying claims marks the owning node and its ancestors
   stale. Write prose deepest-first: leaves from their own claims, parents from their
   subtree.

## Working rules

- Pass `--json` to every command and parse the envelope:
  `{ ok, data, issues, errors, warnings, nextActions, hints }`.
- `ok:false` ⇒ read `issues[].code` and recover from the table below. Never retry blind.
- **Run `nextActions[].command` verbatim** — those are executable as printed. `hints` are
  advice, not commands.
- **Never write a payload from memory.** Get the shape from `kb <cmd> --help --json`
  (`data.input.example`) right before you author it.
- Export an **absolute** `KB_DIR` (`export KB_DIR="$(pwd)/<kb-dir>"`) or pass
  `--kb <absolute-dir>`; a bare relative value is rebased by any later `cd`.
- Commands are written as `kb …` — the globally installed CLI. Inside a clone of the
  repo, use `./bin/kb …` instead; the preflight `kb version --json` tells you which one
  you are running.
- `--dry-run` exists on exactly five commands: `ingest`, `node apply`, `claim apply`,
  `graph apply`, `synthesize`. No other command accepts it.

## Stages

```
preflight → discover → preview → apply → resume → finish
```

| Stage | What | Commands |
|---|---|---|
| preflight | Confirm the tool and the KB identity before any mutation | `kb version --json`, `kb status --json` |
| discover | Get contracts from the tool, never from memory | `kb <cmd> --help --json` |
| preview | Dry-run every authored payload; branch on the issue `code` | `--dry-run` on the five commands above |
| apply | Apply the **unchanged** validated payload; consume the receipt | `… --json` |
| resume | Restart from state, not from step 1 | `kb status --json`, `kb node tree --json` (stale flags), receipts' `nextActions` |
| finish | Explicit terminal condition | `kb verify --strict --json` → `kb render --json` → `kb render --check --json`; then review `kb coverage --json` |

## Recovery by issue code

| Code | Recovery |
|---|---|
| `QUOTE_AMBIGUOUS` | Reread the chunk (`kb source chunks <source_id> --json`), extend the quote with adjacent verbatim text until it is unique, re-dry-run |
| `QUOTE_NOT_FOUND` | Re-copy the quote verbatim from the chunk text — never retype it or normalize whitespace |
| `CITATION_OUT_OF_SUBTREE` | Cite only ids from that node's `--context` `allowedCitationIds`; move the claim or cite the right node |
| `CITATION_INACTIVE` | Cite the superseding claim named in the hint |
| `PROVENANCE_SOURCE_INACTIVE` | Claims anchored only to a non-active source — appears after a `--supersedes` ingest; re-extract from the active successor (see the **kb-ingest** skill) |
| `NODE_TITLE_MISMATCH` / `NODE_KIND_MISMATCH` | Align the manifest with the existing node, or choose a new slug — do not force |
| `UNSUPPORTED_MEDIA` | Follow the recipe in the error verbatim (the `--text-from` flow; see the **kb-ingest** skill) |
| `INVALID_ARGUMENT` on a repeated original with a new sidecar | Follow the corrected-transcription recipe in the hint (new source + `--supersedes`) |
| `PAYLOAD_SCHEMA` | Fetch `kb <cmd> --help --json`, fix the field named by the issue `path`, re-dry-run |
| `MULTIPLE_ROOTS` / `ROOT_HAS_PARENT` | One root per KB, and it has no parent — reuse the existing root |
| `DUPLICATE_REF` / `DUPLICATE_SLUG` | Two manifest entries collide; rename the ref or give one a distinct slug |

## Procedure

### 1. preflight

```
export KB_DIR="$(pwd)/<kb-dir>"   # once, absolute; all later commands omit --kb
kb version --json
kb init "$KB_DIR" --json
kb status --json
```

`kb init` creates `kb.sqlite`, `sources/`, `kb/`, and the `AGENTS.md`/`CLAUDE.md`
scaffold; it is idempotent, so it is also the safe way to reopen an existing KB.
`kb status` tells you whether you are starting empty or resuming.

### 2. discover

Skim the corpus (filenames, titles, headings) to decide the shape: one `root` for the
KB's scope, `topic` nodes for major areas, `leaf` nodes for focused subtopics. Keep the
tree shallow at first — splitting a leaf later is cheap. Then fetch the contracts you
are about to use:

```
kb node apply --help --json
kb claim apply --help --json
kb synthesize --help --json
```

### 3. Bootstrap the hierarchy with `node apply`

Author the whole tree as **one manifest** and apply it once — not one `kb node create`
per node. Each entry carries a `ref` you choose; the receipt maps every `ref` to its
`nodeId`.

```
kb node apply --file ./hierarchy.json --dry-run --json
kb node apply --file ./hierarchy.json --json
```

The receipt's `nodes[]` is your **ref → nodeId map** (`{ ref, nodeId, outcome }`) plus
`totals` and `staleNodes`. Keep that map: it is where the node ids in your claim
payloads come from, so you never have to re-read the tree to write them. `node apply`
is idempotent per node — re-running with the same manifest reports `existing`, and a
title or kind that disagrees with an existing node fails with `NODE_TITLE_MISMATCH` /
`NODE_KIND_MISMATCH` rather than silently overwriting.

`kb node create` still exists for adding a single node mid-run when one source turns
out to need an area the manifest missed.

### 4. Batch workflow (normative order)

1. **Ingest every source, oldest-first** (by `--source-date`), so a later source can
   cleanly supersede an earlier one. `ingest` is one of the five preview commands —
   dry-run it, read the receipt, then apply the same command without `--dry-run`:
   ```
   kb ingest <path> --title "<T>" --source-date YYYY-MM-DD --dry-run --json
   kb ingest <path> --title "<T>" --source-date YYYY-MM-DD --json
   ```
   The dry-run is where you find out the file is a binary that needs a transcription
   sidecar (`UNSUPPORTED_MEDIA`) — before anything is stored. A source that needs one is
   ingested the same way, with the sidecar flags on both commands:
   ```
   kb ingest <original> --text-from <extracted.md> --verification visual --dry-run --json
   kb ingest <original> --text-from <extracted.md> --verification visual --json
   ```
   See the **kb-ingest** skill's format decision table for which files need this.
2. **Per source, in that same order.** Read the chunks, author each payload, dry-run it,
   then apply the **unchanged** file:
   ```
   kb source chunks <source_id> --json
   kb claim apply --file ./claims.json --dry-run --json
   kb claim apply --file ./claims.json --json
   kb graph apply --file ./graph.json --dry-run --json
   kb graph apply --file ./graph.json --json
   ```
   Copy quotes from the chunk text and nothing else; take node ids from the ref map. Do
   not strip version numbers from entity names ("React 18" ≠ "React").
   If a new claim contradicts an existing one, apply the new claim first, then
   `kb claim supersede <old_claim_id> --by <new_claim_id> --json`; if the sources
   genuinely disagree with no winner, `kb claim conflict <claim_id_a> <claim_id_b> --json`.
3. **Synthesize, deepest-first over the stale set.** For each stale node:
   `kb node show <node_id> --context --json` returns everything one synthesize write
   needs — the node's own body, children with their citable claims, the whole subtree's
   claims with provenance snippets, the contributing sources, and `allowedCitationIds`.
   Author the prose from that one payload; put an inline `[^clm_…]` citation after every
   assertion. Never write footnote definitions or child links — the renderer generates
   both.
4. **Batch the synthesis writes.** `kb synthesize` accepts a batch of node payloads
   (up to 200) applied deepest-first in one transaction. Dry-run the batch, then apply
   the unchanged file:
   ```
   kb synthesize --file ./batch.json --dry-run --json
   kb synthesize --file ./batch.json --json
   ```
   The receipt's `staleNodes` is what is still left — loop until it is empty.

### 5. resume

If you are interrupted, do **not** start over. Rebuild state from the KB:

```
kb status --json          # what exists
kb source list --json     # which sources are already ingested (and their claim counts)
kb node tree --json       # the hierarchy, with isStale per node
kb verify --json          # what is failing right now
```

Re-ingesting identical bytes is a no-op, and an exact-repeat `claim apply` /
`graph apply` reports `unchanged` and writes nothing — so replaying a step you are
unsure about is safe.

### 6. finish — definition of done

```
kb verify --strict --json      # must be ok:true
kb render --json               # regenerate kb/*.md
kb render --check --json       # must report no drift
kb coverage --json             # descriptive, not a gate
```

You are done only when **all three** hold:

- `verify --strict` is `ok:true`,
- `render --check` reports no drift,
- **every `kb coverage` finding is either actioned or consciously accepted in your
  report to the user.** Coverage is descriptive — `SOURCE_NO_CLAIMS`,
  `CHUNK_UNCITED`, `CLAIM_NOT_SYNTHESIZED`, `NODE_SINGLE_SOURCE`,
  `OPEN_QUESTION_NOT_SYNTHESIZED`. Each `summary` entry states `total` vs `shown`, so
  say the real totals; ids are capped at 20 and nothing is silently truncated.

Then report: sources ingested, the node hierarchy, claim/entity/relationship counts,
conflicts recorded, the coverage findings you accepted and why, and where to read it
(`<kb-dir>/kb/index.md`).

## Judgment (the part the CLI cannot do)

- **Claim atomicity.** One assertion per claim. "The limiter uses a token bucket that
  refills at 200 tok/s" is two claims — split it, so each can be superseded on its own.
- **Node granularity.** Prefer fewer, well-scoped nodes. Split a leaf only once it
  genuinely covers several distinct subtopics.
- **Conflicts.** A newer source that restates an older fact with a different value is a
  supersession. Two sources that disagree with no clear winner are a conflict — record
  both, do not average them.
- **The root synthesis is the reader's entry point.** Make it a crisp, cited overview;
  do not duplicate the generated subtopic list.
