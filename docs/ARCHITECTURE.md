# Architecture & Implementation Guide

A deep walkthrough of how `knowledge-base-ingest` is built and why. For how to *use* it,
see [USER_GUIDE.md](USER_GUIDE.md). For the original design record and the contested
decisions, see [DESIGN.md](DESIGN.md).

---

## 1. Thesis

A knowledge base is only trustworthy if **every generated statement can be traced to a
source, and that link cannot silently rot or be faked**. This system makes that an
*enforced invariant* rather than a convention by choosing:

- **SQLite as the single source of truth** for all derived/generated state (synthesis
  prose, claims, provenance edges, the knowledge graph). Foreign keys and a quote-verified
  provenance chain make "untraceable knowledge" structurally impossible to persist.
- **Markdown as a deterministic, read-only projection** of the database — the human view,
  regenerated on demand, never the authority.
- **Immutable, content-addressed source copies** segregated from everything derived.
- **A hard boundary**: the AI agent only *proposes* Zod-validated JSON; the CLI *validates
  and persists* inside a single transaction. All judgment (what a claim is, how to phrase
  synthesis) lives in the agent; all determinism (hashing, chunking, quote verification,
  staleness, render) lives in tested code.

Everything below follows from those four choices.

---

## 2. System layers

Dependencies flow strictly downward. Nothing in a lower layer imports from a higher one.

```
┌──────────────────────────────────────────────────────────────┐
│ cli/            argument parsing, command dispatch, envelope   │  src/cli/
├──────────────────────────────────────────────────────────────┤
│ kb/             workspace (open/init), scaffold (AGENTS.md)    │  src/kb/
├──────────────────────────────────────────────────────────────┤
│ render/  verify/  query/   feature modules over repositories   │  src/render, src/verify, src/query
├──────────────────────────────────────────────────────────────┤
│ domain/services/    Ingest · Claim · Graph · Node · spanResolver│ src/domain/services/
├──────────────────────────────────────────────────────────────┤
│ domain/algorithms/  PURE: hash, idDeriver, normalize, chunker, │  src/domain/algorithms/
│                     quoteVerifier, citations                   │
│ db/repositories/    typed data access (one class per aggregate)│  src/db/repositories/
├──────────────────────────────────────────────────────────────┤
│ db/   connection, migrations, rows (Zod row→model parsers)     │  src/db/
│ domain/schemas/  enums, ids (branded), models, agent payloads  │  src/domain/schemas, src/domain/ids
│ ingest/sourceStore   immutable file storage (injected)         │  src/ingest/
└──────────────────────────────────────────────────────────────┘
```

| Layer | Responsibility | Key property |
|---|---|---|
| `domain/algorithms` | Pure functions, zero I/O | Deterministic; ~full unit coverage |
| `db` | Schema, connection, typed repositories | Every read re-validated by Zod |
| `domain/services` | Transactional business logic | All judgment-free; atomic |
| `render`/`verify`/`query` | Read-mostly features | Pure-ish, testable in isolation |
| `cli` | Thin dispatch + `{ok,data,warnings,errors}` envelope | No business logic |

The seams that keep LLM judgment out of the deterministic core:
- Agent JSON enters at exactly one point per command — a `*Schema.parse()` in `cli/index.ts`.
  If Zod throws, the command fails before any DB write.
- Quote verification (`spanResolver.ts` → `quoteVerifier.ts`) runs after Zod, before any
  span is persisted.
- FTS sync is in SQL triggers, so no code path can write a chunk/claim/node without updating
  its search index.

---

## 3. Data model (SQLite schema)

Defined in [`src/db/migrations.ts`](../src/db/migrations.ts). All domain tables are `STRICT`
(typed storage), use `PRAGMA foreign_keys=ON`, WAL, and stable text ids with a type prefix
(`src_`, `chk_`, `spn_`, `nod_`, `clm_`, `ent_`, `rel_`).

### The provenance chain (the spine)

```
synthesis node.body_md  ──[^clm_…] inline citation──►  claims
                                                          │
                                          claim_spans (role=supports)
                                                          ▼
                                                        spans  ──►  source_chunks
                                                          │              │
                                              (char_start, char_end, quote, quote_hash)
                                                          ▼              ▼
                                                    source_texts (canonical) ◄── sources (immutable bytes)
```

