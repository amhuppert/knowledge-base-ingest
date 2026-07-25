# Phase 3 — Measured Retrieval and Answer-Check Parsing

Goal: fix the recall-hostile search default with a per-scope AND→OR fallback and
explicit match modes; add the two fixture-justified `ask-context` filters; make
`answer-check` Markdown-aware so quoted material stops producing false positives.
Further retrieval work is gated on measured fixture results, with exactly one
specified follow-up increment.

Depends on Phase 0 (parallel to Phases 1–2 except the shared issue/envelope
conventions). Est. ~2 days. Revised per Codex findings 27–33.

## Background (verified)

- `kb search` AND-joins every token (`src/query/query.ts:37,155`) — primary
  hypothesis for the reported 5/8 zero-result searches (not proven; the fixture
  measures it).
- `ask-context` already OR-joins (`query.ts:241`); its issue is ranking, measured
  separately.
- Porter stemming is already enabled; no index changes.
- The stateful shared citation regex (`hasCitation` leaving `lastIndex` set) was
  fixed in Phase 0 (02 §4.4).

## 1. Search: match modes and per-scope fallback (findings 27, 28)

```
kb search <query...> [--scope chunks|claims|nodes|entities|all] [--limit 1-200]
                     [--match auto|all|any|phrase] [--json]
```

Modes (default **`auto`** — finding 27; there IS a strict-AND mode):

| Mode | Behavior per FTS scope | matchMode reported |
|---|---|---|
| `auto` (default) | AND; if this scope has zero hits, rerun this scope with OR | `"all"` or `"any-fallback"` |
| `all` | strict AND, no fallback | `"all"` |
| `any` | OR | `"any"` |
| `phrase` | whole query as one quoted FTS phrase, no fallback | `"phrase"` |
| (entities scope) | LIKE, unaffected by `--match` | `"like"` |

Fallback is decided **independently per FTS scope** (design-review resolution — a
hit in one scope must not suppress fallback in another; `--scope all` runs all four
scopes).

**Result contract** (finding 28 — `SearchHit[]` cannot carry per-scope modes):

```ts
export const SEARCH_SCOPES = ['chunks', 'claims', 'nodes', 'entities'] as const; // runtime const for Commander choices
export const MATCH_MODES = ['auto', 'all', 'any', 'phrase'] as const;

export interface SearchResult {
  query: string;
  matchModes: Partial<Record<Scope, 'all' | 'any' | 'any-fallback' | 'phrase' | 'like'>>;
  hits: SearchHit[];   // hit gains: matchMode (its scope's), rank: number | null
}
```

- `rank`: raw FTS5 bm25 (more negative = better) for FTS scopes; **`null` for
  entity hits** (LIKE has no rank). Ranks are comparable **only within a scope**;
  `hits` are ordered scope-major (chunks, claims, nodes, entities — the existing
  concatenation order) and rank-ordered within each FTS scope. Documented in the
  HelpSpec output notes.
- Envelope hints (corrected per finding 27):
  - any scope fell back → `"<scope>: no hits required all terms; showing any-term
    matches (weaker evidence). Use --match all for strict matching."`
  - zero hits everywhere under `auto` → `"No matches even with any-term fallback.
    Rephrase with distinctive terms or try: kb ask-context \"<query>\" --json"`
    (never suggests `--match any` — auto already ran OR).
- Compatibility matrix entry: `data` was `{query, hits}`; `hits` items gain fields
  (additive); `matchModes` added. No removals.

Tests: AND-zero→OR fallback per scope with `--scope all` (one scope hits on AND,
another falls back); strict `all` does not fall back; `phrase` exact match;
`any` skips the AND pass (assert via SQL spy or matchModes); entity `rank: null`;
scope-major ordering; `MATCH_MODES`/`SEARCH_SCOPES` drive Commander choices
(runtime consts, not types).

## 2. `ask-context` filters (finding 29)

```
kb ask-context <question...> [--limit 1-50] [--claim-type <CLAIM_TYPES>] [--node <node_id>] [--json]
```

- `--node` is validated **first**: unknown → `UNKNOWN_NODE`, exit 1.
- Filters are pushed **into SQL before ranking** — status
  (`IN ('active','conflicted')`), `claim_type = ?`, and subtree
  (`c.node_id IN (<listInSubtree ids>)`) all inside the FTS query's WHERE, before
  `ORDER BY rank LIMIT ?` — eliminating the `limit*4` over-fetch false-zero
  (regression test: > 4×limit higher-ranked excluded claims, qualifying claim still
  returned). The status filter moving into SQL also tightens the current
  post-filter (same semantics, no behavior change).
- `data` gains `"applied": { "claimType": "open_question" | null, "node": "nod_…" | null }`.
- Zero-results hint is built from the filters actually supplied
  (finding 29): with filters → `"No matches with the applied filters — rerun
  without <the supplied flag(s)> to widen"`; without → the search-style rephrase
  hint.
- Still deferred pending the gate: stop-words beyond §3b, `--source`/`--status`
  filters, diversity, embeddings.

## 3. Retrieval gate (finding 30 — hard gate, one specified increment)

`src/query/retrieval-fixture.test.ts` builds the fixture KB and runs the 8 cases
through the new `auto` path.

- **Gate:** ≥7/8 cases return an expected claim in the top 5 **and** ≤1 case is a
  false zero-result. This is a hard phase gate.
