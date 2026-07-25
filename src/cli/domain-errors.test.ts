import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * End-to-end proof that the migrated domain errors (03 §1) surface through the CLI as
 * their REGISTRY codes with structured path/ids — never as `LEGACY` and never mapped by
 * message text. The service layer throws `DomainIssueError`; `runAction`/`errorToIssues`
 * map it by `code` alone.
 */

interface Issue {
  code: string;
  severity: string;
  message: string;
  path?: string;
  ids?: string[];
  hint?: string;
}
interface CliResult {
  code: number;
  json: { ok: boolean; issues: Issue[]; errors: string[] };
}

let kb: string;
let sourceId: string;
let chunkId: string;
let nodeId: string;

async function runIo(args: string[]): Promise<CliResult> {
  let stdout = '';
  const io: CliIo = {
    stdout: (c) => (stdout += c),
    stderr: () => {},
    cwd: process.cwd(),
    env: { ...process.env, KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(stdout || '{}') };
}

let n = 0;
async function apply(group: string, sub: string | null, payload: unknown): Promise<CliResult> {
  const file = join(kb, `p-${n++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  const path = sub ? [group, sub] : [group];
  return runIo([...path, '--file', file]);
}

function issue(r: CliResult, code: string): Issue | undefined {
  return r.json.issues.find((i) => i.code === code);
}

beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-domerr-'));
  await runIo(['init', kb]);
  const doc = join(kb, 'doc.md');
  writeFileSync(doc, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
  const ing = await runIo(['ingest', doc]);
  sourceId = (ing.json as unknown as { data: { sourceId: string } }).data.sourceId;
  const chunks = await runIo(['source', 'chunks', sourceId]);
  chunkId = (chunks.json as unknown as { data: { chunks: Array<{ id: string; text: string }> } }).data.chunks.find((c) =>
    c.text.includes('caches results in Redis'),
  )!.id;
  const node = await runIo(['node', 'create', '--title', 'Topic', '--kind', 'root']);
  nodeId = (node.json as unknown as { data: { nodeId: string } }).data.nodeId;
});

afterAll(() => rmSync(kb, { recursive: true, force: true }));

describe('domain errors surface as registry codes through the CLI (03 §1)', () => {
  it('a hallucinated quote → QUOTE_NOT_FOUND with a formatPath path and the chunk id (never LEGACY)', async () => {
    const r = await apply('claim', 'apply', {
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'Fabricated.',
          claim_type: 'fact',
          spans: [{ chunk_id: chunkId, quote: 'the service is written in Rust' }],
        },
      ],
    });
    expect(r.code).toBe(1);
    const q = issue(r, 'QUOTE_NOT_FOUND');
    expect(q).toBeDefined();
    expect(q!.path).toBe('claims[0].spans[0].quote');
    expect(q!.ids).toContain(chunkId);
    expect(q!.hint).toBeTruthy();
    expect(issue(r, 'LEGACY')).toBeUndefined();
  });

  it('an ambiguous quote → QUOTE_AMBIGUOUS (structured, message preserved)', async () => {
    // "Redis" appears twice in the doc heading + body region; use a genuinely repeated
    // token so the quote is non-unique within its chunk.
    const dup = join(kb, 'dup.md');
    writeFileSync(dup, '# Dup\n\nrate limit. rate limit.\n');
    const ing = await runIo(['ingest', dup]);
    const dupSource = (ing.json as unknown as { data: { sourceId: string } }).data.sourceId;
    const chunks = await runIo(['source', 'chunks', dupSource]);
    const dupChunk = (chunks.json as unknown as { data: { chunks: Array<{ id: string; text: string }> } }).data.chunks.find(
      (c) => c.text.includes('rate limit. rate limit'),
    )!.id;

    const r = await apply('claim', 'apply', {
      source_id: dupSource,
      claims: [
        {
          node_id: nodeId,
          text: 'Ambiguous.',
          claim_type: 'fact',
          spans: [{ chunk_id: dupChunk, quote: 'rate limit', role: 'supports' }],
        },
      ],
    });
    expect(r.code).toBe(1);
    const a = issue(r, 'QUOTE_AMBIGUOUS');
    expect(a).toBeDefined();
    expect(a!.path).toBe('claims[0].spans[0].quote');
    expect(a!.message).toMatch(/appears more than once/);
  });

  it('an unknown source → UNKNOWN_SOURCE with the source id', async () => {
    const r = await apply('claim', 'apply', {
      source_id: 'src_deadbeefdeadbeef',
      claims: [
        {
          node_id: nodeId,
          text: 'x',
          claim_type: 'fact',
          spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }],
        },
      ],
    });
    expect(r.code).toBe(1);
    const u = issue(r, 'UNKNOWN_SOURCE');
    expect(u).toBeDefined();
    expect(u!.ids).toContain('src_deadbeefdeadbeef');
  });

  it('an unknown node on a claim → UNKNOWN_NODE with the node id and claim path', async () => {
    const r = await apply('claim', 'apply', {
      source_id: sourceId,
      claims: [
        {
          node_id: 'nod_deadbeefdeadbeef',
          text: 'x',
          claim_type: 'fact',
          spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }],
        },
      ],
    });
    expect(r.code).toBe(1);
    const u = issue(r, 'UNKNOWN_NODE');
    expect(u).toBeDefined();
    expect(u!.path).toBe('claims[0].node_id');
    expect(u!.ids).toContain('nod_deadbeefdeadbeef');
  });

  it('synthesize citing an unknown claim → CITATION_UNKNOWN with body_md path and the claim id (never LEGACY)', async () => {
    // The shared synthesis validator (03 §1) classifies an unresolved citation as
    // CITATION_UNKNOWN (precedence rule 1), replacing the old existence-only UNKNOWN_CLAIM.
    const r = await apply('synthesize', null, {
      node_id: nodeId,
      body_md: 'Bogus.[^clm_deadbeefdeadbeef]',
    });
    expect(r.code).toBe(1);
    const u = issue(r, 'CITATION_UNKNOWN');
    expect(u).toBeDefined();
    expect(u!.message).toMatch(/unknown claim/);
    expect(u!.path).toBe('body_md');
    expect(u!.ids).toContain('clm_deadbeefdeadbeef');
    expect(u!.hint).toBeTruthy();
    expect(issue(r, 'LEGACY')).toBeUndefined();
  });
});
