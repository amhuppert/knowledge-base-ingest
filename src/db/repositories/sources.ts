import type { Db } from '../connection.js';
import { SourceRow, SourceTextRow, ChunkRow } from '../rows.js';
import type { Source, SourceText, Chunk } from '../../domain/schemas/models.js';
import type { SourceId } from '../../domain/ids.js';
import type { SourceStatus } from '../../domain/schemas/enums.js';

export class SourceRepo {
  constructor(private readonly db: Db) {}

  insert(s: Source): void {
    this.db
      .prepare(
        `INSERT INTO sources(id, sha256, stored_path, original_path, title, media_type,
           byte_size, source_date, author, version_label, supersedes_source_id, status,
           metadata_json, ingested_at)
         VALUES (@id,@sha256,@storedPath,@originalPath,@title,@mediaType,@byteSize,
           @sourceDate,@author,@versionLabel,@supersedesSourceId,@status,@metadataJson,@ingestedAt)`,
      )
      .run(s as unknown as Record<string, unknown>);
  }

  getById(id: SourceId): Source | undefined {
    const r = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    return r ? SourceRow.parse(r) : undefined;
  }

  getBySha256(sha: string): Source | undefined {
    const r = this.db.prepare('SELECT * FROM sources WHERE sha256 = ?').get(sha);
    return r ? SourceRow.parse(r) : undefined;
  }

  listAll(): Source[] {
    return this.db
      .prepare('SELECT * FROM sources ORDER BY ingested_at, id')
      .all()
      .map((r) => SourceRow.parse(r));
  }

  updateMeta(
    id: SourceId,
    patch: { title?: string; sourceDate?: string | null; author?: string | null; versionLabel?: string | null },
  ): void {
    const cur = this.getById(id);
    if (!cur) return;
    this.db
      .prepare(
        `UPDATE sources SET title=@title, source_date=@sourceDate, author=@author,
           version_label=@versionLabel WHERE id=@id`,
      )
      .run({
        id,
        title: patch.title ?? cur.title,
        sourceDate: patch.sourceDate ?? cur.sourceDate,
        author: patch.author ?? cur.author,
        versionLabel: patch.versionLabel ?? cur.versionLabel,
      });
  }

  setStatus(id: SourceId, status: SourceStatus): void {
    this.db.prepare('UPDATE sources SET status = ? WHERE id = ?').run(status, id);
  }

  setSupersedes(id: SourceId, supersedesId: SourceId): void {
    this.db.prepare('UPDATE sources SET supersedes_source_id = ? WHERE id = ?').run(supersedesId, id);
  }
}

export class SourceTextRepo {
  constructor(private readonly db: Db) {}

  insert(t: SourceText): void {
    this.db
      .prepare(
        `INSERT INTO source_texts(source_id, extractor, extractor_version, text, text_hash)
         VALUES (@sourceId,@extractor,@extractorVersion,@text,@textHash)`,
      )
      .run(t as unknown as Record<string, unknown>);
  }

  get(sourceId: SourceId): SourceText | undefined {
    const r = this.db.prepare('SELECT * FROM source_texts WHERE source_id = ?').get(sourceId);
    return r ? SourceTextRow.parse(r) : undefined;
  }
}

export class ChunkRepo {
  constructor(private readonly db: Db) {}

  insert(c: Chunk): void {
    this.db
      .prepare(
        `INSERT INTO source_chunks(id, source_id, chunk_index, heading_path, text, char_start,
           char_end, token_estimate, content_hash, chunker_version)
         VALUES (@id,@sourceId,@chunkIndex,@headingPath,@text,@charStart,@charEnd,
           @tokenEstimate,@contentHash,@chunkerVersion)`,
      )
      .run(c as unknown as Record<string, unknown>);
  }

  listBySource(sourceId: SourceId): Chunk[] {
    return this.db
      .prepare('SELECT * FROM source_chunks WHERE source_id = ? ORDER BY chunk_index')
      .all(sourceId)
      .map((r) => ChunkRow.parse(r));
  }

  getById(id: string): Chunk | undefined {
    const r = this.db.prepare('SELECT * FROM source_chunks WHERE id = ?').get(id);
    return r ? ChunkRow.parse(r) : undefined;
  }
}
