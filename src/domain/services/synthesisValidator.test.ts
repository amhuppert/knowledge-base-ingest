import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { allowedCitations, validateSynthesis } from './synthesisValidator.js';
import { deriveNodeId, deriveClaimId } from '../algorithms/idDeriver.js';
import { normalizeClaimText } from '../algorithms/normalize.js';
import { makeSourceId, type ClaimId, type NodeId } from '../ids.js';
import type { Source, Node, Claim } from '../schemas/models.js';
import type { ClaimStatus } from '../schemas/enums.js';

/**
 * Shared synthesis validator (03 §1). `allowedCitations` = active/conflicted claims in
 * the target node's subtree, sorted; `validateSynthesis` applies per-citation precedence
 * (UNKNOWN > INACTIVE > OUT_OF_SUBTREE) with exactly one issue per distinct cited id,
 * ordered by first occurrence in `body_md`.
 */

const NOW = '2026-06-14T00:00:00.000Z';
const SOURCE_ID = makeSourceId('src_0000000000000000');

function makeRepos(): Repositories {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  const source: Source = {
    id: SOURCE_ID,
    sha256: '0'.repeat(64),
    storedPath: 'sources/00/0.md',
    originalPath: null,
    title: 'fixture',
    mediaType: 'text/markdown',
    byteSize: 1,
    sourceDate: null,
    author: null,
    versionLabel: null,
    supersedesSourceId: null,
    status: 'active',
    metadataJson: '{}',
    ingestedAt: NOW,
  };
  repos.sources.insert(source);
  return repos;
}

