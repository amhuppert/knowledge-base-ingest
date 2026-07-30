import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIM_TYPES, ENTITY_TYPES, RELATIONSHIP_TYPES, SPAN_ROLES } from '../domain/schemas/enums.js';
import { runCli, type CliIo } from './runCli.js';

interface ObservedType {
  type: string;
  count: number;
  recommended: boolean;
}

interface VocabularyData {
  claimTypes?: readonly string[];
  spanRoles?: readonly string[];
  entityTypes?: { recommended: readonly string[]; observed: ObservedType[] };
  relationshipTypes?: { recommended: readonly string[]; observed: ObservedType[] };
}

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: VocabularyData | null;
    issues: Array<{ code: string }>;
  };
}

let kb: string;
let sourceId: string;
let chunkId: string;
let payloadCounter = 0;

async function run(args: string[]): Promise<CliResult> {
  let stdout = '';
  const io: CliIo = {
    stdout: (chunk) => (stdout += chunk),
    stderr: () => {},
    cwd: kb,
    env: { KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(stdout || '{}') as CliResult['json'] };
}

async function applyGraph(payload: unknown): Promise<CliResult> {
  const file = join(kb, `graph-${payloadCounter++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return run(['graph', 'apply', '--file', file]);
}

beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-vocabulary-'));
  await run(['init', kb]);
  const source = join(kb, 'source.md');
  writeFileSync(source, '# Graph\n\nGateway calls Billing and Billing calls Ledger.\n');
  const ingested = await run(['ingest', source]);
  sourceId = (ingested.json.data as unknown as { sourceId: string }).sourceId;
  const chunks = await run(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as unknown as { chunks: Array<{ id: string; text: string }> }).chunks.find(
    (chunk) => chunk.text.includes('Gateway calls Billing'),
  )!.id;

  const applied = await applyGraph({
    source_id: sourceId,
    entities: [
      { type: 'Service', name: 'Gateway' },
      { type: 'Service', name: 'Billing' },
      { type: 'Subsystem', name: 'Ledger' },
    ],
    relationships: [
      {
        type: 'calls',
        subject: { type: 'Service', name: 'Gateway' },
        object: { type: 'Service', name: 'Billing' },
        evidence: [{ chunk_id: chunkId, quote: 'Gateway calls Billing' }],
      },
      {
        type: 'routes_to',
        subject: { type: 'Service', name: 'Billing' },
        object: { type: 'Subsystem', name: 'Ledger' },
        evidence: [{ chunk_id: chunkId, quote: 'Billing calls Ledger' }],
      },
    ],
  });
  expect(applied.code).toBe(0);
});

afterAll(() => rmSync(kb, { recursive: true, force: true }));

describe('kb vocabulary list', () => {
  it('returns the complete schema and graph vocabulary in a successful envelope', async () => {
    const result = await run(['vocabulary', 'list']);

    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.data).toEqual({
      claimTypes: CLAIM_TYPES,
      spanRoles: SPAN_ROLES,
      entityTypes: {
        recommended: ENTITY_TYPES,
        observed: [
          { type: 'Service', count: 2, recommended: true },
          { type: 'Subsystem', count: 1, recommended: false },
        ],
      },
      relationshipTypes: {
        recommended: RELATIONSHIP_TYPES,
        observed: [
          { type: 'calls', count: 1, recommended: true },
          { type: 'routes_to', count: 1, recommended: false },
        ],
      },
    });
  });

  it.each([
    ['claim', 'claimTypes', CLAIM_TYPES],
    ['span-role', 'spanRoles', SPAN_ROLES],
    [
      'entity',
      'entityTypes',
      {
        recommended: ENTITY_TYPES,
        observed: [
          { type: 'Service', count: 2, recommended: true },
          { type: 'Subsystem', count: 1, recommended: false },
        ],
      },
    ],
    [
      'relationship',
      'relationshipTypes',
      {
        recommended: RELATIONSHIP_TYPES,
        observed: [
          { type: 'calls', count: 1, recommended: true },
          { type: 'routes_to', count: 1, recommended: false },
        ],
      },
    ],
  ] as const)('--kind %s returns only %s', async (kind, key, expected) => {
    const result = await run(['vocabulary', 'list', '--kind', kind]);

    expect(result.code).toBe(0);
    expect(result.json.data).toEqual({ [key]: expected });
  });

  it('rejects an invalid --kind as INVALID_ARGUMENT', async () => {
    const result = await run(['vocabulary', 'list', '--kind', 'graph']);

    expect(result.code).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.issues).toEqual([expect.objectContaining({ code: 'INVALID_ARGUMENT' })]);
  });

  it('documents reciprocal related edges with graph apply', async () => {
    const vocabularyHelp = await run(['vocabulary', 'list', '--help']);
    const graphHelp = await run(['graph', 'apply', '--help']);

    expect((vocabularyHelp.json.data as unknown as { related: string[] }).related).toContain('graph apply');
    expect((graphHelp.json.data as unknown as { related: string[] }).related).toContain('vocabulary list');
  });
});
