# Phase 0 — Contract and Baseline

Goal: make the tool identity, argument handling, and command contracts explicit and
machine-readable, and capture the baselines every later claim is measured against.
No domain behavior changes in this phase (except `source list`, which is a new
read-only command).

Prerequisite for all other phases. Est. ~2 days. Revised per Codex findings 1–8, 26,
39, 40.

## Deliverables

1. `runCli(argv, io)` extraction + Commander migration per
   [01-shared-contracts.md](01-shared-contracts.md) §1 (pre-parse router, strict
   argument rejection, standard options at all levels).
2. Envelope v2 + issue registry + domain `issueCodes.ts` + steering module.
   Existing handlers migrate mechanically (`LEGACY`-wrapped strings where no code
   applies yet; parse/argument paths use real codes).
3. HelpSpec for **every existing command** (the current CLI has **21** leaf
   commands — count derived from the registry, asserted by test, not hand-counted)
   + global workflow help.
4. `kb version` + root `--version` (router-handled).
5. `kb source list`.
6. Fixture corpus, retrieval fixture, baseline script, and known-bug regression
   tests (`test.fails`).

## 1. Migration order (red-green)

1. **Extract `runCli`** from the current hand-rolled dispatcher without changing
   behavior: move `main()`'s body into `runCli(argv, io)`; `index.ts` becomes the
   thin caller. Port the existing subprocess-style CLI tests to in-process `runCli`
   calls; keep one `bin/kb` subprocess smoke test. All 99 existing tests stay green.
2. **Golden parity tests** (`cli-parity.test.ts`) against `runCli`: exact envelopes
   for `status`, `ingest`, `source chunks`, `claim apply` (success + ambiguous-quote
   failure), `node tree`, `node show`, `synthesize`, `verify` (strict + non-strict
   on a warning-only KB), `render --check`, `search`, `ask-context`,
   `answer-check`, `provenance` on a seeded temp KB.
3. **Commander swap** inside `runCli`: `program.ts` + `run.ts` + `commands/*`
   registering all 21 commands with identical semantics (variadic
   `search <query...>`, `ask-context <question...>`,
   `claim conflict <claim_id...>`; `--file` optional with stdin/`-` default).
   Parity green (additive envelope fields only).
4. Delete the hand-rolled `parseArgs`/`TWO_WORD`/`commandHelp` machinery.

New argument-handling tests (fail before, pass after):

| Test | Expected |
|---|---|
| `kb search q --limt 5` | exit 2, `UNKNOWN_OPTION`, hint suggests `--limit` |
| `kb search q --limit banana` | exit 2, `INVALID_ARGUMENT`, "expected integer 1–200" |
| `kb search q --scope bogus` | exit 2, `INVALID_ARGUMENT`, lists `chunks|claims|nodes|entities|all` |
| `kb nodee tree` | exit 2, `UNKNOWN_COMMAND`, "did you mean node?" |
| `kb node frob` | exit 2, `UNKNOWN_COMMAND` (group has no action; finding 2) |
| `kb node` (bare group) | exit 0, router group help |
| `kb` (bare) | exit 0, global workflow help |
| `kb help` / `kb help claim apply` | exit 0, router help |
| every leaf `--help --json` with no other args | exit 0, HelpSpec envelope (finding 1 table test) |
| `kb source list --kb --json` | exit 2, `MISSING_ARGUMENT` ("--kb expects a value; got --json") |
| position matrix: `--json` at root/group/leaf positions | all exit 0, JSON output (finding 3) |
| `kb search a b c --json` | query "a b c" (variadic join parity) |
| `kb claim apply < payload.json` (stdin) | works as today |

## 2. `kb version` and root `--version`

Router-handled (never Commander; finding 4). Output (workspace-free; null fields
when no KB resolves):

```jsonc
{
  "ok": true,
  "data": {
    "cli": "0.1.0",                         // package.json version
    "node": "v22.x.x",
    "entry": "/abs/path/src/cli/index.ts",  // io-provided argv[1], resolved
    "schema": { "supported": 1, "onDisk": 1 },  // dynamic — currently 1 (currentSchemaVersion());
                                                 // no planned phase adds a migration
    "kbRoot": "/abs/kb/root"                // resolved root or null
  },
  "issues": [], "errors": [], "warnings": [], "nextActions": [],
  "hints": ["kb status --json shows KB contents; kb --help lists the workflow."]
}
```

- `onDisk` read via a read-only probe (no migration run); missing DB → `null`;
  schema-too-new is **reported**, not thrown (`version` must work when things are
  broken). Tests: no KB, older on-disk, too-new on-disk.
- `kb status` gains the same `cli` and `schema` fields.
- Rationale: skills preflight — a stale binary was previously indistinguishable
  from a missing feature.

