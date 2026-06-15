/**
 * Schema migrations, in order. Each entry is applied once and recorded in
 * `_migrations`. SQL lives here as template strings (no file IO) so it works
 * identically under tsx, vitest, and a compiled build.
 *
 * All domain tables are STRICT (typed storage) and use stable TEXT ids with a
 * type prefix. FTS5 tables use the external-content pattern kept in sync by
 * triggers, so no application code path can desync the index.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INIT = /* sql */ `
-- ---------- bookkeeping ----------
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) STRICT;

-- ---------- immutable source registry ----------
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL UNIQUE,
  stored_path   TEXT NOT NULL UNIQUE,
  original_path TEXT,
  title         TEXT NOT NULL,
  media_type    TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  source_date   TEXT,
  author        TEXT,
  version_label TEXT,
  supersedes_source_id TEXT REFERENCES sources(id),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','superseded','duplicate','retracted')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ingested_at   TEXT NOT NULL
) STRICT;
CREATE INDEX ix_sources_status ON sources(status);
CREATE INDEX ix_sources_supersedes ON sources(supersedes_source_id);

-- Canonical extracted text. Provenance offsets address THIS text, not raw bytes.
CREATE TABLE source_texts (
  source_id         TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  extractor         TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  text              TEXT NOT NULL,
  text_hash         TEXT NOT NULL
) STRICT;

-- ---------- deterministic chunks ----------
CREATE TABLE source_chunks (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  heading_path   TEXT NOT NULL DEFAULT '',
  text           TEXT NOT NULL,
  char_start     INTEGER NOT NULL,
  char_end       INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  chunker_version INTEGER NOT NULL,
  UNIQUE (source_id, chunk_index)
) STRICT;
CREATE INDEX ix_chunks_source ON source_chunks(source_id, chunk_index);

-- ---------- provenance spans (the atomic provenance target) ----------
CREATE TABLE spans (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_id   TEXT REFERENCES source_chunks(id) ON DELETE SET NULL,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL,
  quote      TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, char_start, char_end)
) STRICT;
CREATE INDEX ix_spans_source ON spans(source_id);
CREATE INDEX ix_spans_chunk ON spans(chunk_id);

-- ---------- synthesis tree (arbitrary depth) ----------
CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES nodes(id),
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('root','topic','leaf')),
  depth      INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  summary    TEXT NOT NULL DEFAULT '',
  body_md    TEXT NOT NULL DEFAULT '',
  body_hash  TEXT NOT NULL DEFAULT '',
  is_stale   INTEGER NOT NULL DEFAULT 1 CHECK (is_stale IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (parent_id, slug)
) STRICT;
CREATE INDEX ix_nodes_parent ON nodes(parent_id, sort_order);
CREATE INDEX ix_nodes_stale ON nodes(is_stale);

-- ---------- claims (knowledge atoms) ----------
CREATE TABLE claims (
  id              TEXT PRIMARY KEY,
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  text            TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  claim_type      TEXT NOT NULL CHECK (claim_type IN
                    ('fact','definition','decision','requirement','constraint',
                     'procedure','warning','example','open_question')),
  confidence      REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','superseded','conflicted','retracted')),
  superseded_by_claim_id TEXT REFERENCES claims(id),
  first_seen_source_id   TEXT NOT NULL REFERENCES sources(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (node_id, normalized_text)
) STRICT;
CREATE INDEX ix_claims_node ON claims(node_id, status);
CREATE INDEX ix_claims_status ON claims(status);

-- claim -> span provenance edges
CREATE TABLE claim_spans (
  claim_id   TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  span_id    TEXT NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'supports'
               CHECK (role IN ('supports','contradicts','context','supersedes')),
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  extractor  TEXT NOT NULL DEFAULT 'agent' CHECK (extractor IN ('agent','cli','human')),
  PRIMARY KEY (claim_id, span_id, role)
) STRICT;
CREATE INDEX ix_claim_spans_span ON claim_spans(span_id);

-- ---------- knowledge graph ----------
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  confidence      REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  first_seen_source_id TEXT REFERENCES sources(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (type, normalized_name)
) STRICT;
CREATE INDEX ix_entities_type ON entities(type);
CREATE INDEX ix_entities_norm ON entities(normalized_name);

CREATE TABLE relationships (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  subject_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  object_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  description       TEXT NOT NULL DEFAULT '',
  confidence        REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','superseded','conflicted','retracted')),
  first_seen_source_id TEXT REFERENCES sources(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (type, subject_entity_id, object_entity_id)
) STRICT;
CREATE INDEX ix_rel_subject ON relationships(subject_entity_id);
CREATE INDEX ix_rel_object ON relationships(object_entity_id);

CREATE TABLE relationship_spans (
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  span_id         TEXT NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'supports'
                    CHECK (role IN ('supports','contradicts','context','supersedes')),
  PRIMARY KEY (relationship_id, span_id, role)
) STRICT;
CREATE INDEX ix_rel_spans_span ON relationship_spans(span_id);

-- ---------- operating tables ----------
CREATE TABLE changelog (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  op          TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'agent',
  source_id   TEXT REFERENCES sources(id),
  summary     TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX ix_changelog_ts ON changelog(ts);

CREATE TABLE rendered_files (
  path         TEXT PRIMARY KEY,
  node_id      TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  content_hash TEXT NOT NULL,
  rendered_at  TEXT NOT NULL
) STRICT;

-- ---------- FTS5 (external content + sync triggers) ----------
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, heading_path, content='source_chunks', tokenize='porter unicode61'
);
CREATE TRIGGER chunks_fts_ai AFTER INSERT ON source_chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;
CREATE TRIGGER chunks_fts_ad AFTER DELETE ON source_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
END;
CREATE TRIGGER chunks_fts_au AFTER UPDATE ON source_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
  INSERT INTO chunks_fts(rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;

CREATE VIRTUAL TABLE claims_fts USING fts5(
  text, content='claims', tokenize='porter unicode61'
);
CREATE TRIGGER claims_fts_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER claims_fts_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER claims_fts_au AFTER UPDATE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO claims_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  title, body_md, content='nodes', tokenize='porter unicode61'
);
CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
END;
CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO nodes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: INIT },
];
