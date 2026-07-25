# Phase 2 — Corpus Batching and Synthesis Context

Goal: collapse the corpus-scale orchestration cost — one read that returns everything
a synthesis write needs, one manifest that creates a whole hierarchy, and batch
synthesis — while keeping every apply atomic.

Depends on Phase 1 (validator, dry-run runner, receipt conventions). Est. ~2–3 days.
Revised per Codex findings 10, 14, 24–26.

## Deliverables

1. `kb node show <id> --context` — the synthesis-ready bundle.
2. `kb node apply --file hierarchy.json [--dry-run]` — atomic hierarchy manifest.
3. Batch `kb synthesize --file` (`{"nodes":[…]}`) with deepest-first apply.
4. The named steering flip "stale-target v2" (01 §6.1): stale steering now emits
   `kb node show <id> --context --json`.
5. `scripts/baseline-new.sh` + snapshot-based equivalence + command-count
   comparison.

## 1. `kb node show <id> --context`

One flag; compact-complete; no pagination; no silent truncation; conflicts appear
as claim `status` only. Without `--context`: current behavior unchanged.

Envelope with `--context`:

```jsonc
{
  "ok": true,
  "data": {
    "node": { "id", "parentId", "title", "kind", "depth", "summary", "isStale",
              "bodyMd": "…current prose…", "bodyHash": "…" },   // full node — the agent revises the existing body (finding 25)
    "children": [ { "id", "title", "kind", "summary", "isStale", "ownClaims": 4 } ],
    "claims": [
      { "id": "clm_…", "text": "…", "claimType": "fact", "status": "active",
        "confidence": 0.9, "nodeId": "nod_…", "nodeTitle": "Rate limiter",
        "provenance": [ { "sourceId": "src_…", "sourceTitle": "…", "quoteSnippet": "first 160 chars…" } ] }
    ],
    "sources": [ { "id": "src_…", "title": "…", "claimCount": 12 } ],
    "allowedCitationIds": ["clm_…"],
    "stats": { "descendantNodes": 6, "claims": 41, "approxTokens": 5200, "complete": true }
  },
  "issues": [], "errors": [], "warnings": [],
  "nextActions": [],
  "hints": [
    "Author a synthesis payload citing only allowedCitationIds, then: kb synthesize --file <payload.json> --dry-run --json",
    "Full quotes: kb provenance <claim_id> --json (snippets over 160 chars are truncated)"
  ]
}
```

Decisions (finding 25):

- The synthesis authoring step needs a file the CLI cannot know, so it is a
  **hint** (template), not a NextAction — NextActions are verbatim-only (01 §2).
- **Total ordering keys** (deterministic under ties):
  claims by `(ownerDepth asc, ownerSortOrder asc, ownerNodeId, createdAt, claimId)`;
  `provenance` within a claim by `(sourceId, charStart, spanId)`;
  `children` by `(sortOrder, nodeId)`; `sources` by `(title, sourceId)`;
  `allowedCitationIds` lexicographic.
- Claim statuses included: `active` + `conflicted` (mirrors
  `allowedCitationIds`).
- `quoteSnippet`: first 160 chars, whitespace-collapsed, `…` suffix when longer;
  the provenance hint appears whenever any snippet was truncated.
- **`approxTokens` measurement subset** (no self-reference):
  `ceil(JSON.stringify({node, children, claims, sources, allowedCitationIds}).length / 4)` —
  computed before `stats` is attached; envelope fields excluded. `complete` is
  always `true` in this phase (field exists so future pagination is additive).
  `approxTokens > 24000` adds the "synthesize children first" hint.
- **Provenance query**: one batched
  `SELECT … FROM claim_spans cs JOIN spans s ON … WHERE cs.claim_id IN (…) ORDER BY cs.claim_id, s.char_start, s.id`,
  grouped in memory — not one query per claim.
- Read-only; no dry-run.

Tests: leaf/topic/root shapes; owner tagging; superseded claim excluded from both
`claims` and `allowedCitationIds`; every ordering tie-break (fixture plants equal
keys); snippet truncation hint; `approxTokens` excludes stats/envelope
(self-reference regression); body present.

## 2. `kb node apply` — hierarchy manifest

