# Fixture corpus

A deterministic mini knowledge base reproducing the report's workflow shape. Every
id below is content-derived (see `src/domain/algorithms/idDeriver.ts`), so the
payload files can reference nodes, chunks, and claims by their stable ids. If a
source is edited, ids shift and `tsx scripts/build-fixture.ts` fails loudly — that
build is the gate that keeps this corpus honest.

## Contents

- `sources/` — four sources: `design-notes`, `api-reference`, `meeting-transcript`,
  `press-release`. The press release is ingested but has **no** claims payload.
- `hierarchy.json` — Phase 2 manifest (04 §2) format: 1 root, 4 topics, 16 leaves.
- `claims/<source>.json` — per-source `claim apply` payloads (concrete `node_id` +
  `chunk_id` + exact `quote`).
- `graph/api-reference.json` — `graph apply` payload. **No** entity `evidence`, and
  relationship evidence carries **no** `confidence` (both removed in Phase 1, 03 §3.2).
- `synthesis/{leaves,topics,root}.json` — `{ "nodes": [ … ] }` synthesis payloads.
  Claimless leaves get an empty body so `verify --strict` (leaf-has-citation) passes.

## Planted invariants (asserted by build-fixture)

- Every span quote is an exact substring of its referenced chunk.
- ≥1 `open_question` claim is never cited in synthesis:
  `clm_b818b407b87ec929` ("burst credits roll over").
- ≥2 chunks in claimed sources carry no span (title chunks + the design-notes
  "Constraints" chunk).
- `press-release` has zero claim links (no claims payload → zero spans).
- Supersession pair on the `rate-limit-algorithm` leaf for the eval memo (07):
  old `clm_20e5846f3d00bec6` (100 rps, from design-notes) →
  new `clm_ba0a11995afc89d8` (1000 rps, from meeting-transcript).
- The design-notes "Constraints" chunk (`chk_1925a1ad04298baa`) repeats
  "The limit is enforced at the edge." — the ambiguous-quote trap for the
  `QUOTE_AMBIGUOUS` regression.

## Derived ids

Sources: `design-notes` `src_faa820ed6c8baf41` · `api-reference` `src_99b80b69b34da7d3`
· `meeting-transcript` `src_1b10eaa2e7f0d94a` · `press-release` `src_2769a4cdedc5235e`.

Nodes (ref → id):

| ref | id | ref | id |
|---|---|---|---|
| root | nod_474ea1fbe2191831 | operations | nod_b59826ba41efed7f |
| architecture | nod_9e3ee2a275995598 | deployment | nod_e2dc8cd1fcf18c5a |
| rate-limiter | nod_717ca2b0939923f7 | monitoring | nod_201c9799ff3508df |
| token-store | nod_f65f68035da154c1 | scaling | nod_f35c594fb1edcc6c |
| request-pipeline | nod_143c4c1f954e0937 | incident-response | nod_914b308b84726ed0 |
| caching-layer | nod_ab3a77075b3e40d5 | decisions | nod_69c71211bf98c0f5 |
| api | nod_ead3947854c0deaf | storage-choice | nod_563124d170a8508c |
| authentication | nod_1a1bbbd35770b507 | rate-limit-algorithm | nod_23b022cb91d8fa3b |
| endpoints | nod_815fa596b2ea21ac | open-questions | nod_5cc3194ad86019ad |
| error-responses | nod_c9d3d704e53ef6b8 | rollout-plan | nod_3523e28b1edd53db |
| pagination | nod_2bbad906d4e065a9 | | |

To re-derive every id (nodes, chunks, claims) after a corpus edit, the deriver is
pure: `deriveNodeId(parent, slug)`, `deriveChunkId(sourceId, index)`,
`deriveClaimId(normalizeClaimText(text), firstSeenSourceId)`.
