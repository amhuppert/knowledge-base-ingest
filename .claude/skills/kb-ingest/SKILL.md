---
name: kb-ingest
description: Ingest a new source document into a kb-ingest knowledge base and update the synthesis. Use when the user says "ingest this into the knowledge base", "add this source", "update the KB with this document", or points at a file/URL to integrate. Drives the `kb` CLI (SQLite-backed, strict provenance).
---

<note>Skill in active development: after use, surface friction, bugs, design issues, and suggested improvements.</note>

# Ingest a source into the knowledge base

Add one source to an existing KB and bring the synthesis back into a consistent state.
**SQLite (`kb.sqlite`) is the source of truth; the markdown under `kb/` is a read-only
render.** You add knowledge ONLY through `kb` commands — never by editing files under
`kb/` or `sources/`.

## Non-negotiables

- **Every claim quotes the source exactly.** You supply a chunk id plus a quote that is a
  verbatim, unique substring of that chunk; the CLI verifies it against the immutable
  text and rejects paraphrases. Never invent, retype, or reflow a quote.
- **Extract only from the chunk text the CLI gives you.** Not from memory, not from the
  file on disk.
- **Dry-run every authored payload before applying it.** Then apply the *unchanged* file.
- **Re-synthesize what you changed.** Applying claims marks the owning node and its
  ancestors stale.

## Working rules

- Pass `--json` to every command and parse the envelope:
  `{ ok, data, issues, errors, warnings, nextActions, hints }`.
- `ok:false` ⇒ read `issues[].code` and recover from the table below. Never retry blind.
- **Run `nextActions[].command` verbatim** — those are executable as printed. `hints` are
  advice, not commands.
- **Never write a payload from memory.** Get the shape from `kb <cmd> --help --json`
  (`data.input.example`) right before you author it.
- Export an **absolute** `KB_DIR` (`export KB_DIR="$(pwd)/memory-bank/<kb>"`) or pass
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
| `PROVENANCE_SOURCE_INACTIVE` | A `--supersedes` ingest left claims anchored only to the old source — re-extract them from the new source's chunks (the ingest receipt and `kb verify --strict --json` list them), then supersede or retract the outdated claims |
| `NODE_TITLE_MISMATCH` / `NODE_KIND_MISMATCH` | Align the manifest with the existing node, or choose a new slug — do not force |
| `UNSUPPORTED_MEDIA` | Follow the recipe in the error verbatim (the `--text-from` flow, below) |
| `INVALID_ARGUMENT` on a repeated original with a new sidecar | Follow the corrected-transcription recipe in the hint (new source + `--supersedes`) |
| `PAYLOAD_SCHEMA` | Fetch `kb <cmd> --help --json`, fix the field named by the issue `path`, re-dry-run |
| `TEXT_SIDECAR_INVALID` | The `--text-from` file is unreadable or not valid UTF-8; rewrite it as UTF-8 text |
| `UNKNOWN_NODE` | The node id does not exist; list the tree with `kb node tree --json` |

## Source-format decision table

Decide this *before* running `kb ingest`. `kb ingest --help --json` prints the full
extension → media-type map.

| The source is… | Do this |
|---|---|
| Native text (`md`, `txt`, `rst`, `html`, `csv`, `json`, or any extension whose bytes decode as UTF-8) | `kb ingest <path> --json` — no sidecar needed |
| A known binary (`pdf`, `docx`, `pptx`, `xlsx`, `png`, `jpg`, `jpeg`, `gif`, `zip`) or bytes that fail a strict UTF-8 decode | Transcribe it faithfully to a UTF-8 file, then `kb ingest <original> --text-from <extracted.md> --verification visual --json`. Keep the sidecar next to the original. |
| Remote content (Slack thread, Jira issue, Confluence page) | Produce a **faithful export** as a text file, ingest that with `--origin-system/--origin-id/--origin-url` — see the reference section below |

For the sidecar path:

- The **original bytes own source identity** (id + sha256); the sidecar becomes the
  canonical text that quotes are verified against. Ingest the *original*, not the
  transcription.
- Transcribe **faithfully** — this is not summarization. Preserve wording, order, and
  structure; if you could not read part of it, say so in the transcription text itself so
  the gap is quotable.
- `--verification visual` is an explicit statement that you compared the transcription
  against the original. Use `none` (the default) if you did not.
- `--extractor <name>/<integer>` records how the text was produced; it defaults to
  `agent-transcription/1`. Passing `--extractor` or `--verification` without
  `--text-from` is `INVALID_ARGUMENT`.

## Corrected transcription

A source's canonical text is **immutable**, and a source's identity derives solely from
its original bytes — so the same original can never yield a second source, and
`--supersedes` cannot change that. Re-ingesting the same original with a different
sidecar is always rejected (`INVALID_ARGUMENT`), with this exact recovery in the hint:

```
Canonical text for src_<id> is immutable. To publish a corrected transcription:
  kb ingest report.extracted-v2.md --supersedes src_<id> \
     --title "<original title> (corrected transcription)" --json
The corrected transcription file itself becomes a new UTF-8 source (byte-distinct,
so it gets its own identity) that supersedes the derived source record. Re-extract
claims from the new source; staleness will drive re-synthesis.
```

## Remote sources (Slack / Jira / Confluence) — reference

- **One first-class source per page, issue, or thread** whenever claims will cite it. A
  bulk "evidence pack" of many threads in one file stays acceptable for low-stakes
  material, but you cannot cite a pack precisely.
