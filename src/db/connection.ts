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
