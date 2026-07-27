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
pnpm test             # optional: the full suite should pass
```

The CLI runs without a build step via `./bin/kb` (it uses `tsx`). Point it at a knowledge base
in one of three ways (checked in this order):

1. `--kb <dir>` on any command
2. `export KB_DIR=<absolute-dir>`
3. the nearest `kb.sqlite` in or above the current directory

Prefer an absolute `KB_DIR`. A relative value is resolved from each command's current
directory, so a later `cd` can accidentally turn `memory-bank/fedramp` into a doubled path
such as `memory-bank/fedramp/memory-bank/fedramp`.

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
export KB_DIR="$(pwd)/my-kb"

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

Discover the surface from the tool, not from this page: `./bin/kb --help --json` lists
every command with its workflow group, `./bin/kb <command> --help --json` prints one
command's full contract (arguments, flags, payload example, output, side effects), and
`./bin/kb version --json` reports the CLI and schema versions.

The reference below is generated from exactly those calls. Regenerate it with
`pnpm docs:commands` (or `pnpm docs`, which also rebuilds `docs/index.html`); a test
fails if it drifts.

<!-- generated:commands:start -->

Generated from the CLI by `pnpm docs:commands` — do not edit this block by hand.

Every command accepts `--json` (the envelope `{ ok, data, issues, errors, warnings, nextActions, hints }`)
and `--kb <dir>`. Exit code is `1` when `ok:false`. `--dry-run` is accepted by exactly 5
commands: `kb claim apply`, `kb graph apply`, `kb ingest`, `kb node apply`, `kb synthesize`.

Start here: `kb init --json`. Workflow order: **setup** → **ingest** → **structure** → **extract** → **synthesize** → **query** → **maintain**.

### setup — Create and open the knowledge base

#### `kb init`

Create or open a KB root, write scaffold files, and render the initial markdown.

```text
kb init [dir]
```

*When:* The very first step: create the knowledge base.

| Argument | Description |
|---|---|
| `dir` | the KB directory (defaults to the current directory) |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- root
- created
- scaffold (files written)
- rendered (files count)

**Side effects**

- creates the KB directory + sqlite DB
- writes scaffold + initial rendered markdown

**Examples**

```bash
# Initialize a KB here
kb init --json
```

*Related:* `kb ingest` · `kb status`

### ingest — Register sources and read their chunks

#### `kb ingest`

Register an immutable source copy, normalize text, and create deterministic chunks.

```text
kb ingest [options] <path>
```

*When:* The first step: ingest a source, then read its chunks and extract claims.

| Argument | Description |
|---|---|
| `path` | the ORIGINAL file to ingest (it owns source identity) |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--dry-run` | preview the change without persisting |
| `--title <title>` | source title (defaults to the first heading or filename) |
| `--source-date <date>` | source authorship date |
| `--supersedes <src_id>` | the source id this ingest supersedes |
| `--text-from <path>` | sidecar file supplying the canonical text for this original |
| `--extractor <name/version>` | how the sidecar text was produced (default agent-transcription/1) |
| `--verification <mode>` | whether the transcription was checked against the original (one of: `visual`, `none`) |
| `--origin-system <system>` | the system this source came from, e.g. github, notion |
| `--origin-id <id>` | the source’s id in that system |
| `--origin-url <url>` | the source’s canonical URL in that system |

**Input**

