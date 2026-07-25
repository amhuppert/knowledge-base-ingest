/**
 * DRY-RUN RUNNER (03 §2).
 *
 * `inDryRunTx` previews a DB-only mutation through the REAL code path and then rolls
 * it back, so a dry-run computes an authoritative receipt with zero net state change.
 * It works by running `fn` inside `repos.tx` and ALWAYS aborting that transaction with
 * a sentinel throw (`DryRunRollback`), which is swallowed after `fn`'s value is
 * captured. Verified by the Codex review premises (03 §2): `repos.tx` is
 * `db.transaction(fn).immediate()`; better-sqlite3 nests an inner service `repos.tx`
 * call as a SAVEPOINT, and the outer ROLLBACK removes both the content rows and the
 * FTS trigger rows — sound for every DB-only service (`claim apply`, `graph apply`,
 * `synthesize`). `ingest` is excluded (its store write is outside the DB tx; it uses
 * plan-based dry-run instead, 03 §5).
 */

import type { Repositories } from '../db/repositories/index.js';

/**
 * Sentinel thrown to force `repos.tx` to roll back a previewed mutation. Never
 * escapes `inDryRunTx` — a caught `DryRunRollback` is the expected success path; any
 * OTHER throw (a real validation failure) propagates unchanged so the CLI can surface
 * it as `ok:false`.
 */
export class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback (sentinel)');
    this.name = 'DryRunRollback';
  }
}

/**
 * Run `fn` inside a single `repos.tx` that is ALWAYS rolled back, returning `fn`'s
 * value. A non-sentinel throw from `fn` (e.g. a `DomainIssueError` from quote
 * verification) rolls the transaction back too and then propagates, so a failed
 * preview surfaces its real error rather than a silent no-op.
 */
export function inDryRunTx<T>(repos: Repositories, fn: () => T): T {
  let out!: T;
  try {
    repos.tx(() => {
      out = fn();
      throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  return out;
}
