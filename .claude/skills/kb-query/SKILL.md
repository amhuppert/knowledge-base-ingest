---
name: kb-query
description: Answer a question from a kb-ingest knowledge base with source-cited provenance. Use when the user asks a question that the knowledge base should answer, or says "what does the KB say about…", "answer from the knowledge base", "look this up in the KB". Retrieves claims with provenance and validates the answer's citations.
---

<note>Skill in active development: after use, surface friction, bugs, design issues, and suggested improvements.</note>

# Answer questions from the knowledge base (with provenance)

Answer using ONLY what the knowledge base actually contains, and cite every assertion back
to a source-backed claim. Uses the `kb` CLI (`./bin/kb` in this repo). Set `KB_DIR` or pass
`--kb <dir>`.

## Non-negotiables
- **Evidence is a claim.** Build the answer from claims returned by `kb ask-context`, each
  of which carries a verified source quote. Do not add facts from memory.
- **Cite every assertion** with `[^<claim_id>]`. If the KB does not support a point, say so
  rather than guessing.
- **Surface conflicts.** If retrieved claims include `conflicted` ones, present both sides.

## Procedure

1. **Retrieve context** for the question:
   ```
   kb ask-context "<the user's question>" --json
   ```
   This returns the most relevant `claims` (each with `id`, `text`, `status`, owning
   `nodeTitle`, and `provenance` = source title + exact quote), plus related `nodes` and
   `entities`. For broader lookup use:
   ```
   kb search "<terms>" --scope claims|chunks|nodes|entities --json
   ```

2. **Draft the answer** using only those claims. After each assertion, place the citation
   of the claim that supports it, e.g.:
   `Bucket state is stored in Redis.[^clm_37c84b164ab86154]`

3. **Validate the answer's provenance** before showing it:
   ```jsonc
   // answer.json
   { "answer": "Your drafted answer with [^clm_…] citations." }
   ```
   ```
   kb answer-check --file answer.json --json
   ```
   `ok:false` means a problem: `unknownCitations` (cited a non-existent claim),
   `inactiveCitations` (cited a superseded/retracted claim), or `uncitedSentences`
   (assertive sentences with no citation). Fix and re-check until `ok:true`.
   (Note: this is a STRUCTURAL check — it confirms citations resolve to active claims, not
   semantic entailment. Still read the quotes to ensure each claim truly supports your
   sentence.)

4. **Present** the answer to the user. Render each citation as the claim's source quote so
   the user can trace it, e.g. a short "Sources" list mapping each `[^clm_…]` to its quote
   and source title (you can get these from the `ask-context` provenance or
   `kb provenance <claim_id> --json`).

5. If `ask-context` returns nothing relevant, tell the user the knowledge base does not
   cover the question — do not fabricate an answer.