```text
accepted formats (extension → media type):
  md, markdown → text/markdown
  txt, rst → text/plain
  html, htm → text/html
  csv → text/csv
  json → application/json
  pdf → application/pdf — requires --text-from
  docx → application/vnd.openxmlformats-officedocument.wordprocessingml.document — requires --text-from
  pptx → application/vnd.openxmlformats-officedocument.presentationml.presentation — requires --text-from
  xlsx → application/vnd.openxmlformats-officedocument.spreadsheetml.sheet — requires --text-from
  png → image/png — requires --text-from
  jpg, jpeg → image/jpeg — requires --text-from
  gif → image/gif — requires --text-from
  zip → application/zip — requires --text-from
  any other extension → text/plain when it decodes as UTF-8 (no sidecar needed), else application/octet-stream — requires --text-from
for a format that requires --text-from, transcribe or extract the text first, then:
  1. write the extracted text to a UTF-8 file, e.g. extracted.md
  2. kb ingest report.pdf --text-from extracted.md --json
the ORIGINAL bytes own source identity (id + sha256); the sidecar becomes the canonical text.
canonical text is immutable: to publish a corrected transcription, ingest the corrected file itself
  with --supersedes <src_id> — re-ingesting the same original with different text is rejected.
```

**Output**

- sourceId
- title
- status
- updated
- chunks (count)
- original: { mediaType, byteSize, sha256 } — the bytes that own source identity
- text: { extractor, verification, textHash } — the canonical-text lineage
- next (a source-chunks pointer)

**Side effects**

- stores an immutable copy of the source
- creates deterministic chunks

*atomic (one transaction; all-or-nothing) · supports `--dry-run`*

**Examples**

```bash
# Ingest a markdown file
kb ingest ./notes.md --json
```

*Related:* `kb source chunks` · `kb claim apply`

#### `kb source chunks`

List chunks with ids, heading paths, and exact text for quote selection.

```text
kb source chunks <source_id>
```

*When:* Read chunk text to copy exact quotes into a claim/graph payload.

| Argument | Description |
|---|---|
| `source_id` | the source id (src_…) whose chunks to list |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- sourceId
- chunks: [{ id, chunkIndex, headingPath, text }] — copy quotes verbatim from text

**Examples**

```bash
# List a source’s chunks
kb source chunks src_1a2b3c --json
```

*Related:* `kb source show` · `kb claim apply`

#### `kb source list`

List sources with chunk and claim counts, plus global per-status totals.

```text
kb source list [options]
```

*When:* Survey ingested sources and their extraction coverage.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--status <status>` | filter the list by source status (one of: `active`, `superseded`, `duplicate`, `retracted`) |

**Output**

- sources: [{ id, title, status, sourceDate, mediaType, chunks, claims, origin, ingestedAt }] ordered by (ingestedAt, id)
- counts: GLOBAL per-status source totals, unaffected by --status

**Examples**

```bash
# List all sources
kb source list --json

# List only active sources
kb source list --status active --json
```

*Related:* `kb source show` · `kb source chunks`

#### `kb source show`

Show source metadata.

```text
kb source show <source_id>
```

*When:* Inspect an ingested source before extracting claims from it.

| Argument | Description |
|---|---|
| `source_id` | the source id (src_…) to show |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- the full source row: id, title, status, mediaType, sourceDate, ingestedAt, storedPath, metadataJson
- origin: { system, url } from metadata.origin — null when no origin was recorded

**Examples**

```bash
# Show one source
kb source show src_1a2b3c --json
```

*Related:* `kb source list` · `kb source chunks`

### structure — Build the synthesis hierarchy

#### `kb node apply`

Create a whole node hierarchy from a manifest, atomically.

```text
kb node apply [options]
```

*When:* Stand up the synthesis hierarchy in one command before extracting claims into it.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--dry-run` | preview the change without persisting |
| `--file <path>` | hierarchy manifest file (defaults to stdin; - for stdin) |

**Input**

```json
{
  "nodes": [
    {
      "ref": "root",
      "title": "Knowledge Base",
      "kind": "root",
      "children": [
        {
          "ref": "caching",
          "title": "Caching",
          "kind": "leaf"
        }
      ]
    }
  ]
}
```

**Output**

- nodes: [{ ref, nodeId, outcome }]
- totals { created, existing }
- staleNodes

**Side effects**

- creates the manifest nodes in one transaction (parents before children)
- marks created nodes and their ancestors stale

