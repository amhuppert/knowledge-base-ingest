---
name: kb-create
description: Create a new kb-ingest knowledge base from a set of source documents (a corpus). Use when the user says "build a knowledge base from these docs", "create a KB", "ingest this folder into a new knowledge base", or provides multiple sources to organize. Bootstraps the SQLite-backed KB and its synthesis hierarchy.
---

<note>Skill in active development: after use, surface friction, bugs, design issues, and suggested improvements.</note>

# Create a knowledge base from a corpus

Build a new knowledge base from one or more source documents, with strict provenance and
a hierarchical synthesis. Uses the `kb` CLI (`./bin/kb` in this repo). **SQLite is the
source of truth; `kb/` markdown is a read-only render.**

Read the **kb-ingest** skill first — creation is "ingest, repeated, plus an initial
hierarchy design." This skill adds the bootstrap and the top-down structure.

## Procedure

1. **Initialize** the KB (creates `kb.sqlite`, `sources/`, `kb/`, `AGENTS.md`, `CLAUDE.md`):
   ```
   kb init <kb-dir> --json
   export KB_DIR=<kb-dir>
   ```

2. **Survey the corpus.** Skim the documents (titles, headings) to decide the top-level
   shape: a single `root` node for the KB's scope, then `topic` nodes for major areas,
   then `leaf` nodes for focused subtopics. Keep the tree shallow at first; you can split
   later as leaves grow.

3. **Create the root and first-level topics:**
   ```
   kb node create --title "<KB scope>" --kind root --json          # one root
   kb node create --parent <root_id> --title "<Area>" --kind topic --json
   kb node create --parent <topic_id> --title "<Subtopic>" --kind leaf --json
   ```

4. **Ingest each source** following the **kb-ingest** procedure (ingest → read chunks →
   apply quote-verified claims to the right nodes → apply entities/relationships).
   Process sources oldest-first when dates are known, so later sources can supersede
   earlier ones cleanly. Create new nodes as needed when a source introduces a new area.

5. **Synthesize bottom-up.** Once claims are in, write each node's prose deepest-first:
   leaves from their own claims, then parents synthesizing their children (a parent may
   cite any claim in its subtree and should summarize + link its children, not restate
   everything). Use `kb synthesize --file node.json --json`. Every assertion needs an
   inline `[^<claim_id>]` citation.

6. **Verify, render, report:**
   ```
   kb verify --strict --json     # ok:true required
   kb render --json
   kb status --json
   ```
   Tell the user what was created: sources, the node hierarchy, claim/entity/relationship
   counts, and where to read it (`<kb-dir>/kb/index.md`).

## Tips
- Keep claims atomic (one assertion each) and faithful to the source — the CLI rejects
  any quote that is not an exact substring of the immutable source.
- Prefer fewer, well-scoped nodes over many tiny ones. Split a leaf only when it covers
  several distinct subtopics.
- The root synthesis is the reader's entry point: make it a crisp overview that links to
  the topics, each line backed by a citation.
