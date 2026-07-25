import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { openDb } from '../db/connection.js';
import { DB_FILENAME } from '../kb/workspace.js';

/**
 * `kb source list` (02 §3). Sources ordered by (ingestedAt, id), each with a chunk
 * count and a DISTINCT claim count (claims linked via claim_spans → spans of that
 * source). The `--status` filter narrows the LIST but `counts` stays GLOBAL — a
 * per-status total over every source, unaffected by the filter (finding 40).
 */

interface SourceEntry {
  id: string;
  title: string;
  status: string;
  sourceDate: string | null;
  mediaType: string;
  chunks: number;
  claims: number;
  origin: unknown;
  ingestedAt: string;
}
interface ListData {
  sources: SourceEntry[];
  counts: Record<string, number>;
}
interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  env: { ok: boolean; data: ListData | null; hints: string[] };
}

let kb: string;

async function run(args: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (c) => (stdout += c),
    stderr: (c) => (stderr += c),
    cwd: kb,
    env: { KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, stdout, stderr, env: JSON.parse(stdout || '{}') };
}

/** Apply a raw UPDATE between CLI calls (to control status/ingested_at deterministically). */
function tweak(sql: string, params: unknown[]): void {
  const db = openDb(join(kb, DB_FILENAME));
  db.prepare(sql).run(...params);
  db.close();
}

describe('kb source list — empty KB', () => {
  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-srclist-empty-'));
    await run(['init', kb]);
  });
  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('returns an empty list and empty global counts', async () => {
    const r = await run(['source', 'list']);
    expect(r.code).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(r.env.data!.sources).toEqual([]);
    expect(r.env.data!.counts).toEqual({});
  });
});

describe('kb source list — aggregates, filter, and global counts', () => {
  let srcA = '';
  let srcB = '';

  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-srclist-'));
    await run(['init', kb]);

    // Source A: two quotable sentences → two claims (distinct-claim count = 2).
    const docA = join(kb, 'alpha.md');
    writeFileSync(docA, '# Alpha\n\nThe alpha service runs in Rust. The beta module handles caching.\n');
    const ingestA = await run(['ingest', docA]);
    srcA = (ingestA.env.data as unknown as { sourceId: string }).sourceId;

    // Source B: ingested but never given any claims (distinct-claim count = 0).
    const docB = join(kb, 'beta.md');
    writeFileSync(docB, '# Beta\n\nThe beta release shipped.\n');
    const ingestB = await run(['ingest', docB]);
    srcB = (ingestB.env.data as unknown as { sourceId: string }).sourceId;

    const chunks = (await run(['source', 'chunks', srcA])).env.data as unknown as {
      chunks: Array<{ id: string; text: string }>;
    };
    const chunkId = chunks.chunks[0]!.id;

    const root = await run(['node', 'create', '--title', 'Root', '--kind', 'root']);
    const rootId = (root.env.data as unknown as { nodeId: string }).nodeId;
    const leaf = await run(['node', 'create', '--title', 'Alpha', '--kind', 'leaf', '--parent', rootId]);
    const leafId = (leaf.env.data as unknown as { nodeId: string }).nodeId;

    const payload = join(kb, 'claims.json');
    writeFileSync(
      payload,
      JSON.stringify({
        source_id: srcA,
        claims: [
          { node_id: leafId, text: 'Alpha is in Rust.', claim_type: 'fact', spans: [{ chunk_id: chunkId, quote: 'runs in Rust' }] },
          { node_id: leafId, text: 'Beta caches.', claim_type: 'fact', spans: [{ chunk_id: chunkId, quote: 'handles caching' }] },
        ],
      }),
    );
    const applied = await run(['claim', 'apply', '--file', payload]);
    expect(applied.env.ok).toBe(true);

    // Mark B superseded so the global counts span two statuses.
    tweak('UPDATE sources SET status = ? WHERE id = ?', ['superseded', srcB]);
  });
  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('reports per-source chunk and distinct-claim counts, origin null', async () => {
    const r = await run(['source', 'list']);
    expect(r.code).toBe(0);
    const byId = new Map(r.env.data!.sources.map((s) => [s.id, s]));
    const a = byId.get(srcA)!;
    expect(a.chunks).toBeGreaterThan(0);
    expect(a.claims).toBe(2); // two distinct claims linked to spans of source A
    expect(a.origin).toBeNull();
    const b = byId.get(srcB)!;
    expect(b.claims).toBe(0); // no claim links
  });

  it('--status filters the LIST but counts stay GLOBAL (unaffected by the filter)', async () => {
    const all = await run(['source', 'list']);
    expect(all.env.data!.sources.map((s) => s.id).sort()).toEqual([srcA, srcB].sort());
    expect(all.env.data!.counts).toEqual({ active: 1, superseded: 1 });

    const activeOnly = await run(['source', 'list', '--status', 'active']);
    expect(activeOnly.env.data!.sources.map((s) => s.id)).toEqual([srcA]);
    // The filter narrowed the list to 1, but counts remain the GLOBAL per-status totals.
    expect(activeOnly.env.data!.counts).toEqual({ active: 1, superseded: 1 });
  });

  it('steers to source show and source chunks (hints, not next-actions with placeholders)', async () => {
    const r = await run(['source', 'list']);
    const hints = r.env.hints.join(' ');
    expect(hints).toContain('kb source show');
    expect(hints).toContain('kb source chunks');
  });

  it('rejects an invalid --status value (INVALID_ARGUMENT, exit 2)', async () => {
    const r = await run(['source', 'list', '--status', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.env.ok).toBe(false);
  });
});

describe('kb source list — deterministic tie ordering by (ingestedAt, id)', () => {
  let ids: string[] = [];

  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-srclist-tie-'));
    await run(['init', kb]);
    const one = join(kb, 'one.md');
    const two = join(kb, 'two.md');
    writeFileSync(one, '# One\n\nFirst source body.\n');
    writeFileSync(two, '# Two\n\nSecond source body.\n');
    const a = await run(['ingest', one]);
    const b = await run(['ingest', two]);
    ids = [
      (a.env.data as unknown as { sourceId: string }).sourceId,
      (b.env.data as unknown as { sourceId: string }).sourceId,
    ];
    // Force an EXACT ingestedAt tie so ordering must fall back to id.
    tweak('UPDATE sources SET ingested_at = ?', ['2026-01-01T00:00:00.000Z']);
  });
  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('orders tied ingestedAt rows by id ascending', async () => {
    const r = await run(['source', 'list']);
    const listed = r.env.data!.sources.map((s) => s.id);
    expect(listed).toEqual([...ids].sort());
  });
});
