import type { Db } from '../connection.js';
import type { ClaimId, NodeId, RelationshipId, SourceId } from '../../domain/ids.js';
import type { ClaimStatus } from '../../domain/schemas/enums.js';

export interface ClaimContribution {
  claimId: ClaimId;
  nodeId: NodeId | null;
  status: ClaimStatus;
  claimType: string;
  firstSeenSourceId: SourceId;
}

export interface RelationshipContribution {
  relationshipId: RelationshipId;
  status: ClaimStatus;
  firstSeenSourceId: SourceId | null;
}

/**
 * The canonical read model for source membership: an object belongs to a source
 * only while a live provenance link reaches one of that source's spans.
 */
export class SourceContributionRepository {
  constructor(private readonly db: Db) {}

  claimsEvidencedBy(sourceId: SourceId): ClaimContribution[] {
    return this.db
      .prepare(
        `SELECT c.id AS claimId, c.node_id AS nodeId, c.status AS status,
                c.claim_type AS claimType, c.first_seen_source_id AS firstSeenSourceId
           FROM claims c
          WHERE EXISTS (
            SELECT 1
              FROM claim_spans cs
              JOIN spans s ON s.id = cs.span_id
             WHERE cs.claim_id = c.id AND s.source_id = ?
          )
          ORDER BY c.id`,
      )
      .all(sourceId) as ClaimContribution[];
  }

  relationshipsEvidencedBy(sourceId: SourceId): RelationshipContribution[] {
    return this.db
      .prepare(
        `SELECT r.id AS relationshipId, r.status AS status,
                r.first_seen_source_id AS firstSeenSourceId
           FROM relationships r
          WHERE EXISTS (
            SELECT 1
              FROM relationship_spans rs
              JOIN spans s ON s.id = rs.span_id
             WHERE rs.relationship_id = r.id AND s.source_id = ?
          )
          ORDER BY r.id`,
      )
      .all(sourceId) as RelationshipContribution[];
  }
}
