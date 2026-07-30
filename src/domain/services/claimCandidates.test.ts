import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../kb/workspace.js';
import {
  makeClaimId,
  makeNodeId,
  makeSourceId,
  type ClaimId,
  type NodeId,
} from '../ids.js';
import type { Claim, Node, Source } from '../schemas/models.js';
import {
  buildClaimCandidateMatchQuery,
  candidatesForClaim,
} from './claimCandidates.js';

const SOURCE_ID = makeSourceId('src_candidates');
const NODE_A = makeNodeId('nod_candidates_a');
const NODE_B = makeNodeId('nod_candidates_b');
const NOW = '2026-01-01T00:00:00.000Z';

function source(): Source {
  return {
    id: SOURCE_ID,
    sha256: 'sha-candidates',
    storedPath: 'sources/candidates.md',
    originalPath: null,
    title: 'Candidates',
    mediaType: 'text/markdown',
    byteSize: 10,
    sourceDate: null,
    author: null,
    versionLabel: null,
    supersedesSourceId: null,
    status: 'active',
    metadataJson: '{}',
    ingestedAt: NOW,
  };
}

function node(id: NodeId, slug: string): Node {
  return {
    id,
    parentId: null,
    slug,
    title: slug,
    kind: 'root',
    depth: 0,
    sortOrder: 0,
    summary: '',
    bodyMd: '',
    bodyHash: '',
    isStale: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function claim(
  id: string,
  nodeId: NodeId | null,
  text: string,
  status: Claim['status'] = 'active',
): Claim {
  return {
    id: makeClaimId(id),
    nodeId,
    text,
    normalizedText: text.toLowerCase(),
    claimType: 'fact',
    confidence: 0.9,
    status,
    supersededByClaimId: null,
    firstSeenSourceId: SOURCE_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let directory: string;
let workspace: Workspace;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kb-candidates-'));
  workspace = initWorkspace(directory).ws;
  workspace.repos.sources.insert(source());
  workspace.repos.nodes.insert(node(NODE_A, 'a'));
  workspace.repos.nodes.insert(node(NODE_B, 'b'));
});

afterEach(() => {
  workspace.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('candidatesForClaim', () => {
  it.each([
    {
      name: 'lowercases and splits on non-word characters',
      proposed: 'ALPHA, beta-gamma',
      expected: 'alpha OR beta OR gamma',
    },
    {
      name: 'keeps underscores as word characters',
      proposed: 'alpha_beta',
      expected: 'alpha_beta',
    },
    {
      name: 'drops tokens shorter than three characters',
      proposed: 'an ox alpha',
      expected: 'alpha',
    },
    {
      name: 'uses only the first eight distinct tokens',
      proposed: 'one two three four five six seven eight nine',
      expected: 'one OR two OR three OR four OR five OR six OR seven OR eight',
    },
    {
      name: 'keeps only the first occurrence of duplicate tokens',
      proposed: 'Alpha beta alpha BETA gamma',
      expected: 'alpha OR beta OR gamma',
    },
  ])('$name', ({ proposed, expected }) => {
    expect(buildClaimCandidateMatchQuery(proposed)).toBe(expected);
  });

  it('drops the complete fixed stopword list and skips FTS when no tokens survive', () => {
    workspace.repos.claims.upsert(
      claim('clm_stopwords', NODE_B, 'the and for with that this are was has have not its'),
    );

    const result = candidatesForClaim(workspace.repos, {
      nodeId: NODE_A,
      text: 'the and for with that this are was has have not its',
      excludeClaimIds: [],
    });

    expect(result).toEqual({ matched: 0, shown: 0, complete: true, items: [] });
  });

  it('returns only active/conflicted candidates and same-node wins deduplication', () => {
    workspace.repos.claims.upsert(claim('clm_same', NODE_A, 'shared lexical phrase'));
    workspace.repos.claims.upsert(claim('clm_conflicted', NODE_B, 'shared phrase contested', 'conflicted'));
    workspace.repos.claims.upsert(claim('clm_superseded', NODE_B, 'shared phrase old', 'superseded'));
    workspace.repos.claims.upsert(claim('clm_retracted', NODE_B, 'shared phrase withdrawn', 'retracted'));

    const result = candidatesForClaim(workspace.repos, {
      nodeId: NODE_A,
      text: 'shared lexical phrase',
      excludeClaimIds: [],
    });

    expect(result.items.map(({ claimId, reason, score }) => ({ claimId, reason, score }))).toEqual([
      { claimId: makeClaimId('clm_same'), reason: 'same_node', score: 1 },
      {
        claimId: makeClaimId('clm_conflicted'),
        reason: 'lexical_overlap',
        score: expect.any(Number),
      },
    ]);
  });

  it('reports the exact match count while capping shown items at five', () => {
    for (let index = 0; index < 7; index++) {
      workspace.repos.claims.upsert(
        claim(`clm_cap_${index}`, NODE_B, `shared candidate ${index}`),
      );
    }

    const result = candidatesForClaim(workspace.repos, {
      nodeId: NODE_A,
      text: 'shared candidate',
      excludeClaimIds: [],
    });

    expect(result).toMatchObject({ matched: 7, shown: 5, complete: false });
    expect(result.items).toHaveLength(5);
  });

  it('excludes every supplied claim id before counting and slicing', () => {
    const excluded: ClaimId[] = [
      makeClaimId('clm_excluded_same'),
      makeClaimId('clm_excluded_lexical'),
    ];
    workspace.repos.claims.upsert(claim(excluded[0]!, NODE_A, 'shared candidate'));
    workspace.repos.claims.upsert(claim(excluded[1]!, NODE_B, 'shared candidate excluded'));
    workspace.repos.claims.upsert(claim('clm_kept', NODE_B, 'shared candidate kept'));

    const result = candidatesForClaim(workspace.repos, {
      nodeId: NODE_A,
      text: 'shared candidate',
      excludeClaimIds: excluded,
    });

    expect(result.matched).toBe(1);
    expect(result.items.map((item) => item.claimId)).toEqual([makeClaimId('clm_kept')]);
  });
});