Reading bottom-up: an immutable **source** has a canonical **source_text**; it is split into
**source_chunks**; a **span** is an exact `[char_start, char_end)` slice of the canonical
text (carrying the verified `quote`); a **claim** is justified by one or more spans via
**claim_spans**; a **node**'s prose cites claims inline, which the renderer turns into
footnotes. The knowledge graph hangs off the same spans via **relationship_spans**.

### Tables

| Table | Purpose | Natural key / notes |
|---|---|---|
| `meta` | `schema_version`, bookkeeping | `k` PK |
| `sources` | immutable registry: hash, stored path, title, status, `supersedes_source_id` | `sha256` UNIQUE |
| `source_texts` | **canonical extracted text** + extractor name/version | offsets address *this* text |
| `source_chunks` | deterministic structure-aware chunks + char offsets | `(source_id, chunk_index)` UNIQUE |
| `spans` | atomic provenance target: `(char_start,char_end,quote,quote_hash)` | `(source_id, char_start, char_end)` UNIQUE |
| `nodes` | synthesis tree: `parent_id`, `slug`, `kind`, `depth`, `body_md`, `is_stale` | `(parent_id, slug)` UNIQUE |
| `claims` | knowledge atoms: `text`, `normalized_text`, `claim_type`, `status`, `superseded_by_claim_id` | `(node_id, normalized_text)` UNIQUE |
| `claim_spans` | claim→span provenance edges, `role`, `extractor` | `(claim_id, span_id, role)` PK |
| `entities` | KG nodes: `type`, `canonical_name`, `normalized_name` | `(type, normalized_name)` UNIQUE |
| `relationships` | KG edges: `type`, subject/object entity ids, `status` | `(type, subject, object)` UNIQUE |
| `relationship_spans` | relationship→span provenance | `(relationship_id, span_id, role)` PK |
| `changelog` | append-only mutation log | for `changelog.md` + audit |
| `rendered_files` | per-file content hash for drift detection | `path` PK |
| `chunks_fts` / `claims_fts` / `nodes_fts` | FTS5 external-content indexes | kept in sync by triggers |

### Why `source_texts` is separate from `sources`

The raw bytes are immutable and content-hashed, but a *quote* must be addressed against a
stable, decoded string. `source_texts` stores the **canonical extracted text** produced by a
named, versioned extractor (`text-utf8/1`: strip BOM, CRLF→LF, Unicode NFC). All character
offsets and quotes are defined against this string, in **JS UTF-16 code units** (the units
`String.prototype.slice` uses), so multi-byte characters line up and the provenance chain is
stable forever. (This was a fix surfaced by an independent design review — addressing raw
bytes would have broken on encoding/line-ending differences.)

### FTS sync via triggers

Each FTS table is external-content over its base table and kept consistent by three triggers
(`_ai` insert, `_ad` delete, `_au` update-as-delete+insert). Putting sync in SQL means no
application path can desync the index, and the update trigger prevents the classic "old text
still searchable after an edit" bug. `verify` additionally runs each index's built-in
`integrity-check`.

---

## 4. The deterministic core (`domain/algorithms`)

Pure functions, no I/O, no clock, no randomness — hammered by unit tests because everything
downstream trusts them.

| Module | Guarantees |
|---|---|
| `hash.ts` | `sha256Hex` — byte-exact, no hidden normalization |
| `normalize.ts` | `normalizeSourceText` (canonical text); `normalizeClaimText` / `normalizeEntityName` (identity keys — lossy on purpose, never used to address source); `slugify` |
| `idDeriver.ts` | Content-addressed ids: same inputs → same id (the basis of idempotency) |
| `chunker.ts` | Structure-aware, **exact-tiling** chunking (chunks concatenate back to the input, no gaps/overlap), respects fenced code blocks, size-splits oversized sections |
| `quoteVerifier.ts` | `verifyQuote` — exact substring at exact offsets, no normalization, no fuzzy match |
| `citations.ts` | Extract `[^clm_…]` references from prose |

### Identity & idempotency

Ids are `<prefix> + first 16 hex of a SHA-256` of a stable tuple:

