import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * Graph apply schema breaking-changes + steering (03 §3.2, criterion 5). Entity
 * `evidence` and relationship-evidence `confidence` are removed and rejected via
 * PAYLOAD_SCHEMA with a field-specific hint explaining the silent-loss elimination.
 * A successful apply hints at `kb entity show <firstEntityId> --json` with no stale chain.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; message: string; hint?: string; path?: string }>;
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

let kb: string;
let sourceId: string;
let chunkId: string;

async function runIo(args: string[]): Promise<CliResult> {
  const out = { stdout: '' };
  const io: CliIo = { stdout: (c) => (out.stdout += c), stderr: () => {}, cwd: process.cwd(), env: { ...process.env, KB_DIR: kb } };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(out.stdout || '{}') };
}

let counter = 0;
function writePayload(payload: unknown): string {
  const file = join(kb, `payload-${counter++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-graph-'));
  await runIo(['init', kb]);
  const docPath = join(kb, 'doc.md');
  writeFileSync(docPath, '# Topic\n\nThe Gateway service validates the key against the Accounts service.\n');
  const ing = await runIo(['ingest', docPath]);
  sourceId = (ing.json.data as { sourceId: string }).sourceId;
  const chunks = await runIo(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('validates the key'),
  )!.id;
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('graph apply — removed fields rejected via PAYLOAD_SCHEMA (03 §3.2)', () => {
  it('entity evidence → PAYLOAD_SCHEMA with the silent-loss hint at the entity evidence path', async () => {
    const file = writePayload({
      source_id: sourceId,
      entities: [{ type: 'Service', name: 'Gateway', evidence: [{ chunk_id: chunkId, quote: 'validates the key' }] }],
      relationships: [],
    });
    const res = await runIo(['graph', 'apply', '--file', file]);
    expect(res.code).toBe(1);
    const issue = res.json.issues.find((i) => i.code === 'PAYLOAD_SCHEMA');
    expect(issue).toBeDefined();
    expect(issue!.path).toBe('entities[0].evidence');
    expect(issue!.hint).toMatch(/entity evidence is not stored/i);
  });

  it('relationship evidence confidence → PAYLOAD_SCHEMA with the silent-loss hint', async () => {
    const file = writePayload({
      source_id: sourceId,
      entities: [
        { type: 'Service', name: 'Gateway' },
        { type: 'Service', name: 'Accounts' },
      ],
      relationships: [
        {
          type: 'depends_on',
          subject: { type: 'Service', name: 'Gateway' },
          object: { type: 'Service', name: 'Accounts' },
          evidence: [{ chunk_id: chunkId, quote: 'validates the key', role: 'supports', confidence: 0.8 }],
        },
      ],
    });
    const res = await runIo(['graph', 'apply', '--file', file]);
    expect(res.code).toBe(1);
    const issue = res.json.issues.find((i) => i.code === 'PAYLOAD_SCHEMA');
    expect(issue).toBeDefined();
    expect(issue!.path).toBe('relationships[0].evidence[0].confidence');
    expect(issue!.hint).toMatch(/no confidence/i);
  });
});

describe('graph apply — steering (03 §3.2)', () => {
  it('a successful apply hints at kb entity show <firstEntityId> --json and never steers to node show', async () => {
    const file = writePayload({
      source_id: sourceId,
      entities: [
        { type: 'Service', name: 'Gateway' },
        { type: 'Service', name: 'Accounts' },
      ],
      relationships: [
        {
          type: 'depends_on',
          subject: { type: 'Service', name: 'Gateway' },
          object: { type: 'Service', name: 'Accounts' },
          evidence: [{ chunk_id: chunkId, quote: 'validates the key', role: 'supports' }],
        },
      ],
    });
    const res = await runIo(['graph', 'apply', '--file', file]);
    expect(res.code).toBe(0);
    const firstEntityId = (res.json.data as { entities: Array<{ entityId: string }> }).entities[0]!.entityId;
    expect(res.json.hints.join(' ')).toContain(`kb entity show ${firstEntityId} --json`);
    // Graph never emits a stale chain (01 §6.1).
    expect(res.json.nextActions.some((n) => n.command.startsWith('kb node show'))).toBe(false);
  });
});