- **Always set the origin flags:** `--origin-system <system>` (e.g. `slack`, `jira`,
  `confluence`), `--origin-id <id>`, `--origin-url <url>`. `kb source show` and
  `kb source list` surface `origin.system` and `origin.url`, and a duplicate re-ingest
  carrying origin flags patch-merges them.
- **The transcription preserves structure:** message ids, timestamps (with timezone),
  author handles, and thread nesting. That is what makes a quote traceable back to the
  live system.
- **State the limits inside the source text**, not just in your report: what page range
  you exported, what was truncated, what you could not see (private channels, restricted
  attachments). A limitation written into the source text is quotable; one you only
  mention in chat is not.

## Procedure

### 1. preflight

```
export KB_DIR="$(pwd)/memory-bank/<kb>"   # once, absolute; all later commands omit --kb
kb version --json
kb status --json
```

### 2. discover

```
kb ingest --help --json
kb claim apply --help --json
kb graph apply --help --json
kb synthesize --help --json
```

### 3. Ingest the source

`ingest` is one of the five preview commands, so it is dry-run first like every other
payload — the preview is where you learn the file needs a sidecar, or that this original
is already in the KB, before anything is stored. Native text:

```
kb ingest <path> --title "<T>" --source-date YYYY-MM-DD --dry-run --json
kb ingest <path> --title "<T>" --source-date YYYY-MM-DD --json
```

A binary or an undecodable file (see the decision table above) — transcribe it first,
then pass the sidecar flags on **both** commands:

```
kb ingest <original> --text-from <extracted.md> --verification visual --dry-run --json
kb ingest <original> --text-from <extracted.md> --verification visual --json
```

Add `--supersedes <old_src_id>` to either form when this document is a newer version of
a source already in the KB (the old one becomes `superseded`). Re-ingesting identical
bytes is a no-op. Note the returned `sourceId`; the receipt also reports `original`
(`mediaType`, `byteSize`, `sha256`) and `text` (`extractor`, `verification`, `textHash`).

### 4. Read the chunks

```
kb source chunks <source_id> --json
```

Each chunk has an `id`, a `headingPath`, and its exact `text`. Copy quotes from that
`text` — character for character, from a single chunk, unique within it.

### 5. Place the claims

```
kb node tree --json
```

Find the node each new fact belongs to (usually a leaf). If the source opens a genuinely
new area, add a node with `kb node create --title "<T>" --kind <topic|leaf> --parent <node_id> --json`,
or several at once with `kb node apply --file ./hierarchy.json --dry-run --json` then
without `--dry-run`.

### 6. preview → apply the claims, then the graph

```
kb claim apply --file ./claims.json --dry-run --json
kb claim apply --file ./claims.json --json
kb graph apply --file ./graph.json --dry-run --json
kb graph apply --file ./graph.json --json
```

Both are atomic: if one quote fails verification, nothing persists — fix that quote and
re-run. The claim receipt gives you one entry per input (`inputIndex`, `claimId`,
`outcome`, span counts) plus `totals` and `staleNodes`; an exact repeat reports
`unchanged` and writes nothing at all, so a replay is safe. For the graph, prefer the
recommended vocabulary (entities: Service, DataStore, Library, Concept, Pattern,
Decision, Config…; relationships: depends_on, stores_in, implements, supersedes,
configured_by, part_of…), and never strip version numbers from names ("React 18" ≠
"React").

### 7. Conflicts and supersession

When the new source contradicts what is already in the KB:

1. Apply the new claim first (you need its id).
2. Find the old claim's id with `kb node show <node_id> --json`.
3. One clear winner ⇒ `kb claim supersede <old_claim_id> --by <new_claim_id> --json`.
4. Genuine disagreement with no winner ⇒ keep both and
   `kb claim conflict <claim_id_a> <claim_id_b> --json`.
5. If the source itself states an unresolved question, model it as a claim of type
   `open_question` instead.

Both commands stale the affected nodes; follow the receipt's `nextActions` back into
synthesis. Conflicted and open-question claims surface in `kb/open-questions.md`.

### 8. Re-synthesize, deepest-first

For each stale node, deepest first:

```
kb node show <node_id> --context --json
kb synthesize --file ./batch.json --dry-run --json
kb synthesize --file ./batch.json --json
```

`--context` returns everything one synthesize write needs — the node, its children with
their citable claims, the whole subtree's claims with provenance snippets, the
contributing sources, and `allowedCitationIds`. Put an inline `[^clm_…]` citation after
every assertion, citing only ids from that list. Never write footnote definitions or
child links; the renderer generates both. `synthesize` takes a batch of node payloads
applied deepest-first in one transaction — use it, and loop until the receipt's
`staleNodes` is empty.

### 9. resume

Interrupted? Rebuild state instead of restarting:

```
kb status --json
kb source list --json     # is this source already ingested? how many claims does it have?
kb node tree --json       # which nodes are still stale
kb verify --json          # what is failing right now
```

### 10. finish

```
kb verify --strict --json      # must be ok:true
kb render --json
kb render --check --json       # must report no drift
kb coverage --json             # review; action or consciously accept each finding
```

Then report: the source added (id, title, chunk count), claims/entities/relationships
created, conflicts recorded, nodes re-synthesized, the `verify` result, and any coverage
finding you chose to accept and why.

## Judgment (the part the CLI cannot do)

- **Claim atomicity.** One assertion per claim, so each can be superseded on its own.
- **Supersession vs. conflict.** A newer source restating an old fact with a new value is
  a supersession. Two sources that disagree with no clear winner are a conflict — record
  both; never average them.
- **Quote extension.** When a quote is ambiguous, extend it with the *adjacent verbatim
  text* until it is unique. Do not paraphrase it into uniqueness, and do not switch to a
  different chunk that says something weaker.
