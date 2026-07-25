# Phase 4 — Source Lineage and Coverage

Goal: make binary/derived sources first-class without an extraction pipeline — the
original bytes own source identity, the agent's transcription is the canonical
text, and the link is recorded and hashed. Add the five-check coverage report.

Depends on Phases 1–3 (ingest split from 1; steering rows finalized against
commands from 2; answer-check/search shapes from 3 — finding 14). Est. ~2–3 days.
Revised per Codex findings 34–39, 15–16.

## 1. `kb ingest` with a text sidecar

```
kb ingest <original> [--text-from <file>] [--extractor <name/version>]
          [--verification visual|none]
          [--origin-system <s>] [--origin-id <id>] [--origin-url <url>]
          [--title T] [--source-date D] [--author A] [--supersedes <src_id>]
          [--dry-run] [--json]
```

**Original-first** (locked): `deriveSourceId` and `sha256` come from the original
file's bytes; the original is what the store persists; the sidecar becomes the
canonical text in `source_texts` — quote verification untouched.

### 1.1 Media policy (finding 36 — exact, compatibility-preserving)

- **Known-binary extensions** (`pdf docx pptx xlsx png jpg jpeg gif zip`): require
  `--text-from`; without it → `UNSUPPORTED_MEDIA` with the recipe.
- **Everything else** (known-text extensions and unknown extensions alike): decode
  with `new TextDecoder('utf-8', { fatal: true })`; decode failure or a NUL byte →
  `UNSUPPORTED_MEDIA`. This replaces the current lossy
  `Buffer.toString('utf8')` (which substitutes U+FFFD silently) — stricter and
  listed in the compatibility matrix; unknown-extension UTF-8 text keeps working
  exactly as today.
- **Complete MIME map** (single table in `ingest.ts`; HelpSpec renders it):
  `md|markdown → text/markdown`, `txt|rst → text/plain`,
  `html|htm → text/html`, `csv → text/csv`, `json → application/json`,
  `pdf → application/pdf`,
  `docx → application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
  `pptx → …presentationml.presentation`, `xlsx → …spreadsheetml.sheet`,
  `png → image/png`, `jpg|jpeg → image/jpeg`, `gif → image/gif`,
  `zip → application/zip`, anything else → `text/plain` if it decoded, else
  `application/octet-stream`.
- The native path records extractor **`text-utf8/1`** — the existing constant
  (`SOURCE_TEXT_EXTRACTOR`), not the invented `cli/1` (finding 34).

### 1.2 Extractor representation (finding 34 — blocker fix, no migration)

`source_texts` has `extractor TEXT` + `extractor_version INTEGER` (schema fact).
Therefore `--extractor` is constrained to `name/<decimal integer>`:
`/^[a-z][a-z0-9-]*\/[0-9]+$/` (e.g. `agent-transcription/1`, default when
`--text-from` is present). The CLI splits it into the two columns and recombines
for display and for `metadata.extraction.method`. Non-integer versions are
`INVALID_ARGUMENT` at parse time (exit 2). No migration.

### 1.3 Behavior matrix

| Input | Behavior |
|---|---|
| Decodable text, no `--text-from` | current path (`text-utf8/1`) |
| Decodable text with `--text-from` | derived path (raw export + cleaned transcription) |
| Known-binary ext or undecodable, no `--text-from` | `UNSUPPORTED_MEDIA` + recipe |
| Binary with `--text-from` | derived path |
| `--text-from` unreadable / fails fatal UTF-8 decode | `TEXT_SIDECAR_INVALID` |
| `--extractor`/`--verification` without `--text-from` | `INVALID_ARGUMENT`, exit 2, **pre-workspace** (finding 37) |
| Same original bytes re-ingested (any flags) | duplicate path: metadata patch-merge only (§2) |
| Same original, different sidecar text | **always rejected** — see §1.4 |

Derived path = Phase 1 `plan`/`commit` extended: `plan` hashes the original,
duplicate-checks, then decodes the **sidecar** for chunking; title derives from
sidecar text. `commit` stores original bytes (atomic, `created` flag), writes
`source_texts` from the sidecar (normalized; `textHash` = sha256 of normalized
text), `metadataJson` per §2.

### 1.4 Corrected-transcription recipe (finding 35 — blocker fix)

A source's canonical text is **immutable**, and a source's identity derives solely
from its original bytes — so the same original can never yield a second source, and
`--supersedes` cannot change that. Re-ingesting the same original with a different
sidecar is always rejected (`INVALID_ARGUMENT`), with this exact executable
recovery in the hint (and in the kb-ingest skill):

```
Canonical text for src_<id> is immutable. To publish a corrected transcription:
  kb ingest report.extracted-v2.md --supersedes src_<id> \
     --title "<original title> (corrected transcription)" --json
