**Experimental project**, not for production use.

# knowledge-base-ingest

An agent-driven knowledge base: an AI coding agent (Claude Code) uses the `kb` CLI to
**create**, **maintain**, and **ingest into** a knowledge base built from source material —
with **strict, verifiable provenance** and a **human-readable** markdown view.

Optimized for technical documentation and software-engineering material; general enough for
other subjects.

## Core idea

- **SQLite (`kb.sqlite`) is the source of truth** for everything derived: the synthesis
  tree, claims, provenance edges, and the knowledge graph.
- **Source documents are immutable**, content-addressed copies under `sources/`, segregated
  from anything generated.
- **The markdown under `kb/` is a deterministic, read-only render** of the database — the
  human view. Regenerate it with `kb render`; never hand-edit it.
- **Provenance is an enforced invariant, not a convention.** Every claim must cite an exact
  quote from a source; the CLI verifies the quote against the immutable text before
  persisting. A paraphrased or invented quote is rejected. This makes "every generated part
  traces to a source" structurally true.
- **Hierarchical synthesis:** a tree of arbitrary depth. Leaf nodes own quote-backed claims;
  parents synthesize their children. Inline `[^clm_…]` citations resolve to source-quote
  footnotes in the rendered markdown.
- **The agent proposes, the CLI validates.** Claim/entity/relationship/synthesis payloads
  are Zod-validated and persisted in a single transaction; the deterministic work (hashing,
  chunking, quote verification, staleness, render) lives in tested code, and only judgment
  (what a claim is, how to phrase synthesis, conflict adjudication) is left to the agent.

## Layout of a knowledge base

```
<kb-root>/
  kb.sqlite            # source of truth
  sources/             # immutable, content-addressed source copies (read-only)
  kb/                  # GENERATED markdown (read-only): index, changelog, open-questions,
                       #   synthesis/ tree, graph/ entities+relationships
  AGENTS.md / CLAUDE.md
```

## Quick start

`./bin/kb` runs straight from a clone with no build step (it uses `tsx`). Installing the
package globally (`pnpm link --global`, or `npm i -g .`) puts a plain `kb` on your PATH —
that is what the skills and all the examples in the docs call. The two are the same CLI;
use `./bin/kb` in a fresh clone and `kb` once it is installed.

```bash
pnpm install
export KB_DIR="$(pwd)/my-kb"                      # absolute: a relative value rebases after cd

# Preflight — which CLI am I running, and against which KB?
./bin/kb version --json                           # cli + node + schema version, resolved kbRoot

# Discovery — get contracts from the tool, never from memory
./bin/kb --help --json                            # every command, grouped by workflow stage
./bin/kb claim apply --help --json                # one command: flags, payload example, output

./bin/kb init "$KB_DIR" --json
./bin/kb ingest path/to/doc.md --source-date 2026-05-01 --json
./bin/kb source chunks <sourceId> --json          # read chunks to find exact quotes
./bin/kb node apply --file hierarchy.json --json  # the whole node tree in one atomic call
./bin/kb claim apply --file claims.json --json    # quote-verified claims
./bin/kb graph apply --file graph.json --json     # entities + relationships
./bin/kb synthesize --file node.json --json       # prose with [^clm_…] citations
./bin/kb verify --strict --json                   # provenance + freshness invariants
./bin/kb render --json                            # write kb/*.md
./bin/kb ask-context "a question" --json          # retrieve claims+provenance to answer
```

Preview before you persist: `ingest`, `node apply`, `claim apply`, `graph apply`, and
`synthesize` all accept `--dry-run`, which validates the payload and reports what would
change without writing.

The agent normally drives these via the three skills in `.claude/skills/`:
**kb-create** (build a KB from a corpus), **kb-ingest** (add one source), **kb-query**
(answer a question with provenance).

## CLI commands

Run `./bin/kb --help --json` for the authoritative list — it is generated from the
registered commands, so it can never advertise something this build does not ship. The
full reference in [docs/USER_GUIDE.md](docs/USER_GUIDE.md#6-cli-reference) is generated
from those same calls by `pnpm docs:commands`.

Every command accepts `--json` (the envelope
`{ ok, data, issues, errors, warnings, nextActions, hints }`; exit code `1` when
`ok:false`) and resolves the KB from `--kb <dir>`, `$KB_DIR`, or the nearest `kb.sqlite`
above the cwd. Prefer an absolute `KB_DIR`; relative values are resolved from each
command's cwd and can break after `cd`.

## How provenance works (the keystone)

1. A source is stored verbatim and content-hashed; its **canonical extracted text** (BOM
   stripped, CRLF→LF, NFC) is what offsets address.
2. It is chunked deterministically (structure-aware, exact-tiling).
3. A **claim** cites a `chunk_id` + an exact `quote`. The CLI locates the quote in that
   chunk, derives absolute character offsets, and re-verifies it against the canonical text
   (`verifyQuote`). No normalization, no fuzzy matching — the agent must copy real text.
4. `kb verify --strict` re-checks every active claim has a supporting, still-matching quote,
   that every inline citation resolves to a claim in scope, and that nothing is stale.

## Documentation

- **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** — concepts, the agent/skills flow, full CLI
  reference, JSON payload formats, workflows, troubleshooting.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — implementation & design deep dive: layers,
  schema, the provenance keystone, algorithms, type safety, testing, trade-offs, V2.
- **[docs/DESIGN.md](docs/DESIGN.md)** — the original design record and post-review scope
  decisions (the implementation contract).

## Design & development

- Full design and the post-review scope decisions: [`docs/DESIGN.md`](docs/DESIGN.md).
- Stack: TypeScript (strict), Zod at every agent boundary, `better-sqlite3`, Vitest.
- Built test-first (red/green/refactor). Run:
  ```bash
  pnpm test         # vitest
  pnpm typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
  ```

## V1 scope

Ships: immutable sources, deterministic chunking + FTS, quote-verified claim extraction,
arbitrary-depth synthesis with boolean staleness, claim→span→source provenance, read-only
markdown render with drift detection, conflict/supersession, a software-domain knowledge
graph, provenance-checked Q&A, and the three skills. Deferred: PDF/binary extraction,
bidirectional markdown editing, embeddings/vector search, fuzzy entity auto-merge, and
semantic (NLI) answer entailment.