- **If the gate fails:** implement **Phase 3b — query-side stop-words** (fully
  specified now so no decision is needed later): maintain
  `src/query/stopwords.ts`, a fixed ~40-entry English list (question/function
  words: how, what, why, does, is, are, the, a, of, in, to, for, …); in `auto` and
  `any` modes, drop stop-word tokens when ≥2 non-stop tokens remain; `all` and
  `phrase` modes never drop. Re-run the gate.
- **If it still fails:** the phase is **blocked** — write
  `docs/plans/retrieval-results.json`
  (`{ cases: [{id, query, matchMode, topIds, expected, hit, rank}], recallAt5,
  zeroResults }`) and stop; the next increment (filters/diversity/embeddings) is a
  new decision for the maintainer with that file as evidence. The phase never
  "passes with an evidence package".

## 4. `answer-check` Markdown pre-pass (findings 31–33)

### 4.1 Region scanner (replaces the current split-then-filter)

A single line-oriented state machine, `scanRegions(text): Region[]`, where
`Region = { kind: 'prose' | 'fence' | 'footnoteDef' | 'blockquote' | 'inlineCode',
startOffset, endOffset, startLine }`. Exact rules (CommonMark-aligned; each rule
one test):

- **Fences:** open = line matching `^ {0,3}(`{3,}|~{3,})` (info string allowed);
  close = line with the same character, length ≥ opener, ≤3 leading spaces;
  **unclosed fence runs to EOF** (CommonMark).
- **Footnote definitions:** line matching `^\[\^[^\]]+\]:`; continuation lines =
  blank lines followed by indented (≥2 spaces) lines, per GFM lazy continuation;
  the definition ends at the first non-blank, non-indented line (that line is
  prose — the "unindented prose immediately after a footnote" test).
- **Blockquotes:** maximal runs of lines matching `^\s{0,3}>`.
- **Inline code:** backtick run of length n opens, next run of exactly length n
  closes (CommonMark); unmatched run = literal text.
- Sentence assertions are evaluated over **prose regions only**. Regions never
  overlap; the scanner is total (every offset belongs to exactly one region).

### 4.2 Sentence spans with offsets (finding 31 — the current splitter returns
mutated strings)

`splitSentenceSpans(prose: string, baseOffset): { text, startOffset, endOffset }[]`
replaces `splitSentences`: same boundary rule (sentence-ending punctuation +
trailing quotes/citation tokens) but implemented as an index scanner producing
spans, with **double-quote suppression**: `.`/`!`/`?` inside an open double-quote
(straight `"` or curly `“ ”`; `\"` escapes ignored) do not end a sentence; quote
state resets at each blank line (unmatched-quote containment). Line numbers derive
from `startOffset` against the original text (no lineMap indirection).

Scope note (explicit, finding 31): an *inline* quotation inside an assertive prose
sentence does not exempt that sentence — it still needs a citation (quoting
evidence is exactly the cited case). The false positives being fixed are quoted
material in non-prose regions (footnote definitions, blockquotes, code) and
mid-quote sentence splits.

### 4.3 Citations and results (findings 32, 33)

- Citation extraction runs over **prose + footnoteDef + blockquote regions,
  excluding code regions** — `[^clm_…]` in a code sample is neither a citation nor
  an assertion. Footnote-definition citations still validate for
  existence/status.
- `data` (complete; `uncitedSentences` **retained** for all of envelope v2 —
  finding 33; Phase 4's removal is rescinded):

```jsonc
{ "ok": false,
  "data": { "ok": false,                                   // legacy nested ok, kept in sync with envelope ok
            "citedClaims": ["clm_a"], "unknownCitations": ["clm_x"],
            "inactiveCitations": [], "uncited": [ { "text": "…", "line": 12 } ],
            "uncitedSentences": ["…"] },                   // deprecated alias of uncited[].text
  "issues": [
    { "code": "CITATION_UNKNOWN", "severity": "error", "ids": ["clm_x"], "message": "…", "hint": "…" },
    { "code": "UNCITED_ASSERTION", "severity": "error", "message": "line 12: \"…\"", "hint": "…" }
  ],
  "errors": ["…"], "warnings": [], "nextActions": [],
  "hints": ["kb ask-context \"<topic>\" --json finds citable claims."] }
```

- Issue cardinality and order (finding 33): one issue **per citation id** for
  unknown then inactive (each in first-occurrence order), then one **per uncited
  sentence** in line order. Envelope `ok` ≡ `data.ok`.

Tests: Phase 0 quoted-footnote `test.fails` flips green; unindented prose directly
after a footnote definition is still checked; tilde fence; unclosed fence to EOF;
multi-backtick inline code; escaped and unmatched quotes; identical sentences on
different lines get distinct line numbers; citation inside fenced code neither
validated nor counted; ordinary inline quoted question still requires a citation;
genuinely uncited prose fails with the correct line.

## Acceptance (Phase 3 done when)

- Gate of §3 passes (possibly via Phase 3b), or the phase is blocked with
  `retrieval-results.json` — never silently passed.
- §1–§2 tests green; `matchModes` + per-hit `matchMode`/`rank` as specified;
  compatibility matrix entries recorded and goldens updated.
- All §4 scanner/splitter/citation tests green; quoted-footnote regression green;
  `uncitedSentences` still emitted.
