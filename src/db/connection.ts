import Database from 'better-sqlite3';

/** A live SQLite connection (better-sqlite3 is synchronous). */
export type Db = Database.Database;

/**
 * Open a KB database with the pragmas every connection must have:
 *  - foreign_keys=ON so referential integrity is enforced (off by default!),
 *  - busy_timeout so concurrent CLI invocations wait rather than fail,
 *  - WAL for on-disk DBs (not applicable to in-memory).
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

/**
 * Open a KB database READ-ONLY for a pure inspection (the `kb version` schema probe;
 * 02 §2). Unlike `openDb`, it opens with `SQLITE_OPEN_READONLY` and sets NO pragmas
 * that write to the file — critically NOT `journal_mode = WAL`, which mutates the DB
 * header and spawns `-wal`/`-shm` sidecars and would fail on a read-only-on-disk KB.
 * Only `busy_timeout` (a connection-scoped setting that never touches the file) is set,
 * so the probe never migrates, never mutates, and answers even when a normal open would.
 * The caller must ensure the file exists (better-sqlite3 will not create it here).
 */
export function openDbReadonly(path: string): Db {
  const db = new Database(path, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}
