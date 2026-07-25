# Phase 1 — Previewable Mutations and Actionable Receipts

Goal: the payload-authoring commands (`claim apply`, `graph apply`, `synthesize`,
`ingest`; `node apply` joins in Phase 2 — this exact list is the dry-run scope,
01 §6.2) can be previewed through the real code path; every mutation returns a
per-input receipt with IDs and honest dedup accounting; exact repeats become true
no-ops; synthesis validation closes its persist-then-fail gap.

Depends on Phase 0. Est. ~3 days. Revised per Codex findings 10–12, 17–23.

## Deliverables

1. Shared synthesis validator + `DomainIssueError` migration of service errors.
2. `--dry-run` on `claim apply`, `graph apply`, `synthesize`, `ingest`.
3. Per-input receipts (compatibility matrix below).
4. Exact-repeat no-op semantics for claims, graph, and synthesis.
5. Ingest `prepare/plan/commit` split + source-store cleanup contract.
6. `LEGACY` no longer emitted anywhere (registry entry retained).

## 1. Synthesis validator

```ts
// src/domain/services/synthesisValidator.ts
export interface SynthesisValidation {
  issues: DomainIssue[];           // codes below; [] when valid
  allowedCitationIds: ClaimId[];   // sorted lexicographically
}
export function validateSynthesis(repos, payload: Synthesize): SynthesisValidation;
export function allowedCitations(repos, nodeId: NodeId): ClaimId[];
```

- `allowedCitations(node)` = claims `status ∈ {active, conflicted}` owned by the
  node's subtree (`ClaimRepo.listInSubtree` + status filter), sorted.
- Per-citation precedence (finding 23) — exactly **one issue per distinct cited
  claim id**, first matching rule wins:
  1. unknown id → `CITATION_UNKNOWN`;
  2. known, status superseded/retracted → `CITATION_INACTIVE` (dominates: even a
     correctly-owned inactive claim is uncitable; hint names the superseding claim
     when set);
  3. known, active/conflicted, but outside the subtree → `CITATION_OUT_OF_SUBTREE`
     (`ids: [claimId, owningNodeId]`).
  Issue order = first occurrence of the citation in `body_md`.
- `NodeService.synthesize()` rejects on any issue (tightens the current
  existence-only check, `nodeService.ts:93-98`). `verify` retains its own checks as
  defense in depth.
- Ancestor staleness on synthesis (finding 23): a `title` or `summary` change marks
  the parent chain stale (both are parent-render/synthesis inputs); a body-only
  change never affects ancestors. Test the stale/content/title/summary
  cross-product.

Error-type migration (finding 12): `ProvenanceError`/`NodeError` become
`DomainIssueError` subtypes carrying `{code, path?, ids?}`
(`QUOTE_NOT_FOUND`, `QUOTE_AMBIGUOUS` with `path` like `claims[2].spans[0].quote`
via `formatPath`, `UNKNOWN_NODE`, `UNKNOWN_SOURCE`, …). The CLI maps them to
issues + registry hints. No message-string matching anywhere.

## 2. Dry-run runner

```ts
class DryRunRollback extends Error {}
export function inDryRunTx<T>(repos: Repositories, fn: () => T): T {
  let out!: T;
  try { repos.tx(() => { out = fn(); throw new DryRunRollback(); }); }
  catch (e) { if (!(e instanceof DryRunRollback)) throw e; }
  return out;
}
```

- Verified by review: `repos.tx` = `db.transaction(fn).immediate()`; better-sqlite3
  nests inner `tx` calls as savepoints, and outer rollback removes content rows
  **and** FTS trigger rows. Sound for all DB-only services.
- Applied by `runAction` for `claim apply`, `graph apply`, `synthesize` when
  `--dry-run`. **Ingest uses `plan` instead** (§5) — its store write is outside the
  DB transaction.
- Dry-run with validation errors → `result(null | partialReport, issues)`, exit 1.
- **Receipt parity projection** (finding 18): tests compare dry-run vs. real
  receipts on `{ perInput outcomes, ids, span accounting, staleNodes }` only —
  `dryRun`, `nextActions`, `hints`, and clock-derived fields excluded. Steering is
  asserted separately: dry-run(file payload) steers to the same command without
  `--dry-run`; dry-run(stdin) emits the hint from 01 §6.1; the real apply steers
  per the steering table.

## 3. Receipts

All examples below are **complete envelopes** (finding 10): command payload under
`data`, guidance at the envelope level.