*atomic (one transaction; all-or-nothing) · supports `--dry-run`*

**Examples**

```bash
# Preview a hierarchy manifest
kb node apply --file ./hierarchy.json --dry-run --json

# Apply a hierarchy manifest
kb node apply --file ./hierarchy.json --json
```

*Related:* `kb node create` · `kb node tree` · `kb claim apply`

#### `kb node create`

Create a synthesis node.

```text
kb node create [options]
```

*When:* Build the synthesis hierarchy that claims are attached to.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--title <title>` | node title |
| `--kind <kind>` | node kind (one of: `root`, `topic`, `leaf`) |
| `--parent <node_id>` | parent node id (omit or "root" for the root) |
| `--slug <slug>` | explicit slug (defaults to a slugified title) |

**Output**

- nodeId
- created
- kind
- depth

**Side effects**

- creates a node in the synthesis hierarchy

*atomic (one transaction; all-or-nothing)*

**Examples**

```bash
# Create the root node
kb node create --title "KB" --kind root --json

# Create a leaf under the root
kb node create --title "Caching" --kind leaf --json
```

*Related:* `kb node tree` · `kb claim apply`

#### `kb node show`

Show a node and the claims it owns.

```text
kb node show [options] <node_id>
```

*When:* Inspect a node’s claims before synthesizing its prose; --context returns everything one synthesize write needs.

| Argument | Description |
|---|---|
| `node_id` | the node id (nod_…) to show |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--context` | return the synthesis-ready bundle for the node’s whole subtree |

**Output**

- node, claims owned by the node (with ids to cite during synthesis)
- --context: node (bodyMd + bodyHash included), children [{…, ownClaims: citable claims owned directly}], claims (the whole subtree, active + conflicted, owner-tagged, each with provenance snippets carrying sourceStatus + supersededBy), sources [{ id, title, claimCount: bundle claims quoting it }], allowedCitationIds, stats { descendantNodes, claims, approxTokens, complete }

**Examples**

```bash
# Show a node and its claims
kb node show nod_1a2b3c --json

# Read the synthesis bundle for a node
kb node show nod_1a2b3c --context --json
```

*Related:* `kb node tree` · `kb synthesize` · `kb provenance`

#### `kb node tree`

List the synthesis hierarchy with depth, kind, stale flag, and claim counts.

```text
kb node tree
```

*When:* See the whole hierarchy and which nodes are stale.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- nodes: [{ id, parentId, title, kind, depth, isStale, claims (count) }]

**Examples**

```bash
# List the hierarchy
kb node tree --json
```

*Related:* `kb node show` · `kb node create`

### extract — Extract claims and the knowledge graph

#### `kb claim apply`

Persist quote-verified claims atomically.

```text
kb claim apply [options]
```

