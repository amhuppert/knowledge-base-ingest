---
name: kb-ingest
description: Ingest a new source document into a kb-ingest knowledge base and update the synthesis. Use when the user says "ingest this into the knowledge base", "add this source", "update the KB with this document", or points at a file/URL to integrate. Drives the `kb` CLI (SQLite-backed, strict provenance).
---

<note>Skill in active development: after use, surface friction, bugs, design issues, and suggested improvements.</note>

# Ingest a source into the knowledge base

The knowledge base is managed by the globally installed `kb` CLI. **SQLite is the source of
truth; the markdown under `kb/` is a read-only render.** You add knowledge ONLY through
`kb` commands — never by editing files under `kb/` or `sources/`.

Set `KB_DIR` to an absolute KB root (the directory containing `kb.sqlite`), for example
`export KB_DIR="$(pwd)/memory-bank/fedramp"`, or pass `--kb <absolute-dir>` to each
command. Avoid bare relative `KB_DIR` values because later `cd` commands rebase them.
All commands accept `--json`; always use `--json` and parse it.

## Non-negotiables
- **Every claim must quote the source exactly.** You give the CLI a `chunk_id` + an
  exact `quote` (a verbatim substring of that chunk); the CLI verifies it against the
  immutable source and rejects paraphrases. Never invent or paraphrase a quote.
- **Do not trust memory.** Extract only from the chunk text the CLI gives you.
- **Re-synthesize what you changed.** Applying claims marks the owning node and its
  ancestors stale; rewrite their prose bottom-up.

## Procedure

1. **Ingest the file** (deterministic — registers an immutable copy, chunks it):
   ```
   kb ingest <path> [--title "T"] [--source-date YYYY-MM-DD] [--supersedes <src_id>] --json
   ```
   Use `--supersedes <old_src_id>` when this document is a newer version of an existing
   source (marks the old one `superseded`). Note the returned `sourceId`. Re-ingesting
   identical bytes is a no-op.

2. **Read the chunks** to find evidence:
   ```
   kb source chunks <sourceId> --json
   ```
   Each chunk has an `id`, `headingPath`, and `text`. Quotes must be exact substrings of
   a single chunk's `text`, and must be unique within that chunk.

3. **Find or create the synthesis nodes** the new facts belong to:
   ```
   kb node tree --json
   kb node create --title "T" --kind <root|topic|leaf> [--parent <node_id>] --json
   ```
   One `root` per KB. Group related facts under `topic`/`leaf` nodes. A claim is owned by
   exactly one node (usually a leaf).

4. **Apply claims** with quote-verified provenance. Write a JSON file and apply it:
   ```jsonc
   // claims.json
   {
     "source_id": "src_…",
     "claims": [
       {
         "node_id": "nod_…",
         "text": "A normalized one-sentence assertion.",
         "claim_type": "fact",            // fact|definition|decision|requirement|constraint|procedure|warning|example|open_question
         "confidence": 0.9,
         "spans": [
           { "chunk_id": "chk_…", "quote": "exact substring of that chunk", "role": "supports" }
         ]
       }
     ]
   }
   ```
   ```
   kb claim apply --file claims.json --json
   ```
   The whole batch is atomic: if any quote fails verification, nothing is persisted —
   fix the quote and retry.

5. **Extract the knowledge graph** (entities + relationships, each with evidence):
   ```jsonc
   // graph.json
   {
     "source_id": "src_…",
     "entities": [ { "type": "Service", "name": "Rate Limiter", "description": "…" } ],
     "relationships": [
       { "type": "stores_in",
         "subject": { "type": "Service", "name": "Rate Limiter" },
         "object":  { "type": "DataStore", "name": "Redis" },
         "evidence": [ { "chunk_id": "chk_…", "quote": "Bucket state is stored in Redis." } ] }
     ]
   }
   ```
   ```
   kb graph apply --file graph.json --json
   ```
   Prefer the recommended vocabulary (Service, DataStore, Library, Concept, Pattern,
   Decision, Config, …; relationships: depends_on, stores_in, implements, supersedes,
   configured_by, part_of, …). Do NOT strip version numbers from names ("React 18" ≠ "React").

6. **Handle conflicts / supersession.** If a new claim contradicts an existing one:
   - Find the old claim's id (`kb node show <node_id> --json`).
   - After applying the new claim, mark the old one superseded:
     ```
     kb claim supersede <old_claim_id> --by <new_claim_id> --json
     ```
   - If sources genuinely disagree with no clear winner, keep both, lower confidence if
     appropriate, and mark both unresolved:
     ```
     kb claim conflict <claim_id_a> <claim_id_b> --json
     ```
   - If the source itself states a gap or unresolved decision, model it as
     `claim_type: "open_question"`. `open_question` claims and conflicted claims both
     surface in `kb/open-questions.md`.

7. **Re-synthesize stale nodes bottom-up.** `kb verify --json` lists stale nodes (warning
   `no-stale-nodes`). For each, deepest first, rewrite its prose. Every assertion must
   carry an inline citation `[^<claim_id>]` to a claim owned by that node (a parent may
   cite any claim in its subtree). The renderer turns citations into footnotes and
   automatically adds a `## Subtopics` list for parent nodes — never write footnote
   definitions yourself or duplicate generated child links.
   ```jsonc
   // node.json
   { "node_id": "nod_…", "title": "Algorithm", "summary": "one line",
     "body_md": "The limiter uses a token bucket.[^clm_…] It refills at 200 tok/s.[^clm_…]" }
   ```
   ```
   kb synthesize --file node.json --json
   ```

8. **Verify and render:**
   ```
   kb verify --strict --json     # must be ok:true (provenance intact, nothing stale)
   kb render --json              # regenerate kb/*.md
   ```

9. **Report** to the user: source added, claims/entities/relationships created, conflicts
   resolved, nodes re-synthesized, and the `verify` result.
