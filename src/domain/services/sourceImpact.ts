import type {
  ClaimContribution,
  RelationshipContribution,
  Repositories,
} from '../../db/repositories/index.js';
import {
  COVERAGE_ID_CAP,
  coverageForSource,
  type SourceCoverageCode,
} from '../../coverage/coverage.js';
import type {
  ClaimId,
  NodeId,
  RelationshipId,
  SourceId,
} from '../ids.js';
import type { ClaimStatus, SourceStatus } from '../schemas/enums.js';
import {
  candidatesForClaim,
  type ClaimCandidateSet,
} from './claimCandidates.js';
import { buildNodeContext } from './nodeContext.js';

type StatusTotals = Record<ClaimStatus, number>;

interface ContributionSummary<Id extends string> {
  byStatus: StatusTotals;
  total: number;
  shown: number;
  ids: Id[];
}

export interface SourceImpactData {
  source: {
    id: SourceId;
    title: string;
    status: SourceStatus;
  };
  claims: {
    introduced: ContributionSummary<ClaimId>;
    evidencedExisting: ContributionSummary<ClaimId>;
  };
  relationships: {
    introduced: ContributionSummary<RelationshipId>;
    evidencedExisting: ContributionSummary<RelationshipId>;
  };
  affectedNodes: Array<{
    nodeId: NodeId;
    title: string;
    depth: number;
    stale: boolean;
    contributedClaimCount: number;
  }>;
  coverage: Record<SourceCoverageCode, number>;
  candidates: {
    total: number;
    claimIds: ClaimId[];
  };
}

export interface SourceImpactNodeData {
  node: {
    id: NodeId;
    title: string;
    bodyMd: string;
    bodyHash: string;
  };
  contributedClaims: Array<{
    claimId: ClaimId;
    text: string;
    status: ClaimStatus;
    candidates: ClaimCandidateSet;
  }>;
  allowedCitationIds: ClaimId[];
  children: Array<{
    id: NodeId;
    title: string;
    ownClaimCount: number;
  }>;
}

export interface SourceImpactNodeResult {
  data: SourceImpactNodeData;
  affected: boolean;
}

function emptyStatusTotals(): StatusTotals {
  return {
    active: 0,
    superseded: 0,
    conflicted: 0,
    retracted: 0,
  };
}

function summarize<Id extends string>(
  contributions: Array<{ id: Id; status: ClaimStatus }>,
): ContributionSummary<Id> {
  const sorted = [...contributions].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const byStatus = emptyStatusTotals();
  for (const contribution of sorted) byStatus[contribution.status] += 1;
  const ids = sorted.slice(0, COVERAGE_ID_CAP).map((contribution) => contribution.id);
  return {
    byStatus,
    total: sorted.length,
    shown: ids.length,
    ids,
  };
}

function splitClaims(
  contributions: ClaimContribution[],
  sourceId: SourceId,
): SourceImpactData['claims'] {
  const introduced: Array<{ id: ClaimId; status: ClaimStatus }> = [];
  const evidencedExisting: Array<{ id: ClaimId; status: ClaimStatus }> = [];
  for (const contribution of contributions) {
    const target =
      contribution.firstSeenSourceId === sourceId
        ? introduced
        : evidencedExisting;
    target.push({ id: contribution.claimId, status: contribution.status });
  }
  return {
    introduced: summarize(introduced),
    evidencedExisting: summarize(evidencedExisting),
  };
}

function splitRelationships(
  contributions: RelationshipContribution[],
  sourceId: SourceId,
): SourceImpactData['relationships'] {
  const introduced: Array<{ id: RelationshipId; status: ClaimStatus }> = [];
  const evidencedExisting: Array<{ id: RelationshipId; status: ClaimStatus }> = [];
  for (const contribution of contributions) {
    const target =
      contribution.firstSeenSourceId === sourceId
        ? introduced
        : evidencedExisting;
    target.push({
      id: contribution.relationshipId,
      status: contribution.status,
    });
  }
  return {
    introduced: summarize(introduced),
    evidencedExisting: summarize(evidencedExisting),
  };
}

