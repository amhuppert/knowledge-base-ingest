# Cross-review of Agent One’s initial draft

## Overall assessment

**Score: 8/10.** Agent One’s proposal is well grounded, substantially converges with my draft, and improves on it in several places. Reducing the report’s symptoms to five root causes is especially effective, as is the explicit rejection table. The proposal becomes decision-ready after tightening several contracts and replacing a few factual overclaims with measured acceptance criteria.

There are **no blocking disagreements**. Every major issue below has a bounded correction that preserves the proposal’s direction.

## Strong agreements

- Preserve SQLite-as-truth, exact-quote provenance, atomic writes, boolean staleness, strict verification, and deterministic rendering.
- Prefer the same `--dry-run` flag on mutations over separate validation command families.
- Keep schemas/templates tool-owned and stop duplicating payload contracts in skills.
- Provide one synthesis-oriented context read with an explicit allowed-citation set.
- Batch hierarchy creation and synthesis rather than building a general workflow engine.
- Fix lexical retrieval and measure it before adding embeddings.
- Keep `answer-check` deterministic and structural; semantic entailment belongs with the calling agent.
- Make original-plus-derived-text ingestion first-class before adding native OCR or document extractors.
- Keep coverage descriptive and deterministic rather than turning it into a subjective integrity gate.
- Add `source list`, clearer deduplication reporting, actionable next steps, and concise skills.
- Defer native OCR, connectors, semantic retrieval, semantic entailment, and a generic batch DSL.

## Disagreements and required revisions

| ID | Category | Severity | Disagreement | Required revision |
|---|---|---|---|---|
| CR-01 | Objective | Major | The draft says rollback-backed dry-run validates citation ownership and that `allowedCitations` is exactly what synthesis accepts. Current `NodeService.synthesize()` checks only citation existence; subtree ownership and inactive status are detected later by `verify`. Validation parity therefore preserves a weak validator. | Extract one synthesis validator that checks existence, subtree membership, and allowed status. Use it for single apply, batch apply, dry-run, and construction of `allowedCitationIds`. Keep `verify` as defense in depth. |
| CR-02 | Objective | Major | “Idempotent so retries are free” is too strong. Reapplying a claim updates timestamps, marks nodes stale, and appends changelog entries. Unchanged synthesis also writes and logs. `createNode()` returns an existing derived ID without checking that title, kind, or ordering match the requested manifest. | Distinguish **content-deduplicating** from **side-effect-free idempotent**. Make exact repeats true no-ops where practical, and report incompatible existing hierarchy fields as conflicts. Do not promise free retries until tests prove the operational state is unchanged. |
| CR-03 | Implementation | Major | The hierarchy receipt maps title to ID, but titles can repeat across branches. A nested manifest can also silently collide with an existing node whose derived ID matches while other fields differ. | Give every input node a stable local `ref`, or use a canonical path key. Prevalidate duplicate refs, parent resolution, root count, kind compatibility, and collisions before one atomic apply. Return `ref/path → {nodeId,outcome}`. |
| CR-04 | Objective | Major | AND-joining is a credible cause of zero-result searches, but “this alone explains five of eight” is not proven because the queries and expected hits are not in the repository. It also does not explain `ask-context` noise: that path already OR-joins raw tokens. | Check in the eight representative queries with expected claim IDs. Implement per-scope AND→OR fallback as the first experiment, then address stop words, significant-term coverage, status filtering, or diversity only when the fixture shows a need. Require recall-at-five and false-zero thresholds before declaring retrieval fixed. |
| CR-05 | Implementation | Minor | A single fallback after combined `search --scope all` can be suppressed by an irrelevant hit in another scope. `--source` and `--node` are also ambiguous: first-seen versus any evidence source, and direct owner versus subtree. | Apply fallback per requested scope and report the effective mode per hit group. Define filter semantics explicitly and add only filters justified by the retrieval fixture. |
| CR-06 | Objective | Minor | The project declares Zod `^3.24.1` and no JSON-Schema converter. “Zod’s JSON-Schema export” is not available as written. Hand-written templates also become a second source of truth unless tested. | Choose explicitly among a small converter dependency, a separately justified Zod upgrade, or initially exposing Zod-validated templates plus concise field metadata. Parse every shipped template in tests. |
| CR-07 | Objective | Minor | “Supported formats aren’t listed anywhere” is overstated. `docs/USER_GUIDE.md` and the README explicitly describe text-only V1 support and PDF conversion. The actual gap is CLI and skill discoverability. | Say that formats are absent from command help and the ingest skill, not absent from the project. Expose capabilities through the CLI and a compact skill decision table. |
| CR-08 | Implementation | Major | `node context` is a useful deep command, but always returning separate direct and descendant claim arrays, full provenance, and invented conflict pairs/groups can be large and duplicative. The data model stores conflicted statuses, not durable conflict groups. | Always include descendant scope, but return one compact claim list tagged with owner node. Make full quotes/provenance opt-in or budgeted. Return conflicted claims as statuses unless a real use case justifies a conflict-group model. Include a truncation indicator and deterministic continuation mechanism if output can exceed a context budget. |
| CR-09 | Implementation | Major | Rollback is straightforward for claim, graph, and current node mutations, but the “~30 lines / S” characterization understates validator refactoring, result capture, nested transactions, structured issues, and tests. Ingest stores bytes before its database transaction and cannot use the same mechanism. | Split the work: transactional previews for existing DB mutators are small; synthesis-validator hardening and ingest prepare/commit are medium. Ingest preview must normalize and chunk without calling the source store. Test logical DB equivalence, unchanged changelog/domain rows, and no new source-store paths. |
| CR-10 | Implementation | Major | `kb ingest transcript.md --original report.pdf` makes source identity ambiguous: does the source ID, SHA, media type, byte size, and stored path describe the transcript or PDF? The current source row has one raw-file identity. | Prefer `kb ingest report.pdf --text-from transcript.md --extractor agent-transcription --verification visual`. The source row then describes original bytes, while `source_texts` holds canonical text, its hash, and extractor metadata. If transcript-first syntax is retained, add an explicit attachment model instead of overloading one source row. |
| CR-11 | Objective | Major | “Agent transcription is the highest-fidelity extraction available” is an unsupported generalization. It may help with complex visual layouts but can be worse than deterministic extraction for born-digital documents and remains probabilistic. | Present visually audited transcription as the first supported fallback, not a universal quality claim. Record extraction method and verification status; leave native extractors conditional on measured demand. |
| CR-12 | Implementation | Major | The proposed `answer-check` fix adds a footnote prefix check after sentence splitting. The current splitter can already detach the second sentence from that prefix, so the false positive can survive. “Do not split inside quotes” also risks becoming a fragile general sentence parser. | Exclude whole GFM footnote-definition blocks and continuations, fenced code, blockquotes, and supported source-note regions before sentence segmentation. Preserve offsets/line numbers and add the exact report case as a regression before expanding quote-aware parsing. |
| CR-13 | Implementation | Major | Prose `next` strings and aggregate dedup counts help but are insufficient as an agent recovery contract. They still force agents to parse prose and look up created IDs. | Add stable issue objects (`code`, JSON path, relevant ID, hint), structured `nextActions`, and per-input outcomes. Distinguish submitted evidence refs, unique spans created/reused, and provenance links created/reused. Keep human-readable strings for compatibility. |
| CR-14 | Implementation | Major | The proposal misses a version/capability ambiguity already visible in the repository: skills require a globally installed `kb`, while the README invokes `./bin/kb`; there is no version command. Argument parsing also accepts unknown flags and invalid numeric limits too quietly. | Add `kb --version --json` with executable path and supported schema version; include on-disk schema version in status. Resolve project-local versus global usage in the skills. Reject unknown flags, invalid scopes, and non-positive/non-numeric limits. |
| CR-15 | Objective | Minor | Coverage is described as wholly SQL-computable. Claims cited by no synthesis and open questions absent from prose require parsing citation IDs from Markdown. “Sources with zero claims” must traverse source → span → claim-span rather than rely on `first_seen_source_id`. | Describe coverage as deterministic read-only SQL plus the existing citation parser. Define whether “uncited chunk” means no claim support, no graph evidence, or no span of either kind. Keep it separate from strict integrity. |
| CR-16 | Implementation | Major | The skill rewrite has no explicit old-skill versus new-skill evaluation loop, while calendar estimates and the projected `70+ → 25` command count are presented without a recorded baseline. | Add representative skill/workflow evals before finalizing the skills: ambiguous quote, conflict update, 20-node corpus, binary sidecar, and open-question query. Measure strict-verification success, command count, retries, tokens, time, retrieval recall, and citation correctness. Replace calendar estimates with S/M/L until interfaces and tests are specified. |