*When:* Extract claims from a source’s chunks and attach them to nodes.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--dry-run` | preview the change without persisting |
| `--file <path>` | claims payload file (defaults to stdin; - for stdin) |

**Input**

```json
{
  "source_id": "src_1a2b3c",
  "claims": [
    {
      "node_id": "nod_1a2b3c",
      "text": "The service is written in Rust.",
      "claim_type": "fact",
      "spans": [
        {
          "chunk_id": "chk_1a2b3c",
          "quote": "written in Rust"
        }
      ]
    }
  ]
}
```

**Output**

- claims[] — one receipt per input: {inputIndex, claimId, outcome (created|updated|unchanged), spans:{submitted, spansCreated, spansReused, linksCreated, linksReused}}; per input spansCreated + spansReused === submitted (same for links)
- totals — {created, updated, unchanged, spansCreated, spansReused, linksCreated, linksReused, linksUpdated} summed over the inputs (linksUpdated counts reused links whose role or confidence changed)
- staleNodes — the currently-stale node ids, deepest-first (only owners of created/updated claims are staled)
- claimsCreated, claimsUpdated, affectedNodes, spansCreatedNet — deprecated aliases kept for envelope v2; read claims[]/totals instead

**Side effects**

- persists created/updated claims and their quote-verified spans
- marks the owning nodes (and ancestors) of created/updated claims stale
- writes one changelog entry iff created + updated > 0 — an exact repeat writes nothing at all

*atomic (one transaction; all-or-nothing) · supports `--dry-run`*

**Examples**

```bash
# Apply a claims payload
kb claim apply --file ./claims.json --json
```

*Related:* `kb source chunks` · `kb node show`

#### `kb claim conflict`

Mark one or more unresolved claims as conflicted and stale their owning nodes.

```text
kb claim conflict <claim_id...>
```

*When:* Flag contradictory claims so their nodes get re-synthesized.

| Argument | Description |
|---|---|
| `claim_id` | one or more claim ids (clm_…) to mark conflicted |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- conflicted (the claim ids)
- staleNodes (count marked stale)

**Side effects**

- sets the claims to conflicted
- marks owning nodes (and ancestors) stale

*atomic (one transaction; all-or-nothing)*

**Examples**

```bash
# Conflict two claims
kb claim conflict clm_1a2b3c clm_4d5e6f --json
```

*Related:* `kb claim supersede` · `kb node show`

#### `kb claim supersede`

Mark an older claim superseded by another claim and stale affected nodes.

```text
kb claim supersede [options] <old_claim_id>
```

*When:* Retire an outdated claim in favor of a newer one.

| Argument | Description |
|---|---|
| `old_claim_id` | the claim id (clm_…) being superseded |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--by <new_claim_id>` | the superseding claim id |

**Output**

- superseded (the old claim id)
- by (the new claim id)
- staleNodes (count marked stale)

**Side effects**

- sets the old claim to superseded
- marks affected nodes (and ancestors) stale

*atomic (one transaction; all-or-nothing)*

**Examples**

```bash
# Supersede a claim
kb claim supersede clm_1a2b3c --by clm_4d5e6f --json
```

*Related:* `kb claim conflict` · `kb provenance`

#### `kb entity list`

List knowledge-graph entities with their relationship counts.

```text
kb entity list [options]
```

*When:* Survey the knowledge graph after graph apply, then inspect one entity.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--type <type>` | filter the list to one entity type |

**Output**

- entities: [{ id, type, canonicalName, description, relationships }] ordered by (type, canonicalName)
- counts: GLOBAL per-type entity totals, unaffected by --type

**Examples**

```bash
# List every entity
kb entity list --json

# List only data stores
kb entity list --type DataStore --json
```

*Related:* `kb entity show` · `kb graph apply` · `kb search`

#### `kb entity show`

Show an entity and its relationships.

```text
kb entity show <entity_id>
```

*When:* Inspect the knowledge graph after graph apply.

| Argument | Description |
|---|---|
| `entity_id` | the entity id (ent_…) to show |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- entity
- relationships owned by the entity

**Examples**

```bash
# Show one entity
kb entity show ent_1a2b3c --json
```

*Related:* `kb graph apply` · `kb search`

#### `kb graph apply`

Persist entities and quote-verified relationships atomically.

```text
kb graph apply [options]
```

*When:* Extract the knowledge graph from a source alongside its claims.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--dry-run` | preview the change without persisting |
| `--file <path>` | graph payload file (defaults to stdin; - for stdin) |

**Input**

```json
{
  "source_id": "src_1a2b3c",
  "entities": [
    {
      "type": "Service",
      "name": "Billing"
    }
  ],
  "relationships": [
    {
      "type": "depends_on",
      "subject": {
        "type": "Service",
        "name": "Billing"
      },
      "object": {
        "type": "Service",
        "name": "Auth"
      },
      "evidence": [
        {
          "chunk_id": "chk_1a2b3c",
          "quote": "Billing calls Auth"
        }
      ]
    }
  ]
}
```