### 3.1 `claim apply`

```jsonc
{
  "ok": true,
  "data": {
    "dryRun": false,
    "claims": [
      { "inputIndex": 0, "claimId": "clm_a", "outcome": "created",
        "spans": { "submitted": 2, "spansCreated": 2, "spansReused": 0, "linksCreated": 2, "linksReused": 0 } },
      { "inputIndex": 1, "claimId": "clm_b", "outcome": "unchanged",
        "spans": { "submitted": 1, "spansCreated": 0, "spansReused": 1, "linksCreated": 0, "linksReused": 1 } }
    ],
    "totals": { "created": 1, "updated": 0, "unchanged": 1,
                "spansCreated": 2, "spansReused": 1, "linksCreated": 2, "linksReused": 1 },
    "staleNodes": ["nod_leaf", "nod_topic", "nod_root"],
    "claimsCreated": 1, "claimsUpdated": 0, "spansCreatedNet": 2, "affectedNodes": 1   // deprecated aliases, see matrix
  },
  "issues": [], "errors": [], "warnings": [],
  "nextActions": [ { "title": "Synthesize stale node \"Rate limiter\"", "command": "kb node show nod_leaf --json" } ],
  "hints": ["2 more stale nodes (kb node tree --json lists them deepest-first)"]
}
```

- Invariant per input: `spansCreated + spansReused === submitted`; same for links.
- Outcomes: `created` | `updated` (confidence raised and/or ≥1 new span/link) |
  `unchanged` (§4).
- Changelog: one entry iff `created + updated > 0`.
- Staleness: only nodes owning `created`/`updated` claims.
- Phase 1 steering emits `kb node show <id> --json`; Phase 2 flips to `--context`
  (named flip, 01 §6.1).

### 3.2 `graph apply` (finding 22)

Same receipt pattern (`entities[]`, `relationships[]` with per-input
`evidence` accounting, `totals`). Schema corrections, listed in the compatibility
matrix because both eliminate silent data loss:

- `EntityInputSchema.evidence` is **removed** — the service has never persisted it
  (there is no `entity_spans` table); accepting-and-dropping violates the receipt
  contract. Payloads that still send it fail `PAYLOAD_SCHEMA` with hint
  "entity evidence is not stored; attach evidence to relationships or claims".
- Relationship evidence uses a new `RelEvidenceSchema` = `{chunk_id, quote, role}`
  (no `confidence` — `relationship_spans` has no such column; previously silently
  dropped). Hint on violation explains the same.
- Evidence-only additions to an existing relationship ⇒ outcome `updated`.
- Changelog iff `created + updated > 0` (today it always writes — fixed).
- No `staleNodes` field at all: graph mutations never stale nodes; the field is
  omitted rather than always-empty (01 §6.1 keeps graph out of stale steering).

### 3.3 `synthesize` (single; batch in Phase 2)

