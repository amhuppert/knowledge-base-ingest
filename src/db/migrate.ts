import type { Db } from './connection.js';
import { MIGRATIONS } from './migrations.js';

export interface MigrateResult {
  /** Versions applied by this call (empty when already up to date). */
  readonly applied: number[];
  readonly schemaVersion: number;
}

/** Highest migration version this binary knows about. */
export function currentSchemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

function ensureMigrationsTable(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );
}

/**
 * Apply all pending migrations in version order. Each migration runs in its own
 * transaction together with its bookkeeping insert, so a failure leaves the DB
 * at the last fully-applied version. Idempotent: re-running applies nothing.
 *
 * `applied_at` uses a fixed sentinel, not the wall clock, so the schema is a pure
 * function of the migration set (keeps tests deterministic; this column is
 * bookkeeping only).
 */
export function migrate(db: Db): MigrateResult {
  ensureMigrationsTable(db);
  const done = new Set(
    db
      .prepare('SELECT version FROM _migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );

  const applied: number[] = [];
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  const record = db.prepare(
    'INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const m of ordered) {
    if (done.has(m.version)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, 'applied');
    });
    run();
    applied.push(m.version);
  }

  const schemaVersion = currentSchemaVersion();
  db.prepare(
    `INSERT INTO meta(k, v) VALUES ('schema_version', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run(String(schemaVersion));

  return { applied, schemaVersion };
}

/**
 * Open-time guard: refuse to operate on a DB whose schema is newer than this
 * binary understands. Returns the on-disk version. Throws on a forward-incompat.
 */
export function assertSchemaCompatible(db: Db): number {
  const row = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get() as
    | { v: string }
    | undefined;
  const onDisk = row ? Number(row.v) : 0;
  if (onDisk > currentSchemaVersion()) {
    throw new Error(
      `KB schema version ${onDisk} is newer than this CLI supports (${currentSchemaVersion()}). Upgrade the kb CLI.`,
    );
  }
  return onDisk;
}