**Output**

- entities[] — one receipt per input entity: {inputIndex, entityId, outcome (created|updated|unchanged)}
- relationships[] — one receipt per input relationship: {inputIndex, relationshipId, outcome, evidence:{submitted, spansCreated, spansReused, linksCreated, linksReused}}; per relationship spansCreated + spansReused === submitted (same for links)
- totals — {entitiesCreated, entitiesUpdated, entitiesUnchanged, entitiesReferenced, relationshipsCreated, relationshipsUpdated, relationshipsUnchanged, spansCreated, spansReused, linksCreated, linksReused}
- entitiesCreated, entitiesUpdated, entitiesUnchanged, entitiesReferenced, relationshipsCreated, relationshipsUpdated, relationshipsUnchanged, spansCreated — deprecated aliases kept for envelope v2; read entities[]/relationships[]/totals instead
- no stale-node field: graph mutations never mark nodes stale

**Side effects**

- persists created/updated entities
- persists created/updated relationships and their quote-verified evidence spans
- writes one changelog entry iff created + updated > 0 — an exact repeat writes nothing at all

*atomic (one transaction; all-or-nothing) · supports `--dry-run`*

**Examples**

```bash
# Apply a graph payload
kb graph apply --file ./graph.json --json
```

*Related:* `kb entity show` · `kb source chunks`

### synthesize — Write node prose that cites claims

#### `kb synthesize`

Set node prose with inline claim citations and clear that node stale flag.

```text
kb synthesize [options]
```

*When:* Write node prose citing active claims after claims are applied.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--dry-run` | preview the change without persisting |
| `--file <path>` | node payload file (defaults to stdin; - for stdin) |

**Input**

```json
{
  "node_id": "nod_1a2b3c",
  "title": "Caching strategy",
  "body_md": "The service caches responses for 60s [^clm_1a2b3c]."
}
```

**Output**

- single payload: nodeId, outcome (updated | unchanged | stale-cleared)
- batch payload: nodes[] (inputIndex, nodeId, depth, outcome) in apply order + totals
- staleNodes (nodes still needing synthesis, deepest-first)

**Side effects**

- sets the node prose (body, and title/summary when provided)
- clears the node stale flag
- marks ancestor nodes stale when the title or summary changes (a body-only change does not)

*atomic (one transaction; all-or-nothing) · supports `--dry-run`*

**Examples**

```bash
# Synthesize one node from a file
kb synthesize --file ./node.json --json

# Synthesize a batch — {"nodes":[<payload>, …]}, up to 200, applied deepest-first in one transaction
kb synthesize --file ./batch.json --dry-run --json
```

*Related:* `kb node show` · `kb verify`

### query — Search and answer with provenance

#### `kb answer-check`

Structurally validate that a drafted answer cites supported active claims.

```text
kb answer-check [options]
```

*When:* Validate a drafted answer’s citations before finalizing it.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--file <path>` | answer payload file (defaults to stdin; - for stdin) |

**Input**

```text
claim_ids is optional and normally omitted — citations are parsed from the answer text.
Supply it only to validate ids that do not appear in the text.
```

```json
{
  "answer": "The service is written in Rust [^clm_1a2b3c]."
}
```

**Output**

- ok (mirrors envelope ok)
- citedClaims / unknownCitations / inactiveCitations
- staleSourceCitations: [{ claimId, sourceIds, successorId, quoteSurvives }] (warnings; never affects ok)
- uncited: [{ text, line }] (uncitedSentences retained as a deprecated alias)

**Examples**

```bash
# Check an answer
kb answer-check --file ./answer.json --json
```

*Related:* `kb ask-context` · `kb provenance`

#### `kb ask-context`

Retrieve relevant claims with provenance, plus related nodes and entities.

```text
kb ask-context [options] <question...>
```

*When:* Gather cited context before drafting an answer.