`data`: `{ nodeId, outcome: "updated" | "unchanged" | "stale-cleared",
staleNodes: [...] , updated: true, unchanged: false }` (last two = deprecated
aliases of today's fields). Steering per table.

### Compatibility matrix (finding 11)

| Command | Old field | Disposition |
|---|---|---|
| `claim apply` | `claimsCreated`, `claimsUpdated`, `affectedNodes` | kept as aliases (deprecated in HelpSpec) |
| `claim apply` | `spansCreated` (net after-minus-before) | renamed `spansCreatedNet` alias; new accounting is authoritative |
| `graph apply` | aggregate counts | kept as aliases |
| `graph apply` | entity `evidence`, relationship evidence `confidence` | **breaking** (silent-loss elimination): `PAYLOAD_SCHEMA` with explanatory hint |
| `synthesize` | `updated`, `unchanged`, `missingCitations` | kept as aliases (`missingCitations` always `[]` — superseded by issues) |
| `ingest` | `next` (string) | kept as alias mirroring `nextActions[0].command` |
| all | envelope `errors`/`warnings` strings | kept, derived (01 §2) |

Parity goldens update in the same commits; aliases live for all of envelope v2.

## 4. Exact-repeat no-op semantics

- **Claim input `unchanged`** iff: claim exists by `(node_id, normalizedText)`;
  `input.confidence <= existing.confidence`; and every span ref's **candidate**
  (§4.1) matches an existing span AND an existing `claim_spans` link on
  `(claim_id, span_id)` whose `role` equals the ref's and whose stored confidence
  `>=` the ref's. Zero writes for that input.
- Link semantics on non-matching refs (finding 21): link identity is
  `(claim_id, span_id)`; a differing `role` or a higher incoming confidence updates
  the link — confidence is monotone (`max(existing, input)`), never lowered.
  Outcome `updated`, counted as `linksReused` (identity existed) with a
  `linksUpdated` counter added to the totals.
- **Synthesize**: `unchanged` iff bodyHash, title, summary all unchanged AND node
  not stale → zero writes. Content unchanged + stale → `stale-cleared` via a new
  `NodeRepo.clearStale(nodeId, now)` which sets `is_stale = 0` **and**
  `updated_at = now` (explicit decision, finding 23 — clearing staleness is a real
  state change and is timestamped; the existing `setStale` helper is not reused for
  this) + one changelog entry (`detail.unchanged: true`).
- Whole-payload repeat ⇒ all inputs `unchanged` ⇒ zero writes, no changelog.

### 4.1 Span resolution split (finding 21)

`spanResolver` splits into:

```ts
resolveSpanCandidate(repos, sourceId, sourceText, ref): // READ-ONLY
  { charStart, charEnd, quote, existingSpanId: SpanId | null }
persistSpan(repos, candidate, now): SpanId              // insert iff existingSpanId === null
```

`ClaimService` classifies from candidates + link lookups before any write — no
circular "check before resolveSpan writes". Tests: mixed new/reused refs in one
claim; lower-confidence replay (no write, `unchanged`); role change (link update,
`updated`).

## 5. Ingest split: `prepare` / `plan` / `commit` (findings 19, 20)

```ts
prepareContent(input): PreparedContent   // pure: decode+validate, normalize, chunk, title, textHash
plan(input, repos): IngestPlan           // read-only: sha256 → duplicate | new(PreparedContent)
commit(plan, repos, store): IngestResult // store write + DB tx + cleanup
```

- **Duplicate-before-decode preserved**: `plan` computes `sha256(bytes)` and checks
  `getBySha256` **before** decoding; a duplicate never decodes (current behavior,
  `ingestService.ts:35-64`). Only `new` plans run `prepareContent`.
- `kb ingest <path> --dry-run` = `plan` only. Duplicate →
  `{ dryRun, status: "duplicate", sourceId, wouldUpdate: {title?, sourceDate?} }`;
  new → `{ dryRun, status: "new", sourceId, title, chunks, byteSize, mediaType }`.
  No store or DB writes by construction.
- **SourceStore contract change** (finding 19, blocker):
  - `store(sourceId, ext, bytes): { storedPath: string; created: boolean }` —
    atomic create (`fs.writeFileSync(..., { flag: 'wx' })`; `EEXIST` ⇒
    `created: false`). Content-addressed paths make concurrent same-source writers
    converge on one path: exactly one gets `created: true`.
  - `remove(storedPath): void` — chmod +w then unlink, ENOENT ignored. Implemented
    on `FsSourceStore` **and** the in-memory test store.
- `commit` order: `store()` first (capturing `created`), then the DB transaction,
  which **re-checks** `getBySha256` inside `BEGIN IMMEDIATE` (concurrent-winner
  detection) — if now duplicate, the transaction returns the duplicate result and
  the loser removes its file only if `created === true` (it never is for the loser,
  because the winner already created that path — the check is belt-and-braces).
  On any transaction failure: `if (created) store.remove(storedPath)` then rethrow.
- Tests: new commit; pre-existing file (created=false ⇒ no cleanup); injected tx
  failure ⇒ file removed; cleanup failure tolerated (warning issue, commit error
  still primary); simulated concurrent duplicate (pre-seeded row) ⇒ duplicate
  result, no file deletion.

## 6. Steering

Phase 1 rows of the normative table in 01 §6.1 (claim apply, graph apply,
synthesize, ingest, dry-run rows). No other rows change in this phase.

## Acceptance (Phase 1 done when)

- Dry-run available and state-clean on the four commands (row/changelog/FTS probes
  identical before/after); parity per the §2 projection.
- Receipts: per-input outcomes/IDs; `submitted = created + reused` holds in every
  test; compatibility aliases present.
- Exact repeats are true no-ops (claims, graph, synthesize tests).
- Synthesize rejects inactive/out-of-subtree citations with the §1 precedence;
  ambiguous-quote regression flipped green (structured `QUOTE_AMBIGUOUS`).
- `LEGACY` emission test passes suite-wide; typecheck + full suite green.
