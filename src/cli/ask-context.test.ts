import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * `kb ask-context` filters at the CLI edge (05 §2): unknown `--node` fails FIRST
 * with `UNKNOWN_NODE` (exit 1); `data.applied` echoes the filters; and the
 * zero-result hint names ONLY the filters actually supplied (finding 29).
 */

interface Captured {
  code: number;
  stdout: string;
  env: {
    ok: boolean;
    data: {
      applied: { claimType: string | null; node: string | null };
      claims: unknown[];
      retrieval: 'fts' | 'filter-fallback';
    } | null;
    issues: Array<{ code: string }>;
    hints: string[];
  };
}

let kb: string;
let nodeId: string;

async function run(args: string[]): Promise<Captured> {
  let stdout = '';
  const io: CliIo = { stdout: (c) => (stdout += c), stderr: () => {}, cwd: kb, env: { KB_DIR: kb } };
  const code = await runCli([...args, '--json'], io);
  return { code, stdout, env: JSON.parse(stdout || '{}') };
}

beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-askctx-'));
  await run(['init', kb]);
  const doc = join(kb, 'doc.md');
  writeFileSync(doc, '# Topic\n\nThe widget caches results in Redis for speed.\n');
  const ing = await run(['ingest', doc]);
  const sourceId = (ing.env.data as unknown as { sourceId: string }).sourceId;
  const chunks = await run(['source', 'chunks', sourceId]);
  const chunkId = (chunks.env.data as unknown as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('caches results in Redis'),
  )!.id;
  const root = await run(['node', 'create', '--title', 'Root', '--kind', 'root']);
  const rootId = (root.env.data as unknown as { nodeId: string }).nodeId;
  const leaf = await run(['node', 'create', '--title', 'Caching', '--kind', 'leaf', '--parent', rootId]);
  nodeId = (leaf.env.data as unknown as { nodeId: string }).nodeId;
  const payload = join(kb, 'claim.json');
  writeFileSync(
    payload,
    JSON.stringify({
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'The widget caches results in Redis.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }],
        },
      ],
    }),
  );
  await run(['claim', 'apply', '--file', payload]);
});

afterAll(() => rmSync(kb, { recursive: true, force: true }));

describe('kb ask-context filters', () => {
  it('echoes applied filters and returns claims for a matching filtered query', async () => {
    const r = await run(['ask-context', 'how does caching work', '--claim-type', 'fact', '--node', nodeId]);
    expect(r.code).toBe(0);
    expect(r.env.data!.applied).toEqual({ claimType: 'fact', node: nodeId });
    expect(r.env.data!.claims.length).toBeGreaterThan(0);
  });

  /**
   * CATEGORY SELECTOR (eval run 1, finding 1).
   *
   * `--claim-type` is reached for as a SELECTOR ("show me the open questions"), but
   * `claims_fts MATCH ?` is mandatory, so it could only ever NARROW term matches. A
   * category question shares little vocabulary with the claim texts it wants — the
   * eval saw 1 of 4 open questions on one phrasing and 0 on another.
   *
   * When a filter is supplied the filtered set defines the answer: term matches keep
   * their rank and lead, the remainder is appended by (confidence, id), and the
   * augmentation is labelled. Fires on UNDER-COVERAGE, not just emptiness.
   */
  it('uses the filter as a selector when the query matches no terms', async () => {
    // None of these words appear in the seeded claim text.
    const r = await run(['ask-context', 'enumerate every recorded item', '--claim-type', 'fact']);
    expect(r.code).toBe(0);
    expect(r.env.data!.claims.length).toBeGreaterThan(0);
    expect(r.env.data!.retrieval).toBe('filter-fallback');
    expect(r.env.hints.join(' ')).toMatch(/selector to complete the set/i);
  });

  it('reports retrieval:"fts" when the query does match terms', async () => {
    const r = await run(['ask-context', 'how does caching work', '--claim-type', 'fact']);
    expect(r.env.data!.claims.length).toBeGreaterThan(0);
    expect(r.env.data!.retrieval).toBe('fts');
  });

  it('does NOT fall back when no filter was supplied (no defined set)', async () => {
    const r = await run(['ask-context', 'zzz nonexistent vocabulary qqq']);
    expect(r.code).toBe(0);
    expect(r.env.data!.claims).toEqual([]);
    expect(r.env.data!.retrieval).toBe('fts');
  });

  it('rejects an unknown --node with UNKNOWN_NODE and exit 1 (validated first)', async () => {
    const r = await run(['ask-context', 'caching', '--node', 'nod_missing']);
    expect(r.code).toBe(1);
    expect(r.env.issues.some((i) => i.code === 'UNKNOWN_NODE')).toBe(true);
  });

  it('zero-result hint names only the filter(s) actually supplied', async () => {
    const r = await run(['ask-context', 'nonexistentxyzzy', '--claim-type', 'open_question']);
    expect(r.code).toBe(0);
    expect(r.env.data!.claims).toHaveLength(0);
    const hint = r.env.hints.join('\n');
    expect(hint).toContain('--claim-type');
    expect(hint).not.toContain('--node');
  });

  it('zero-result hint without filters is a rephrase hint (names no filters)', async () => {
    const r = await run(['ask-context', 'nonexistentxyzzy']);
    expect(r.code).toBe(0);
    expect(r.env.data!.claims).toHaveLength(0);
    const hint = r.env.hints.join('\n');
    expect(hint).not.toContain('--claim-type');
    expect(hint).not.toContain('--node');
  });
});
