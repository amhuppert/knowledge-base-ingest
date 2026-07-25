/**
 * OUTPUT ENVELOPE v2 (01 §2).
 *
 * Every command emits exactly one `Envelope<T>`, built ONLY through the
 * `success()`/`result()` constructors. `data` carries the command payload and
 * nothing else; diagnostics live in `issues`; `errors`/`warnings` are *derived*
 * from `issues` inside the constructors (nothing writes them directly). The
 * load-bearing invariant, asserted across the suite, is:
 *
 *     ok === !issues.some(i => i.severity === 'error')
 */

export type IssueSeverity = 'error' | 'warning' | 'info';

/** A single diagnostic: a stable registry code plus a human message. */
export interface Issue {
  /** Stable SCREAMING_SNAKE id from the issue-code registry. */
  code: string;
  severity: IssueSeverity;
  message: string;
  /** Canonical bracket-dot path (see domain `formatPath`), when the issue is located. */
  path?: string;
  ids?: string[];
  hint?: string;
}

/** A follow-up the agent can run. `command` MUST be executable verbatim — no placeholders. */
export interface NextAction {
  title: string;
  command: string;
}

/** The single output envelope every command emits. */
export interface Envelope<T> {
  ok: boolean;
  /** Command payload ONLY — never issues or steering. */
  data: T | null;
  issues: Issue[];
  /** Derived: error-severity issue messages. */
  errors: string[];
  /** Derived: warning-severity issue messages. */
  warnings: string[];
  nextActions: NextAction[];
  /** Guidance strings; placeholder-bearing command templates live here, not in nextActions. */
  hints: string[];
}

/** Steering that either constructor may attach. */
export interface EnvelopeExtras {
  nextActions?: NextAction[];
  hints?: string[];
}

/** `success()` additionally accepts non-error issues (warnings/info). */
export interface SuccessExtras extends EnvelopeExtras {
  issues?: Issue[];
}

/** Split issue messages into the derived errors/warnings arrays, preserving order. */
function derive(issues: Issue[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message);
    else if (issue.severity === 'warning') warnings.push(issue.message);
  }
  return { errors, warnings };
}

function assemble<T>(okFlag: boolean, data: T | null, issues: Issue[], extras: EnvelopeExtras): Envelope<T> {
  const { errors, warnings } = derive(issues);
  return {
    ok: okFlag,
    data,
    issues,
    errors,
    warnings,
    nextActions: extras.nextActions ?? [],
    hints: extras.hints ?? [],
  };
}

/**
 * Build a successful envelope. `ok` is forced true; passing an error-severity
 * issue is a programming error and throws (a success cannot carry an error).
 */
export function success<T>(data: T, extras: SuccessExtras = {}): Envelope<T> {
  const issues = extras.issues ?? [];
  const offending = issues.find((i) => i.severity === 'error');
  if (offending) {
    throw new Error(`success() cannot carry an error-severity issue: [${offending.code}] ${offending.message}`);
  }
  return assemble(true, data, issues, extras);
}

/**
 * Build an envelope whose `ok` is DERIVED from its issues. Failures may still
 * carry non-null `data` (verify, render --check, answer-check keep their reports
 * on failure).
 */
export function result<T>(data: T | null, issues: Issue[], extras: EnvelopeExtras = {}): Envelope<T> {
  const okFlag = !issues.some((i) => i.severity === 'error');
  return assemble(okFlag, data, issues, extras);
}

/** Write sinks for CLI output, injected so `emit` can be captured in-process. */
export interface OutputStreams {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

const GLYPH: Record<IssueSeverity, string> = { error: '✗', warning: '!', info: 'ℹ' };

/**
 * Print an envelope as pretty JSON (machine) or a compact human summary. `renderHuman`
 * overrides the default `data` rendering in non-JSON mode: help commands build their
 * envelope through `success()` (envelope-discipline) but render `data` as a formatted
 * help block rather than raw JSON. It never affects `--json` output.
 */
export function emit(
  env: Envelope<unknown>,
  json: boolean,
  out: OutputStreams,
  renderHuman?: (data: unknown) => string,
): void {
  if (json) {
    out.stdout(JSON.stringify(env, null, 2) + '\n');
    return;
  }
  // Diagnostics + their per-issue hints go to stderr.
  for (const issue of env.issues) {
    out.stderr(`${GLYPH[issue.severity]} [${issue.code}] ${issue.message}\n`);
    if (issue.hint) out.stderr(`  ↳ ${issue.hint}\n`);
  }
  // Payload + steering go to stdout.
  if (env.data !== null && env.data !== undefined) {
    out.stdout((renderHuman ? renderHuman(env.data) : formatHuman(env.data)) + '\n');
  }
  if (env.nextActions.length > 0) {
    out.stdout('next:\n');
    for (const na of env.nextActions) out.stdout(`  ${na.title}\n    ${na.command}\n`);
  }
  for (const hint of env.hints) out.stdout(`tip: ${hint}\n`);
}

function formatHuman(data: unknown): string {
  if (data === null || data === undefined) return 'ok';
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}
