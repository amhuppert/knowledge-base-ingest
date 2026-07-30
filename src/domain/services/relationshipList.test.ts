import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../../db/connection.js';
import { Repositories } from '../../db/repositories/index.js';
import {
  makeEntityId,
  makeRelationshipId,
  type EntityId,
  type RelationshipId,
} from '../ids.js';
import type { Entity, Relationship } from '../schemas/models.js';
import { DB_FILENAME } from '../../kb/workspace.js';
import { runCli, type CliIo } from '../../cli/runCli.js';
import {
  seedCrossSourceKb,
  type CrossSourceFixture,
  type FixtureCliResult,
  type FixtureCliRun,
} from '../../cli/test-fixtures.js';
import { buildRelationshipList } from './relationshipList.js';

const run: FixtureCliRun = async (args): Promise<FixtureCliResult> => {
  let stdout = '';
  const env = { ...process.env };
  delete env.KB_DIR;
  const io: CliIo = {
    stdout: (chunk) => (stdout += chunk),
    stderr: () => {},
    cwd: process.cwd(),
    env,
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(stdout || '{}') as FixtureCliResult['json'] };
};

const CATALOG = makeEntityId('ent_relationship_list_catalog');
const CALLS = makeRelationshipId('rel_relationship_list_calls');
const REVERSE_DEPENDENCY = makeRelationshipId('rel_relationship_list_reverse');

function entity(id: EntityId, type: string, canonicalName: string, sourceId: CrossSourceFixture['sourceB']): Entity {
  return {
    id,
    type,
    canonicalName,
    normalizedName: canonicalName.toLowerCase(),
    description: '',
    confidence: 0.8,
    firstSeenSourceId: sourceId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function relationship(
  id: RelationshipId,
  type: string,
  subjectEntityId: EntityId,
  objectEntityId: EntityId,
  status: Relationship['status'],
  sourceId: CrossSourceFixture['sourceB'],
): Relationship {
  return {
    id,
    type,
    subjectEntityId,
    objectEntityId,
    description: `${type} relationship`,
    confidence: 0.7,
    status,
    firstSeenSourceId: sourceId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildRelationshipList', () => {
  let fixture: CrossSourceFixture;
  let db: Db;
  let repos: Repositories;
  let authId: EntityId;
  let billingId: EntityId;

  beforeAll(async () => {
    fixture = await seedCrossSourceKb(run);
    db = openDb(join(fixture.kbDir, DB_FILENAME));
    repos = new Repositories(db);

    const seeded = repos.relationships.getById(fixture.r1)!;
    const seededEntities = repos.entities.listAll();
    const auth = seededEntities.find((row) => row.id === seeded.objectEntityId)!;
    const billing = seededEntities.find((row) => row.id === seeded.subjectEntityId)!;
    authId = auth.id;
    billingId = billing.id;

    repos.entities.upsert(entity(CATALOG, 'Service', 'Catalog', fixture.sourceB));
    repos.relationships.upsert(
      relationship(CALLS, 'calls', CATALOG, authId, 'active', fixture.sourceB),
    );
    repos.relationships.upsert(
      relationship(REVERSE_DEPENDENCY, 'depends_on', authId, billingId, 'superseded', fixture.sourceB),
    );

    const evidence = db
      .prepare(
        `SELECT rs.span_id AS spanId, s.source_id AS sourceId
           FROM relationship_spans rs
           JOIN spans s ON s.id = rs.span_id
          WHERE rs.relationship_id = ?`,
      )
      .all(fixture.r1) as Array<{ spanId: string; sourceId: string }>;
    const sourceASpan = evidence.find((row) => row.sourceId === fixture.sourceA)!;
    const sourceBSpan = evidence.find((row) => row.sourceId === fixture.sourceB)!;
    repos.relationshipSpans.upsert(CALLS, sourceBSpan.spanId as never, 'supports');
    repos.relationshipSpans.upsert(REVERSE_DEPENDENCY, sourceASpan.spanId as never, 'context');
  });

  afterAll(() => {
    db?.close();
    if (fixture) rmSync(fixture.kbDir, { recursive: true, force: true });
  });

  it('selects a relationship through evidence added by a later source and marks only matching evidence', () => {
    const result = buildRelationshipList(repos, { sourceId: fixture.sourceB });
    const relationship = result.relationships.find((row) => row.id === fixture.r1)!;

    expect(relationship.firstSeenSource?.id).toBe(fixture.sourceA);
    expect(relationship.evidence).toHaveLength(2);
    expect(relationship.evidence.map((row) => row.sourceId)).toContain(fixture.sourceA);
    expect(relationship.evidence.map((row) => row.sourceId)).toContain(fixture.sourceB);
    expect(
      relationship.evidence.find((row) => row.sourceId === fixture.sourceB)?.matchesSourceScope,
    ).toBe(true);
    expect(
      relationship.evidence.find((row) => row.sourceId === fixture.sourceA)?.matchesSourceScope,
    ).toBe(false);
    expect(result.totals).toMatchObject({
      relationships: 2,
      evidenceLinks: 3,
      matchingEvidenceLinks: 2,
      byStatus: { active: 2, superseded: 0, conflicted: 0, retracted: 0 },
      byType: { calls: 1, depends_on: 1 },
    });
  });

  it('AND-combines filters and matches --entity on either relationship endpoint', () => {
    expect(
      buildRelationshipList(repos, {
        sourceId: fixture.sourceA,
        entityId: authId,
        type: 'depends_on',
        status: 'superseded',
      }).relationships.map((row) => row.id),
    ).toEqual([REVERSE_DEPENDENCY]);

    expect(
      buildRelationshipList(repos, { entityId: billingId }).relationships.map((row) => row.id),
    ).toEqual([REVERSE_DEPENDENCY, fixture.r1]);
  });

  it('orders relationships and evidence deterministically and omits scoped-only fields without sourceId', () => {
    const result = buildRelationshipList(repos, {});
    expect(
      result.relationships.map(
        (row) => `${row.type}/${row.subject.canonicalName}/${row.object.canonicalName}/${row.id}`,
      ),
    ).toEqual([
      `calls/Catalog/Auth/${CALLS}`,
      `depends_on/Auth/Billing/${REVERSE_DEPENDENCY}`,
      `depends_on/Billing/Auth/${fixture.r1}`,
    ]);

    for (const row of result.relationships) {
      const evidenceKeys = row.evidence.map(
        (evidence) => `${evidence.sourceId}/${String(evidence.charStart).padStart(12, '0')}/${evidence.spanId}`,
      );
      expect(evidenceKeys).toEqual([...evidenceKeys].sort());
      expect(row.evidence.every((evidence) => !('matchesSourceScope' in evidence))).toBe(true);
    }
    expect('matchingEvidenceLinks' in result.totals).toBe(false);
  });

  it('hydrates any number of relationships in exactly three batched queries', () => {
    const original = db.prepare.bind(db);
    const prepared: string[] = [];
    const patched = db as unknown as { prepare: Db['prepare'] };
    patched.prepare = ((sql: string) => {
      prepared.push(sql);
      return original(sql);
    }) as Db['prepare'];
    try {
      expect(buildRelationshipList(repos, {}).relationships).toHaveLength(3);
    } finally {
      delete (patched as Partial<typeof patched>).prepare;
    }
    expect(prepared).toHaveLength(3);
    expect(prepared.filter((sql) => sql.includes('FROM relationships'))).toHaveLength(1);
    expect(prepared.filter((sql) => sql.includes('FROM entities'))).toHaveLength(1);
    expect(prepared.filter((sql) => sql.includes('relationship_spans'))).toHaveLength(1);
  });
});