| Argument | Description |
|---|---|
| `question` | the question (joined with spaces) |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--limit <n>` | max claims (1–50) |
| `--claim-type <type>` | restrict claims to this type (one of: `fact`, `definition`, `decision`, `requirement`, `constraint`, `procedure`, `warning`, `example`, `open_question`) |
| `--node <node_id>` | restrict claims to this node’s subtree |

**Output**

- claims with provenance (each span: sourceTitle, quote, storedPath, sourceStatus, supersededBy)
- related nodes
- related entities
- applied: the { claimType, node } filters echoed back

**Examples**

```bash
# Ask for context
kb ask-context how does caching work --json

# Only open questions
kb ask-context caching --claim-type open_question --json
```

*Related:* `kb search` · `kb answer-check`

#### `kb provenance`

Show a claim and its source quotes, offsets, source titles, and stored paths.

```text
kb provenance <claim_id>
```

*When:* Trace a claim back to its exact source quotes.

| Argument | Description |
|---|---|
| `claim_id` | the claim id (clm_…) whose provenance to show |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- claim
- provenance: [{ quote, charStart, charEnd, sourceTitle, sourceStatus, supersededBy, storedPath }]
- supersededBy: the active successor source id when sourceStatus is not active (else null)

**Examples**

```bash
# Show a claim’s provenance
kb provenance clm_1a2b3c --json
```

*Related:* `kb node show` · `kb source show`

#### `kb search`

Search chunks, claims, nodes, entities, or all scopes.

```text
kb search [options] <query...>
```

*When:* Find ids to inspect, cite, or answer from.

| Argument | Description |
|---|---|
| `query` | the search terms (joined with spaces) |

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--scope <scope>` | search scope (one of: `chunks`, `claims`, `nodes`, `entities`, `all`) |
| `--match <mode>` | match strategy (one of: `auto`, `all`, `any`, `phrase`) |
| `--limit <n>` | max hits per scope (1–200) |

**Output**

- query (the joined terms)
- matchModes (strategy applied per scope: all | any | any-fallback | phrase | like)
- hits scope-major (chunks, claims, nodes, entities), each with id, matchMode, and rank (raw bm25; null for entity hits; comparable only within a scope)

**Examples**

```bash
# Search all scopes (auto AND→OR fallback)
kb search caching layer --json

# Require every term (strict)
kb search caching layer --match all --json

# Search only claims
kb search caching --scope claims --json
```

*Related:* `kb ask-context` · `kb node show`

### maintain — Inspect, verify, and render

#### `kb coverage`

Report synthesis completeness gaps across sources, chunks, claims, and nodes.

```text
kb coverage
```

*When:* Survey synthesis completeness after verify; descriptive, never an integrity gate.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- summary: per-check { total, shown } for SOURCE_NO_CLAIMS, CHUNK_UNCITED, CLAIM_NOT_SYNTHESIZED, NODE_SINGLE_SOURCE, OPEN_QUESTION_NOT_SYNTHESIZED
- issues: one aggregated info issue per non-empty check (ids capped at 20; exact totals in summary)

**Examples**

```bash
# Report coverage
kb coverage --json
```

*Related:* `kb verify` · `kb render`

#### `kb propagate`

Re-assert stale propagation from stale nodes to ancestors.

```text
kb propagate
```

*When:* Recompute staleness if the hierarchy was edited out of band.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- propagated stale set (nodes marked stale by ancestor propagation)

**Side effects**

- marks ancestors of stale nodes stale

*atomic (one transaction; all-or-nothing)*

**Examples**

```bash
# Re-assert staleness
kb propagate --json
```

*Related:* `kb node tree` · `kb verify`

#### `kb render`

Render generated markdown, or check rendered markdown for drift.

```text
kb render [options]
```

