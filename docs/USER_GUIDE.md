# User Guide

How to build, maintain, and query a knowledge base with `knowledge-base-ingest`. For how the
system works internally, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. What this is

A tool for turning source documents (technical docs, design notes, transcripts, PRDs, READMEs)
into a **queryable, provenance-tracked knowledge base** that an AI agent (Claude Code) can keep
up to date and answer questions from — with every answer traceable to an exact quote in an
immutable source.

Two audiences use it:
- **You (human):** read the generated markdown in `kb/`, run the agent, ask questions.
- **The agent (Claude Code):** drives the `kb` CLI via three skills to ingest sources, extract
  knowledge, and answer with citations.

You normally **don't run the low-level commands by hand** — you ask Claude Code to "build a
knowledge base from these docs" or "what does the KB say about X," and the skills do the rest.
This guide documents both the agent flow and the raw CLI.

---

## 2. Core concepts

| Term | What it is |
|---|---|
| **Source** | An original document, stored verbatim and immutably under `sources/`, content-addressed by hash. Never edited. |
| **Canonical text** | The decoded, normalized text of a source (BOM stripped, CRLF→LF, NFC) that all quotes address. |
| **Chunk** | A deterministic, heading-aware slice of a source. The unit you search and quote from. |
| **Claim** | One atomic assertion (a normalized sentence) owned by a node, backed by ≥1 source quote. The knowledge atom. |
| **Span** | An exact `[start,end)` quote from a source — the atomic unit of provenance. |
| **Node** | A document in the synthesis tree (`root` / `topic` / `leaf`). Leaves own claims; parents synthesize children. |
| **Entity / Relationship** | The knowledge graph: typed things (Service, Library, Concept…) and typed links (depends_on, stores_in…), each with provenance. |
| **Synthesis** | A node's human-readable prose, with inline `[^clm_…]` citations that render to source-quote footnotes. |
| **Stale** | A node whose inputs changed since it was last synthesized; it needs rewriting. |

**Mental model:** `kb.sqlite` is the truth. The markdown under `kb/` is a *printout* of it —
read it, don't edit it (run `kb render` to regenerate). Knowledge changes only through `kb`
commands, which validate everything (especially that quotes are real) before saving.

---

## 3. Install & setup

```bash
pnpm install          # builds the native better-sqlite3 module
pnpm test             # optional: 94 tests should pass
```

The CLI runs without a build step via `./bin/kb` (it uses `tsx`). Point it at a knowledge base
in one of three ways (checked in this order):

1. `--kb <dir>` on any command
2. `export KB_DIR=<dir>`
3. the nearest `kb.sqlite` in or above the current directory

A knowledge base is just a directory:

```
<kb-root>/
  kb.sqlite          # the source of truth
  sources/           # immutable source copies (read-only)
  kb/                # GENERATED markdown — your reading view (read-only)
    index.md  changelog.md  open-questions.md
    synthesis/…      # the hierarchy
    graph/entities.md  graph/relationships.md
  AGENTS.md  CLAUDE.md   # operating rules (autoloaded by Claude Code)
```

---

## 4. The fast path: let the agent do it

Ask Claude Code in natural language. The three skills in `.claude/skills/` trigger automatically:

| You say… | Skill | What happens |
|---|---|---|
| "Build a knowledge base from the docs in `./design-notes`" | **kb-create** | inits a KB, designs a hierarchy, ingests every doc, synthesizes, verifies, renders |
| "Ingest this new spec into the knowledge base" | **kb-ingest** | adds one source, extracts quote-backed claims + graph, resolves conflicts, re-synthesizes |
| "What does the KB say about token rotation?" | **kb-query** | retrieves cited claims, drafts an answer, validates citations, answers with sources |

Everything below is what those skills do under the hood — useful for scripting, debugging, or
driving the system yourself.

---

## 5. Quick start (manual walkthrough)

