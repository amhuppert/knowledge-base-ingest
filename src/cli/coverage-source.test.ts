import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/connection.js';
import { DB_FILENAME } from '../kb/workspace.js';
import { CoverageSourceReportSchema } from '../domain/schemas/readModels.js';
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

async function coverageSource(sourceId: string, kbDir: string): Promise<Captured> {
  const response = await run(['coverage', '--source', sourceId, '--kb', kbDir]);
  return response as Captured;
}

describe('kb coverage --source', () => {
  let fixture: CrossSourceFixture;

  beforeAll(async () => {
    fixture = await seedCrossSourceKb(run);
  });

  afterAll(() => {
    if (fixture) rmSync(fixture.kbDir, { recursive: true, force: true });
  });

  it('returns the exact zero-preserving scoped shape and includes later-added evidence', async () => {
    const source = await run(['source', 'show', fixture.sourceB, '--kb', fixture.kbDir]);
    const chunks = await run(['source', 'chunks', fixture.sourceB, '--kb', fixture.kbDir]);
    const structuralIds = (
      chunks.json.data as {
        chunks: Array<{ id: string; contentKind: string }>;
      }
    ).chunks
      .filter((chunk) => chunk.contentKind === 'structural')
      .map((chunk) => chunk.id)
      .sort();
    const response = await coverageSource(fixture.sourceB, fixture.kbDir);
    const activeUnsynthesized = [fixture.c2, fixture.supersedingClaimId].sort();

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    expect(response.json.data).toEqual({
      scope: {
        kind: 'source',
        sourceId: fixture.sourceB,
        title: (source.json.data as { title: string }).title,
        sourceStatus: 'active',
        membership: 'evidence-span',
      },
      chunks: {
        total: 3,
        substantive: 1,
        cited: 1,
        uncited: { total: 0, shown: 0, ids: [] },
        structural: { total: 2, shown: 2, ids: structuralIds },
      },
      claims: {
        active: {
          total: 3,
          synthesized: 1,
          unsynthesized: { total: 2, shown: 2, ids: activeUnsynthesized },
        },
        conflicted: {
          total: 2,
          shown: 2,
          ids: [...fixture.conflictedClaimIds].sort(),
        },
        superseded: {
          total: 1,
          shown: 1,
          ids: [fixture.supersededClaimId],
        },
        retracted: { total: 0, shown: 0, ids: [] },
      },
      relationships: {
        total: 1,
        byStatus: { active: 1, superseded: 0, conflicted: 0, retracted: 0 },
      },
      candidates: {
        total: 3,
        shown: 3,
        claimIds: [fixture.c1, fixture.c2, fixture.supersedingClaimId].sort(),
      },
      findings: [
        { code: 'SOURCE_NO_CLAIMS', total: 0, shown: 0, ids: [] },
        { code: 'CHUNK_UNCITED', total: 0, shown: 0, ids: [] },
        {
          code: 'CLAIM_NOT_SYNTHESIZED',
          total: 2,
          shown: 2,
          ids: activeUnsynthesized,
        },
        { code: 'OPEN_QUESTION_NOT_SYNTHESIZED', total: 0, shown: 0, ids: [] },
      ],
    });
    expect(CoverageSourceReportSchema.parse(response.json.data)).toEqual(response.json.data);
    expect(
      (response.json.data as { claims: { active: { total: number } } }).claims.active.total,
    ).toBe(3);
    expect(fixture.c1).not.toBe(fixture.c2);

    const findingIssue = response.json.issues.find(
      (issue) => issue.code === 'CLAIM_NOT_SYNTHESIZED',
    );
    expect(findingIssue).toEqual(
      expect.objectContaining({
        severity: 'info',
        ids: activeUnsynthesized,
      }),
    );
    expect(findingIssue!.message).toContain('(2 of 2 shown)');
  });

  it('caps candidate claim ids at 20 while preserving exact total and deterministic ordering', async () => {
    const db = openDb(join(fixture.kbDir, DB_FILENAME));
    const span = db
      .prepare('SELECT id FROM spans WHERE source_id = ? ORDER BY id LIMIT 1')
      .get(fixture.sourceB) as { id: string };
    const addedIds = Array.from(
      { length: 22 },
      (_, index) => `clm_coverage_cap_${String(index).padStart(2, '0')}`,
    );
    try {
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
        for (const [index, claimId] of addedIds.entries()) {
          const text = `Coverage cap candidate ${index}.`;
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

      const response = await coverageSource(fixture.sourceB, fixture.kbDir);
      const candidates = (
        response.json.data as {
          candidates: { total: number; shown: number; claimIds: string[] };
        }
      ).candidates;
      const expectedIds = [
        fixture.c1,
        fixture.c2,
        fixture.supersedingClaimId,
        ...addedIds,
      ].sort();

      expect(candidates).toEqual({
        total: 25,
        shown: 20,
        claimIds: expectedIds.slice(0, 20),
      });
    } finally {
      db.transaction(() => {
        for (const claimId of addedIds) {
          db.prepare('DELETE FROM claim_spans WHERE claim_id = ?').run(claimId);
          db.prepare('DELETE FROM claims WHERE id = ?').run(claimId);
        }
      })();
      db.close();
    }
  });

  it('returns structured UNKNOWN_SOURCE with the source-list recovery hint and exit 1', async () => {
    const response = await coverageSource('src_does_not_exist', fixture.kbDir);

    expect(response.code).toBe(1);
    expect(response.json.ok).toBe(false);
    expect(response.json.data).toBeNull();
    expect(response.json.issues).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_SOURCE',
        severity: 'error',
        ids: ['src_does_not_exist'],
        hint: 'List sources: kb source list --json',
      }),
    ]);
  });

  it('keeps a valid all-clean source successful with all finding zeros', async () => {
    const response = await coverageSource(fixture.sourceA, fixture.kbDir);

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    expect(
      (response.json.data as { findings: Array<{ total: number }> }).findings.map(
        (finding) => finding.total,
      ),
    ).toEqual([0, 0, 0, 0]);
  });

  it('steers scoped coverage to the same source relationship review but corpus coverage does not', async () => {
    const scoped = await coverageSource(fixture.sourceB, fixture.kbDir);
    const corpus = (await run(['coverage', '--kb', fixture.kbDir])) as Captured;

    expect(scoped.json.hints).toEqual([
      `kb relationship list --source ${fixture.sourceB} --json`,
    ]);
    expect(corpus.json.hints).toEqual([
      'Coverage is descriptive; kb verify --strict --json remains the integrity gate.',
    ]);
  });

  it('allows a superseded source and emits one info issue naming its status', async () => {
    const db = openDb(join(fixture.kbDir, DB_FILENAME));
    db.prepare(`UPDATE sources SET status = 'superseded' WHERE id = ?`).run(fixture.sourceA);
    db.close();

    const response = await coverageSource(fixture.sourceA, fixture.kbDir);

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    expect(
      (response.json.data as { scope: { sourceStatus: string } }).scope.sourceStatus,
    ).toBe('superseded');
    const statusIssues = response.json.issues.filter((issue) =>
      issue.message.includes('superseded'),
    );
    expect(statusIssues).toEqual([
      expect.objectContaining({ severity: 'info', ids: [fixture.sourceA] }),
    ]);
  });

  it('documents evidence-span membership, scoped semantics, and later-added evidence', async () => {
    const response = await run(['coverage', '--help']);
    const help = response.json.data as {
      usage: string;
      summary: string;
      flags: Array<{ flags: string; description: string }>;
      output: string[];
      workflow: string;
      related: string[];
      examples: Array<{ description: string; command: string }>;
    };
    const documentation = [
      help.summary,
      help.workflow,
      ...help.output,
      ...help.examples.flatMap((example) => [example.description, example.command]),
    ].join(' ');

    expect(response.code).toBe(0);
    expect(help.usage).toContain('--source');
    expect(help.flags).toContainEqual(
      expect.objectContaining({ flags: '--source <source_id>' }),
    );
    expect(documentation).toContain(
      '--source matches any live evidence span contributed by that source, not the source that first created the claim',
    );
    expect(documentation).toContain('NODE_SINGLE_SOURCE is corpus-only');
    expect(documentation).toContain('empty scoped results are success');
    expect(documentation).toContain('unknown sources are structured errors');
    expect(documentation).toContain(
      'candidate review inventory with exact total and capped claim ids only',
    );
    expect(help.related).toContain('relationship list');
    expect(help.examples).toContainEqual({
      description: 'Scope to a source that added evidence to existing claims',
      command: 'kb coverage --source src_1a2b3c --json',
    });
  });
});