| Entity | Derived from | Consequence |
|---|---|---|
| source | raw bytes | re-ingesting identical bytes is a no-op |
| chunk | `(source_id, chunk_index)` | stable across re-runs |
| span | `(source_id, char_start, char_end)` | same quote range → same span (provenance dedupes) |
| claim | `(normalized_text, first_seen_source_id)` | node-independent, so a claim keeps its id when it moves between nodes |
| entity | `(type, normalized_name)` | exact-match resolution; **versions are not stripped** (`React 18` ≠ `React`) |
| relationship | `(type, subject_id, object_id)` | |
| node | `(parent_id, slug)` | re-creating the same node is idempotent |

The derived id is a *stable handle*; the real dedup guard is the `UNIQUE` natural key in the
DB. Services look up by natural key, then upsert — and report `{created, updated}` counts.

> **Subtlety (review-fixed):** claims dedupe by `(node_id, normalized_text)`, not by the
> derived id. The same assertion reaching the same node from a *second* source attaches new
> provenance to the existing claim rather than colliding — and a re-extraction never resets a
> superseded claim back to active (status is preserved on upsert). Covered by
> `regression.test.ts`.

---

## 5. Provenance — the keystone in depth

The single load-bearing mechanism. Its purpose is **anti-hallucination**, not anti-rot.

**Write path** (`ClaimService.apply`, `GraphService.apply` → `spanResolver.resolveSpan`):
1. The agent supplies a `chunk_id` + an exact `quote` (it never computes offsets).
2. The CLI locates the quote inside that chunk's text (`chunk.text.indexOf(quote)`); a
   not-found or **non-unique** quote is rejected (a citation must point at exactly one place).
3. It derives absolute offsets `chunk.charStart + idx` and re-verifies them against the
   canonical `source_texts.text` with `verifyQuote` — exact match, no normalization.
4. Only then is the span persisted (`quote_hash = sha256(quote)`), deduped by range, and
   linked via `claim_spans` / `relationship_spans`.

If any quote in a batch fails, the **whole transaction rolls back** — nothing is persisted.

**Audit path** (`verify`): re-runs the substring check for **every** span in the table (not
just claim-reachable ones, so a tampered graph-only span is caught too) and confirms each
`quote_hash` matches. A claim citing a superseded/retracted claim, or a claim with no
supporting span, is an error.

This is why "every generated part traces to a source" is a `JOIN`, not a hope: a span cannot
exist without an exact, re-verifiable quote, and a synthesis sentence's citation must resolve
to such a claim.

---

## 6. Hierarchical synthesis & staleness

The synthesis tree (`nodes`) has arbitrary depth: one `root`, then `topic`/`leaf` nodes.
**Leaf nodes own claims** (`claims.node_id`); a parent synthesizes its children and may cite
any claim in its subtree (provenance stays monotonic up the tree). Each node stores its prose
in `body_md` with inline `[^clm_…]` citations; the renderer generates the footnote
definitions (the agent never writes them).

**Staleness is a boolean** (`nodes.is_stale`), not a set of revision counters. When a node's
claims change — or a child is added — the node *and all its ancestors* are marked stale in one
recursive-CTE `UPDATE` (`markStaleWithAncestors`). Re-synthesis proceeds bottom-up:
`listStaleDeepestFirst()` orders by `depth DESC`. Writing a node's body via `synthesize`
clears its flag.

> This boolean model replaced a counter-based design during review: counters could mask
> staleness (an old high child-rev hiding a new low one) and mishandle moves/splits. A
> boolean + ancestor-walk is simpler *and* correct for those cases. See
> [DESIGN.md §9](DESIGN.md).

---

## 7. Knowledge graph

`entities` (typed, with `normalized_name`) and `relationships` (typed, subject→object), each
carrying provenance via `relationship_spans`. `type` is free **TEXT** validated against a
*recommended* vocabulary the skills document (Service, DataStore, Library, Concept, Pattern,
Decision, …; relationships: depends_on, stores_in, implements, supersedes, configured_by, …) —
extensible without schema changes. Resolution is exact `(type, normalized_name)`; normalization
lowercases and collapses whitespace but deliberately **does not** strip versions or
punctuation, because for software entities those are identity. No fuzzy auto-merge in V1.

---

