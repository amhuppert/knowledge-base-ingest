/**
 * POSIX shell quoting — ONE implementation, shared by the two places that render a
 * runnable `kb …` command into agent-facing output: the CLI's next-actions/re-run
 * commands (`src/cli/run.ts` re-exports this) and the domain's recovery recipes
 * (`media.ts`, `recipes.ts`), which must stay executable verbatim even when a path
 * or title carries spaces or shell metacharacters (charter: verbatim-next-actions).
 *
 * It lives in the domain layer because the domain cannot import the CLI (enforced by
 * `issueCodes.test.ts`), while the CLI may import the domain.
 */

/**
 * Shell-quote a dynamic argument. Shell-safe values (the `shlex.quote` safe set) pass
 * through unquoted; anything else is single-quoted with embedded single quotes escaped
 * as `'\''`. The empty string becomes `''` (never a vanishing bare token).
 */
export function shellQuoteArg(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
