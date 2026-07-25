import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './connection.js';
import { migrate, currentSchemaVersion, probeSchemaVersion } from './migrate.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('migrate', () => {
  it('creates the full schema and records the schema version', () => {
    const db = freshDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'meta',
      'sources',
      'source_texts',
      'source_chunks',
      'spans',
      'nodes',
      'claims',
      'claim_spans',
      'entities',
      'relationships',
      'relationship_spans',
      'changelog',
      'rendered_files',
    ]) {
      expect(tables).toContain(t);
    }
    const ver = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get() as { v: string };
    expect(Number(ver.v)).toBe(currentSchemaVersion());
  });

  it('is idempotent: re-running applies nothing new', () => {
    const db = openDb(':memory:');
    const a = migrate(db);
    const b = migrate(db);
    expect(a.applied.length).toBeGreaterThan(0);
    expect(b.applied.length).toBe(0);
  });

  it('enforces foreign keys', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_texts(source_id, extractor, extractor_version, text, text_hash) VALUES ('src_missing','text-utf8',1,'x','h')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('enforces CHECK constraints (invalid enum value rejected)', () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO sources(id, sha256, stored_path, title, media_type, byte_size, status, ingested_at) VALUES ('src_a','sha','p','t','text/markdown',1,'active','2026-01-01')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO sources(id, sha256, stored_path, title, media_type, byte_size, status, ingested_at) VALUES ('src_b','sha2','p2','t','text/markdown',1,'bogus','2026-01-01')",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('probeSchemaVersion reads read-only: no journal_mode=WAL switch, no sidecar files, no mutation', () => {
    // 02 §2: the version probe must be GENUINELY read-only. Build a DELETE-journal DB
    // (NOT WAL) with a recorded schema version; a probe that opened via the writable
    // `openDb` would run `PRAGMA journal_mode=WAL`, flipping the header and spawning a
    // `-wal` sidecar. The read-only probe must do none of that.
    const dir = mkdtempSync(join(tmpdir(), 'kb-probe-'));
    const dbPath = join(dir, 'kb.sqlite');
    try {
      const setup = new Database(dbPath);
      setup.pragma('journal_mode = DELETE');
      setup.exec('CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      setup.prepare("INSERT INTO meta(k, v) VALUES ('schema_version', '7')").run();
      setup.close();
      expect(existsSync(`${dbPath}-wal`)).toBe(false);

      expect(probeSchemaVersion(dbPath)).toBe(7);

      // The probe left the DB untouched: still DELETE journal mode, no WAL/shm sidecars.
      const check = new Database(dbPath, { readonly: true });
      const mode = check.pragma('journal_mode', { simple: true }) as string;
      check.close();
      expect(mode).toBe('delete');
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probeSchemaVersion returns null (never throws) when no schema version is recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-probe-'));
    const dbPath = join(dir, 'kb.sqlite');
    try {
      const setup = new Database(dbPath);
      setup.exec('CREATE TABLE unrelated(x)'); // no meta table at all
      setup.close();
      expect(probeSchemaVersion(dbPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps chunks_fts in sync through insert, update, and delete', () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO sources(id, sha256, stored_path, title, media_type, byte_size, status, ingested_at) VALUES ('src_a','sha','p','t','text/markdown',1,'active','2026-01-01')",
    ).run();
    const insertChunk = db.prepare(
      "INSERT INTO source_chunks(id, source_id, chunk_index, heading_path, text, char_start, char_end, token_estimate, content_hash, chunker_version) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    insertChunk.run('chk_a', 'src_a', 0, 'Auth', 'tokens rotate frequently', 0, 24, 6, 'h1', 1);

    const search = (term: string) =>
      db
        .prepare('SELECT sc.id FROM chunks_fts f JOIN source_chunks sc ON sc.rowid = f.rowid WHERE chunks_fts MATCH ?')
        .all(term) as Array<{ id: string }>;

    expect(search('rotate')).toHaveLength(1);

    db.prepare("UPDATE source_chunks SET text='widgets assemble slowly' WHERE id='chk_a'").run();
    expect(search('rotate')).toHaveLength(0);
    expect(search('widgets')).toHaveLength(1);

    db.prepare("DELETE FROM source_chunks WHERE id='chk_a'").run();
    expect(search('widgets')).toHaveLength(0);
  });
});
