import type { Db } from '../connection.js';
import type { SourceId, NodeId } from '../../domain/ids.js';

export interface ChangelogEntry {
  ts: string;
  op: string;
  actor?: string;
  sourceId?: SourceId | null;
  summary: string;
  detail?: unknown;
}

export interface ChangelogRow {
  id: number;
  ts: string;
  op: string;
  actor: string;
  summary: string;
  detailJson: string;
}

export class ChangelogRepo {
  constructor(private readonly db: Db) {}

  append(e: ChangelogEntry): void {
    this.db
      .prepare(
        `INSERT INTO changelog(ts, op, actor, source_id, summary, detail_json)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(e.ts, e.op, e.actor ?? 'agent', e.sourceId ?? null, e.summary, JSON.stringify(e.detail ?? {}));
  }

  recent(limit: number): ChangelogRow[] {
    return this.db
      .prepare('SELECT * FROM changelog ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row.id as number,
          ts: row.ts as string,
          op: row.op as string,
          actor: row.actor as string,
          summary: row.summary as string,
          detailJson: row.detail_json as string,
        };
      });
  }
}

export class RenderedFileRepo {
  constructor(private readonly db: Db) {}

  upsert(path: string, nodeId: NodeId | null, contentHash: string, renderedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO rendered_files(path, node_id, content_hash, rendered_at)
         VALUES (?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET node_id=excluded.node_id,
           content_hash=excluded.content_hash, rendered_at=excluded.rendered_at`,
      )
      .run(path, nodeId, contentHash, renderedAt);
  }

  get(path: string): { contentHash: string } | undefined {
    const r = this.db.prepare('SELECT content_hash FROM rendered_files WHERE path = ?').get(path) as
      | { content_hash: string }
      | undefined;
    return r ? { contentHash: r.content_hash } : undefined;
  }

  all(): Array<{ path: string; contentHash: string }> {
    return this.db
      .prepare('SELECT path, content_hash FROM rendered_files ORDER BY path')
      .all()
      .map((r) => {
        const row = r as { path: string; content_hash: string };
        return { path: row.path, contentHash: row.content_hash };
      });
  }
}
