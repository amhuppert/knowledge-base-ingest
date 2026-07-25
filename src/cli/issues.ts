/**
 * CLI ISSUE MAPPING (01 §3.1–§3.2).
 *
 * Owns the per-code hint templates, the verify-check→code map, canonical path
 * serialization (`formatPath`), and the payload-parse helper. The domain layer
 * (`src/domain/issueCodes.ts`) owns the code list and `DomainIssueError`; this
 * module maps that error to an envelope `Issue`. No message-text matching.
 */

import { CommanderError } from 'commander';
import {
  DomainIssueError,
  ISSUE_CODES,
  formatPath,
  type DomainIssue,
  type DomainIssueDetail,
  type IssueCode,
} from '../domain/issueCodes.js';
import type { RemovedGraphField } from '../domain/schemas/agent.js';
import { VERIFY_CHECKS, type VerifyCheck } from '../verify/verify.js';
import type { Issue } from './output.js';

/**
 * A non-empty, agent-facing hint for every registered code. Every embedded
 * `kb …` command names a command that exists in the current registry (a test
 * enforces this) — there is deliberately no `kb claim list` / `kb entity list`.
 */
export const HINTS: Record<IssueCode, string> = {
  // --- Argument & payload parsing ---
  UNKNOWN_COMMAND: 'Not a known command. Run kb --help --json for the command list.',
  UNKNOWN_OPTION: 'Unrecognized flag. Re-run with --help --json to list the valid flags for this command.',
  MISSING_ARGUMENT: 'A required argument or option value is missing. Re-run with --help --json to see the usage.',
  INVALID_ARGUMENT: 'The value is out of range or not an allowed choice. Re-run with --help --json for the accepted values.',
  PAYLOAD_PARSE_ERROR: 'The payload is not valid JSON at the reported character. Fix the JSON syntax and re-run.',
  PAYLOAD_SCHEMA: 'Fix the field named by the issue path, then re-run with --help --json to see the expected payload shape.',

  // --- Workspace resolution ---
  NO_KB: 'No knowledge base here. Run kb init --json in the KB directory, or pass --kb <dir>.',
  KB_PATH_SUSPECT: 'The resolved KB root looks doubled. Prefer an absolute --kb/KB_DIR so a later cd cannot rebase it.',

  // --- Unknown entity lookups ---
  UNKNOWN_NODE: 'No such node. List them with kb node tree --json, or find one with kb search <text> --scope nodes --json.',
  UNKNOWN_SOURCE: 'No such source. See the counts with kb status --json, or find one with kb search <text> --json.',
  UNKNOWN_CLAIM: 'No such claim. Find one with kb search <text> --scope claims --json, or list a node’s claims with kb node show <node_id> --json.',
  UNKNOWN_ENTITY: 'No such entity. Find one with kb search <name> --scope entities --json.',
  UNKNOWN_PARENT_REF: 'The parent id is not in the KB. List existing nodes with kb node tree --json.',

  // --- Quote / provenance ---
  QUOTE_NOT_FOUND: 'The quote is not an exact substring of the source. Re-copy it verbatim from kb source chunks <source_id> --json — never retype or normalize whitespace.',
  QUOTE_AMBIGUOUS: 'The quote appears more than once. Reread kb source chunks <source_id> --json and extend the quote with adjacent verbatim text until it is unique, then re-run.',
  CLAIM_HAS_PROVENANCE: 'Every active claim needs a supporting span. Re-run kb claim apply --json with a quote-verified span, or retract the claim.',

  // --- Citations ---
  CITATION_UNKNOWN: 'The cited claim id does not exist. Cite an id shown by kb node show <node_id> --json.',
  CITATION_OUT_OF_SUBTREE: 'Cite only claims owned within the node’s subtree. Move the claim or cite the correct node; kb node show <node_id> --json lists what is in scope.',
  CITATION_INACTIVE: 'The cited claim is superseded or retracted. Cite the active replacement; kb provenance <claim_id> --json shows the lineage.',

  // --- Hierarchy / batch structure ---
  ROOT_HAS_PARENT: 'A root node cannot have a parent. Omit the parent, or choose a non-root kind.',
  MULTIPLE_ROOTS: 'A knowledge base has exactly one root. Reuse the existing root instead of declaring another.',
  DUPLICATE_REF: 'Each manifest ref must be unique. Rename the duplicated ref.',
  DUPLICATE_SLUG: 'Two manifest entries resolve to the same parent and slug. Give one a distinct slug.',
  NODE_KIND_MISMATCH: 'The manifest kind differs from the existing node. Align the manifest with the node or choose a new slug — do not force.',
  NODE_TITLE_MISMATCH: 'The manifest title differs from the existing node. Align the manifest with the node or choose a new slug — do not force.',

  // --- Staleness & index integrity ---
  NO_STALE_NODES: 'Some nodes are stale and need re-synthesis. Re-synthesize them, then re-run kb verify --strict --json.',
  FTS_INTEGRITY: 'A full-text index failed its integrity check — this is KB corruption. Re-run with --json and report the envelope.',
  RENDER_DRIFT: 'A rendered file no longer matches what the renderer produces. Regenerate it with kb render --json — never hand-edit the rendered markdown.',

  // --- Media & lineage ---
  UNSUPPORTED_MEDIA: 'The file is not decodable text. Follow the recipe in the error message to supply extracted text.',
  TEXT_SIDECAR_INVALID: 'The supplied text sidecar is unreadable or not valid UTF-8. Provide a decodable text file.',

  // --- Answer-check ---
  UNCITED_ASSERTION: 'A sentence asserts a fact without citing an active claim. Add a [^claim_id] citation or soften the sentence; find claims with kb search <text> --json.',

  // --- Coverage (info) ---
  SOURCE_NO_CLAIMS: 'This active source has no claim provenance. Extract claims with kb source chunks <source_id> --json, or state in your report why it stays uncited.',
  CHUNK_UNCITED: 'Some chunks are covered by no claim. Extract claims from them with kb source chunks <source_id> --json, or note why they stay uncovered.',
  CLAIM_NOT_SYNTHESIZED: 'An active claim is cited by no node. Cite it during synthesis or note why it is omitted; locate it with kb provenance <claim_id> --json.',
  NODE_SINGLE_SOURCE: 'This node’s cited claims trace to a single source. Corroborate with another source or note the limitation.',
  OPEN_QUESTION_NOT_SYNTHESIZED: 'An open-question claim is surfaced in no node. Address it in synthesis or record it as an open question; locate it with kb provenance <claim_id> --json.',

  // --- Meta ---
  INTERNAL: 'This is a bug in kb — re-run with --json and report this envelope.',
  LEGACY: 'Transitional diagnostic; read the message. A specific issue code will replace this in a later phase.',
};