## 3. `kb source list`

```
kb source list [--status active|superseded|duplicate|retracted] [--json]
```

`data`:

```jsonc
{
  "sources": [ { "id": "src_…", "title": "…", "status": "active", "sourceDate": null,
                 "mediaType": "text/markdown", "chunks": 14, "claims": 22,
                 "origin": null,             // {system, url} when set (Phase 4 metadata)
                 "ingestedAt": "…" } ],
  "counts": { "active": 3, "superseded": 1 }   // GLOBAL counts, unaffected by --status (finding 40)
}
```

- Ordering: `(ingestedAt, id)` — deterministic on ties (matches the repo's existing
  convention; finding 40).
- `claims` = distinct claims with ≥1 span from the source
  (`claim_spans → spans` join, live links only).
- Steering: hints `kb source show <id> --json`, `kb source chunks <id> --json`.
- Tests: status filter vs. global counts; tie ordering; empty KB.

## 4. Fixtures and baselines

### 4.1 Fixture corpus — `fixtures/corpus/`

Deterministic mini-corpus reproducing the report's workflow shape. Checked in:

```
fixtures/corpus/
  sources/design-notes.md        # decisions + constraints; contains the ambiguous-quote trap text
  sources/api-reference.md       # entity/relationship-rich
  sources/meeting-transcript.md  # conflicting + open-question material
  sources/press-release.md      # ingested but NO claims payload → SOURCE_NO_CLAIMS positive (finding 39)
  hierarchy.json                 # Phase 2 manifest: 1 root, 4 topics, 16 leaves
  claims/design-notes.json  claims/api-reference.json  claims/meeting-transcript.json
  graph/api-reference.json
  synthesis/leaves.json  synthesis/topics.json  synthesis/root.json
```

Content rules (asserted by the fixture build): all quotes are exact chunk
substrings; ≥1 `open_question` claim never cited in synthesis; ≥2 chunks in claimed
sources never covered by any span; one whole source (press-release) with zero claim
links; one claim pair set up for supersession in the eval memo (07).

### 4.2 Baseline script — `scripts/`

- `scripts/baseline-old.sh`: assembles the fixture KB with Phase-0 commands only
  (per-node `node create`, per-node `synthesize`, per-source claim applies); prints
  `COMMANDS=<n>`. Ends with `kb verify --strict --json`, **`kb render --json`, then
  `kb render --check --json`** (render before check — finding 26), failing on
  non-zero exit.
- `scripts/kb-snapshot.ts` (finding 26): dumps a normalized semantic snapshot —
  sorted JSON of nodes (slug path, kind, title, body), claims (normalized text,
  type, status, owner slug path), span quotes, entities, relationships, sources
  (sha256) — **excluding** timestamps, changelog, and render bookkeeping. Phase 2
  compares old-vs-new script results with this snapshot, not raw DB bytes.
- Counts recorded in `docs/plans/baseline.md` (generated, not hand-written).

### 4.3 Retrieval fixture — `fixtures/retrieval/queries.json`

Unchanged from prior revision (8 reconstructed cases, labeled as reconstruction;
5 natural-language / 2 keyword / 1 phrase; `expectAnyOf` filled from the fixture
build). `scripts/eval-retrieval.ts` prints per-case `matchMode`, `recall@5`,
`zeroResults`. Phase 3 hardens this into a gate (05 §3).

### 4.4 Known-bug regression tests (red now, green later)

- Quoted-footnote `answer-check` false positive → `test.fails` in
  `src/query/query.test.ts`; flipped in Phase 3.
- Ambiguous-quote structured issue (`QUOTE_AMBIGUOUS` + `path` + chunk id) →
  `test.fails`; flipped in Phase 1.
- Citation-regex statefulness (finding 32): `hasCitation()` then
  `extractCitations()` on the same input misses citations (shared global regex
  `lastIndex`) → `test.fails`; flipped in Phase 3 (or fixed immediately if it
  blocks parity tests — it is a two-line fix; decision: fix it **in Phase 0** and
  assert positively).

## Acceptance (Phase 0 done when)

- All parity + argument tests green; hand-rolled parser deleted; every CLI test
  runs in-process via `runCli`.
- Unknown flags/commands/values fail with exit 2 and registry codes; no raw
  Commander output anywhere (asserted).
- Every command answers `--help --json` (router) with a spec passing the drift
  tests; global help is registry-generated.
- `kb version` (3 probe states) and `kb source list` as specified.
- Fixture corpus builds; `baseline-old.sh` runs green end-to-end;
  `docs/plans/baseline.md` recorded.
- `pnpm test` and `pnpm typecheck` green.
