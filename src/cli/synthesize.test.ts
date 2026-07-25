import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

/**
 * CLI synthesize receipt + steering (03 §3.3, §4; 01 §6.1). Drives the real dispatcher
 * in-process against a temp KB. The receipt carries `nodeId`/`outcome`/`staleNodes` plus
 * the deprecated `updated`/`unchanged`/`missingCitations` aliases; steering points at the
 * remaining stale nodes when any survive, else at `verify`.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; severity: string; message: string; hint?: string; ids?: string[] }>;
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

let kb: string;
let sourceId: string;
let chunkId: string;

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

let payloadCounter = 0;
function writePayload(payload: unknown): string {
  const file = join(kb, `payload-${payloadCounter++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

async function createNode(title: string, kind: string, parent?: string): Promise<string> {
  const args = ['node', 'create', '--title', title, '--kind', kind];
  if (parent) args.push('--parent', parent);
  const r = await runIo(args);
  return (r.json.data as { nodeId: string }).nodeId;
}

async function applyClaim(nodeId: string, text: string): Promise<string> {
  const file = writePayload({
    source_id: sourceId,
    claims: [{ node_id: nodeId, text, claim_type: 'fact', confidence: 0.9, spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }] }],
  });
  await runIo(['claim', 'apply', '--file', file]);
  const shown = await runIo(['node', 'show', nodeId]);
  return (shown.json.data as { claims: Array<{ id: string }> }).claims[0]!.id;
}

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-synth-'));
  await runIo(['init', kb]);
  const docPath = join(kb, 'doc.md');
  writeFileSync(docPath, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
  const ing = await runIo(['ingest', docPath]);
  sourceId = (ing.json.data as { sourceId: string }).sourceId;
  const chunks = await runIo(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('caches results in Redis'),
  )!.id;
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('synthesize receipt (03 §3.3)', () => {
  it('carries nodeId/outcome/staleNodes plus the deprecated updated/unchanged/missingCitations aliases', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.');

    const file = writePayload({ node_id: leafId, body_md: `Caches in Redis.[^${claimId}]` });
    const r = await runIo(['synthesize', '--file', file]);

    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({
      nodeId: leafId,
      outcome: 'updated',
      updated: true,
      unchanged: false,
      missingCitations: [],
    });
    // The leaf was synthesized; the root remains stale (a body-only change never stales ancestors,
    // but the root was already stale from node creation + claim apply).
    expect(r.json.data!.staleNodes).toEqual([rootId]);
  });
});

describe('synthesize steering (01 §6.1)', () => {
  it('stale nodes remain → steers to the deepest-first node show --context (not verify)', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.');

    const file = writePayload({ node_id: leafId, body_md: `Caches in Redis.[^${claimId}]` });
    const r = await runIo(['synthesize', '--file', file]);

    expect(r.code).toBe(0);
    expect(r.json.nextActions).toEqual([expect.objectContaining({ command: `kb node show ${rootId} --context --json` })]);
    expect(r.json.nextActions.map((n) => n.command)).not.toContain('kb verify --strict --json');
  });

  it('no stale nodes remain → steers to verify', async () => {
    // A single root that owns its own claim: synthesizing it clears the last stale node.
    const rootId = await createNode('Root', 'root');
    const claimId = await applyClaim(rootId, 'The widget service caches in Redis.');

    const file = writePayload({ node_id: rootId, body_md: `Caches in Redis.[^${claimId}]` });
    const r = await runIo(['synthesize', '--file', file]);

    expect(r.code).toBe(0);
    expect((r.json.data as { staleNodes: string[] }).staleNodes).toEqual([]);
    expect(r.json.nextActions).toEqual([expect.objectContaining({ command: 'kb verify --strict --json' })]);
  });

  it('rejecting an out-of-subtree citation surfaces CITATION_OUT_OF_SUBTREE (dynamic hint names the owning node) and persists nothing', async () => {
    const rootId = await createNode('Root', 'root');
    const leafA = await createNode('Alpha', 'leaf', rootId);
    const leafB = await createNode('Bravo', 'leaf', rootId);
    const claimB = await applyClaim(leafB, 'The widget service caches in Redis.');

    const file = writePayload({ node_id: leafA, body_md: `Cross-cite.[^${claimB}]` });
    const r = await runIo(['synthesize', '--file', file]);

    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    const issue = r.json.issues.find((i) => i.code === 'CITATION_OUT_OF_SUBTREE');
    expect(issue).toBeDefined();
    // The DYNAMIC hint (owning node's title) reaches the envelope through the real
    // errorToIssues → domainIssueToIssue path — not the static registry hint.
    expect((issue as { hint?: string }).hint).toContain('Bravo');
    expect(issue!.ids).toEqual([claimB, leafB]);
    // Nothing persisted: leafA has no body.
    const shown = await runIo(['node', 'show', leafA]);
    expect((shown.json.data as { node: { bodyMd: string } }).node.bodyMd).toBe('');
  });
});
