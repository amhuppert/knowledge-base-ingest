/**
 * ISSUE CODE REGISTRY (01 §3.1).
 *
 * The domain layer owns the stable code list and `DomainIssueError`; domain
 * services throw the error and never import CLI modules (dependency direction is
 * preserved). The CLI layer (`src/cli/issues.ts`) owns the per-code hint templates
 * and all mapping.
 *
 * The registry is APPEND-ONLY: codes are never renamed or removed. `LEGACY` stays
 * registered even after its emission is forbidden (Phase 1+).
 */

export const ISSUE_CODES = [
  // --- Argument & payload parsing (CLI edge) ---
  'UNKNOWN_COMMAND',
  'UNKNOWN_OPTION',
  'MISSING_ARGUMENT',
  'INVALID_ARGUMENT',
  'PAYLOAD_PARSE_ERROR',
  'PAYLOAD_SCHEMA',

  // --- Workspace resolution ---
  'NO_KB',
  'KB_PATH_SUSPECT',

  // --- Unknown entity lookups ---
  'UNKNOWN_NODE',
  'UNKNOWN_SOURCE',
  'UNKNOWN_CLAIM',
  'UNKNOWN_ENTITY',
  'UNKNOWN_PARENT_REF',

  // --- Quote / provenance (claim apply, graph apply, verify) ---
  'QUOTE_NOT_FOUND',
  'QUOTE_AMBIGUOUS',
  'CLAIM_HAS_PROVENANCE',

  // --- Citations (synthesize, verify) ---
  'CITATION_UNKNOWN',
  'CITATION_OUT_OF_SUBTREE',
  'CITATION_INACTIVE',

  // --- Hierarchy / batch structure (Phase 2) ---
  'ROOT_HAS_PARENT',
  'MULTIPLE_ROOTS',
  'DUPLICATE_REF',
  'DUPLICATE_SLUG',
  'NODE_KIND_MISMATCH',
  'NODE_TITLE_MISMATCH',

  // --- Staleness & index integrity (verify, render --check) ---
  'NO_STALE_NODES',
  'FTS_INTEGRITY',
  'RENDER_DRIFT',

  // --- Media & lineage (Phase 4) ---
  'UNSUPPORTED_MEDIA',
  'TEXT_SIDECAR_INVALID',

  // --- Answer-check (Phase 3) ---
  'UNCITED_ASSERTION',

  // --- Coverage (reserved; Phase 4 — always info severity) ---
  'SOURCE_NO_CLAIMS',
  'CHUNK_UNCITED',
  'CLAIM_NOT_SYNTHESIZED',
  'NODE_SINGLE_SOURCE',
  'OPEN_QUESTION_NOT_SYNTHESIZED',

  // --- Meta ---
  'INTERNAL',
  // Transitional; emission forbidden after Phase 1, but the entry is retained forever.
  'LEGACY',
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

const REGISTERED: ReadonlySet<string> = new Set(ISSUE_CODES);

/** True iff `code` is a registered issue code. */
export function isIssueCode(code: string): code is IssueCode {
  return REGISTERED.has(code);
}

/**
 * THE canonical path serializer (01 §3.1): bracket-dot style, e.g.
 * `claims[2].spans[0].quote`, `nodes[3].body_md`. Numeric segments render as `[n]`;
 * string segments as `.name`, except the leading segment has no dot. It lives in the
 * domain layer so services can format the `path` they attach to a `DomainIssueError`
 * WITHOUT importing the CLI (dependency direction is enforced by a test); `src/cli/issues.ts`
 * re-exports it so Zod paths and batch prefixes share this one implementation.
 */
export function formatPath(segments: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? seg : `.${seg}`;
  }
  return out;
}

/**
 * The structured payload of a domain diagnostic (01 §3.1): `code` + `path` + `ids` +
 * `details`. Hint WORDING belongs to `src/cli/issues.ts` (finding 12): when one code
 * covers several distinct failures that each warrant their own guidance, the service
 * reports WHICH failure it is in `details` (e.g. `{ removedField }` on the graph
 * `PAYLOAD_SCHEMA` rejections, 03 §3.2) and the CLI derives the wording from that —
 * never a hint string authored in the domain. The `hint` field below is the one
 * deliberate exception (06 §1.4), documented on the field itself.
 */
export interface DomainIssueOptions {
  /** Canonical bracket-dot path (formatted via `formatPath`). */
  path?: string;
  ids?: string[];
  details?: unknown;
  /**
   * A per-instance hint that OVERRIDES the code's registry hint. Reserved for a
   * recovery recipe that must name concrete ids/paths to be executable (06 §1.4) —
   * the registry hint stays the default for every other issue of the same code, so
   * routing is still by code and never by message text.
   */
  hint?: string;
}

/**
 * A structured, coded diagnostic a domain service can surface WITHOUT importing the
 * CLI (the CLI maps it to an envelope `Issue` by `code`, never by message text). Unlike
 * `DomainIssueError`, a `DomainIssue` is a plain value — validators return arrays of them
 * (e.g. one per bad citation, 03 §1) and the service decides whether to reject. A `hint`,
 * when present, is a DYNAMIC hint (e.g. naming a superseding claim) that overrides the
 * static per-code registry hint; `severity` defaults to `error`.
 */
export interface DomainIssue {
  code: IssueCode;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  path?: string;
  ids?: string[];
  hint?: string;
}

/**
 * The error domain services throw to signal a coded, structured failure. The CLI
 * maps it to an envelope `Issue` (code + registry hint) — never by message text.
 */
export class DomainIssueError extends Error {
  readonly code: IssueCode;
  readonly path: string | undefined;
  readonly ids: string[] | undefined;
  readonly details: unknown;
  /** Overrides the registry hint when set (see {@link DomainIssueOptions.hint}). */
  readonly hint: string | undefined;

  constructor(code: IssueCode, message: string, options: DomainIssueOptions = {}) {
    super(message);
    this.name = 'DomainIssueError';
    this.code = code;
    this.path = options.path;
    this.ids = options.ids;
    this.details = options.details;
    this.hint = options.hint;
  }
}

/**
 * One structured, coded diagnostic in a collected batch (e.g. 04 §2 manifest
 * prevalidation), where every issue carries the static per-code registry hint at error
 * severity. It is the hint-less, always-error NARROWING of `DomainIssue`, so a
 * `DomainIssueDetail[]` is accepted anywhere a `DomainIssue[]` is (notably
 * `DomainIssuesError`).
 */
export interface DomainIssueDetail {
  code: IssueCode;
  message: string;
  path?: string;
  ids?: string[];
}

/**
 * The error a domain service throws when it collected MULTIPLE coded issues before
 * rejecting — 04 §2 manifest prevalidation reports every structural/collision issue
 * together rather than failing on the first, and synthesize rejects on every bad
 * citation at once (03 §1). The CLI maps each carried `DomainIssue` to an envelope
 * `Issue` by CODE — never by message text — preserving per-issue dynamic hints and
 * severities. The `Error.message` concatenates the individual messages so a plain
 * `.toThrow(/…/)` (and any accidental stringification) still reads sensibly.
 */
export class DomainIssuesError extends Error {
  readonly issues: DomainIssue[];

  constructor(issues: DomainIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.name = 'DomainIssuesError';
    this.issues = issues;
  }
}