The corrected transcription file itself becomes a new UTF-8 source (byte-distinct,
so it gets its own identity) that supersedes the derived source record. Re-extract
claims from the new source; staleness will drive re-synthesis.
```

Test: execute the documented recipe verbatim against a fixture derived source and
assert the supersession chain (`old.status = superseded`,
`new.supersedesSourceId = old.id`).

### 1.5 Receipt and recipe error

Receipt `data` adds `original: {mediaType, byteSize, sha256}` and
`text: {extractor: "agent-transcription/1", verification, textHash}`;
`nextActions: [kb source chunks src_… --json]`. The `UNSUPPORTED_MEDIA` message
contains the literal two-step `--text-from` recipe and the supported-format table
reference (test asserts the literal `--text-from` string).

## 2. Source metadata (finding 37)

No migration (`sources.metadata_json` exists). Zod schema validates **the keys this
tool writes** and preserves everything else:

```ts
export const SourceMetadataSchema = z.object({
  extraction: z.object({
    method: z.string(),                       // recombined name/version
    verification: z.enum(['visual', 'none']), // default 'none'
    textFileHash: z.string(),                 // sha256 of the sidecar file bytes as given
    textFilePath: z.string(),
  }).optional(),
  origin: z.object({
    system: z.string().optional(),
    externalId: z.string().optional(),
    url: z.string().url().optional(),
  }).optional(),
}).passthrough();                             // unknown existing keys preserved verbatim
```

- **Write rules:** read-modify-write via a new `SourceRepo.updateMetadata(id, json)`
  (API addition — none exists today). `extraction` is **immutable after first
  write** (attempt to change ⇒ the §1.4 rejection). `origin` fields **patch-merge**:
  only supplied flags overwrite their keys; a duplicate re-ingest carrying
  `--origin-*` flags updates origin and reports `updated: true`.
- `--verification` defaults to `none`; `visual` is an explicit agent statement.
- `source show`/`source list` surface `origin.system` + `origin.url`.
- Duplicate-update matrix test: {no flags, title-only, origin-only, extraction
  attempt} × {first ingest, duplicate}.

Evidence-pack guidance lives in the skill (07): one first-class source per original
page/issue/thread when claims will cite it, `--origin-*` always set; packs stay
acceptable for bulk low-stakes material.

## 3. `kb coverage`

Read-only; always `ok: true`, exit 0 (severity `info` never fails — 01 §2).
**Findings live in envelope `issues`** (one aggregated issue per check);
`data` carries the machine summary (finding 39 resolves the two-homes question):

```jsonc
{ "ok": true,
  "data": { "summary": {
      "SOURCE_NO_CLAIMS":            { "total": 1, "shown": 1 },
      "CHUNK_UNCITED":               { "total": 23, "shown": 20 },
      "CLAIM_NOT_SYNTHESIZED":       { "total": 0, "shown": 0 },
      "NODE_SINGLE_SOURCE":          { "total": 2, "shown": 2 },
      "OPEN_QUESTION_NOT_SYNTHESIZED": { "total": 1, "shown": 1 } } },
  "issues": [
    { "code": "SOURCE_NO_CLAIMS", "severity": "info", "ids": ["src_…"],
      "message": "1 active source has no claim provenance (1 of 1 shown)",
      "hint": "Extract claims from it: kb source chunks src_… --json — or state in your report why it stays uncited." }
  ],
  "errors": [], "warnings": [], "nextActions": [],
  "hints": ["Coverage is descriptive; kb verify --strict --json remains the integrity gate."] }