```bash
export KB_DIR=./my-kb

# 1. Create the knowledge base
./bin/kb init "$KB_DIR" --json

# 2. Ingest a source (registers an immutable copy + chunks it)
./bin/kb ingest ./docs/rate-limiter.md --source-date 2026-05-01 --json
#   → { "data": { "sourceId": "src_…", "chunks": 4, … } }

# 3. Read the chunks to find exact quotes
./bin/kb source chunks src_… --json

# 4. Build the synthesis hierarchy
./bin/kb node create --title "Rate Limiter" --kind root --json     # → nodeId nod_ROOT
./bin/kb node create --parent nod_ROOT --title "Storage" --kind leaf --json

# 5. Apply quote-verified claims (see §7 for the JSON shape)
./bin/kb claim apply --file claims.json --json

# 6. Add knowledge-graph entities + relationships
./bin/kb graph apply --file graph.json --json

# 7. Write the synthesis prose with inline [^clm_…] citations
./bin/kb synthesize --file node.json --json

# 8. Check invariants, then render the human view
./bin/kb verify --strict --json
./bin/kb render --json

# 9. Ask a question
./bin/kb ask-context "how is bucket state stored?" --json
```

---

## 6. CLI reference

Every command accepts `--json` (machine output) and `--kb <dir>`. Output envelope:
`{ ok, data, warnings, errors }`; exit code is `1` when `ok:false`. JSON payloads for the
`apply`/`synthesize`/`answer-check` commands are read from `--file <path>` **or** stdin.

### Lifecycle & status
| Command | Purpose |
|---|---|
| `kb init [<dir>]` | Create a KB (DB, `sources/`, `kb/`, `AGENTS.md`/`CLAUDE.md`, initial render). Idempotent. |
| `kb status` | Counts: sources, chunks, nodes, stale nodes, claims, spans, entities, relationships. |

### Sources
| Command | Purpose |
|---|---|
| `kb ingest <path> [--title T] [--source-date D] [--supersedes <src_id>]` | Register + chunk a source. Re-ingesting identical bytes is a no-op. `--supersedes` marks an older version superseded. |
| `kb source show <source_id>` | Source metadata. |
| `kb source chunks <source_id>` | All chunks with full text (this is how you find exact quotes). |

### Synthesis tree
| Command | Purpose |
|---|---|
| `kb node create --title T --kind <root\|topic\|leaf> [--parent <node_id>] [--slug S]` | Create a node. One `root`; others need `--parent`. |
| `kb node tree` | The whole hierarchy with depth, kind, stale flag, claim counts. |
| `kb node show <node_id>` | A node plus the claims it owns (with their ids — needed for citations). |
| `kb synthesize --file <json>` | Set a node's prose. Clears its stale flag. Rejects citations to unknown claims. |
| `kb propagate` | Re-assert staleness propagation (every stale node marks its ancestors stale). |

### Claims & graph
| Command | Purpose |
|---|---|
| `kb claim apply --file <json>` | Persist claims with quote-verified provenance (atomic). |
| `kb claim supersede <old_claim_id> --by <new_claim_id>` | Mark a claim superseded; marks affected nodes stale. |
| `kb graph apply --file <json>` | Persist entities + relationships with provenance (atomic). |

### Read, verify, render
| Command | Purpose |
|---|---|
| `kb search <query> [--scope chunks\|claims\|nodes\|entities\|all] [--limit N]` | Full-text search. |
| `kb ask-context "<question>" [--limit N]` | Retrieve relevant claims **with provenance**, plus related nodes/entities. The basis for answering. |
| `kb answer-check --file <json>` | Validate a drafted answer's citations (structural). |
| `kb provenance <claim_id>` | Full provenance chain for a claim (quotes, offsets, source, stored path). |
| `kb entity show <entity_id>` | An entity and its relationships. |
| `kb verify [--strict]` | Run provenance/structure invariants (see §11). |
| `kb render [--check]` | Write `kb/*.md`, or with `--check` detect drift without writing. |

---

## 7. JSON payload formats

### `claim apply`
The agent supplies a `chunk_id` and an **exact** `quote` (a verbatim substring of that
chunk, unique within it). The CLI computes offsets and verifies the quote — paraphrases are
rejected and the whole batch rolls back on any failure.

```jsonc
{
  "source_id": "src_…",
  "claims": [
    {
      "node_id": "nod_…",                       // the leaf this claim belongs to
      "text": "Bucket state is stored in Redis.", // your normalized assertion
      "claim_type": "fact",                      // fact|definition|decision|requirement|
                                                 //   constraint|procedure|warning|example|open_question
      "confidence": 0.9,
      "spans": [
        { "chunk_id": "chk_…", "quote": "Bucket state is stored in Redis.", "role": "supports" }
      ]
    }
  ]
}
```
`role` ∈ `supports|contradicts|context|supersedes` (default `supports`). A claim may cite
multiple spans (e.g. two phrases that together justify it).