## 8. The ingestion pipeline

The division of labor between deterministic CLI work and agent judgment:

| Step | Owner | Module |
|---|---|---|
| Register source (hash, dedup, store immutable copy, canonical text) | CLI | `IngestService` |
| Structure-aware chunk + FTS | CLI | `chunker`, triggers |
| Read chunks (the context bundle) | CLI | `source chunks` |
| Decide claims, types, exact quotes | **agent** | (skill) |
| Verify quotes, persist claims + spans (atomic) | CLI | `ClaimService` |
| Decide entities/relationships + evidence | **agent** | (skill) |
| Resolve + persist graph (atomic) | CLI | `GraphService` |
| Adjudicate conflicts/supersession | **agent** | (skill) + `claim supersede` |
| Build/choose synthesis nodes | **agent** | `node create` |
| Mark stale (automatic on claim apply / node create) | CLI | recursive CTE |
| Re-synthesize stale nodes bottom-up | **agent** | `synthesize` |
| Verify + render | CLI | `verify`, `render` |

Every mutating command runs in one `BEGIN IMMEDIATE` transaction (`Repositories.tx`) and
appends to `changelog`.

### Conflict & supersession

- **Source level:** `ingest --supersedes <old>` marks the old source `superseded`.
- **Claim level:** the agent adds the new claim, then `claim supersede <old> --by <new>` sets
  the old claim `superseded` (with `superseded_by_claim_id`) and marks affected nodes stale.
- **Unresolved disagreement:** both claims stay, status `conflicted`; they surface in
  `kb/open-questions.md`. (Setting `conflicted` is a manual/agent step in V1.)

---

## 9. Rendering (DB → markdown)

[`src/render/render.ts`](../src/render/render.ts). `renderAll(repos)` is a **pure,
deterministic** function — same DB state → byte-identical output (no wall-clock in file
bodies; all ordering comes from stable `ORDER BY`). It produces, under `kb/`:

- `synthesis/…` — one file per node mirroring the tree (parents → `…/index.md`, leaves →
  `….md`), each with the node's prose, a `## Subtopics` list (parents), and a `## Sources`
  footnote section resolving every `[^clm_…]` to its claim text + exact source quote + stored
  path.
- `index.md` (sources + links), `changelog.md`, `open-questions.md`, `graph/entities.md`,
  `graph/relationships.md`.

`writeRender` writes the files and records each `content_hash` in `rendered_files`.
`checkRender` (via `render --check`) recomputes and reports `ok | missing | drifted` — the
read-only contract is enforced by detection, not file permissions.

---

## 10. Search & provenance-checked Q&A

[`src/query/query.ts`](../src/query/query.ts):

- `search(query, {scope, limit})` — FTS over chunks/claims/nodes (token-quoted to survive
  punctuation; **AND** semantics for precision) plus entity `LIKE`. Degrades to empty per
  scope on FTS error rather than throwing.
- `askContext(question, {limit})` — the primary Q&A retrieval. **OR** semantics (a natural
  question AND-joined would match nothing) returns relevant `active`/`conflicted` claims, each
  enriched with owning-node title and full provenance (source title + exact quote). Plus
  related nodes and entities.
- `answerCheck(answer)` — a **structural** gate: every `[^clm_…]` in the answer must resolve
  to an `active` claim; assertive sentences must carry a citation (the splitter keeps a
  citation attached to the sentence it follows, even when it sits right after the period).
  Returns `{ok, unknownCitations, inactiveCitations, uncitedSentences}`. It does **not** check
  semantic entailment — that needs an NLI/LLM pass and is deferred (documented in-module).

---

## 11. The `verify` invariants

[`src/verify/verify.ts`](../src/verify/verify.ts) — read-only, each finding has a stable
`check` name. `--strict` turns warnings into failures.

| Check | Severity | What it guarantees |
|---|---|---|
| `claim-has-provenance` | error | every active claim has ≥1 supporting span |
| `quote-matches-source` | error | **every** span (incl. relationship-only) still quotes its source exactly; `quote_hash` intact |
| `citation-resolves` | error | every inline `[^clm_…]` resolves to a claim |
| `parent-cites-subtree` | error | a node only cites claims in its subtree |
| `citation-active` | error | prose does not cite a superseded/retracted claim |
| `leaf-has-citation` | warning | a leaf with a body cites ≥1 claim |
| `no-stale-nodes` | warning | nothing needs re-synthesis |
| `fts-integrity` | error | each FTS index passes its internal integrity-check |

