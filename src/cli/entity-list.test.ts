import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * `kb entity list` (eval run 1, finding 3).
 *
 * The graph was write-then-guess: `kb entity` exposed only `show`, which needs an id
 * the agent had no way to enumerate. In the paired eval BOTH skill variants
 * independently invented a listing command (`entity show --name` x4, `entity list`
 * x1) — convergent guessing across variants is evidence of a missing surface, not
 * one agent's quirk. `EntityRepo.listAll()` already existed; this is pure exposure.
 */

interface Entity {
  id: string;
  type: string;
  canonicalName: string;
  relationships: number;
}

interface Captured {
  code: number;
  env: {
    ok: boolean;
    data: { entities: Entity[]; counts: Record<string, number> } | null;
    issues: Array<{ code: string }>;
    hints: string[];
  };
}

let kb: string;

async function run(args: string[]): Promise<Captured> {
  let stdout = '';
  const io: CliIo = { stdout: (c) => (stdout += c), stderr: () => {}, cwd: kb, env: { KB_DIR: kb } };
  const code = await runCli([...args, '--json'], io);
  return { code, env: JSON.parse(stdout || '{}') };
}

beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-entlist-'));
  await run(['init', kb]);
  const doc = join(kb, 'doc.md');
  writeFileSync(doc, '# Arch\n\nBucket state is stored in Redis by the Rate Limiter service.\n');
  const ing = await run(['ingest', doc]);
  const sourceId = (ing.env.data as unknown as { sourceId: string }).sourceId;
  const chunks = await run(['source', 'chunks', sourceId]);
  const chunkId = (chunks.env.data as unknown as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('stored in Redis'),
  )!.id;
  const graph = join(kb, 'graph.json');
  writeFileSync(
    graph,
    JSON.stringify({
      source_id: sourceId,
      entities: [
        { type: 'Service', name: 'Rate Limiter', description: 'Enforces limits' },
        { type: 'DataStore', name: 'Redis', description: 'Counter store' },
      ],
      relationships: [
        {
          type: 'stores_in',
          subject: { type: 'Service', name: 'Rate Limiter' },
          object: { type: 'DataStore', name: 'Redis' },
          evidence: [{ chunk_id: chunkId, quote: 'stored in Redis' }],
        },
      ],
    }),
  );
  await run(['graph', 'apply', '--file', graph]);
});

afterAll(() => rmSync(kb, { recursive: true, force: true }));

describe('kb entity list', () => {
  it('enumerates entities with ids usable by entity show', async () => {
    const r = await run(['entity', 'list']);
    expect(r.code).toBe(0);
    const names = r.env.data!.entities.map((e) => e.canonicalName).sort();
    expect(names).toEqual(['Rate Limiter', 'Redis']);

    // The point of the command: an id it yields must actually resolve.
    const first = r.env.data!.entities[0]!;
    const shown = await run(['entity', 'show', first.id]);
    expect(shown.code).toBe(0);
    expect(shown.env.ok).toBe(true);
  });

  it('reports each entity’s relationship count', async () => {
    const r = await run(['entity', 'list']);
    const byName = new Map(r.env.data!.entities.map((e) => [e.canonicalName, e]));
    expect(byName.get('Rate Limiter')!.relationships).toBe(1);
    expect(byName.get('Redis')!.relationships).toBe(1);
  });

  it('filters by --type while counts stay global', async () => {
    const r = await run(['entity', 'list', '--type', 'DataStore']);
    expect(r.env.data!.entities.map((e) => e.canonicalName)).toEqual(['Redis']);
    // Global totals, unaffected by the filter — same rule as `source list` (02 §3).
    expect(r.env.data!.counts).toEqual({ DataStore: 1, Service: 1 });
  });

  it('orders deterministically by (type, canonicalName)', async () => {
    const r = await run(['entity', 'list']);
    const keys = r.env.data!.entities.map((e) => `${e.type}/${e.canonicalName}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('returns an empty list, not an error, on a KB with no graph', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'kb-entlist-empty-'));
    let stdout = '';
    const io: CliIo = { stdout: (c) => (stdout += c), stderr: () => {}, cwd: empty, env: { KB_DIR: empty } };
    await runCli(['init', empty, '--json'], io);
    stdout = '';
    const code = await runCli(['entity', 'list', '--json'], io);
    const env = JSON.parse(stdout) as Captured['env'];
    expect(code).toBe(0);
    expect(env.ok).toBe(true);
    expect(env.data!.entities).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
