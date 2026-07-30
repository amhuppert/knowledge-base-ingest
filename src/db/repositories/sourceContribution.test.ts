import { describe, expect, it } from 'vitest';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import {
  makeClaimId,
  makeEntityId,
  makeRelationshipId,
  makeSourceId,
  makeSpanId,
} from '../../domain/ids.js';
import type { Claim, Entity, Relationship, Source, Span } from '../../domain/schemas/models.js';
import { Repositories } from './index.js';

const SOURCE_A = makeSourceId('src_source_a');
const SOURCE_B = makeSourceId('src_source_b');
const CLAIM_A = makeClaimId('clm_claim_a');
const CLAIM_B = makeClaimId('clm_claim_b');
const RELATIONSHIP_A = makeRelationshipId('rel_relationship_a');
const RELATIONSHIP_B = makeRelationshipId('rel_relationship_b');
const ENTITY_A = makeEntityId('ent_entity_a');
const ENTITY_B = makeEntityId('ent_entity_b');
const NOW = '2026-07-29T00:00:00.000Z';

function source(id: typeof SOURCE_A, title: string): Source {
  return {
    id,
    sha256: `sha-${id}`,
    storedPath: `sources/${id}.md`,
    originalPath: null,
    title,
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
}

function claim(id: typeof CLAIM_A, status: Claim['status']): Claim {
  return {
    id,
    nodeId: null,
    text: `Claim ${id}`,
    normalizedText: `claim ${id}`,
    claimType: 'fact',
    confidence: 0.9,
    status,
    supersededByClaimId: null,
    firstSeenSourceId: SOURCE_A,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function entity(id: typeof ENTITY_A, name: string): Entity {
  return {
    id,
    type: 'Service',
    canonicalName: name,
    normalizedName: name.toLowerCase(),
    description: '',
    confidence: 0.9,
    firstSeenSourceId: SOURCE_A,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function relationship(id: typeof RELATIONSHIP_A, type: string, status: Relationship['status']): Relationship {
  return {
    id,
    type,
    subjectEntityId: ENTITY_A,
    objectEntityId: ENTITY_B,
    description: '',
    confidence: 0.8,
    status,
    firstSeenSourceId: SOURCE_A,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function span(id: ReturnType<typeof makeSpanId>, start: number): Span {
  return {
    id,
    sourceId: SOURCE_B,
    chunkId: null,
    charStart: start,
    charEnd: start + 5,
    quote: 'proof',
    quoteHash: `hash-${id}`,
    createdAt: NOW,
  };
}

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  repos.sources.insert(source(SOURCE_A, 'Source A'));
  repos.sources.insert(source(SOURCE_B, 'Source B'));

  repos.claims.upsert(claim(CLAIM_B, 'conflicted'));
  repos.claims.upsert(claim(CLAIM_A, 'active'));

  repos.entities.upsert(entity(ENTITY_A, 'Alpha'));
  repos.entities.upsert(entity(ENTITY_B, 'Beta'));
  repos.relationships.upsert(relationship(RELATIONSHIP_B, 'uses', 'superseded'));
  repos.relationships.upsert(relationship(RELATIONSHIP_A, 'calls', 'active'));

  const claimSpanA = span(makeSpanId('spn_claim_a'), 0);
  const claimSpanB = span(makeSpanId('spn_claim_b'), 10);
  const relationshipSpanA = span(makeSpanId('spn_relationship_a'), 20);
  const relationshipSpanB = span(makeSpanId('spn_relationship_b'), 30);
  const orphanSpan = span(makeSpanId('spn_orphan'), 40);
  for (const evidence of [claimSpanA, claimSpanB, relationshipSpanA, relationshipSpanB, orphanSpan]) {
    repos.spans.upsert(evidence);
  }

  repos.claimSpans.upsert({
    claimId: CLAIM_B,
    spanId: claimSpanB.id,
    role: 'supports',
    confidence: 0.8,
    extractor: 'agent',
  });
  repos.claimSpans.upsert({
    claimId: CLAIM_A,
    spanId: claimSpanA.id,
    role: 'supports',
    confidence: 0.8,
    extractor: 'agent',
  });
  repos.relationshipSpans.upsert(RELATIONSHIP_B, relationshipSpanB.id, 'supports');
  repos.relationshipSpans.upsert(RELATIONSHIP_A, relationshipSpanA.id, 'supports');

  return { db, repos, claimSpanA, relationshipSpanA };
}

describe('SourceContributionRepository', () => {
  it('finds claims through live evidence added by a later source, ordered by id without status filtering', () => {
    const { db, repos, claimSpanA } = setup();

    expect(repos.sourceContribution.claimsEvidencedBy(SOURCE_B)).toEqual([
      {
        claimId: CLAIM_A,
        nodeId: null,
        status: 'active',
        claimType: 'fact',
        firstSeenSourceId: SOURCE_A,
      },
      {
        claimId: CLAIM_B,
        nodeId: null,
        status: 'conflicted',
        claimType: 'fact',
        firstSeenSourceId: SOURCE_A,
      },
    ]);

    db.prepare('DELETE FROM claim_spans WHERE claim_id = ? AND span_id = ?').run(CLAIM_A, claimSpanA.id);
    expect(repos.sourceContribution.claimsEvidencedBy(SOURCE_B).map((row) => row.claimId)).toEqual([CLAIM_B]);
  });

  it('finds relationships through live evidence added by a later source, ordered by id without status filtering', () => {
    const { db, repos, relationshipSpanA } = setup();

    expect(repos.sourceContribution.relationshipsEvidencedBy(SOURCE_B)).toEqual([
      {
        relationshipId: RELATIONSHIP_A,
        status: 'active',
        firstSeenSourceId: SOURCE_A,
      },
      {
        relationshipId: RELATIONSHIP_B,
        status: 'superseded',
        firstSeenSourceId: SOURCE_A,
      },
    ]);

    db.prepare('DELETE FROM relationship_spans WHERE relationship_id = ? AND span_id = ?').run(
      RELATIONSHIP_A,
      relationshipSpanA.id,
    );
    expect(repos.sourceContribution.relationshipsEvidencedBy(SOURCE_B).map((row) => row.relationshipId)).toEqual([
      RELATIONSHIP_B,
    ]);
  });
});
