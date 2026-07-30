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

async function nodeState(nodeId: string): Promise<{ bodyMd: string; bodyHash: string }> {
  const shown = await runIo(['node', 'show', nodeId, '--context']);
  return (shown.json.data as { node: { bodyMd: string; bodyHash: string } }).node;
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
  it.each([false, true])('requires expected_body_hash in %s mode', async (dryRun) => {
    const rootId = await createNode('Root', 'root');
    const file = writePayload({ node_id: rootId, body_md: 'Overview.' });
    const r = await runIo(['synthesize', '--file', file, ...(dryRun ? ['--dry-run'] : [])]);

    expect(r.code).toBe(1);
    expect(r.json.issues).toEqual([
      expect.objectContaining({ code: 'PAYLOAD_SCHEMA', path: 'expected_body_hash' }),
    ]);
  });

  it.each([false, true])('rejects a stale expected_body_hash in %s mode with a re-read hint', async (dryRun) => {
    const rootId = await createNode('Root', 'root');
    const before = await nodeState(rootId);
    const first = writePayload({
      node_id: rootId,
      body_md: 'First version.',
      expected_body_hash: before.bodyHash,
    });
    expect((await runIo(['synthesize', '--file', first])).code).toBe(0);

    const stale = writePayload({
      node_id: rootId,
      body_md: 'Second version.',
      expected_body_hash: before.bodyHash,
    });
    const r = await runIo(['synthesize', '--file', stale, ...(dryRun ? ['--dry-run'] : [])]);

    expect(r.code).toBe(1);
    expect(r.json.issues).toEqual([
      expect.objectContaining({
        code: 'BODY_HASH_MISMATCH',
        hint: `Re-read the node: kb node show ${rootId} --context --json`,
      }),
    ]);
    expect((await nodeState(rootId)).bodyMd).toBe('First version.');
  });

  it('reports bodyDelta and warns without failing when a current citation is removed in dry-run and apply', async () => {
    const rootId = await createNode('Root', 'root');
    const claimId = await applyClaim(rootId, 'The widget service caches in Redis.');
    const initialBody = `Caches in Redis.[^${claimId}]`;
    const initial = writePayload({
      node_id: rootId,
      body_md: initialBody,
      expected_body_hash: (await nodeState(rootId)).bodyHash,
    });
    expect((await runIo(['synthesize', '--file', initial])).code).toBe(0);

    const replacement = 'Caches in Redis.';
    const file = writePayload({
      node_id: rootId,
      body_md: replacement,
      expected_body_hash: (await nodeState(rootId)).bodyHash,
    });
    const dry = await runIo(['synthesize', '--file', file, '--dry-run']);
    const applied = await runIo(['synthesize', '--file', file]);

    for (const r of [dry, applied]) {
      expect(r.code).toBe(0);
      expect(r.json.ok).toBe(true);
      expect(r.json.data?.['bodyDelta']).toEqual({
        charsBefore: initialBody.length,
        charsAfter: replacement.length,
        citationsAdded: [],
        citationsRemoved: [claimId],
        removedCurrent: [claimId],
      });
      expect(r.json.issues).toEqual([
        expect.objectContaining({
          code: 'CITATIONS_REMOVED',
          severity: 'warning',
          ids: [claimId],
        }),
      ]);
    }
  });

  it('keeps the unchanged happy path and reports an empty bodyDelta', async () => {
    const rootId = await createNode('Root', 'root');
    const body = 'Overview.';
    const first = writePayload({
      node_id: rootId,
      body_md: body,
      expected_body_hash: (await nodeState(rootId)).bodyHash,
    });
    expect((await runIo(['synthesize', '--file', first])).code).toBe(0);

    const repeat = writePayload({
      node_id: rootId,
      body_md: body,
      expected_body_hash: (await nodeState(rootId)).bodyHash,
    });
    const r = await runIo(['synthesize', '--file', repeat]);

    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({
      outcome: 'unchanged',
      bodyDelta: {
        charsBefore: body.length,
        charsAfter: body.length,
        citationsAdded: [],
        citationsRemoved: [],
        removedCurrent: [],
      },
    });
    expect(r.json.issues).toEqual([]);
  });

  it('carries nodeId/outcome/staleNodes plus the deprecated updated/unchanged/missingCitations aliases', async () => {
    const rootId = await createNode('Root', 'root');
    const leafId = await createNode('Caching', 'leaf', rootId);
    const claimId = await applyClaim(leafId, 'The widget service caches in Redis.');

    const file = writePayload({ node_id: leafId, expected_body_hash: (await nodeState(leafId)).bodyHash, body_md: `Caches in Redis.[^${claimId}]` });
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

    const file = writePayload({ node_id: leafId, expected_body_hash: (await nodeState(leafId)).bodyHash, body_md: `Caches in Redis.[^${claimId}]` });
    const r = await runIo(['synthesize', '--file', file]);

    expect(r.code).toBe(0);
    expect(r.json.nextActions).toEqual([expect.objectContaining({ command: `kb node show ${rootId} --context --json` })]);
    expect(r.json.nextActions.map((n) => n.command)).not.toContain('kb verify --strict --json');
  });

  it('no stale nodes remain → steers to verify', async () => {
    // A single root that owns its own claim: synthesizing it clears the last stale node.
    const rootId = await createNode('Root', 'root');
    const claimId = await applyClaim(rootId, 'The widget service caches in Redis.');

    const file = writePayload({ node_id: rootId, expected_body_hash: (await nodeState(rootId)).bodyHash, body_md: `Caches in Redis.[^${claimId}]` });
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

    const file = writePayload({ node_id: leafA, expected_body_hash: (await nodeState(leafA)).bodyHash, body_md: `Cross-cite.[^${claimB}]` });
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
