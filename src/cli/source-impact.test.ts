import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/connection.js';
import { DB_FILENAME } from '../kb/workspace.js';
import { runCli, type CliIo } from './runCli.js';
import {
  seedCrossSourceKb,
  type CrossSourceFixture,
  type FixtureCliResult,
  type FixtureCliRun,
} from './test-fixtures.js';

interface Issue {
  code: string;
  severity: string;
  message: string;
  ids?: string[];
  hint?: string;
}

interface Captured {
  code: number;
  json: {
    ok: boolean;
    data: unknown;
    issues: Issue[];
    hints: string[];
  };
}

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

async function impact(
  fixture: CrossSourceFixture,
  sourceId: string,
  nodeId?: string,
): Promise<Captured> {
  const args = ['source', 'impact', sourceId];
  if (nodeId) args.push('--node', nodeId);
  return (await run([...args, '--kb', fixture.kbDir])) as Captured;
}

describe('kb source impact', () => {
  let fixture: CrossSourceFixture;
  let unaffectedNodeId: string;

  beforeAll(async () => {
    fixture = await seedCrossSourceKb(run);
    const created = await run([
      'node',
      'create',
      '--title',
      'Unrelated Topic',
      '--kind',
      'leaf',
      '--parent',
      fixture.nodeIds.topic,
      '--kb',
      fixture.kbDir,
    ]);
    unaffectedNodeId = (created.json.data as { nodeId: string }).nodeId;
  });

  afterAll(() => {
    if (fixture) rmSync(fixture.kbDir, { recursive: true, force: true });
  });

  it('returns only compact source summaries with the cross-source split', async () => {
    const response = await impact(fixture, fixture.sourceB);
    const coverage = await run([
      'coverage',
      '--source',
      fixture.sourceB,
      '--kb',
      fixture.kbDir,
    ]);
    const coverageData = coverage.json.data as {
      findings: Array<{ code: string; total: number }>;
      candidates: { total: number; claimIds: string[] };
    };
    const data = response.json.data as {
      source: { id: string; title: string; status: string };
      claims: {
        introduced: {
          byStatus: Record<string, number>;
          total: number;
          shown: number;
          ids: string[];
        };
        evidencedExisting: {
          byStatus: Record<string, number>;
          total: number;
          shown: number;
          ids: string[];
        };
      };
      relationships: {
        introduced: { total: number; shown: number; ids: string[] };
        evidencedExisting: {
          byStatus: Record<string, number>;
          total: number;
          shown: number;
          ids: string[];
        };
      };
      affectedNodes: Array<{
        nodeId: string;
        title: string;
        depth: number;
        stale: boolean;
        contributedClaimCount: number;
      }>;
      coverage: Record<string, number>;
      candidates: { total: number; claimIds: string[] };
    };

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    expect(data.source).toEqual({
      id: fixture.sourceB,
      title: 'Source B',
      status: 'active',
    });
    expect(data.claims.evidencedExisting).toEqual({
      byStatus: { active: 1, superseded: 0, conflicted: 0, retracted: 0 },
      total: 1,
      shown: 1,
      ids: [fixture.c1],
    });
    expect(data.claims.introduced).toEqual({
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
    expect(data.relationships.introduced).toMatchObject({
      total: 0,
      shown: 0,
      ids: [],
    });
    expect(data.relationships.evidencedExisting).toEqual({
      byStatus: { active: 1, superseded: 0, conflicted: 0, retracted: 0 },
      total: 1,
      shown: 1,
      ids: [fixture.r1],
    });
    expect(data.affectedNodes.map((node) => node.nodeId)).toEqual([
      fixture.nodeIds.leaf,
      fixture.nodeIds.topic,
      fixture.nodeIds.root,
    ]);
    expect(data.coverage).toEqual(
      Object.fromEntries(
        coverageData.findings.map((finding) => [finding.code, finding.total]),
      ),
    );
    expect(data.candidates).toEqual({
      total: coverageData.candidates.total,
      claimIds: coverageData.candidates.claimIds,
    });

    const compactJson = JSON.stringify(data);
    for (const forbiddenKey of [
      '"bodyMd"',
      '"bodyHash"',
      '"text"',
      '"quote"',
      '"provenance"',
      '"items"',
    ]) {
      expect(compactJson).not.toContain(forbiddenKey);
    }
  });

  it('returns the node working set and exactly matches node show citation scope', async () => {
    const response = await impact(
      fixture,
      fixture.sourceB,
      fixture.nodeIds.leaf,
    );
    const nodeContext = await run([
      'node',
      'show',
      fixture.nodeIds.leaf,
      '--context',
      '--kb',
      fixture.kbDir,
    ]);
    const data = response.json.data as {
      node: { id: string; title: string; bodyMd: string; bodyHash: string };
      contributedClaims: Array<{
        claimId: string;
        text: string;
        status: string;
        candidates: { matched: number };
      }>;
      allowedCitationIds: string[];
      children: Array<{ id: string; title: string; ownClaimCount: number }>;
    };

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    expect(data.node).toEqual(
      expect.objectContaining({
        id: fixture.nodeIds.leaf,
        title: 'Billing Authentication',
        bodyMd: expect.any(String),
        bodyHash: expect.any(String),
      }),
    );
    expect(data.contributedClaims.map((claim) => claim.claimId)).toEqual(
      [
        fixture.c1,
        fixture.c2,
        ...fixture.conflictedClaimIds,
        fixture.supersededClaimId,
        fixture.supersedingClaimId,
      ].sort(),
    );
    expect(data.contributedClaims[0]).toEqual(
      expect.objectContaining({
        text: expect.any(String),
        status: expect.any(String),
        candidates: expect.objectContaining({ matched: expect.any(Number) }),
      }),
    );
    expect(data.allowedCitationIds).toEqual(
      (nodeContext.json.data as { allowedCitationIds: string[] })
        .allowedCitationIds,
    );
    expect(data.children).toEqual([]);
  });

  it('emits one drill-down hint only while an affected node is stale', async () => {
    const stale = await impact(fixture, fixture.sourceB);
    expect(stale.json.hints).toEqual([
      `kb source impact ${fixture.sourceB} --node ${fixture.nodeIds.leaf} --json`,
    ]);

    const db = openDb(join(fixture.kbDir, DB_FILENAME));
    try {
      db.prepare('UPDATE nodes SET is_stale = 0').run();
      const fresh = await impact(fixture, fixture.sourceB);
      expect(fresh.json.hints).toEqual([]);
    } finally {
      db.prepare('UPDATE nodes SET is_stale = 1 WHERE id IN (?, ?, ?)').run(
        fixture.nodeIds.root,
        fixture.nodeIds.topic,
        fixture.nodeIds.leaf,
      );
      db.close();
    }
  });

  it('fails unknown ids with standard recovery hints', async () => {
    const unknownSource = await impact(fixture, 'src_missing');
    expect(unknownSource.code).toBe(1);
    expect(unknownSource.json.issues).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_SOURCE',
        severity: 'error',
        ids: ['src_missing'],
        hint: 'List sources: kb source list --json',
      }),
    ]);

    const unknownNode = await impact(
      fixture,
      fixture.sourceB,
      'nod_missing',
    );
    expect(unknownNode.code).toBe(1);
    expect(unknownNode.json.issues).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_NODE',
        severity: 'error',
        ids: ['nod_missing'],
        hint: expect.stringContaining('kb node tree --json'),
      }),
    ]);
  });

  it('returns an unaffected node successfully with exactly one info issue', async () => {
    const response = await impact(
      fixture,
      fixture.sourceB,
      unaffectedNodeId,
    );

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    expect(response.json.issues).toEqual([
      expect.objectContaining({
        code: 'SOURCE_NO_CLAIMS',
        severity: 'info',
        ids: [fixture.sourceB, unaffectedNodeId],
      }),
    ]);
    expect(
      (response.json.data as { contributedClaims: unknown[] })
        .contributedClaims,
    ).toEqual([]);
  });

  it('documents the compact/drill-down contract and links related commands both ways', async () => {
    const help = await run(['source', 'impact', '--help']);
    const spec = help.json.data as {
      command: string;
      usage: string;
      flags: Array<{ flags: string }>;
      output: string[];
      related: string[];
      examples: Array<{ command: string }>;
    };
    expect(spec.command).toBe('source impact');
    expect(spec.usage).toContain('impact <source_id>');
    expect(spec.flags).toContainEqual(
      expect.objectContaining({ flags: '--node <node_id>' }),
    );
    expect(spec.output.join(' ')).toContain('never claim or relationship bodies');
    expect(spec.output.join(' ')).toContain('depth DESC');
    expect(spec.output.join(' ')).toContain('ordered by claimId');
    expect(spec.related).toEqual([
      'coverage',
      'relationship list',
      'claim candidates',
      'node show',
    ]);
    expect(spec.examples.length).toBeGreaterThan(0);

    for (const command of [
      ['coverage'],
      ['relationship', 'list'],
      ['claim', 'candidates'],
      ['node', 'show'],
    ]) {
      const relatedHelp = await run([...command, '--help']);
      expect(
        (relatedHelp.json.data as { related: string[] }).related,
        command.join(' '),
      ).toContain('source impact');
    }
  });
});