function affectedNodes(
  repos: Repositories,
  contributions: ClaimContribution[],
): SourceImpactData['affectedNodes'] {
  const nodes = repos.nodes.listAll();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const subtreeCounts = new Map<NodeId, number>();
  const affected = new Set<NodeId>();

  for (const contribution of contributions) {
    if (contribution.nodeId === null) continue;
    let current = byId.get(contribution.nodeId);
    while (current) {
      affected.add(current.id);
      subtreeCounts.set(
        current.id,
        (subtreeCounts.get(current.id) ?? 0) + 1,
      );
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }

  return nodes
    .filter((node) => affected.has(node.id))
    .sort(
      (a, b) =>
        b.depth - a.depth ||
        a.sortOrder - b.sortOrder ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      depth: node.depth,
      stale: node.isStale,
      contributedClaimCount: subtreeCounts.get(node.id) ?? 0,
    }));
}

function candidateClaimIds(
  repos: Repositories,
  contributions: ClaimContribution[],
): ClaimId[] {
  return contributions
    .filter((contribution) => contribution.status === 'active')
    .filter((contribution) => {
      const claim = repos.claims.getById(contribution.claimId);
      if (!claim) {
        throw new Error(
          `source contribution references missing claim ${contribution.claimId}`,
        );
      }
      return (
        candidatesForClaim(repos, {
          nodeId: claim.nodeId,
          text: claim.text,
          excludeClaimIds: [claim.id],
        }).matched > 0
      );
    })
    .map((contribution) => contribution.claimId);
}

/**
 * Build the compact source-impact index.
 *
 * Membership is read exclusively from the canonical source-contribution
 * repository. `firstSeenSourceId` is consulted only after membership is established,
 * to split introduced objects from existing objects that gained evidence.
 */
export function buildSourceImpact(
  repos: Repositories,
  sourceId: SourceId,
): SourceImpactData {
  const source = repos.sources.getById(sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);

  const claimContributions =
    repos.sourceContribution.claimsEvidencedBy(sourceId);
  const relationshipContributions =
    repos.sourceContribution.relationshipsEvidencedBy(sourceId);
  const scopedCoverage = coverageForSource(repos, sourceId);
  const candidateIds = candidateClaimIds(repos, claimContributions);

  return {
    source: {
      id: source.id,
      title: source.title,
      status: source.status,
    },
    claims: splitClaims(claimContributions, sourceId),
    relationships: splitRelationships(relationshipContributions, sourceId),
    affectedNodes: affectedNodes(repos, claimContributions),
    coverage: Object.fromEntries(
      scopedCoverage.findings.map((finding) => [finding.code, finding.total]),
    ) as Record<SourceCoverageCode, number>,
    candidates: {
      total: candidateIds.length,
      claimIds: candidateIds,
    },
  };
}

/**
 * Build one node's source-scoped synthesis working set.
 *
 * The complete citation scope and direct-child claim counts come from the existing
 * node-context service so this view cannot drift from `kb node show --context`.
 */
export function buildSourceImpactNode(
  repos: Repositories,
  sourceId: SourceId,
  nodeId: NodeId,
): SourceImpactNodeResult | undefined {
  const context = buildNodeContext(repos, nodeId);
  if (!context) return undefined;

  const contributions =
    repos.sourceContribution.claimsEvidencedBy(sourceId);
  const subtreeNodeIds = new Set(
    repos.nodes.listSubtree(nodeId).map((node) => node.id),
  );
  const subtreeContributions = contributions.filter(
    (contribution) =>
      contribution.nodeId !== null &&
      subtreeNodeIds.has(contribution.nodeId),
  );
  const contributedClaims = subtreeContributions.map((contribution) => {
    const claim = repos.claims.getById(contribution.claimId);
    if (!claim) {
      throw new Error(
        `source contribution references missing claim ${contribution.claimId}`,
      );
    }
    return {
      claimId: claim.id,
      text: claim.text,
      status: claim.status,
      candidates: candidatesForClaim(repos, {
        nodeId: claim.nodeId,
        text: claim.text,
        excludeClaimIds: [claim.id],
      }),
    };
  });
  const affected = affectedNodes(repos, contributions).some(
    (node) => node.nodeId === nodeId,
  );

  return {
    affected,
    data: {
      node: {
        id: context.data.node.id,
        title: context.data.node.title,
        bodyMd: context.data.node.bodyMd,
        bodyHash: context.data.node.bodyHash,
      },
      contributedClaims,
      allowedCitationIds: context.data.allowedCitationIds,
      children: context.data.children.map((child) => ({
        id: child.id,
        title: child.title,
        ownClaimCount: child.ownClaims,
      })),
    },
  };
}
