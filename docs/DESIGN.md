# Knowledge Base Ingest — Design (V1)

Synthesized from three independent design passes (two internal architects + Codex/gpt-5.5).
Two of three converged on **SQLite-as-truth**; this design adopts it and grafts the best
ideas from all three.

## 0. Core decision: SQLite is the source of truth; markdown is a rendered projection

- **SQLite** holds all derived/generated state: source registry, chunks, source spans,
  synthesis-node tree, synthesis prose, claims, provenance edges, entities, relationships,
  staleness, render bookkeeping.
- **Immutable source copies** live on disk under `sources/`, content-addressed, never edited.
- **Human-readable markdown** is a deterministic, one-way render of the DB under `kb/`.
  Generated markdown carries a render header + content hash; it is **read-only**. `kb render
  --check` detects drift; `kb render` overwrites. V1 does not import markdown edits back.

Why: the requirement is to *strictly* maintain provenance so every generated part traces to a
source. That is an **enforced invariant** when truth is a relational graph with foreign keys and
quote-verified spans; it is only advisory when truth is hand-editable prose. The cost
(humans read but don't hand-edit synthesis) is acceptable for a local single-user V1, and human
knowledge still enters through typed CLI mutations.

## 1. On-disk layout

```
<kb-root>/                          e.g. ./kb/<slug>/
  kb.sqlite                         # source of truth (WAL)
  sources/                          # IMMUTABLE, content-addressed, chmod 0444
    <ab>/<sha256>.<ext>             # verbatim bytes
    <ab>/<sha256>.meta.json         # registry mirror (informational)
  kb/                               # GENERATED markdown projection (read-only)
    index.md                        # all sources + descriptions (req #3)
    changelog.md                    # mutation history
    open-questions.md               # conflicts / gaps / unresolved
    graph/entities.md
    graph/relationships.md
    synthesis/
      root.md                       # top-level synthesis (req #2)
      <topic-slug>/
        index.md                    # parent = synthesis of children
        <leaf-slug>.md
  AGENTS.md / CLAUDE.md             # how agents must operate in this KB
```

The deterministic CLI **owns** `kb.sqlite` + `sources/` + `kb/`. The agent never writes those
files directly; it calls the CLI.

## 2. SQLite schema (authoritative)

Conventions: `STRICT` tables, `PRAGMA foreign_keys=ON`, WAL. Stable text IDs with type prefixes
(`src_`, `chk_`, `spn_`, `nod_`, `clm_`, `ent_`, `rel_`). Timestamps ISO-8601 text.

### Sources (immutable, content-addressed)
- `sources(id PK, sha256 UNIQUE, stored_path UNIQUE, original_path, title, media_type,
  byte_size, source_date, author, version_label, supersedes_source_id FK, status
  CHECK(active|superseded|duplicate|retracted), metadata_json, ingested_at)`
- Re-ingesting identical bytes → maps to existing source (idempotent no-op).

### Chunks + spans (provenance anchors)
- `source_chunks(id PK, source_id FK, chunk_index, heading_path, text, char_start, char_end,
  token_estimate, content_hash, UNIQUE(source_id, chunk_index))` — deterministic,
  structure-aware chunking; content-hashed so re-chunking identical bytes is stable.
- `source_spans(id PK, source_id FK, chunk_id FK, char_start, char_end, quote, quote_hash,
  created_at)` — **the atomic provenance target**. `quote` must be an exact substring of the
  immutable source text; verified deterministically on insert (`quote_hash` = sha256(quote)).

### Synthesis tree (hierarchy of arbitrary depth)
- `nodes(id PK, parent_id FK→nodes, slug, title, kind CHECK(root|topic|leaf), depth,
  sort_order, body_md, body_hash, token_budget, content_rev INT, subtree_rev INT,
  synthesized_rev INT, status CHECK(fresh|stale), summary, created_at, updated_at,
  UNIQUE(parent_id, slug))`
- `node_claims(node_id FK, claim_id FK, relevance, PRIMARY KEY(node_id, claim_id))` — which
  claims a node synthesizes / is responsible for.
- **Staleness via revision counters** (clean, no LLM needed to detect): `content_rev++` when a
  node's own claim set changes; `subtree_rev` = max(own content_rev, children subtree_rev);
  node is **stale** iff `subtree_rev > synthesized_rev`. Propagation walks parent pointers to
  root. Re-synthesis is bottom-up.

### Claims + provenance (the knowledge atom)
- `claims(id PK, text, normalized_text, claim_type CHECK(fact|definition|decision|requirement|
  constraint|procedure|warning|example|open_question), subject_entity_id FK?, confidence
  REAL[0..1], status CHECK(active|superseded|conflicted|retracted), superseded_by_claim_id FK?,
  first_seen_source_id FK, created_at, updated_at)`
- `claim_spans(id PK, claim_id FK, source_span_id FK, role CHECK(supports|contradicts|context|
  supersedes), confidence, extractor CHECK(agent|cli|human), UNIQUE(claim_id, source_span_id,
  role))` — provenance edges.
- **HARD INVARIANT** (`kb verify --strict`): every `active` claim has ≥1 `supports` span whose
  quote still exactly matches the immutable source (re-verified → catches provenance rot).
- Node prose cites claims inline: `...rotated on every use.[^c:clm_ab12]`. Render resolves to a
  footnote with the claim's source quote + link. `verify` checks every inline citation resolves
  to a claim linked to that node, and every leaf node body has ≥1 claim.

### Knowledge graph
- `entity_types(id PK, name UNIQUE, description)` — seeded software-domain vocabulary.
- `entities(id PK, type_id FK, canonical_name, normalized_name, description, confidence,
  UNIQUE(type_id, normalized_name))`
- `entity_aliases(id PK, entity_id FK, alias, normalized_alias, source_span_id FK?, confidence,
  UNIQUE(entity_id, normalized_alias))`
- `relationship_types(id PK, name UNIQUE, domain_type_id FK?, range_type_id FK?, description)`
- `relationships(id PK, type_id FK, subject_entity_id FK, object_entity_id FK, confidence,
  status, first_seen_source_id FK, UNIQUE(type_id, subject_entity_id, object_entity_id))`
- `relationship_spans(id PK, relationship_id FK, source_span_id FK, role, UNIQUE(...))` — KG
  edges carry provenance too (no orphan edges).

### Operating tables
- `changelog(id PK, ts, op, actor, source_id?, summary, detail_json)` — every mutation appends.
- `open_questions(id PK, node_id?, kind CHECK(conflict|gap|ambiguity), text, claim_a?, claim_b?,
  status, resolution, created_at)`
- `rendered_files(path PK, node_id?, content_hash, rendered_at)` — drift detection.
- `meta(k PK, v)` — schema_version etc.

### FTS5 (agent retrieval)
- `chunks_fts(text, heading_path)` over `source_chunks`
- `claims_fts(text)` over `claims`
- `nodes_fts(title, body_md)` over `nodes`
- `entities_fts(canonical_name, description)` over `entities`
- external-content tables kept in sync by triggers.

## 3. Knowledge-graph vocabulary (software/technical domain, extensible)

**Entity types:** System, Service, Component, Module, Library, Framework, Language, API,
Endpoint, Function, Class, DataStore, Schema, Table, Config, Environment, Protocol, Format,
Tool, Concept, Pattern, Decision (ADR), Requirement, Constraint, Risk, Person, Team, Version,
Repository, File.

**Relationship types:** depends_on, calls, implements, extends, exposes, consumes, produces,
stores_in, configured_by, deployed_to, owned_by, authored_by, supersedes, deprecates,
alternative_to, part_of, references, decided_by, constrains, tested_by, documented_by,
example_of, equivalent_to.

**Entity resolution:** normalize (lowercase, collapse whitespace, strip punctuation/version
suffix). Type-specific canonical keys where useful (Function=`module.name`, Endpoint=`METHOD
path`, Config=dotted path). Exact `(type, normalized_name)` → auto-merge. Alias hit → same
entity. Fuzzy candidates (trigram) → agent adjudicates. No cross-type auto-merge. `kb entity
merge a b` repoints FKs transactionally (lossless).

## 4. Ingestion pipeline (deterministic CLI vs agent judgment)

| # | Step | Owner |
|---|------|-------|
| 1 | Register source: hash, dedup, copy to immutable store, insert `sources` | **CLI** deterministic |
| 2 | Extract text + structure-aware chunk + FTS | **CLI** deterministic |
| 3 | Retrieve neighborhood (FTS + entity aliases) → context bundle | **CLI** deterministic |
| 4 | Extract claims (text, type, confidence, entities, **span quotes**) as Zod JSON | **AGENT** |
| 5 | Persist claims: verify each quote ⊆ source, create spans, dedup/normalize | **CLI** validates |
| 6 | Extract entities + relationships as Zod JSON; resolve exact, queue fuzzy | **AGENT** + CLI |
| 7 | Detect conflicts/supersession (same subject, recency, "deprecated"/"replaced by") | CLI surfaces, **AGENT** adjudicates |
| 8 | Assign claims to nodes (create nodes as needed); bump content_rev; mark stale | **AGENT** |
| 9 | Propagate staleness up the tree | **CLI** deterministic |
| 10 | Re-synthesize stale nodes bottom-up (write body_md + inline claim cites) | **AGENT** |
| 11 | `verify --strict` then `render` | **CLI** deterministic |

**Idempotency:** same bytes → no-op (step 1); same chunk hash → stable IDs; same (normalized
claim, span) → no duplicate provenance; same relationship triple → update, no dup. Updated
source → new hash, may `--supersedes` old → step 7 supersedes old claims rather than duplicating.

**Conflict handling:** never silently overwrite. Explicit supersession evidence → old claim
`superseded`. Disagreement without precedence → mark both claims `conflicted`,
synthesis must state the conflict and cite both sides.

## 5. CLI surface (`kb`)

Output envelope `{ ok, data, warnings, errors }`. `--json` for machine output; default human
text. Read commands never mutate; mutations append to `changelog`.

**Lifecycle/ingest (mutation):** `kb init <dir>` · `kb ingest <path> [--supersedes <id>]
[--title T] [--source-date D]` (steps 1–3, prints context bundle) · `kb claim apply <json>`
(steps 5) · `kb claim conflict <claim...>` · `kb claim supersede <old> --by <new>` ·
`kb graph apply <json>` (step 6) · `kb node create` · `kb synthesize --file <json>` · `kb propagate` · `kb render
[--check]`.

**Read/query:** `kb status` · `kb search <q> [--scope chunks|claims|nodes|entities|all]` · `kb
source show|chunks <id>` · `kb provenance <claim>` (full chain to bytes) · `kb node tree|show` · `kb entity show <id>` · `kb
ask-context <q>` (retrieve claims+nodes+entities+spans for Q&A) · `kb answer-check <json>`
(reject answer sentences lacking resolvable provenance) · `kb verify [--strict]`.

**Provenance-checked Q&A (the V1 headline):** `kb ask-context` retrieves; agent answers using
only retrieved claims with inline claim cites; `kb answer-check` fails closed on any
uncited/over-reaching sentence. Answer ships with per-claim source quotes.

## 6. Claude Code skills

Four skills (markdown instruction files). Each encodes the *judgment* the CLI refuses to make,
plus a non-negotiables block (don't trust memory; evidence is source spans; generated markdown
is output not input; every claim must be traceable).
- **kb-create** — bootstrap a KB from a corpus: ingest all sources, extract claims, build the
  hierarchy from source-backed claims, synthesize bottom-up, `verify --strict`, `render`.
- **kb-ingest** — add one new source: the step 1–11 loop; resolve conflicts; update stale
  leaves before parents.
- **kb-query** — answer questions: `ask-context` → draft with claim cites → `answer-check` →
  say when the KB lacks support.
- **kb-maintain** — repair/refactor: `verify`/`doctor`, fix stale nodes, split oversized nodes,
  resolve low-confidence entity merges, re-render.

## 7. Type safety + testing

- All agent↔CLI JSON validated by **Zod** at the boundary; DB rows validated on read into typed
  models. No `any`. Branded ID types.
- **TDD red/green/refactor** on the deterministic core: hashing, chunking, normalization, quote
  verification, ID derivation, staleness propagation, provenance graph queries, render,
  search, verify invariants. LLM-judgment steps are proven via an end-to-end demo ingest on a
  real sample source.

## 8. Cut from V1 (deferred)

Multi-user, web UI, bidirectional markdown editing, vector/embedding search, background daemon,
source deletion, multi-KB federation, full sentence-level (vs claim-level) prose decomposition,
automatic ontology learning. V1 ships: immutable sources, chunking+FTS, quote-verified claim
extraction, synthesis hierarchy with revision-counter staleness, claim→span→source provenance,
read-only markdown render, conflict/supersession, basic KG, the four skills, provenance-checked
Q&A.

**Guiding principle:** *make unsupported knowledge impossible to persist through normal commands.*

---

## 9. Final scope decisions (post-review) — the implementation contract

Synthesized from three reviews (internal simplicity + software-engineering reviewers, and Codex).
Where this section differs from §0–§8 above, **this section wins**.

### Protected (do not weaken)
SQLite-as-truth + deterministic markdown projection + the hard boundary where the agent only
*proposes* Zod-validated JSON and the CLI *validates & persists*. This is what makes provenance,
TDD, and repair feasible.

### Provenance keystone — KEEP quote verification (rejected the cut)
The atomic provenance unit is a **span** = an exact substring of a source's **canonical
extracted text**, addressed by `[char_start, char_end)` in **JS UTF-16 code-unit** offsets.
Its purpose is *anti-hallucination*, not anti-rot: the agent must copy an exact substring, which
the CLI verifies deterministically before persisting. No flag skips it.
- New table `source_texts(source_id PK, extractor, extractor_version, text, text_hash)` holds the
  canonical text. Offsets/quotes are defined against `source_texts.text`, never raw bytes.
- Canonical normalization for markdown/text extractor: strip BOM, CRLF→LF, Unicode NFC. Documented
  and versioned (`extractor_version`). Code/config use the same (no whitespace collapse).
- `quote_hash = sha256(quote)`; `verify --strict` re-runs the actual substring check, not just the
  hash compare.

### Staleness — boolean, not counters (adopted the simplification; fixes two flagged bugs)
`nodes.is_stale INTEGER`. Marking any node's claim set / structure dirty marks that node + all
ancestors stale (`WITH RECURSIVE`, one transaction). Move/split/merge marks **old-parent chain +
new-parent chain + the moved/split nodes**. Re-synthesis is bottom-up: `WHERE is_stale ORDER BY
depth DESC`. This removes the counter-miscount race entirely.

### Final table set (core)
`meta`, `sources`, `source_texts`, `source_chunks`, `spans`, `nodes`, `claims`, `claim_spans`,
`entities`, `relationships`, `relationship_spans`, `changelog`, `rendered_files`.
FTS5 (external-content, 3 triggers each: insert / delete / update): `chunks_fts`, `claims_fts`,
`nodes_fts`.
**Dropped from §2 for V1:** `entity_types`/`relationship_types` (type is TEXT + a recommended
vocabulary the skill documents), `entity_aliases`, `node_claims` join (claims carry `node_id`
directly — one owning leaf per claim), `open_questions` table (conflicts live as claim
`status='conflicted'`; `open-questions.md` is rendered from conflicted claims and
`claim_type='open_question'` claims),
`token_budget`, revision-counter columns, `entities_fts`.

### Knowledge graph — first-class but lean
Entities & relationships stay first-class (hard requirement #13). `type`/relationship-`type` are
TEXT validated against a recommended-but-extensible vocabulary (§3) — no FK lookup tables.
Resolution = exact `(type, normalized_name)` match, normalized = lowercase + collapse internal
whitespace, **no version stripping** (versions are identity: `React 18` ≠ `React`). No fuzzy
auto-merge in V1; `kb entity merge <a> <b>` is an explicit, audited, FK-repoint op. Relationships
carry provenance via `relationship_spans`.

### Inline citations — agent writes refs, CLI generates footnotes
Node `body_md` carries GFM footnote refs `[^clm_<id>]` only. The renderer GENERATES the footnote
definitions from the DB (agent never authors them). `verify` extracts refs by fixed regex and
checks each resolves to a claim that is (a) `active` (conflict callouts may cite `conflicted`
pairs), and (b) owned by the node (leaf) or present in its subtree (parent). Every leaf node body
must carry ≥1 ref. Parent nodes may cite any claim in their subtree (provenance stays monotonic).

### Idempotency — natural keys + upsert, report created/updated/unchanged
Every `apply` command runs in ONE `BEGIN IMMEDIATE` transaction and returns
`{created, updated, unchanged}` counts. Natural keys: source by `sha256`; chunk by
`(source_id, chunk_index)` over versioned chunker; span by `(source_id, char_start, char_end)`;
claim by `(node_id, normalized_text)`; claim_span by `(claim_id, span_id, role)`; entity by
`(type, normalized_name)`; relationship by `(type, subject, object)`. Re-ingesting identical bytes
with new metadata updates metadata only (same `source_id`), reports `unchanged|updated`.
`kb synthesize` sets the node fresh and no-ops on an unchanged `(body_md, ref-set)`.

### answer-check — structural/provenance only (honest scope)
Deterministic checks: every answer claim-ref resolves to an `active`, span-backed claim; flag
assertive answer sentences with no ref. Semantic entailment / "over-reach" detection needs an
NLI/LLM step → deferred. Documented as such.

### Render determinism
No wall-clock in rendered file bodies (all timestamps come from stored DB rows). Canonical order
`ORDER BY sort_order, id`. Render header carries `content_hash` (sha256 of the file body sans
header). `kb render --check` recomputes & compares against `rendered_files`. `Object` keys sorted
in any serialized JSON.

### Schema/version gate
`meta(schema_version)`; every command opens the DB through a guard that errors if the on-disk
`schema_version` is newer than the binary supports. `kb init` writes it; migration runner is
idempotent and records applied versions.

### Module decomposition & build order (TDD)
Layers (deps flow downward only): `db/` (connection, migrations, repositories) → `domain/schemas`
(branded ids, row schemas, agent-payload schemas) → `domain/algorithms` (PURE: hash, chunker,
normalizer, idDeriver, quoteVerifier, offsetMapper, staleness) → `domain/services` (Ingest, Claim,
Node, Entity, Provenance, Staleness; repos + a `SourceStore` injected) → `render`/`search`/`verify`
→ `cli`. Build/test order: (1) connection+migrations+source/chunk repos, (2) pure algorithms to
~full branch coverage, (3) Ingest+Claim services with the atomicity & quote-verify tests,
(4) Node+Staleness, (5) search+verify, (6) render, (7) CLI commands, (8) skills + e2e demo ingest.

### Skills — three
`kb-create`, `kb-ingest`, `kb-query` (project-local under `.claude/skills/`, wrapping the `kb`
CLI). Maintenance guidance folds into a section of each.
