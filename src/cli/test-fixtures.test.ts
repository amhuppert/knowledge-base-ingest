import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/connection.js';
import { Repositories } from '../db/repositories/index.js';
import { DB_FILENAME } from '../kb/workspace.js';
import { runCli, type CliIo } from './runCli.js';
import {
  seedCrossSourceKb,
  type FixtureCliResult,
  type FixtureCliRun,
  type CrossSourceFixture,
} from './test-fixtures.js';

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

describe('seedCrossSourceKb', () => {
  let fixture: CrossSourceFixture;

  afterAll(() => {
    if (fixture) rmSync(fixture.kbDir, { recursive: true, force: true });
  });

  it('builds the shared cross-source scenario through the real CLI and returns resolvable ids', async () => {
    fixture = await seedCrossSourceKb(run);

    for (const sourceId of [fixture.sourceA, fixture.sourceB]) {
      const shown = await run(['source', 'show', sourceId, '--kb', fixture.kbDir]);
      expect(shown.code).toBe(0);
      expect((shown.json.data as { id: string }).id).toBe(sourceId);
    }

    const chunks = await run(['source', 'chunks', fixture.sourceB, '--kb', fixture.kbDir]);
    const heading = (chunks.json.data as { chunks: Array<{ id: string; contentKind: string }> }).chunks.find(
      (chunk) => chunk.id === fixture.headingChunkId,
    );
    expect(heading?.contentKind).toBe('structural');

    const db = openDb(join(fixture.kbDir, DB_FILENAME));
    try {
      const repos = new Repositories(db);
      expect(repos.sourceContribution.claimsEvidencedBy(fixture.sourceB).map((row) => row.claimId)).toContain(
        fixture.c1,
      );
      expect(
        repos.sourceContribution.relationshipsEvidencedBy(fixture.sourceB).map((row) => row.relationshipId),
      ).toContain(fixture.r1);

      expect(repos.claims.getById(fixture.c1)?.firstSeenSourceId).toBe(fixture.sourceA);
      expect(repos.relationships.getById(fixture.r1)?.firstSeenSourceId).toBe(fixture.sourceA);
      expect(repos.claims.getById(fixture.c2)?.status).toBe('active');
      expect(repos.claims.getById(fixture.supersededClaimId)?.status).toBe('superseded');
      expect(fixture.conflictedClaimIds.map((id) => repos.claims.getById(id)?.status)).toEqual([
        'conflicted',
        'conflicted',
      ]);
      for (const nodeId of Object.values(fixture.nodeIds)) {
        expect(repos.nodes.getById(nodeId)?.bodyMd).toContain(`[^${fixture.c1}]`);
      }
    } finally {
      db.close();
    }
  });
});