## Revisions I would make to my own draft

1. **Adopt the five-root-cause framing.** It is clearer than organizing primarily by feature and should lead the counter-proposal.
2. **Prefer a focused `kb schema <payload> --template` interface.** My draft placed richer schemas directly in `--help --json`; Agent One’s explicit discovery command is easier for agents to request and cache. Help should summarize and link to it. I would retain the converter/version caveat above.
3. **Accept `kb node context` as a deep, task-aligned command.** I originally favored extending `node show`. A dedicated synthesis-context operation better hides assembly work, provided output is compact, bounded, and derived from the same validator as synthesis.
4. **Promote declarative hierarchy apply into P1.** I initially made it conditional. The report’s observed 22-node workflow is sufficient evidence to design it now, with stable refs, compatibility checks, atomic prevalidation, and per-node receipts.
5. **Make AND→OR fallback the first lexical experiment.** I would retain my retrieval fixture, stop-word concern, and acceptance thresholds, while explicitly noting that Porter stemming already exists and does not need redesign.
6. **Split dry-run sizing.** Previewing existing database mutations is small; strengthening synthesis validation and giving ingest a no-store prepare path are medium. Treating all dry-run work as one size obscures the real seam.
7. **Correct my byte-identity acceptance criterion.** A rolled-back SQLite transaction may still alter WAL or file-level bytes. The correct requirement is unchanged logical domain state, row counts/content, and changelog, plus no new or changed source-store files.
8. **Adopt the explicit rejection table.** It communicates the over-engineering boundary more effectively than prose deferrals alone.

## Recommended merged direction

Agent One’s proposal should remain the structural base, with these changes:

1. Establish baseline workflow and retrieval/skill fixtures.
2. Resolve tool identity and argument validation; expose schema/templates, structured issues, and actionable receipts.
3. Strengthen synthesis validation, then add same-path dry-run.
4. Add compact `node context`, safe hierarchy apply, and atomic batch synthesis.
5. Ship measured lexical retrieval and structural `answer-check` fixes.
6. Add original-first derived-text ingestion and deterministic coverage reporting.
7. Update and benchmark the skills alongside each shipped interface.

With those revisions, the design would be a **10/10**: strong invariants behind a small, task-oriented interface, with complexity introduced only where observed workflows and tests justify it.