### `graph apply`
```jsonc
{
  "source_id": "src_…",
  "entities": [
    { "type": "Service",   "name": "Rate Limiter", "description": "…" },
    { "type": "DataStore", "name": "Redis",        "description": "…" }
  ],
  "relationships": [
    {
      "type": "stores_in",
      "subject": { "type": "Service",   "name": "Rate Limiter" },
      "object":  { "type": "DataStore", "name": "Redis" },
      "description": "Bucket state lives in Redis",
      "confidence": 0.95,
      "evidence": [ { "chunk_id": "chk_…", "quote": "Bucket state is stored in Redis." } ]
    }
  ]
}
```
Relationships require ≥1 evidence quote. Use the recommended vocabulary (entities: Service,
Component, Module, Library, Framework, API, DataStore, Config, Concept, Pattern, Decision,
Requirement, Person, Version…; relationships: depends_on, calls, implements, exposes,
stores_in, configured_by, supersedes, deprecates, part_of, references…). Don't strip version
numbers from names — `React 18` and `React` are different entities.

### `synthesize`
```jsonc
{
  "node_id": "nod_…",
  "title": "Storage",                       // optional
  "summary": "Redis holds bucket state.",   // optional (shown in parent subtopic lists)
  "body_md": "Bucket state is stored in Redis.[^clm_37c84b…] A Lua script keeps the check-and-decrement atomic.[^clm_adc85f…]"
}
```
Put an inline `[^clm_…]` citation after each assertion. Get claim ids from `kb node show
<node_id>`. The renderer turns them into footnotes — **never write footnote definitions
yourself**. A leaf must cite ≥1 claim; a parent may cite any claim in its subtree.

### `answer-check`
```jsonc
{ "answer": "Bucket state is stored in Redis.[^clm_37c84b…] It is made atomic with Lua.[^clm_adc85f…]" }
```

---

## 8. Common workflows

### Create a KB from a corpus
Init → survey the docs → create a `root` and first-level `topic`/`leaf` nodes → ingest each
source (oldest first so newer ones can supersede) → apply claims and graph → synthesize
bottom-up → `verify --strict` → `render`. (The **kb-create** skill automates this.)

### Ingest a new source
`ingest` → `source chunks` → apply claims to the right nodes (creating nodes as needed) →
apply graph → resolve conflicts (§ below) → re-synthesize the nodes that went stale →
`verify --strict` → `render`. (The **kb-ingest** skill automates this.)

### Update a document / handle supersession
```bash
kb ingest ./spec-v2.md --supersedes src_OLD --json   # old source → superseded
kb source chunks src_NEW --json
kb claim apply --file new-claims.json --json          # new facts from v2
kb claim supersede clm_OLD --by clm_NEW --json        # retire the contradicted claim
kb verify --json                                      # shows the now-stale nodes
# …re-synthesize stale nodes, then:
kb render --json
```

### Resolve a conflict
If two sources disagree and neither clearly wins, keep both claims and present the conflict in
the node's prose ("Sources disagree: …" citing both). They surface in `kb/open-questions.md`.
If one supersedes the other, use `claim supersede`.

### Answer a question with provenance
```bash
kb ask-context "how is rate limiting enforced?" --json   # → claims + quotes + node titles
# draft an answer with [^clm_…] citations, then:
kb answer-check --file answer.json --json                # ok:true required
```

### Routine maintenance
`kb verify --strict` (catch provenance/staleness issues) → re-synthesize anything stale →
`kb render --check` (confirm the markdown matches the DB).

---

## 9. Reading the output

The `kb/` directory is your human-readable view (regenerate with `kb render`):

- **`index.md`** — every source with title, date, status, and a link to its immutable copy;
  links into the synthesis tree and graph.
- **`synthesis/…`** — the hierarchy. Each file is a node's prose; every claim shows as a
  footnote with the exact source quote and the path to the source. Parents link their
  subtopics.
- **`changelog.md`** — what changed and when.
- **`open-questions.md`** — unresolved conflicts and gaps.
- **`graph/entities.md`, `graph/relationships.md`** — the knowledge graph.