```

- `ids` capped at 20 per issue; `message` always carries `(<shown> of <total>
  shown)`; `data.summary` carries exact totals — the no-silent-caps rule.
- The retire suggestion is **removed** (no such command exists — finding 39).

**Exact check semantics** (finding 38; all via **live links** so orphan spans never
count; overlap is half-open `sp.char_start < c.char_end AND sp.char_end >
c.char_start`; ordering: issues in table order, ids lexicographic):

| Code | Definition |
|---|---|
| `SOURCE_NO_CLAIMS` | `status='active'` sources with zero spans that are linked via `claim_spans` to a claim with `status IN ('active','conflicted')` |
| `CHUNK_UNCITED` | chunks of active sources with no overlapping span that has a live `claim_spans` link (to an active/conflicted claim) **or** a live `relationship_spans` link. Orphan spans (links deleted) do not cover. |
| `CLAIM_NOT_SYNTHESIZED` | `status='active'` claims whose id appears in no node's `body_md` citations (`extractCitations` over all bodies; conflicted claims are excluded — they surface via the open-questions render) |
| `NODE_SINGLE_SOURCE` | nodes whose **body-cited** claims (the support that actually reaches readers — decision per finding 38) trace via live spans to ≤1 distinct source; nodes citing zero claims are excluded (they are stale/empty — different signal) |
| `OPEN_QUESTION_NOT_SYNTHESIZED` | `CLAIM_NOT_SYNTHESIZED` restricted to `claim_type='open_question'` (intentional overlap — the actionable slice) |

Implementation `src/coverage/coverage.ts` mirroring `verify.ts` (pure over
`Repositories`). Tests: fixture-planted positive per check (press-release source →
`SOURCE_NO_CLAIMS`); orphan-span-only chunk (uncovered); inactive-claim-linked-only
chunk (uncovered); relationship-only chunk (covered); cap boundary (21 ids → 20
shown, totals exact); clean-KB negatives; exit 0 with findings.

## 4. Steering completions

Final rows land in the 01 §6.1 table (already corrected there per finding 15):
`verify` ok gains the coverage hint; `render` ok gains the coverage hint
unconditionally (the "first render" condition was unreachable — `init` renders
immediately — and is dropped). `graph apply` remains outside stale steering. The
phase-boundary steering test re-runs against the full registry.

## 5. Compatibility matrix (Phase 4 — recorded as implemented)

Same form as 03 §3. Phase 4 removes NO field; `uncitedSentences` is retained
(finding 33). Aliases live for all of envelope v2 (charter: compat-aliases).

| Command | Old field / behavior | Disposition |
|---|---|---|
| `ingest` | lossy `Buffer.toString('utf8')` decode (silent U+FFFD substitution) | **breaking (stricter, §1.1)**: `TextDecoder('utf-8', {fatal:true})` + NUL guard; undecodable bytes now fail with `UNSUPPORTED_MEDIA` + the `--text-from` recipe. Unknown-extension UTF-8 text is unaffected. |
| `ingest` | media type from the 4-entry `md/markdown/txt/rst` map, everything else `text/plain` | superseded by the complete §1.1 table; an unmapped extension is still `text/plain` when it decodes, `application/octet-stream` when it does not |
| `ingest` | receipt `data` | **additive**: `original {mediaType, byteSize, sha256}` + `text {extractor, verification, textHash}`; `sourceId`/`title`/`status`/`updated`/`chunks`/`next` all retained unchanged |
| `source list` | `origin: null` placeholder | same key, now populated as `{system, url}` from `metadata.origin` (still `null` when no origin was recorded) |
| `source show` | full source row (incl. `metadataJson`) | **additive**: `origin` block alongside the unchanged row fields |

## Acceptance (Phase 4 done when)

- §1 behavior matrix fully tested (one test per row); recipe literals asserted;
  corrected-transcription recipe executed verbatim in a test.
- Extractor split round-trips through the existing integer column; native path
  still records `text-utf8/1`.
- Metadata: passthrough preservation, extraction immutability, origin patch-merge,
  duplicate matrix — all tested; `SourceRepo.updateMetadata` added.
- Coverage: five checks per §3 semantics with all listed positives/negatives;
  always exit 0.
- Compatibility matrix updated (strict UTF-8 decode; no field removals —
  `uncitedSentences` retention reaffirmed, finding 33).
- Full suite + typecheck green; `baseline-new.sh` unaffected.
