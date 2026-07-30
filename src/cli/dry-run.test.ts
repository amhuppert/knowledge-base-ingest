import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { dryRunPlanFor, shellQuoteArg } from './run.js';
import { receiptProjection } from './receiptParity.js';

/**
 * CLI dry-run wiring (03 §2). Drives the real dispatcher in-process against a temp KB.
 * The DB-only dry-run commands (`claim apply`, `graph apply`, `synthesize`) preview
 * through the real code path, stamp `data.dryRun`, steer to the file re-run, and leave
 * the KB byte-identical. Receipt parity is asserted on the §2 projection ONLY; steering
 * is asserted separately (file → re-run action; stdin → the no-replay hint).
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
let sourceId: string;
let chunkId: string;
let nodeId: string;

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
function writePayload(payload: unknown): string {
  const file = join(kb, `payload-${payloadCounter++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

function claimPayload(text = 'The widget service caches in Redis.'): unknown {
  return {
    source_id: sourceId,
    claims: [
      {
        node_id: nodeId,
        text,
        claim_type: 'fact',
        confidence: 0.9,
        spans: [{ chunk_id: chunkId, quote: 'caches results in Redis' }],
      },
    ],
  };
}

/** A fresh KB per test so a real apply in one test never perturbs the next preview. */
beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-dryrun-'));
  const init = await runIo(['init', kb]);
  expect(init.json.ok).toBe(true);
  const docPath = join(kb, 'doc.md');
  writeFileSync(docPath, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
  const ing = await runIo(['ingest', docPath]);
  sourceId = (ing.json.data as { sourceId: string }).sourceId;
  const chunks = await runIo(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('caches results in Redis'),
  )!.id;
  const node = await runIo(['node', 'create', '--title', 'Topic', '--kind', 'root']);
  nodeId = (node.json.data as { nodeId: string }).nodeId;
});

afterEach(() => rmSync(kb, { recursive: true, force: true }));

