import type { Db } from '../connection.js';
import { NodeRow, ClaimRow } from '../rows.js';
import type { Node, Claim } from '../../domain/schemas/models.js';
import type { NodeId, ClaimId, SourceId } from '../../domain/ids.js';
import type { ClaimStatus } from '../../domain/schemas/enums.js';

export class NodeRepo {
  constructor(private readonly db: Db) {}

  insert(n: Node): void {
    this.db
      .prepare(
        `INSERT INTO nodes(id, parent_id, slug, title, kind, depth, sort_order, summary,
           body_md, body_hash, is_stale, created_at, updated_at)
         VALUES (@id,@parentId,@slug,@title,@kind,@depth,@sortOrder,@summary,@bodyMd,
           @bodyHash,@isStaleInt,@createdAt,@updatedAt)`,
      )
      .run({ ...n, isStaleInt: n.isStale ? 1 : 0 } as unknown as Record<string, unknown>);
  }

  getById(id: NodeId): Node | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    return r ? NodeRow.parse(r) : undefined;
  }

  getByParentSlug(parentId: NodeId | null, slug: string): Node | undefined {
    const r =
      parentId === null
        ? this.db.prepare('SELECT * FROM nodes WHERE parent_id IS NULL AND slug = ?').get(slug)
        : this.db.prepare('SELECT * FROM nodes WHERE parent_id = ? AND slug = ?').get(parentId, slug);
    return r ? NodeRow.parse(r) : undefined;
  }

  getRoot(): Node | undefined {
    const r = this.db.prepare("SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY id LIMIT 1").get();
    return r ? NodeRow.parse(r) : undefined;
  }

  children(parentId: NodeId): Node[] {
    return this.db
      .prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY sort_order, id')
      .all(parentId)
      .map((r) => NodeRow.parse(r));
  }

  listAll(): Node[] {
    return this.db
      .prepare('SELECT * FROM nodes ORDER BY depth, sort_order, id')
      .all()
      .map((r) => NodeRow.parse(r));
  }

  listStaleDeepestFirst(): Node[] {
    return this.db
      .prepare('SELECT * FROM nodes WHERE is_stale = 1 ORDER BY depth DESC, sort_order, id')
      .all()
      .map((r) => NodeRow.parse(r));
  }

  updateBody(
    id: NodeId,
    fields: { bodyMd: string; bodyHash: string; title?: string; summary?: string; isStale: boolean; updatedAt: string },
  ): void {
    const cur = this.getById(id);
    if (!cur) return;
    this.db
      .prepare(
        `UPDATE nodes SET body_md=@bodyMd, body_hash=@bodyHash, title=@title, summary=@summary,
           is_stale=@isStaleInt, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({
        id,
        bodyMd: fields.bodyMd,
        bodyHash: fields.bodyHash,
        title: fields.title ?? cur.title,
        summary: fields.summary ?? cur.summary,
        isStaleInt: fields.isStale ? 1 : 0,
        updatedAt: fields.updatedAt,
      });
  }

  /** Mark this node and all its ancestors stale, in one statement (recursive CTE). */
  markStaleWithAncestors(id: NodeId, updatedAt: string): void {
    this.db
      .prepare(
        `WITH RECURSIVE anc(id) AS (
           SELECT id FROM nodes WHERE id = ?
           UNION
           SELECT n.parent_id FROM nodes n JOIN anc ON n.id = anc.id WHERE n.parent_id IS NOT NULL
         )
         UPDATE nodes SET is_stale = 1, updated_at = ? WHERE id IN (SELECT id FROM anc)`,
      )
      .run(id, updatedAt);
  }

  setStale(id: NodeId, stale: boolean, updatedAt: string): void {
    this.db
      .prepare('UPDATE nodes SET is_stale = ?, updated_at = ? WHERE id = ?')
      .run(stale ? 1 : 0, updatedAt, id);
  }
}

export class ClaimRepo {
  constructor(private readonly db: Db) {}

  /** Insert, or update the existing claim with the same id. Reports whether it was created. */
  upsert(c: Claim): { claim: Claim; created: boolean } {
    const existing = this.getById(c.id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE claims SET node_id=@nodeId, text=@text, normalized_text=@normalizedText,
             claim_type=@claimType, confidence=@confidence, status=@status,
             superseded_by_claim_id=@supersededByClaimId, updated_at=@updatedAt WHERE id=@id`,
        )
        .run(c as unknown as Record<string, unknown>);
      return { claim: c, created: false };
    }
    this.db
      .prepare(
        `INSERT INTO claims(id, node_id, text, normalized_text, claim_type, confidence, status,
           superseded_by_claim_id, first_seen_source_id, created_at, updated_at)
         VALUES (@id,@nodeId,@text,@normalizedText,@claimType,@confidence,@status,
           @supersededByClaimId,@firstSeenSourceId,@createdAt,@updatedAt)`,
      )
      .run(c as unknown as Record<string, unknown>);
    return { claim: c, created: true };
  }

  getById(id: ClaimId): Claim | undefined {
    const r = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
    return r ? ClaimRow.parse(r) : undefined;
  }

  getByNodeNormalized(nodeId: NodeId, normalizedText: string): Claim | undefined {
    const r = this.db
      .prepare('SELECT * FROM claims WHERE node_id = ? AND normalized_text = ?')
      .get(nodeId, normalizedText);
    return r ? ClaimRow.parse(r) : undefined;
  }

  listByNode(nodeId: NodeId): Claim[] {
    return this.db
      .prepare('SELECT * FROM claims WHERE node_id = ? ORDER BY created_at, id')
      .all(nodeId)
      .map((r) => ClaimRow.parse(r));
  }

  /** All claims whose owning node is in the subtree rooted at nodeId (recursive). */
  listInSubtree(nodeId: NodeId): Claim[] {
    return this.db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE id = ?
           UNION
           SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
         )
         SELECT c.* FROM claims c WHERE c.node_id IN (SELECT id FROM sub)
         ORDER BY c.created_at, c.id`,
      )
      .all(nodeId)
      .map((r) => ClaimRow.parse(r));
  }

  listBySource(sourceId: SourceId): Claim[] {
    return this.db
      .prepare('SELECT * FROM claims WHERE first_seen_source_id = ? ORDER BY created_at, id')
      .all(sourceId)
      .map((r) => ClaimRow.parse(r));
  }

  setStatus(id: ClaimId, status: ClaimStatus, supersededBy: ClaimId | null, updatedAt: string): void {
    this.db
      .prepare('UPDATE claims SET status = ?, superseded_by_claim_id = ?, updated_at = ? WHERE id = ?')
      .run(status, supersededBy, updatedAt, id);
  }
}
