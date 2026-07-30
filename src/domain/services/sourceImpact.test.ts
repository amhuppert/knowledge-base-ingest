import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, type CliIo } from '../../cli/runCli.js';
import {
  seedCrossSourceKb,
  type CrossSourceFixture,
  type FixtureCliResult,
  type FixtureCliRun,
} from '../../cli/test-fixtures.js';
import { openDb, type Db } from '../../db/connection.js';
import { Repositories } from '../../db/repositories/index.js';
import { DB_FILENAME } from '../../kb/workspace.js';
import { coverageForSource } from '../../coverage/coverage.js';
import { buildNodeContext } from './nodeContext.js';
import { buildSourceImpact, buildSourceImpactNode } from './sourceImpact.js';

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

describe('source impact read model', () => {
  let fixture: CrossSourceFixture;
  let db: Db;
  let repos: Repositories;

  beforeAll(async () => {
    fixture = await seedCrossSourceKb(run);
    db = openDb(join(fixture.kbDir, DB_FILENAME));
    repos = new Repositories(db);
  });

  afterAll(() => {
    db?.close();
    if (fixture) rmSync(fixture.kbDir, { recursive: true, force: true });
  });

  it('splits introduced objects from existing objects evidenced by the source', () => {
    const impact = buildSourceImpact(repos, fixture.sourceB);

    expect(impact.source).toEqual({
      id: fixture.sourceB,
      title: 'Source B',
      status: 'active',
    });
    expect(impact.claims.evidencedExisting).toEqual({
      byStatus: { active: 1, superseded: 0, conflicted: 0, retracted: 0 },
      total: 1,
      shown: 1,
      ids: [fixture.c1],
    });
    expect(impact.claims.introduced).toEqual({
      byStatus: { active: 2, superseded: 1, conflicted: 2, retracted: 0 },
      total: 5,
      shown: 5,
      ids: [
        fixture.c2,
        ...fixture.conflictedClaimIds,
        fixture.supersededClaimId,
        fixture.supersedingClaimId,
      ].sort(),
    });
    expect(impact.relationships).toEqual({
      introduced: {
        byStatus: { active: 0, superseded: 0, conflicted: 0, retracted: 0 },
        total: 0,
        shown: 0,
        ids: [],
      },
      evidencedExisting: {
        byStatus: { active: 1, superseded: 0, conflicted: 0, retracted: 0 },
        total: 1,
        shown: 1,
        ids: [fixture.r1],
      },
    });
  });

  it('lists affected owners and ancestors deepest-first and composes scoped summaries', () => {
    const impact = buildSourceImpact(repos, fixture.sourceB);
    const scopedCoverage = coverageForSource(repos, fixture.sourceB);

    expect(impact.affectedNodes).toEqual([
      {
        nodeId: fixture.nodeIds.leaf,
        title: 'Billing Authentication',
        depth: 2,
        stale: true,
        contributedClaimCount: 6,
      },
      {
        nodeId: fixture.nodeIds.topic,
        title: 'Services',
        depth: 1,
        stale: true,
        contributedClaimCount: 6,
      },
      {
        nodeId: fixture.nodeIds.root,
        title: 'Knowledge Base',
        depth: 0,
        stale: true,
        contributedClaimCount: 6,
      },
    ]);
    expect(impact.coverage).toEqual(
      Object.fromEntries(
        scopedCoverage.findings.map((finding) => [finding.code, finding.total]),
      ),
    );
    expect(impact.candidates).toEqual({
      total: scopedCoverage.candidates.total,
      claimIds: scopedCoverage.candidates.claimIds,
    });
  });

  it('builds a one-node working set with the node-context citation scope', () => {
    const drillDown = buildSourceImpactNode(
      repos,
      fixture.sourceB,
      fixture.nodeIds.leaf,
    );
    const context = buildNodeContext(repos, fixture.nodeIds.leaf)!;

    expect(drillDown).toBeDefined();
    expect(drillDown!.affected).toBe(true);
    expect(drillDown!.data.node).toEqual({
      id: fixture.nodeIds.leaf,
      title: 'Billing Authentication',
      bodyMd: context.data.node.bodyMd,
      bodyHash: context.data.node.bodyHash,
    });
    expect(drillDown!.data.contributedClaims.map((claim) => claim.claimId)).toEqual(
      [
        fixture.c1,
        fixture.c2,
        ...fixture.conflictedClaimIds,
        fixture.supersededClaimId,
        fixture.supersedingClaimId,
      ].sort(),
    );
    expect(
      drillDown!.data.contributedClaims.find(
        (claim) => claim.claimId === fixture.c1,
      ),
    ).toEqual(
      expect.objectContaining({
        text: 'Billing calls Auth for token validation.',
        status: 'active',
        candidates: expect.objectContaining({ matched: expect.any(Number) }),
      }),
    );
    expect(drillDown!.data.allowedCitationIds).toEqual(
      context.data.allowedCitationIds,
    );
    expect(drillDown!.data.children).toEqual([]);
  });

  it('includes descendant contributions in an ancestor drill-down and caps contribution ids at 20', () => {
    const ancestor = buildSourceImpactNode(
      repos,
      fixture.sourceA,
      fixture.nodeIds.topic,
    );
    expect(ancestor).toEqual(
      expect.objectContaining({
        affected: true,
        data: expect.objectContaining({
          contributedClaims: [
            expect.objectContaining({ claimId: fixture.c1 }),
          ],
          children: [
            {
              id: fixture.nodeIds.leaf,
              title: 'Billing Authentication',
              ownClaimCount: 5,
            },
          ],
        }),
      }),
    );

    const span = db
      .prepare('SELECT id FROM spans WHERE source_id = ? ORDER BY id LIMIT 1')
      .get(fixture.sourceB) as { id: string };
    const addedIds = Array.from(
      { length: 22 },
      (_, index) => `clm_source_impact_cap_${String(index).padStart(2, '0')}`,
    );
    const insertClaim = db.prepare(
      `INSERT INTO claims(
         id, node_id, text, normalized_text, claim_type, confidence, status,
         superseded_by_claim_id, first_seen_source_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'fact', 0.9, 'active', NULL, ?, ?, ?)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO claim_spans(claim_id, span_id, role, confidence, extractor)
       VALUES (?, ?, 'supports', 0.9, 'agent')`,
    );
    db.transaction(() => {
      for (const claimId of addedIds) {
        const text = `Source impact cap claim ${claimId}.`;
        insertClaim.run(
          claimId,
          fixture.nodeIds.leaf,
          text,
          text.toLowerCase(),
          fixture.sourceB,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        insertLink.run(claimId, span.id);
      }
    })();

    const impact = buildSourceImpact(repos, fixture.sourceB);
    const introduced = impact.claims.introduced;
    const expectedIds = [
      fixture.c2,
      ...fixture.conflictedClaimIds,
      fixture.supersededClaimId,
      fixture.supersedingClaimId,
      ...addedIds,
    ].sort();
    expect(introduced).toMatchObject({
      total: 27,
      shown: 20,
      ids: expectedIds.slice(0, 20),
    });
    expect(impact.candidates.claimIds).toHaveLength(impact.candidates.total);
    expect(impact.candidates.claimIds).toEqual(
      [...impact.candidates.claimIds].sort(),
    );
  });
});
