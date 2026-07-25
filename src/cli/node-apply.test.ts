import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { receiptProjection } from './receiptParity.js';

/**
 * `kb node apply` at the CLI boundary (04 §2). Drives the real dispatcher in-process
 * against a temp KB: the receipt maps every ref to {nodeId, outcome}; `--dry-run` previews
 * through the Phase-1 runner, steers exclusively to the file re-run, and leaves the KB
 * unchanged; steering hints branch on whether the KB has sources yet.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; severity: string; message: string }>;
    warnings: string[];
    errors: string[];
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

let kb: string;

async function runIo(args: string[]): Promise<CliResult> {
  const out = { stdout: '', stderr: '' };
  const env: NodeJS.ProcessEnv = { ...process.env, KB_DIR: kb };
  const io: CliIo = {
    stdout: (c) => (out.stdout += c),
    stderr: (c) => (out.stderr += c),
    cwd: process.cwd(),
    env,
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(out.stdout || '{}') };
}

let payloadCounter = 0;
function writeManifest(manifest: unknown): string {
  const file = join(kb, `manifest-${payloadCounter++}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

/** A root with two leaves — the minimal tree that exercises parents-before-children. */
const rootManifest = {
  nodes: [
    {
      ref: 'root',
      title: 'Knowledge Base',
      kind: 'root',
      children: [
        { ref: 'cache', title: 'Caching', kind: 'leaf' },
        { ref: 'auth', title: 'Auth', kind: 'leaf' },
      ],
    },
  ],
};

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-nodeapply-'));
  const init = await runIo(['init', kb]);
  expect(init.json.ok).toBe(true);
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('kb node apply — receipt (04 §2)', () => {
  it('maps every ref to {nodeId, outcome} with totals, staleNodes, and the ref-map + ingest hints', async () => {
    const file = writeManifest(rootManifest);
    const r = await runIo(['node', 'apply', '--file', file]);

    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    const data = r.json.data as {
      dryRun: boolean;
      nodes: Array<{ ref: string; nodeId: string; outcome: string }>;
      totals: { created: number; existing: number };
      staleNodes: string[];
    };
    expect(data.dryRun).toBe(false);
    expect(data.nodes.map((n) => n.ref).sort()).toEqual(['auth', 'cache', 'root']);
    expect(data.nodes.every((n) => n.outcome === 'created' && n.nodeId.startsWith('nod_'))).toBe(true);
    expect(data.totals).toEqual({ created: 3, existing: 0 });
    expect(data.staleNodes).toHaveLength(3);

    // AC5 hints: the ref→nodeId map for the next payload, and — because the KB has no
    // sources yet — an ingest-first hint (never a claim-apply hint).
    expect(r.json.hints).toContain('Map claim payload node_id values from the ref→nodeId list above');
    expect(r.json.hints.join(' ')).toContain('No sources yet');
    expect(r.json.hints.join(' ')).toContain('kb ingest');
    expect(r.json.hints.join(' ')).not.toContain('kb claim apply');
  });

  it('once the KB has sources, the second hint flips to the claim-apply payload hint', async () => {
    // Create the hierarchy, then ingest a source so a later graft sees hasSources === true.
    await runIo(['node', 'apply', '--file', writeManifest(rootManifest)]);
    const docPath = join(kb, 'doc.md');
    writeFileSync(docPath, '# Topic\n\nThe service caches results in Redis.\n');
    await runIo(['ingest', docPath]);

    const root = await runIo(['node', 'tree']);
    const rootId = (root.json.data as { nodes: Array<{ id: string; kind: string }> }).nodes.find(
      (n) => n.kind === 'root',
    )!.id;
    const graft = {
      nodes: [{ ref: 'obs', title: 'Observability', kind: 'topic', parent_id: rootId }],
    };
    const r = await runIo(['node', 'apply', '--file', writeManifest(graft)]);

    expect(r.code).toBe(0);
    expect(r.json.hints).toContain('Map claim payload node_id values from the ref→nodeId list above');
    expect(r.json.hints.join(' ')).toContain('kb claim apply --help --json');
    expect(r.json.hints.join(' ')).not.toContain('No sources yet');
  });

  it('a prevalidation failure reports every issue, exits 1, and persists nothing', async () => {
    const file = writeManifest({
      nodes: [
        { ref: 'r1', title: 'Root One', kind: 'root' },
        { ref: 'r2', title: 'Root Two', kind: 'root' },
      ],
    });
    const r = await runIo(['node', 'apply', '--file', file]);

    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.issues.map((i) => i.code)).toContain('MULTIPLE_ROOTS');
    // Nothing applied.
    const tree = await runIo(['node', 'tree']);
    expect((tree.json.data as { nodes: unknown[] }).nodes).toEqual([]);
  });
});

describe('kb node apply --dry-run (04 §2 via the Phase-1 runner)', () => {
  it('previews the receipt (ok, dryRun:true), steers to the same command without --dry-run, and writes nothing', async () => {
    const file = writeManifest(rootManifest);
    const dry = await runIo(['node', 'apply', '--file', file, '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.json.ok).toBe(true);
    expect(dry.json.data?.dryRun).toBe(true);
    // A file payload steers EXCLUSIVELY to the verbatim re-run without --dry-run (no ref-map
    // hints, since the previewed writes were rolled back).
    expect(dry.json.nextActions).toEqual([
      expect.objectContaining({ command: `kb node apply --file=${file} --json` }),
    ]);
    expect(dry.json.hints).toEqual([]);

    // The KB is untouched: no nodes were persisted.
    const tree = await runIo(['node', 'tree']);
    expect((tree.json.data as { nodes: unknown[] }).nodes).toEqual([]);
  });

  it('matches the real apply on the §2 receipt projection (dry-run first, then real)', async () => {
    const file = writeManifest(rootManifest);
    const dry = await runIo(['node', 'apply', '--file', file, '--dry-run']);
    const real = await runIo(['node', 'apply', '--file', file]);

    expect(dry.code).toBe(0);
    expect(real.code).toBe(0);
    // The ref→outcome map, totals, and staleNodes are identical; the preview flag is not.
    expect(receiptProjection(dry.json.data)).toEqual(receiptProjection(real.json.data));
    expect(dry.json.data?.dryRun).toBe(true);
    expect(real.json.data?.dryRun).toBe(false);
  });

  it('a dry-run that fails validation returns ok:false with issues, exit 1, and no replay steering', async () => {
    const file = writeManifest({
      nodes: [{ ref: 'orphan', title: 'Orphan Topic', kind: 'topic' }], // non-root, no parent
    });
    const dry = await runIo(['node', 'apply', '--file', file, '--dry-run']);

    expect(dry.code).toBe(1);
    expect(dry.json.ok).toBe(false);
    expect(dry.json.issues.map((i) => i.code)).toContain('PAYLOAD_SCHEMA');
    // A failed preview wrote nothing, so there is nothing to "apply" — no replay next-action.
    expect(dry.json.nextActions).toEqual([]);
  });
});

describe('kb node apply --help', () => {
  it('declares supportsDryRun in its HelpSpec (closing the Phase-1 deferral)', async () => {
    const r = await runIo(['node', 'apply', '--help']);
    expect(r.code).toBe(0);
    const spec = r.json.data as { command: string; supportsDryRun: boolean; input: { schema: string } };
    expect(spec.command).toBe('node apply');
    expect(spec.supportsDryRun).toBe(true);
    expect(spec.input.schema).toBe('NodeApplySchema');
  });
});