/** Look up the hint for a registered code (always defined). */
export function hintFor(code: IssueCode): string {
  return HINTS[code];
}

/**
 * Field-specific `PAYLOAD_SCHEMA` guidance for the two graph fields removed in 03 §3.2.
 * Both rejections share one code, so the registry hint alone cannot say WHY the field is
 * gone; the domain reports which one via `details.removedField` and the wording lives
 * HERE, with every other hint (01 §3.1 — the domain never authors agent-facing text).
 */
export const REMOVED_GRAPH_FIELD_HINTS: Record<RemovedGraphField, string> = {
  'entity.evidence':
    'entity evidence is not stored (there is no entity span table, so it was silently dropped); remove the field and attach the evidence to a relationship or a claim instead.',
  'relationship.evidence.confidence':
    'relationship evidence stores no confidence (it was silently dropped); remove the field — put the confidence on the relationship itself or on a supporting claim.',
};

/** True when `details` names one of the removed graph fields (03 §3.2). */
function removedGraphFieldOf(details: unknown): RemovedGraphField | undefined {
  if (details === null || typeof details !== 'object') return undefined;
  const field = (details as { removedField?: unknown }).removedField;
  return typeof field === 'string' && field in REMOVED_GRAPH_FIELD_HINTS ? (field as RemovedGraphField) : undefined;
}

/**
 * The hint for a domain error: the code's registry hint, REFINED at this boundary for the
 * codes whose single code covers several distinct failures. Refinement reads only the
 * error's structured `details` — never its message text (03 §1).
 */
export function hintForDomainError(err: DomainIssueError): string {
  if (err.code === 'PAYLOAD_SCHEMA') {
    const removed = removedGraphFieldOf(err.details);
    if (removed) return REMOVED_GRAPH_FIELD_HINTS[removed];
  }
  return hintFor(err.code);
}

/**
 * Verify check → issue code (01 §3.2). Total over `VERIFY_CHECKS` by the `Record`
 * type; a test also asserts every finding `verify()` produces has a mapping.
 * Citation checks reuse the semantic `CITATION_*` codes.
 */
export const VERIFY_CHECK_CODES: Record<VerifyCheck, IssueCode> = {
  'claim-has-provenance': 'CLAIM_HAS_PROVENANCE',
  'quote-matches-source': 'QUOTE_NOT_FOUND',
  'leaf-has-citation': 'UNCITED_ASSERTION',
  'citation-resolves': 'CITATION_UNKNOWN',
  'parent-cites-subtree': 'CITATION_OUT_OF_SUBTREE',
  'citation-active': 'CITATION_INACTIVE',
  'no-stale-nodes': 'NO_STALE_NODES',
  'fts-integrity': 'FTS_INTEGRITY',
};

/** The issue code for a verify check name. */
export function codeForVerifyCheck(check: VerifyCheck): IssueCode {
  return VERIFY_CHECK_CODES[check];
}

/**
 * THE canonical path serializer (01 §3.1): bracket-dot style, e.g.
 * `claims[2].spans[0].quote`, `nodes[3].body_md`. Re-exported from the domain layer
 * (`issueCodes.ts`) so services can format the paths they attach to a
 * `DomainIssueError` without importing the CLI, while remaining the single
 * implementation Zod paths and batch prefixes go through.
 */
export { formatPath };

