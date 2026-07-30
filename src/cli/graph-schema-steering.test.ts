import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * Graph apply schema breaking-changes + steering (03 §3.2, criterion 5). Entity
 * `evidence` and relationship-evidence `confidence` are removed and rejected via
 * PAYLOAD_SCHEMA with a field-specific hint explaining the silent-loss elimination.
 * A successful apply hints at the source-scoped relationship review with no stale chain.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; severity: string; message: string; hint?: string; path?: string }>;
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

describe('graph apply — type diagnostics (Phase E)', () => {
  function relationshipPayload(type: string): unknown {
    return {
      source_id: sourceId,
      entities: [
        { type: 'Service', name: 'Gateway' },
        { type: 'Service', name: 'Accounts' },
      ],
      relationships: [
        {
          type,
          subject: { type: 'Service', name: 'Gateway' },
          object: { type: 'Service', name: 'Accounts' },
          evidence: [{ chunk_id: chunkId, quote: 'validates the key against the Accounts service' }],
        },
      ],
    };
  }

  it('warns that depends-on is a near miss for depends_on instead of reporting it as new', async () => {
    const file = writePayload(relationshipPayload('depends-on'));
    const result = await runIo(['graph', 'apply', '--file', file, '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.issues).toEqual([
      expect.objectContaining({
        code: 'GRAPH_TYPE_NEAR_MISS',
        severity: 'warning',
        message: expect.stringMatching(/depends-on.*depends_on/i),
      }),
    ]);
    expect(result.json.issues.some((issue) => issue.code === 'GRAPH_TYPE_NEW')).toBe(false);
  });

  it('reports a genuinely new type on dry-run and apply while still persisting it', async () => {
    const file = writePayload(relationshipPayload('routes_through'));

    const preview = await runIo(['graph', 'apply', '--file', file, '--dry-run']);
    expect(preview.code).toBe(0);
    expect(preview.json.ok).toBe(true);
    expect(preview.json.issues).toEqual([
      expect.objectContaining({
        code: 'GRAPH_TYPE_NEW',
        severity: 'info',
        message: expect.stringMatching(/routes_through.*depends_on.*\d+/i),
      }),
    ]);

    const applied = await runIo(['graph', 'apply', '--file', file]);
    expect(applied.code).toBe(0);
    expect(applied.json.ok).toBe(true);
    expect(applied.json.issues).toEqual([
      expect.objectContaining({ code: 'GRAPH_TYPE_NEW', severity: 'info' }),
    ]);

    const listed = await runIo(['relationship', 'list', '--type', 'routes_through']);
    expect(listed.code).toBe(0);
    expect(
      (listed.json.data as { relationships: Array<{ type: string }> }).relationships.map(
        (relationship) => relationship.type,
      ),
    ).toEqual(['routes_through']);
  });

  it('emits no type diagnostic for exact established entity and relationship types', async () => {
    const file = writePayload(relationshipPayload('depends_on'));
    const result = await runIo(['graph', 'apply', '--file', file, '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.json.issues.some((issue) => issue.code.startsWith('GRAPH_TYPE_'))).toBe(false);
  });
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
  it('a successful apply emits exactly the source-scoped relationship-list hint', async () => {
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
    expect(res.json.hints).toEqual([
      `kb relationship list --source ${sourceId} --json`,
    ]);
    expect(res.json.hints.join(' ')).not.toContain('kb entity show');
    expect(res.json.hints.join(' ')).not.toContain('kb entity list');
    // Graph never emits a stale chain (01 §6.1).
    expect(res.json.nextActions.some((n) => n.command.startsWith('kb node show'))).toBe(false);
  });
});
