import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

interface Captured {
  code: number;
  json: {
    ok: boolean;
    data: unknown;
    issues: Array<{ code: string; hint?: string }>;
    instruction?: string;
  };
}

interface CandidateData {
  sourceId: string;
  claims: Array<{
    claimId: string;
    nodeId: string | null;
    text: string;
    candidates: {
      matched: number;
      shown: number;
      complete: boolean;
      items: Array<{ claimId: string; reason: string }>;
    };
  }>;
  totals: { claimsChecked: number; claimsWithCandidates: number };
}

let kb: string;
let sourceB: string;
let emptySource: string;
let sourceBClaimIds: string[];
let fileCounter = 0;

async function run(args: string[]): Promise<Captured> {
  let stdout = '';
  const io: CliIo = {
    stdout: (chunk) => (stdout += chunk),
    stderr: () => {},
    cwd: process.cwd(),
    env: { ...process.env, KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return {
    code,
    json: JSON.parse(stdout || '{}') as Captured['json'],
  };
}

function payloadFile(payload: unknown): string {
  const file = join(kb, `payload-${fileCounter++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

async function ingest(name: string, text: string): Promise<{
  sourceId: string;
  chunkId: string;
}> {
  const file = join(kb, `${name}.md`);
  writeFileSync(file, text);
  const ingested = await run(['ingest', file]);
  const sourceId = (ingested.json.data as { sourceId: string }).sourceId;
  const chunks = await run(['source', 'chunks', sourceId]);
  const chunkId = (
    chunks.json.data as { chunks: Array<{ id: string; contentKind: string }> }
  ).chunks.find((chunk) => chunk.contentKind === 'substantive')!.id;
  return { sourceId, chunkId };
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-claim-candidates-'));
  fileCounter = 0;
  expect((await run(['init', kb])).code).toBe(0);

  const sourceA = await ingest(
    'source-a',
    '# Source A\n\nWidget caching stores results in Redis.\n',
  );
  const sourceBFixture = await ingest(
    'source-b',
    '# Source B\n\nProduction caching uses Redis. Redis caches widget results.\n',
  );
  sourceB = sourceBFixture.sourceId;
  emptySource = (
    await ingest('source-empty', '# Empty Source\n\nNo extracted assertions here.\n')
  ).sourceId;

  const node = await run([
    'node',
    'create',
    '--title',
    'Caching',
    '--kind',
    'root',
  ]);
  const nodeId = (node.json.data as { nodeId: string }).nodeId;

  const appliedA = await run([
    'claim',
    'apply',
    '--file',
    payloadFile({
      source_id: sourceA.sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'Widget caching stores results in Redis.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceA.chunkId,
              quote: 'Widget caching stores results in Redis.',
            },
          ],
        },
      ],
    }),
  ]);
  expect(appliedA.code).toBe(0);

  const appliedB = await run([
    'claim',
    'apply',
    '--file',
    payloadFile({
      source_id: sourceB,
      claims: [
        {
          node_id: nodeId,
          text: 'Production caching uses Redis.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBFixture.chunkId,
              quote: 'Production caching uses Redis.',
            },
          ],
        },
        {
          node_id: nodeId,
          text: 'Redis caches widget results.',
          claim_type: 'fact',
          spans: [
            {
              chunk_id: sourceBFixture.chunkId,
              quote: 'Redis caches widget results.',
            },
          ],
        },
      ],
    }),
  ]);
  expect(appliedB.code).toBe(0);
  sourceBClaimIds = (
    appliedB.json.data as { claims: Array<{ claimId: string }> }
  ).claims.map((claim) => claim.claimId);
});

afterEach(() => {
  rmSync(kb, { recursive: true, force: true });
});

describe('kb claim candidates --source', () => {
  it('checks active contributed claims in deterministic id order and emits the binding instruction', async () => {
    const response = await run(['claim', 'candidates', '--source', sourceB]);

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    const data = response.json.data as CandidateData;
    expect(data.sourceId).toBe(sourceB);
    expect(data.claims.map((claim) => claim.claimId)).toEqual(
      [...sourceBClaimIds].sort(),
    );
    expect(data.claims.every((claim) => claim.candidates.matched > 0)).toBe(true);
    expect(data.totals).toEqual({
      claimsChecked: 2,
      claimsWithCandidates: 2,
    });
    expect(response.json.instruction).toBe(
      'Review candidate conflicts for 2 claim(s) (supersede, conflict, or explicitly accept coexistence) before finishing this ingestion.',
    );
  });

  it('returns ok:true with no instruction when the source has no contributed active claims', async () => {
    const response = await run([
      'claim',
      'candidates',
      '--source',
      emptySource,
    ]);

    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    expect(response.json.data).toEqual({
      sourceId: emptySource,
      claims: [],
      totals: { claimsChecked: 0, claimsWithCandidates: 0 },
    });
    expect('instruction' in response.json).toBe(false);
  });

  it('fails unknown sources with UNKNOWN_SOURCE and the source-list hint', async () => {
    const response = await run([
      'claim',
      'candidates',
      '--source',
      'src_missing',
    ]);

    expect(response.code).toBe(1);
    expect(response.json.ok).toBe(false);
    expect(response.json.issues).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_SOURCE',
        hint: 'List sources: kb source list --json',
      }),
    ]);
  });
});