*When:* Regenerate the human-readable markdown after verify.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--check` | check rendered markdown for drift instead of writing |

**Output**

- written (files) when rendering
- checked + drift (list) with --check

**Side effects**

- writes generated markdown (without --check)

**Examples**

```bash
# Render the markdown
kb render --json

# Check for render drift
kb render --check --json
```

*Related:* `kb verify` · `kb status`

#### `kb status`

Print source, chunk, node, stale-node, claim, span, entity, and relationship counts.

```text
kb status
```

*When:* Check KB contents and the tool/schema versions at a glance.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |

**Output**

- root
- resolvedVia: how the root was resolved (flag | env | walk-up)
- cli + schema (version fields)
- counts: sources, chunks, nodes, staleNodes, claims, spans, entities, relationships

**Examples**

```bash
# Show KB status
kb status --json
```

*Related:* `kb node tree` · `kb verify`

#### `kb verify`

Run provenance, citation, staleness, and FTS integrity checks.

```text
kb verify [options]
```

*When:* Gate integrity before rendering; --strict fails on warnings.

| Flag | Description |
|---|---|
| `--json` | emit the result as a JSON envelope |
| `--kb <dir>` | knowledge base directory (overrides KB_DIR and walk-up) |
| `--help` | show this command’s help as an envelope (router-owned) |
| `--strict` | treat warnings as failures |

**Output**

- findings: [{ check, code, severity, message, ids }]

**Examples**

```bash
# Verify integrity
kb verify --json

# Fail on any warning
kb verify --strict --json
```

*Related:* `kb render` · `kb node tree`

<!-- generated:commands:end -->

---

## 7. JSON payload formats

The authoritative shape of every payload is `kb <command> --help --json` → `data.input`
(a runnable `example`, plus notes). This section adds the judgment the help cannot: which
values to choose and why.

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
the node's prose ("Sources disagree: …" citing both). Mark the unresolved claims so they
surface in `kb/open-questions.md`:
```bash
kb claim conflict clm_A clm_B --json
```
If one supersedes the other, use `claim supersede`.
If the source states a gap or unresolved decision directly, model that as
`claim_type: "open_question"`; those claims also surface in `open-questions.md`.

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
- **`open-questions.md`** — unresolved conflicts and `open_question` claims.
- **`graph/entities.md`, `graph/relationships.md`** — the knowledge graph; relationship
  rows include their source quotes when evidence was supplied.

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
or conflicted source-backed claim — but it cannot judge meaning, so read the quotes for
anything important.
If `ask-context` returns nothing relevant, the KB doesn't cover the question; a good agent says
so rather than guessing.

---

## 11. The `verify` checks

`kb verify` (add `--strict` to fail on warnings):

- **errors** (provenance/structure broken): `claim-has-provenance`, `quote-matches-source`,
  `citation-resolves`, `parent-cites-subtree`, `citation-active`, `fts-integrity`.
- **warnings** (maintenance): `leaf-has-citation`, `no-stale-nodes`.

A green `verify --strict` means: every active claim is backed by a quote that still matches its
source, every synthesized citation resolves to an in-scope claim that is not superseded or
retracted, and nothing is stale.

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
| `No knowledge base at … (missing kb.sqlite)` | Wrong `--kb`/`KB_DIR`, or you haven't run `kb init`. If the path repeats a suffix like `memory-bank/fedramp/memory-bank/fedramp`, set `KB_DIR` to an absolute path. |

---

## 13. Limitations (V1 scope)

- **Text sources only** (UTF-8 markdown/plain text/code). PDFs/HTML must be converted to text
  first.
- **Generated markdown is read-only** — edit knowledge through the CLI, not by hand. (Human
  corrections enter as claims; full bidirectional editing is deferred.)
- **Exact-match entity resolution** — no fuzzy auto-merge; surface-form variants that don't
  normalize identically become distinct entities.
- **Structural answer-check** — confirms citations resolve to active or conflicted claims, not
  that a claim semantically entails the sentence (read the quotes).
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