---

## 12. Type-safety design

- **Branded ids** ([`src/domain/ids.ts`](../src/domain/ids.ts)): phantom-typed strings so a
  `ChunkId` can't be passed where a `SourceId` is expected. Constructed only via `make*`
  (prefix-validating) or `idDeriver`.
- **Single Zod boundary**: agent payloads ([`schemas/agent.ts`](../src/domain/schemas/agent.ts))
  parsed at the CLI edge; raw DB rows parsed into camelCase domain models in
  [`db/rows.ts`](../src/db/rows.ts) on every read. Nothing past the repository layer sees a
  raw row; nothing past the CLI edge sees unparsed agent input.
- `tsconfig` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No
  `any` in the codebase.

---

## 13. Transactions, concurrency, errors

- Multi-table mutations run in one `db.transaction(fn).immediate()` — a write lock is taken up
  front, and a thrown error (Zod failure, quote mismatch, FK violation) rolls everything back.
- The output envelope is uniform: `{ ok, data, warnings, errors }`. Exit code is 1 when
  `ok:false`. Zod errors are flattened to readable `path: message` strings.
- The source store resolves and asserts every read path stays under `<root>/sources`, and
  sanitizes extensions — defense in depth even though paths are derived from content hashes.

---

## 14. Testing strategy

Built test-first (red/green/refactor). 94 tests across 14 files; `pnpm test`, `pnpm typecheck`.

| Layer | How it's tested |
|---|---|
| `domain/algorithms` | Pure unit tests, edge cases (CRLF, BOM, emoji offsets, code-fence headings, exact tiling) |
| `db` | In-memory SQLite: migrations idempotent, FK + CHECK + STRICT enforced, FTS update triggers |
| `domain/services` | Integration against in-memory DB + `MemorySourceStore` + injected clock: quote verification, **atomicity rollback**, idempotency, staleness |
| `render`/`verify`/`query` | Seeded in-memory KB: determinism, drift, tamper detection, retrieval, answer-check |
| `cli` | Subprocess test of the real `kb` binary: envelope, exit codes, the provenance gate |
| `regression` | The bugs an independent (Codex) implementation review found |

Test doubles are injected (`Db`, `SourceStore`, `now`), never `jest.mock` on internal modules.

---

## 15. Key design decisions & trade-offs

| Decision | Why | Cost accepted |
|---|---|---|
| SQLite-as-truth, markdown read-only | provenance is enforceable only in a relational graph | humans read but don't hand-edit synthesis |
| Quote-verified spans (kept despite a "cut it" review) | the anti-hallucination keystone | agent must copy exact text |
| Boolean staleness, not counters | simpler *and* fixes move/split miscount bugs | none material for single-user |
| Claim-level (not sentence-level) prose decomposition | ships V1; readable agent-written prose | sentence-granular provenance deferred |
| Free-TEXT graph types + vocabulary | extensible without migrations | no enforced ontology |
| `answer-check` is structural only | deterministic and shippable | semantic entailment deferred |
| Render to read-only md, drift by hash | zero "DB says X, doc shows Y" | re-render after content changes |

---

## 16. Extension points (V2)

- **Source extractors:** `source_texts` already records `extractor`/`extractor_version`; add a
  PDF/HTML extractor that produces canonical text + offset anchors.
- **Entity resolution:** add `entity_aliases` + fuzzy candidates + an audited `entity merge`
  (FK repoint).
- **Sentence-level provenance:** promote `body_md` to block/sentence records mapping each
  sentence to claims (the schema already isolates claims as the atom).
- **Semantic answer-check:** add an NLI/LLM pass on top of the structural gate.
- **Embeddings:** add a vector index alongside FTS for semantic retrieval in `query`.
- **Node restructuring:** `node move`/`split`/`merge` as claim-reparenting operations (claims
  carry node-independent ids precisely to make this lossless).

The guiding principle to preserve through any extension: **make unsupported knowledge
impossible to persist through normal commands.**