describe('claim apply --dry-run (03 §2)', () => {
  it('previews the receipt (ok, dryRun:true) and steers to the same command without --dry-run', async () => {
    const file = writePayload(claimPayload());
    const dry = await runIo(['claim', 'apply', '--file', file, '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.json.ok).toBe(true);
    expect(dry.json.data?.dryRun).toBe(true);
    // A file payload steers EXCLUSIVELY to the verbatim re-run without --dry-run.
    expect(dry.json.nextActions).toEqual([
      expect.objectContaining({ command: `kb claim apply --file=${file} --json` }),
    ]);
    expect(dry.json.hints).toEqual([]);
    expect(
      (dry.json.data as { claims: Array<{ reviewCandidates: unknown }> }).claims[0]!
        .reviewCandidates,
    ).toEqual({ matched: 0, shown: 0, complete: true, items: [] });
  });

  it('surfaces near-duplicate review candidates and one adjudication hint only in dry-run', async () => {
    const existingFile = writePayload(
      claimPayload('The widget service caches results in Redis.'),
    );
    const existing = await runIo(['claim', 'apply', '--file', existingFile]);
    const existingClaimId = (
      existing.json.data as { claims: Array<{ claimId: string }> }
    ).claims[0]!.claimId;

    const proposedFile = writePayload(claimPayload());
    const dry = await runIo(['claim', 'apply', '--file', proposedFile, '--dry-run']);
    const dryRow = (
      dry.json.data as {
        claims: Array<{
          reviewCandidates: {
            matched: number;
            shown: number;
            complete: boolean;
            items: Array<{ claimId: string }>;
          };
        }>;
      }
    ).claims[0]!;

    expect(dryRow.reviewCandidates).toMatchObject({
      matched: 1,
      shown: 1,
      complete: true,
    });
    expect(dryRow.reviewCandidates.items.map((item) => item.claimId)).toEqual([
      existingClaimId,
    ]);
    expect(dry.json.hints).toHaveLength(1);
    expect(dry.json.hints[0]).toContain('kb claim supersede');
    expect(dry.json.hints[0]).toContain('kb claim conflict');

    const real = await runIo(['claim', 'apply', '--file', proposedFile]);
    expect(
      (real.json.data as { claims: Array<Record<string, unknown>> }).claims[0]!
        .reviewCandidates,
    ).toBeUndefined();
  });

  it('preserves an explicit --kb and shell-quotes a spaced payload path in the steered re-run', async () => {
    // A payload path with a space + shell metacharacters, and an EXPLICIT --kb target: the
    // steered re-run must stay executable verbatim (charter: verbatim-next-actions) — the
    // --kb option preserved so the replay hits the same KB, the path single-quoted.
    const spaced = join(kb, 'pay load (1)&.json');
    writeFileSync(spaced, JSON.stringify(claimPayload()));
    const dry = await runIo(['claim', 'apply', '--kb', kb, '--file', spaced, '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.json.data?.dryRun).toBe(true);
    expect(dry.json.nextActions).toEqual([
      expect.objectContaining({
        command: `kb claim apply --kb=${shellQuoteArg(kb)} --file=${shellQuoteArg(spaced)} --json`,
      }),
    ]);
    // The spaced/metachar path forced single-quoting (no bare space leaks into the command).
    expect(dry.json.nextActions[0]!.command).toContain(`--file='${spaced}'`);
  });

  it('emits an attached --file=<path> re-run that the same CLI accepts verbatim (round-trip)', async () => {
    const file = writePayload(claimPayload());
    // The steered re-run uses the `--file=<path>` form; prove that exact form parses and
    // previews through the REAL router + Commander, so the verbatim command is executable.
    const dry = await runIo(['claim', 'apply', `--file=${file}`, '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.json.data?.dryRun).toBe(true);
    expect(dry.json.nextActions[0]!.command).toBe(`kb claim apply --file=${file} --json`);
  });

  it('the router rejects the space form of a dash-prefixed value — why the re-run uses --file=', async () => {
    // If buildReapplyCommand ever regressed to `--file <value>`, a dash-prefixed value would be
    // swallowed by the greedy-value guard (MISSING_ARGUMENT, exit 2). The `=` form sidesteps it.
    const rejected = await runIo(['claim', 'apply', '--file', '--json', '--dry-run']);
    expect(rejected.code).toBe(2);
    expect(rejected.json.issues.map((i) => i.code)).toContain('MISSING_ARGUMENT');
  });

  it('leaves the KB byte-identical (no claim persisted, status unchanged)', async () => {
    const before = await runIo(['status']);
    const file = writePayload(claimPayload());
    await runIo(['claim', 'apply', '--file', file, '--dry-run']);
    const after = await runIo(['status']);

    expect(after.json.data).toEqual(before.json.data);
    const shown = await runIo(['node', 'show', nodeId]);
    expect((shown.json.data as { claims: unknown[] }).claims).toEqual([]);
  });

  it('matches the real apply on the §2 receipt projection (dry-run first, then real)', async () => {
    const file = writePayload(claimPayload());
    const dry = await runIo(['claim', 'apply', '--file', file, '--dry-run']);
    // The preview rolled back, so the real apply sees the SAME empty starting state.
    const real = await runIo(['claim', 'apply', '--file', file]);

    expect(dry.code).toBe(0);
    expect(real.code).toBe(0);
    expect(receiptProjection(dry.json.data)).toEqual(receiptProjection(real.json.data));
    // The projection excludes the preview flag: dry-run had it, the real apply did not.
    expect(dry.json.data?.dryRun).toBe(true);
    expect(real.json.data?.dryRun).toBeUndefined();
  });

  it('a dry-run that fails validation returns ok:false with issues, exit 1, and persists nothing', async () => {
    const bad = {
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'Hallucinated.',
          claim_type: 'fact',
          confidence: 0.9,
          spans: [{ chunk_id: chunkId, quote: 'this text is absent from the source' }],
        },
      ],
    };
    const file = writePayload(bad);
    const dry = await runIo(['claim', 'apply', '--file', file, '--dry-run']);

    expect(dry.code).toBe(1);
    expect(dry.json.ok).toBe(false);
    expect(dry.json.issues.length).toBeGreaterThan(0);
    expect(dry.json.errors.join(' ')).toMatch(/quote not found/);

    const shown = await runIo(['node', 'show', nodeId]);
    expect((shown.json.data as { claims: unknown[] }).claims).toEqual([]);
  });
});

describe('synthesize --dry-run (03 §2)', () => {
  it('previews without clearing the node stale flag and steers to the re-run', async () => {
    // Apply a real claim so the node has a citable claim for the synthesize body.
    const claimFile = writePayload(claimPayload());
    await runIo(['claim', 'apply', '--file', claimFile]);
    const node = await runIo(['node', 'show', nodeId]);
    expect((node.json.data as { node: { isStale: boolean } }).node.isStale).toBe(true);
    const claimId = (node.json.data as { claims: Array<{ id: string }> }).claims[0]!.id;

    const synthFile = writePayload({ node_id: nodeId, expected_body_hash: '', body_md: `Caches in Redis.[^${claimId}]` });
    const dry = await runIo(['synthesize', '--file', synthFile, '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.json.data?.dryRun).toBe(true);
    expect(dry.json.nextActions).toEqual([
      expect.objectContaining({ command: `kb synthesize --file=${synthFile} --json` }),
    ]);
    // The preview rolled back: the node is still stale afterward.
    const after = await runIo(['node', 'show', nodeId]);
    expect((after.json.data as { node: { isStale: boolean } }).node.isStale).toBe(true);
  });
});

describe('graph apply --dry-run (03 §2)', () => {
  it('previews the graph receipt (dryRun:true), leaves entities empty, and steers to the re-run', async () => {
    const graphFile = writePayload({
      source_id: sourceId,
      entities: [{ type: 'Service', name: 'Widget' }, { type: 'DataStore', name: 'Redis' }],
      relationships: [
        {
          type: 'stores_in',
          subject: { type: 'Service', name: 'Widget' },
          object: { type: 'DataStore', name: 'Redis' },
          evidence: [{ chunk_id: chunkId, quote: 'caches results in Redis' }],
        },
      ],
    });
    const dry = await runIo(['graph', 'apply', '--file', graphFile, '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.json.ok).toBe(true);
    expect(dry.json.data?.dryRun).toBe(true);
    expect((dry.json.data as { entitiesCreated: number }).entitiesCreated).toBe(2);
    expect(dry.json.nextActions).toEqual([
      expect.objectContaining({ command: `kb graph apply --file=${graphFile} --json` }),
    ]);

    // The preview rolled back: a real apply of the SAME payload still CREATES both
    // entities (had the preview persisted, they would be reported "unchanged").
    const real = await runIo(['graph', 'apply', '--file', graphFile]);
    expect((real.json.data as { entitiesCreated: number }).entitiesCreated).toBe(2);
    expect(real.json.data?.dryRun).toBeUndefined();
  });
});

describe('dryRunPlanFor — payload source detection (03 §2)', () => {
  const registry = new Set(['claim apply', 'graph apply', 'synthesize']);

  it('a real --file path is a "file" payload with a verbatim re-run command', () => {
    const plan = dryRunPlanFor('claim apply', { file: '/tmp/c.json' }, registry);
    expect(plan.payloadFrom).toBe('file');
    expect(plan.reapplyCommand).toBe('kb claim apply --file=/tmp/c.json --json');
  });

  it('no --file (or `-`) is a "stdin" payload with no auto-replay command', () => {
    for (const opts of [{}, { file: '-' }]) {
      const plan = dryRunPlanFor('synthesize', opts, registry);
      expect(plan.payloadFrom).toBe('stdin');
      expect(plan.reapplyCommand).toBe('');
    }
  });

  it('preserves an explicit --kb target in the re-run so a replay never retargets the wrong KB', () => {
    const plan = dryRunPlanFor('graph apply', { file: '/tmp/g.json', kb: '/srv/other-kb' }, registry);
    expect(plan.reapplyCommand).toBe('kb graph apply --kb=/srv/other-kb --file=/tmp/g.json --json');
  });

  it('shell-quotes a --file path (and a --kb dir) containing spaces or metacharacters', () => {
    const plan = dryRunPlanFor('claim apply', { file: '/tmp/my kb/pay load (1).json', kb: "/kb's dir" }, registry);
    expect(plan.reapplyCommand).toBe(
      "kb claim apply --kb='/kb'\\''s dir' --file='/tmp/my kb/pay load (1).json' --json",
    );
  });

  it('uses the attached --file=<value> form so a dash-prefixed value never misparses as an option', () => {
    // `--file=--json` is the 01 §1.2 escape for a dash-prefixed value; the space form
    // `--file --json` would be rejected by the router's greedy-value guard on replay
    // (see the E2E "router rejects the space form" test below). `--json` is shell-safe, so
    // it stays unquoted — the `=` alone binds it to --file.
    const plan = dryRunPlanFor('claim apply', { file: '--json' }, registry);
    expect(plan.reapplyCommand).toBe('kb claim apply --file=--json --json');
  });
});

describe('shellQuoteArg — POSIX-safe verbatim quoting (03 §2, verbatim-next-actions)', () => {
  it('leaves shell-safe values unquoted (paths, ids, flags)', () => {
    expect(shellQuoteArg('/tmp/claims.json')).toBe('/tmp/claims.json');
    expect(shellQuoteArg('src_1a2b3c')).toBe('src_1a2b3c');
    expect(shellQuoteArg('a-b_c.d/e:f@g%h+i=j,k')).toBe('a-b_c.d/e:f@g%h+i=j,k');
  });

  it('single-quotes values with spaces or shell metacharacters', () => {
    expect(shellQuoteArg('my file.json')).toBe("'my file.json'");
    expect(shellQuoteArg('pay (1)&.json')).toBe("'pay (1)&.json'");
    expect(shellQuoteArg('$HOME/x;rm -rf /')).toBe("'$HOME/x;rm -rf /'");
  });

  it('escapes embedded single quotes with the standard \x27\\\x27\x27 transform', () => {
    expect(shellQuoteArg("it's a file.json")).toBe("'it'\\''s a file.json'");
  });

  it('quotes the empty string as \x27\x27 (never an empty bare token)', () => {
    expect(shellQuoteArg('')).toBe("''");
  });
});
