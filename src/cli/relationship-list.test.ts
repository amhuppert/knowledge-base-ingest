import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { runCli, type CliIo } from './runCli.js';
import {
  seedCrossSourceKb,
  type CrossSourceFixture,
  type FixtureCliResult,
  type FixtureCliRun,
} from './test-fixtures.js';
import { RelationshipListSchema } from '../domain/schemas/readModels.js';
import type { RelationshipListResult } from '../domain/services/relationshipList.js';

interface Captured {
  code: number;
  json: {
    ok: boolean;
    data: unknown;
    issues: Array<{ code: string; message: string; hint?: string }>;
  };
}

const runFixture: FixtureCliRun = async (args): Promise<FixtureCliResult> => {
  const captured = await run(args);
  return { code: captured.code, json: captured.json };
};

async function run(args: string[]): Promise<Captured> {
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
  return { code, json: JSON.parse(stdout || '{}') as Captured['json'] };
}

describe('kb relationship list', () => {
  let fixture: CrossSourceFixture;
  let subjectId: string;
  let objectId: string;

  beforeAll(async () => {
    fixture = await seedCrossSourceKb(runFixture);
    const listed = await run(['relationship', 'list', '--kb', fixture.kbDir]);
    const data = listed.json.data as RelationshipListResult;
    subjectId = data.relationships[0]!.subject.id;
    objectId = data.relationships[0]!.object.id;
  });

  afterAll(() => {
    if (fixture) rmSync(fixture.kbDir, { recursive: true, force: true });
  });

  it('returns the A4 JSON shape and parses it through RelationshipListSchema', async () => {
    const response = await run(['relationship', 'list', '--kb', fixture.kbDir]);
    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    const data = RelationshipListSchema.parse(response.json.data);
    expect(data.filter).toEqual({});
    expect(data.relationships).toHaveLength(1);
    expect(data.relationships[0]).toMatchObject({
      id: fixture.r1,
      type: 'depends_on',
      status: 'active',
      description: '',
      confidence: 0.8,
      firstSeenSource: {
        id: fixture.sourceA,
        status: 'active',
      },
      subject: { type: 'Service', canonicalName: 'Billing' },
      object: { type: 'Service', canonicalName: 'Auth' },
    });
    expect(data.relationships[0]!.evidence).toHaveLength(2);
    expect(data.relationships[0]!.evidence[0]).toEqual(
      expect.objectContaining({
        spanId: expect.stringMatching(/^spn_/),
        role: 'supports',
        chunkId: expect.stringMatching(/^chk_/),
        sourceId: expect.stringMatching(/^src_/),
        sourceTitle: expect.any(String),
        sourceStatus: 'active',
        charStart: expect.any(Number),
        charEnd: expect.any(Number),
        quote: 'Billing calls Auth for token validation.',
      }),
    );
    expect(data.totals).toEqual({
      relationships: 1,
      evidenceLinks: 2,
      byStatus: { active: 1, superseded: 0, conflicted: 0, retracted: 0 },
      byType: { depends_on: 1 },
    });
    expect('matchesSourceScope' in data.relationships[0]!.evidence[0]!).toBe(false);
    expect('matchingEvidenceLinks' in data.totals).toBe(false);
  });

  it('--source selects by later-added evidence, returns all evidence, and marks the matching row', async () => {
    const response = await run([
      'relationship',
      'list',
      '--source',
      fixture.sourceB,
      '--kb',
      fixture.kbDir,
    ]);
    expect(response.code).toBe(0);
    const data = RelationshipListSchema.parse(response.json.data);
    expect(data.filter).toEqual({ sourceId: fixture.sourceB });
    expect(data.relationships.map((row) => row.id)).toEqual([fixture.r1]);
    expect(data.relationships[0]!.firstSeenSource?.id).toBe(fixture.sourceA);
    expect(data.relationships[0]!.evidence).toHaveLength(2);
    expect(
      data.relationships[0]!.evidence.find((row) => row.sourceId === fixture.sourceB)
        ?.matchesSourceScope,
    ).toBe(true);
    expect(
      data.relationships[0]!.evidence.find((row) => row.sourceId === fixture.sourceA)
        ?.matchesSourceScope,
    ).toBe(false);
    expect(data.totals.matchingEvidenceLinks).toBe(1);
  });

  it('supports every filter and AND-combines them', async () => {
    for (const args of [
      ['--entity', subjectId],
      ['--entity', objectId],
      ['--type', 'depends_on'],
      ['--status', 'active'],
      [
        '--source',
        fixture.sourceB,
        '--entity',
        subjectId,
        '--type',
        'depends_on',
        '--status',
        'active',
      ],
    ]) {
      const response = await run(['relationship', 'list', ...args, '--kb', fixture.kbDir]);
      expect(response.code, args.join(' ')).toBe(0);
      expect((response.json.data as RelationshipListResult).relationships.map((row) => row.id)).toEqual([
        fixture.r1,
      ]);
    }
  });

  it('returns ok:true with empty arrays for valid filters that match nothing', async () => {
    const response = await run([
      'relationship',
      'list',
      '--type',
      'not_a_real_type',
      '--status',
      'active',
      '--kb',
      fixture.kbDir,
    ]);
    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    const data = RelationshipListSchema.parse(response.json.data);
    expect(data.relationships).toEqual([]);
    expect(data.totals).toEqual({
      relationships: 0,
      evidenceLinks: 0,
      byStatus: { active: 0, superseded: 0, conflicted: 0, retracted: 0 },
      byType: {},
    });
  });

  it('rejects invalid --status as INVALID_ARGUMENT before any DB round-trip', async () => {
    const response = await run([
      'relationship',
      'list',
      '--status',
      'bogus',
      '--kb',
      '/definitely/not/a/kb',
    ]);
    expect(response.code).toBe(2);
    expect(response.json.issues).toEqual([
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    ]);
  });

  it.each([
    [
      ['--source', 'src_relationship_list_unknown'],
      'UNKNOWN_SOURCE',
      'List sources: kb source list --json',
    ],
    [
      ['--entity', 'ent_relationship_list_unknown'],
      'UNKNOWN_ENTITY',
      'List entities: kb entity list --json',
    ],
  ])('reports unknown filter ids with their listing recovery hint', async (args, code, hint) => {
    const response = await run(['relationship', 'list', ...args, '--kb', fixture.kbDir]);
    expect(response.code).toBe(1);
    expect(response.json.ok).toBe(false);
    expect(response.json.issues).toEqual([
      expect.objectContaining({ code, hint }),
    ]);
  });

  it('appears in root help under the registered relationship group', async () => {
    const response = await run(['--help']);
    expect(response.code).toBe(0);
    expect((response.json.data as { commands: string[] }).commands).toContain('relationship list');
  });

  it('documents the evidence-membership trap, schema, ordering, flags, and later-evidence example', async () => {
    const response = await run(['relationship', 'list', '--help']);
    expect(response.code).toBe(0);
    const help = response.json.data as {
      summary: string;
      flags: Array<{ flags: string }>;
      output: string[];
      related: string[];
      examples: Array<{ description: string; command: string }>;
    };
    expect(help.summary).toContain(
      '--source matches any live evidence span contributed by that source, not the source that first created the claim',
    );
    expect(help.flags.map((flag) => flag.flags)).toEqual(
      expect.arrayContaining([
        '--source <source_id>',
        '--entity <entity_id>',
        '--type <type>',
        '--status <status>',
      ]),
    );
    expect(help.output.join(' ')).toContain('RelationshipListSchema');
    expect(help.output.join(' ')).toContain(
      '(type, subject canonicalName, object canonicalName, id)',
    );
    expect(help.output.join(' ')).toContain('(sourceId, charStart, spanId)');
    expect(help.related).toEqual([
      'entity show',
      'entity list',
      'graph apply',
      'coverage',
      'source chunks',
      'source impact',
    ]);
    expect(help.examples).toEqual([
      expect.objectContaining({
        description: expect.stringMatching(/source A.*source B|source B.*source A/i),
        command: expect.stringContaining('--source src_B'),
      }),
    ]);
  });

  it('adds the relationship-list related edge back from every linked command', async () => {
    for (const command of [
      ['entity', 'show'],
      ['entity', 'list'],
      ['graph', 'apply'],
      ['source', 'chunks'],
    ]) {
      const response = await run([...command, '--help']);
      expect(
        (response.json.data as { related: string[] }).related,
        command.join(' '),
      ).toContain('relationship list');
    }
  });
});