Payload schema unchanged from prior revision (`nodes` forest; `ref` per spec;
top-level-only `parent_id`; nested `children`). Prevalidation corrected for replay
(finding 24):

| Rule | Issue |
|---|---|
| `ref` unique within manifest | `DUPLICATE_REF` |
| two **manifest** entries resolve to the same `(parent, slug)` | `DUPLICATE_SLUG` (manifest-internal only) |
| spec collides with an **existing DB node** (same derived id, since ids derive from `(parent, slug)`): kind and title both match | → outcome `existing` (NOT an error — this is exactly the replay case) |
| …existing node, `kind` differs | `NODE_KIND_MISMATCH` |
| …existing node, `title` differs | `NODE_TITLE_MISMATCH` |
| root rule: count **distinct logical root ids** = existing root's id ∪ derived ids of manifest root specs; >1 ⇒ error. A root spec whose derived id equals the existing root's id is a replay, not a second root. | `MULTIPLE_ROOTS` |
| root spec with a parent / non-root spec without a resolvable parent | `ROOT_HAS_PARENT` / `PAYLOAD_SCHEMA` |
| top-level `parent_id` not in DB | `UNKNOWN_PARENT_REF` |

All issues collected and returned together; any error ⇒ nothing applied. Apply:
one transaction, parents before children, via `NodeService.createNode`. Exact
manifest replay ⇒ all outcomes `existing`, zero writes, no changelog.

Envelope:

```jsonc
{ "ok": true,
  "data": { "dryRun": false,
            "nodes": [ { "ref": "root", "nodeId": "nod_…", "outcome": "created" } ],
            "totals": { "created": 20, "existing": 1 }, "staleNodes": ["…"] },
  "issues": [], "errors": [], "warnings": [],
  "nextActions": [],
  "hints": [ "Map claim payload node_id values from the ref→nodeId list above",
             "No sources yet — ingest before extracting claims: kb ingest <path> --json" ] }
```

(The ingest suggestion carries a placeholder, so it is a hint; when sources exist
the second hint is replaced by "kb claim apply --help --json shows the payload
shape".)

`--dry-run` via the Phase 1 runner. Tests: nested 21-node create; graft under
existing parent; each prevalidation rule; **full-manifest replay including the
root** (finding 24's regression); kind-mismatch fails atomically; ref→nodeId map.

## 3. Batch `kb synthesize`

As previously specified (single object or `{"nodes":[…]}`, max 200; prevalidate all
with `path: "nodes[i]…"` prefixes via `formatPath`; any error ⇒ atomic fail; apply
deepest-first, ties by payload order; per-node outcomes per Phase 1 rules;
duplicate `node_id` in batch ⇒ `PAYLOAD_SCHEMA` naming both indices).

**Order verification** (finding 26 — the parent-cites-child test is vacuous):
a unit test spies on `NodeRepo.updateBody`/`clearStale` call order for a mixed-depth
batch and asserts strictly non-increasing depth, including equal-depth payload
order. The receipt echoes `depth` per node for visibility, and an integration test
asserts the receipt's `nodes[]` ordering matches the spy order.

## 4. Measurement (finding 26)

- `scripts/baseline-new.sh`: `node apply` ×1, claim applies ×3, graph ×1,
  `--context` reads, batch synthesize ×3, then `kb verify --strict --json`,
  `kb render --json`, `kb render --check --json` (render before check).
- **Equivalence**: `scripts/kb-snapshot.ts` (Phase 0) output of old-script KB ≡
  new-script KB — the normalized semantic snapshot (no timestamps/changelog/render
  bookkeeping; raw DB bytes are *expected* to differ).
- **Acceptance criterion**: `COMMANDS(new) ≤ 0.5 × COMMANDS(old)` recorded in
  `docs/plans/baseline.md`, and the new script contains no synthesis-context
  assembly other than `--context` reads.

## Acceptance (Phase 2 done when)

- §1–§3 tests green (including replay, ordering-spy, self-reference regressions);
  Phase 0/1 suites green with goldens updated per the compatibility policy.
- Snapshot equivalence + ≤50 % command count hold.
- Steering flip "stale-target v2" applied and asserted by the steering table test.