function addNode(repos: Repositories, parentId: NodeId | null, slug: string, title: string): NodeId {
  const id = deriveNodeId(parentId, slug);
  const node: Node = {
    id,
    parentId,
    slug,
    title,
    kind: parentId === null ? 'root' : 'topic',
    depth: parentId === null ? 0 : 1,
    sortOrder: 0,
    summary: '',
    bodyMd: '',
    bodyHash: '',
    isStale: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
  repos.nodes.insert(node);
  return id;
}

function addClaim(
  repos: Repositories,
  nodeId: NodeId,
  text: string,
  status: ClaimStatus = 'active',
  supersededBy: ClaimId | null = null,
): ClaimId {
  const normalizedText = normalizeClaimText(text);
  const id = deriveClaimId(normalizedText, SOURCE_ID);
  const claim: Claim = {
    id,
    nodeId,
    text,
    normalizedText,
    claimType: 'fact',
    confidence: 0.8,
    status,
    supersededByClaimId: supersededBy,
    firstSeenSourceId: SOURCE_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  repos.claims.upsert(claim);
  return id;
}

/**
 * A tree with a target subtree (topicA → leaf) and a sibling (topicB) outside it, seeded
 * with claims across every status, so subtree membership and status both matter.
 */
function seed() {
  const repos = makeRepos();
  const root = addNode(repos, null, 'root', 'Root');
  const topicA = addNode(repos, root, 'a', 'Topic A');
  const leaf = addNode(repos, topicA, 'leaf', 'Leaf');
  const topicB = addNode(repos, root, 'b', 'Topic B');

  const activeLeaf = addClaim(repos, leaf, 'active leaf claim', 'active');
  const conflictedA = addClaim(repos, topicA, 'conflicted topic-a claim', 'conflicted');
  // A superseded claim inside the subtree — excluded from allowedCitations, INACTIVE when cited.
  const supersededLeaf = addClaim(repos, leaf, 'superseded leaf claim', 'superseded', activeLeaf);
  const retractedLeaf = addClaim(repos, leaf, 'retracted leaf claim', 'retracted');
  // Active but OUTSIDE topicA's subtree — OUT_OF_SUBTREE when cited by topicA.
  const activeB = addClaim(repos, topicB, 'active topic-b claim', 'active');
  // Superseded AND outside — INACTIVE must dominate OUT_OF_SUBTREE.
  const supersededB = addClaim(repos, topicB, 'superseded topic-b claim', 'superseded', activeB);

  return { repos, root, topicA, leaf, topicB, activeLeaf, conflictedA, supersededLeaf, retractedLeaf, activeB, supersededB };
}

describe('allowedCitations', () => {
  it('returns active + conflicted claims in the subtree, sorted lexicographically, excluding superseded/retracted', () => {
    const { repos, topicA, activeLeaf, conflictedA } = seed();
    const allowed = allowedCitations(repos, topicA);
    expect(allowed).toEqual([activeLeaf, conflictedA].sort());
  });

  it('excludes claims owned outside the target subtree', () => {
    const { repos, topicA, activeB, supersededB } = seed();
    const allowed = allowedCitations(repos, topicA);
    expect(allowed).not.toContain(activeB);
    expect(allowed).not.toContain(supersededB);
  });

  it('a fixture-planted superseded claim in the subtree is excluded', () => {
    const { repos, topicA, supersededLeaf, retractedLeaf } = seed();
    const allowed = allowedCitations(repos, topicA);
    expect(allowed).not.toContain(supersededLeaf);
    expect(allowed).not.toContain(retractedLeaf);
  });
});

describe('validateSynthesis — per-citation precedence', () => {
  it('valid citations of active/conflicted in-subtree claims yield no issues', () => {
    const { repos, topicA, activeLeaf, conflictedA } = seed();
    const v = validateSynthesis(repos, {
      node_id: topicA,
      body_md: `A[^${activeLeaf}] and B[^${conflictedA}].`,
    });
    expect(v.issues).toEqual([]);
    expect(v.allowedCitationIds).toEqual([activeLeaf, conflictedA].sort());
  });

  it('an unknown cited id → CITATION_UNKNOWN with the id and body_md path', () => {
    const { repos, topicA } = seed();
    const v = validateSynthesis(repos, { node_id: topicA, body_md: 'X[^clm_deadbeefdeadbeef].' });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]!.code).toBe('CITATION_UNKNOWN');
    expect(v.issues[0]!.path).toBe('body_md');
    expect(v.issues[0]!.ids).toEqual(['clm_deadbeefdeadbeef']);
  });

  it('an in-subtree superseded claim → CITATION_INACTIVE naming the superseding claim in the hint', () => {
    const { repos, topicA, supersededLeaf, activeLeaf } = seed();
    const v = validateSynthesis(repos, { node_id: topicA, body_md: `X[^${supersededLeaf}].` });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]!.code).toBe('CITATION_INACTIVE');
    expect(v.issues[0]!.ids).toEqual([supersededLeaf]);
    expect(v.issues[0]!.hint).toContain(activeLeaf);
  });

  it('a retracted claim → CITATION_INACTIVE (no superseding claim set)', () => {
    const { repos, topicA, retractedLeaf } = seed();
    const v = validateSynthesis(repos, { node_id: topicA, body_md: `X[^${retractedLeaf}].` });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]!.code).toBe('CITATION_INACTIVE');
  });

  it('an active out-of-subtree claim → CITATION_OUT_OF_SUBTREE with [claimId, owningNodeId] and the owning node title in the hint', () => {
    const { repos, topicA, topicB, activeB } = seed();
    const v = validateSynthesis(repos, { node_id: topicA, body_md: `X[^${activeB}].` });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]!.code).toBe('CITATION_OUT_OF_SUBTREE');
    expect(v.issues[0]!.ids).toEqual([activeB, topicB]);
    expect(v.issues[0]!.hint).toContain('Topic B');
  });

  it('a claim that is BOTH inactive AND out-of-subtree yields only CITATION_INACTIVE (INACTIVE dominates)', () => {
    const { repos, topicA, supersededB, activeB } = seed();
    const v = validateSynthesis(repos, { node_id: topicA, body_md: `X[^${supersededB}].` });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]!.code).toBe('CITATION_INACTIVE');
    // The superseding claim is named in the hint; no OUT_OF_SUBTREE issue is emitted.
    expect(v.issues[0]!.hint).toContain(activeB);
    expect(v.issues.map((i) => i.code)).not.toContain('CITATION_OUT_OF_SUBTREE');
  });

  it('emits exactly one issue per distinct cited id (a repeated bad citation is not double-counted)', () => {
    const { repos, topicA, topicB, activeB } = seed();
    const v = validateSynthesis(repos, { node_id: topicA, body_md: `X[^${activeB}] then again [^${activeB}].` });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]!.ids).toEqual([activeB, topicB]);
  });

  it('orders issues by first occurrence of the citation in body_md', () => {
    const { repos, topicA, activeB, supersededLeaf } = seed();
    // activeB (OUT_OF_SUBTREE) occurs first, then an unknown id, then supersededLeaf (INACTIVE).
    const body = `First[^${activeB}], mid[^clm_deadbeefdeadbeef], last[^${supersededLeaf}].`;
    const v = validateSynthesis(repos, { node_id: topicA, body_md: body });
    expect(v.issues.map((i) => i.code)).toEqual([
      'CITATION_OUT_OF_SUBTREE',
      'CITATION_UNKNOWN',
      'CITATION_INACTIVE',
    ]);
  });
});
