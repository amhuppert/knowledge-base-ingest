# KB Skills and Tooling Reflections

## Overall assessment

The KB tooling was excellent at integrity and provenance, but expensive in agent orchestration. It produced a trustworthy result; getting there involved more manual payload construction and validation than necessary.

## What worked well

- **Strong provenance model.** Immutable source copies, deterministic chunks, exact quote spans, atomic claims, and claim IDs made the final KB auditable.
- **Safe claim application.** An ambiguous quote caused the whole claim payload to fail without partial application. The error identified the exact chunk needing correction.
- **Useful staleness tracking.** New evidence marked affected leaves and ancestors stale, making the required bottom-up synthesis order clear.
- **Strict verification.** `kb verify --strict` gave a clean terminal condition: zero errors, warnings, and stale nodes.
- **Render determinism.** `kb render --check` confirmed all generated Markdown files matched SQLite.
- **Good generated artifacts.** The executive synthesis, topic tree, open-question register, source index, and graph were immediately usable.
- **Provenance retrieval.** `kb provenance <claim>` was reliable and convenient when constructing cited answers.
- **Answer validation.** `kb answer-check` caught missing or unknown citations before an answer reached the user.
- **Context retrieval.** `kb ask-context` generally found useful claims and returned their source quotes in a compact structure.

## What did not work well

### PDF ingestion

`kb ingest <path>` appears generic, but rejected the PDF. The workaround required rendering it, creating a faithful transcription, visually auditing the content, recording a hash, and ingesting the derived Markdown. The original binary is not managed as an attachment.

### No dry-run validation

Claims, graphs, and syntheses could only be fully validated by applying them or by writing separate validation logic. This was especially costly for:

- exact-quote uniqueness;
- graph references;
- descendant citation ownership;
- JSON schema validation;
- checking for unintended partial application.

### Too many one-at-a-time operations

The workflow required creating 22 nodes, applying multiple claim and graph payloads, and synthesizing 22 nodes individually. There was no convenient batch interface.

### Parent synthesis context

`kb node show` returns only directly owned claims. Topic and root nodes required claims to be gathered manually from every descendant.

### Search quality

Five of eight natural-language, multi-term claim searches returned no results despite relevant claims existing. `ask-context` performed better, but sometimes returned lower-priority roadmap claims while omitting obvious design questions.

### Missing source-list operation

`kb source list` does not exist. Sources were most easily enumerated only after rendering the index.

### Answer-check parsing

`kb answer-check` treated the second question inside a quoted source footnote as an uncited assertion. Rephrasing the source note fixed it, but exact quotations should not trigger this behavior.

### Graph reporting

Some graph payloads contained more evidence spans than `spansCreated` reported, presumably because of deduplication. The command output did not explain the difference.

### Schema discovery

Agents had to inspect existing JSON payloads to infer claim and graph formats. The CLI did not expose canonical schemas or templates.

### Indirect provenance

Jira and Confluence were ingested as evidence packs, so many claims cite the pack rather than a first-class source record for each original page or issue.

### Remote-source preparation

Slack results had to be exported into Markdown while manually preserving:

- message IDs;
- timestamps;
- thread metadata;
- pagination coverage;
- connector visibility limitations;
- exact message fidelity.

## Highest-value improvements

### 1. Add validation and dry-run commands

Examples:

```text
kb claim validate --file claims.json
kb graph validate --file graph.json
kb synthesize validate --file node.json
kb ingest --dry-run <path>
```

Validation should check schemas, IDs, exact quote presence and uniqueness, citation ownership, duplicate entities, and likely partial-application effects.

### 2. Support common source formats and attachments

`kb ingest` should accept PDF, DOCX, and similar files through a standard extraction pipeline while:

- preserving the original file;
- storing its hash and metadata;
- retaining page-level anchors;
- supporting OCR when necessary;
- recording visual-verification status.

At minimum, the help and skill documentation should explicitly list supported formats.

### 3. Add bulk operations

Useful interfaces would include:

```text
kb node apply --file hierarchy.json
kb claim apply --dir claims/
kb graph apply --dir graphs/
kb synthesize --dir synthesis/ --bottom-up
```

A 22-node KB should not require 22 separate synthesis commands.

### 4. Provide synthesis-ready context

An interface such as:

```text
kb node context <node_id> --include-descendants --json
```

should return the node, descendant structure, active claims, conflicts, sources, and allowed citation IDs.

### 5. Improve retrieval

Search should support:

- semantic and lexical hybrid retrieval;
- configurable result limits;
- filters for node, claim type, source, date, status, and confidence;
- explicit phrase and AND/OR behavior;
- topic diversity;
- explainable ranking.

`ask-context` should accept options such as `--limit`, `--node`, and `--claim-type open_question`.

### 6. Improve answer validation

`answer-check` should:

- ignore quoted questions inside footnote definitions;
- understand Markdown blockquotes and source-note syntax;
- optionally verify semantic entailment rather than only citation existence;
- report the exact text span classified as unsupported.

### 7. Make coverage measurable

A coverage audit should report:

- sources with no claims;
- chunks never cited;
- claims absent from synthesis;
- nodes with weak or single-source support;
- uncited open questions;
- current versus historical evidence distribution;
- conflicting or potentially duplicate claims.

## Skill-document improvements

The KB skills should add:

- an explicit supported-format table;
- canonical JSON schemas or downloadable templates;
- examples for ambiguous-quote remediation;
- guidance for evidence packs versus first-class original sources;
- a recommended batch workflow for large corpora;
- instructions for preserving Slack pagination and message metadata;
- troubleshooting guidance for missing commands and retrieval behavior.

## Conclusion

The core design is sound. Its strongest qualities are immutable evidence, exact-quote provenance, staleness tracking, strict verification, and deterministic rendering. The best next step is reducing payload authoring and command count while preserving those guarantees.