/**
 * Parse a JSON payload, raising a coded `PAYLOAD_PARSE_ERROR` on failure. The
 * reported offset is the CHARACTER offset `JSON.parse` gives (not a byte offset);
 * the message says "character".
 */
export function parseJsonPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const match = /at position (\d+)/.exec(detail);
    if (match) {
      const character = Number(match[1]);
      throw new DomainIssueError('PAYLOAD_PARSE_ERROR', `Payload is not valid JSON at character ${character}: ${detail}`, {
        details: { character },
      });
    }
    throw new DomainIssueError('PAYLOAD_PARSE_ERROR', `Payload is not valid JSON: ${detail}`);
  }
}

/**
 * Every reachable `CommanderError.code` → issue code (01 §1.2). This map is
 * EXHAUSTIVE over the codes Commander can raise for the configured tree; a test
 * asserts each listed code is present and that an unmapped code falls back to
 * `INTERNAL` (never a raw Commander error). `commander.help*` / `commander.version`
 * are unreachable because help and version never reach `parseAsync` (the router
 * handles them) and Commander's `.version()` is prohibited.
 */
export const COMMANDER_ISSUE_CODES: Record<string, IssueCode> = {
  'commander.unknownCommand': 'UNKNOWN_COMMAND',
  'commander.unknownOption': 'UNKNOWN_OPTION',
  'commander.missingArgument': 'MISSING_ARGUMENT',
  'commander.optionMissingArgument': 'MISSING_ARGUMENT',
  'commander.missingMandatoryOptionValue': 'MISSING_ARGUMENT',
  'commander.invalidArgument': 'INVALID_ARGUMENT',
  'commander.excessArguments': 'INVALID_ARGUMENT',
  'commander.conflictingOption': 'INVALID_ARGUMENT',
};

/** The issue code for a Commander error code; unmapped codes degrade to `INTERNAL`. */
export function codeForCommanderError(commanderCode: string): IssueCode {
  return COMMANDER_ISSUE_CODES[commanderCode] ?? 'INTERNAL';
}

/**
 * Map a thrown `CommanderError` (raised because every node sets `exitOverride`)
 * to an error-severity envelope `Issue`. Commander's `"error: "` prefix is
 * stripped; suggestion lines (`(Did you mean …?)`) are preserved. `excessArguments`
 * is reworded to lead with "unexpected argument" (01 §1.2).
 */
export function commanderErrorToIssue(err: CommanderError): Issue {
  const code = codeForCommanderError(err.code);
  const cleaned = err.message.replace(/^error:\s*/, '');
  const message =
    err.code === 'commander.excessArguments' ? `unexpected argument — ${cleaned}` : cleaned;
  return { code, severity: 'error', message, hint: hintFor(code) };
}

/** Map one coded, structured diagnostic to an error-severity envelope `Issue` (+ registry hint). */
export function domainIssueDetailToIssue(detail: DomainIssueDetail): Issue {
  return {
    code: detail.code,
    severity: 'error',
    message: detail.message,
    hint: hintFor(detail.code),
    ...(detail.path !== undefined ? { path: detail.path } : {}),
    ...(detail.ids !== undefined ? { ids: detail.ids } : {}),
  };
}

/**
 * Map a thrown `DomainIssueError` to an error-severity envelope `Issue`. Hint precedence,
 * most specific first: the error's OWN hint — the escape hatch for a recovery recipe that
 * must name concrete ids/paths to stay executable (06 §1.4) — then the guidance this
 * module derives from the error's structured `details` (`hintForDomainError`, e.g. the
 * removed graph fields, 03 §3.2), then the code's registry hint. Every fallback is
 * resolved HERE from the code plus structured data, never from message text (03 §1).
 * Routed through `domainIssueToIssue` (not the hint-less `domainIssueDetailToIssue`
 * narrowing) precisely because that per-instance hint has to survive the mapping.
 */
export function domainErrorToIssue(err: DomainIssueError): Issue {
  return domainIssueToIssue({
    code: err.code,
    message: err.message,
    hint: err.hint ?? hintForDomainError(err),
    ...(err.path !== undefined ? { path: err.path } : {}),
    ...(err.ids !== undefined ? { ids: err.ids } : {}),
  });
}

/**
 * Map a domain `DomainIssue` value (carried by a `DomainIssuesError`, e.g. one per bad
 * citation) to an envelope `Issue`. A DYNAMIC hint on the issue (e.g. naming a superseding
 * claim) wins; otherwise the static per-code registry hint is used. Severity defaults to
 * `error`. Mapping is by `code` — never by message text.
 */
export function domainIssueToIssue(issue: DomainIssue): Issue {
  return {
    code: issue.code,
    severity: issue.severity ?? 'error',
    message: issue.message,
    hint: issue.hint ?? hintFor(issue.code),
    ...(issue.path !== undefined ? { path: issue.path } : {}),
    ...(issue.ids !== undefined ? { ids: issue.ids } : {}),
  };
}

/** All registered codes, re-exported for tests and callers that iterate the registry. */
export { ISSUE_CODES, type IssueCode };
export { VERIFY_CHECKS };