A footnote looks like:
```
[^clm_37c84b…]: Bucket state is stored in Redis. — “Bucket state is stored in Redis.” (Rate Limiter Service, sources/9a/9af0bfed8bd3b5a2.md)
```
That is the whole point: from any synthesized sentence you can reach the verbatim source text
that justifies it.

---

## 10. Trusting an answer

An answer is trustworthy when `kb answer-check` returns `ok:true` **and** the cited quotes (in
the `ask-context` provenance or `kb provenance <claim_id>`) actually say what the sentence
claims. `answer-check` guarantees the *structure* — every assertion cites an active,
source-backed claim — but it cannot judge meaning, so read the quotes for anything important.
If `ask-context` returns nothing relevant, the KB doesn't cover the question; a good agent says
so rather than guessing.

---

## 11. The `verify` checks

`kb verify` (add `--strict` to fail on warnings):

- **errors** (provenance/structure broken): `claim-has-provenance`, `quote-matches-source`,
  `citation-resolves`, `parent-cites-subtree`, `citation-active`, `fts-integrity`.
- **warnings** (maintenance): `leaf-has-citation`, `no-stale-nodes`.

A green `verify --strict` means: every active claim is backed by a quote that still matches its
source, every synthesized citation resolves to an in-scope active claim, and nothing is stale.

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `quote not found in chunk …` | Your `quote` isn't a verbatim substring of that chunk. Re-read `kb source chunks` and copy exact text (watch capitalization, punctuation, and line wraps — the canonical text uses `\n`). |
| `quote is ambiguous … appears more than once` | The quote occurs twice in the chunk. Provide a longer, unique quote. |
| `claim apply` failed, nothing saved | Batches are atomic — one bad quote rolls back all. Fix the offending span and retry the whole payload. |
| `body cites unknown claim(s): clm_…` | A `[^clm_…]` in `body_md` doesn't match a real claim id. Get ids from `kb node show <node_id>`. |
| `verify` warns `no-stale-nodes` | Nodes need re-synthesis after an ingest/supersede. Re-run `kb synthesize` on each, deepest first (`node tree` shows the tree; stale nodes are flagged). |
| `render --check` reports `drifted` | Someone edited generated markdown, or content changed. Re-run `kb render` (the DB is the truth; edits to `kb/*.md` are discarded). |
| `V1 ingests UTF-8 text sources …` | The file is binary/PDF. Extract its text first and ingest that (`.md`/`.txt`). |
| `No knowledge base at … (missing kb.sqlite)` | Wrong `--kb`/`KB_DIR`, or you haven't run `kb init`. |

---

## 13. Limitations (V1 scope)

- **Text sources only** (UTF-8 markdown/plain text/code). PDFs/HTML must be converted to text
  first.
- **Generated markdown is read-only** — edit knowledge through the CLI, not by hand. (Human
  corrections enter as claims; full bidirectional editing is deferred.)
- **Exact-match entity resolution** — no fuzzy auto-merge; surface-form variants that don't
  normalize identically become distinct entities.
- **Structural answer-check** — confirms citations resolve to active claims, not that a claim
  semantically entails the sentence (read the quotes).
- **No node move/split/merge command yet** — restructure by creating new nodes and
  re-applying claims.
- Single-user, local. No web UI, no multi-user, no embeddings/vector search.

See [ARCHITECTURE.md §16](ARCHITECTURE.md) for the V2 extension points.

---

## 14. FAQ

**Can I just edit the markdown in `kb/`?** No — it's a render of the database and will be
overwritten. Change knowledge with `kb` commands; `render` regenerates the markdown.

**What stops the agent from making things up?** Every claim must quote the source exactly; the
CLI verifies the quote against the immutable text before saving and re-checks it in `verify`. A
fabricated or paraphrased quote is rejected.

**How do I see where a fact came from?** `kb provenance <claim_id>` (or read the footnote in
the rendered node) shows the exact quote, offsets, source title, and stored file path.

**Can I delete the database and rebuild it?** The sources under `sources/` are the only
irreplaceable data; they're immutable copies. The synthesis and graph live in `kb.sqlite`. (V1
has no automatic rebuild-from-sources; back up `kb.sqlite`.)

**How do I run it through Claude Code instead of by hand?** Just ask — "ingest this into the
knowledge base," "what does the KB say about X." The **kb-ingest**, **kb-create**, and
**kb-query** skills drive the CLI for you.
