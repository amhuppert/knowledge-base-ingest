import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';
import { KNOWN_BINARY_EXTENSIONS, mediaFormatTable } from '../domain/algorithms/media.js';
import type { HelpSpec } from './help/spec.js';

/**
 * PHASE 4 — `kb ingest` media policy, text sidecars, and source metadata (06 §1–§2).
 *
 * One test per 06 §1.3 behavior-matrix row, plus the receipt/recipe literals and the
 * §2 duplicate-update matrix. Everything drives the real CLI in-process against a
 * temp-dir KB, so flag parsing, exit codes, and envelopes are all exercised.
 */

interface CliResult {
  code: number;
  json: {
    ok: boolean;
    data: Record<string, unknown> | null;
    issues: Array<{ code: string; severity: string; message: string; hint?: string }>;
    errors: string[];
    warnings: string[];
    nextActions: Array<{ title: string; command: string }>;
    hints: string[];
  };
}

let kb: string;

/** Run EXACTLY these argv tokens (used to execute a recipe verbatim). */
async function runExact(args: string[]): Promise<CliResult> {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (c) => (out.stdout += c),
    stderr: (c) => (out.stderr += c),
    cwd: kb,
    env: { ...process.env, KB_DIR: kb },
  };
  const code = await runCli(args, io);
  return { code, json: JSON.parse(out.stdout || '{}') };
}

async function runIo(args: string[]): Promise<CliResult> {
  return runExact([...args, '--json']);
}

/**
 * Split a printed shell command into argv tokens, honouring the single/double quoting
 * a recipe uses for values with spaces — so a recipe can be executed EXACTLY as printed.
 */
function shellSplit(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Write a file into the KB dir and return its absolute path. */
function write(name: string, body: string | Buffer): string {
  const p = join(kb, name);
  writeFileSync(p, body);
  return p;
}

const DOC = '# Widget Report\n\nThe widget service caches rendered results in Redis for speed.\n';

beforeEach(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-lineage-'));
  expect((await runIo(['init', kb])).json.ok).toBe(true);
});
afterEach(() => rmSync(kb, { recursive: true, force: true }));

// --------------------------------------------------------------------------
// 06 §1.3 matrix — media policy rows
// --------------------------------------------------------------------------

describe('06 §1.3 row: decodable text, no --text-from → the current native path', () => {
  it('ingests and records extractor text-utf8/1', async () => {
    const r = await runIo(['ingest', write('notes.md', DOC)]);
    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({ status: 'new', title: 'Widget Report' });
    expect(r.json.data!.text).toMatchObject({ extractor: 'text-utf8/1', verification: 'none' });
  });
});

describe('06 §1.3 row: known-binary extension, no --text-from → UNSUPPORTED_MEDIA + recipe', () => {
  it('gates every known-binary extension, even when the bytes are valid UTF-8', async () => {
    for (const ext of KNOWN_BINARY_EXTENSIONS) {
      const r = await runIo(['ingest', write(`report.${ext}`, DOC)]);
      expect(r.code, ext).toBe(1);
      expect(r.json.ok, ext).toBe(false);
      const issue = r.json.issues.find((i) => i.code === 'UNSUPPORTED_MEDIA');
      expect(issue, ext).toBeDefined();
      // The literal two-step recipe (06 §1.5) — asserted on the literal flag string.
      expect(issue!.message, ext).toContain('--text-from');
      expect(issue!.message, ext).toContain('kb ingest --help --json');
    }
  });
});

describe('06 §1.3 row: undecodable bytes, no --text-from → UNSUPPORTED_MEDIA', () => {
  it('rejects malformed UTF-8 rather than substituting U+FFFD', async () => {
    const r = await runIo(['ingest', write('broken.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x41]))]);
    expect(r.code).toBe(1);
    expect(r.json.issues.some((i) => i.code === 'UNSUPPORTED_MEDIA')).toBe(true);
  });

  it('still accepts an UNKNOWN extension holding UTF-8 text (text/plain)', async () => {
    const r = await runIo(['ingest', write('notes.weird', DOC)]);
    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({ status: 'new' });
    const show = await runIo(['source', 'show', r.json.data!.sourceId as string]);
    expect(show.json.data).toMatchObject({ mediaType: 'text/plain' });
  });
});

// --------------------------------------------------------------------------
// 06 §1.3 matrix — sidecar (derived) rows
// --------------------------------------------------------------------------

/** Bytes no decoder can read — only a sidecar can supply this original's text. */
const BINARY = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0x01, 0xff]);
const TRANSCRIPT = '# Widget Report\n\nThe widget service caches rendered results in Redis.\n';

describe('06 §1.3 row: binary original WITH --text-from → the derived path', () => {
  it('takes identity from the original bytes and canonical text from the sidecar', async () => {
    const original = write('report.pdf', BINARY);
    const side = write('report.extracted.md', TRANSCRIPT);
    const r = await runIo(['ingest', original, '--text-from', side]);

    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({ status: 'new', title: 'Widget Report' });
    expect(r.json.data!.original).toMatchObject({ mediaType: 'application/pdf', byteSize: BINARY.byteLength });
    expect(r.json.data!.text).toMatchObject({ extractor: 'agent-transcription/1', verification: 'none' });
    expect(r.json.nextActions[0]!.command).toBe(`kb source chunks ${r.json.data!.sourceId} --json`);

    // The chunks an agent quotes from are the SIDECAR's text.
    const chunks = await runIo(['source', 'chunks', r.json.data!.sourceId as string]);
    expect(JSON.stringify(chunks.json.data)).toContain('caches rendered results in Redis');
  });
});

describe('--dry-run on the derived path (03 §5 plan, extended by 06 §1.3)', () => {
  it('previews the sidecar-derived title and chunks and steers to the verbatim re-run', async () => {
    const original = write('report.pdf', BINARY);
    const side = write('report.extracted.md', TRANSCRIPT);
    const dry = await runIo(['ingest', original, '--text-from', side, '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.json.data).toMatchObject({ dryRun: true, status: 'new', title: 'Widget Report' });
    expect(dry.json.data!.chunks).toBeGreaterThan(0);
    // The re-run preserves --text-from, so applying it reproduces the previewed result.
    const rerun = dry.json.nextActions[0]!.command;
    expect(rerun).toContain(`--text-from=${side}`);
    // Nothing was persisted by the preview.
    expect((await runIo(['source', 'list'])).json.data!.sources).toEqual([]);
  });
});

describe('06 §1.3 row: decodable text WITH --text-from → the derived path', () => {
  it('records the sidecar as canonical text even though the original decodes', async () => {
    const original = write('raw-export.md', '# Raw export\n\nnoisy OCR   dump\n');
    const side = write('cleaned.md', TRANSCRIPT);
    const r = await runIo(['ingest', original, '--text-from', side, '--extractor', 'pdf-text/3', '--verification', 'visual']);

    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({ title: 'Widget Report' });
    expect(r.json.data!.text).toMatchObject({ extractor: 'pdf-text/3', verification: 'visual' });

    const show = await runIo(['source', 'show', r.json.data!.sourceId as string]);
    // The extractor round-trips out of the two split columns via metadata.extraction.method.
    expect(JSON.parse((show.json.data as { metadataJson: string }).metadataJson).extraction).toMatchObject({
      method: 'pdf-text/3',
      verification: 'visual',
      textFilePath: side,
    });
  });
});

describe('06 §1.3 row: unusable --text-from → TEXT_SIDECAR_INVALID', () => {
  it('reports a missing sidecar file', async () => {
    const r = await runIo(['ingest', write('report.pdf', BINARY), '--text-from', join(kb, 'nope.md')]);
    expect(r.code).toBe(1);
    expect(r.json.issues.some((i) => i.code === 'TEXT_SIDECAR_INVALID')).toBe(true);
  });

  it('reports a sidecar that fails the fatal UTF-8 decode', async () => {
    const side = write('bad.md', Buffer.from([0x23, 0x20, 0xff, 0xfe]));
    const r = await runIo(['ingest', write('report.pdf', BINARY), '--text-from', side]);
    expect(r.code).toBe(1);
    expect(r.json.issues.some((i) => i.code === 'TEXT_SIDECAR_INVALID')).toBe(true);
  });
});

describe('06 §1.3 row: --extractor/--verification without --text-from → INVALID_ARGUMENT, exit 2', () => {
  it('fails BEFORE any workspace is opened (nonexistent KB and nonexistent input still exit 2)', async () => {
    const nowhere = join(kb, 'no-kb-here');
    for (const flag of [['--extractor', 'pdf-text/3'], ['--verification', 'visual']]) {
      const r = await runIo(['ingest', join(kb, 'missing.pdf'), ...flag, '--kb', nowhere]);
      expect(r.code, flag[0]).toBe(2);
      const issue = r.json.issues.find((i) => i.code === 'INVALID_ARGUMENT');
      expect(issue, flag[0]).toBeDefined();
      expect(issue!.message, flag[0]).toContain('--text-from');
      // A workspace open would have produced a NO_KB/"no knowledge base" error instead.
      expect(r.json.issues.some((i) => i.code === 'NO_KB' || i.code === 'LEGACY'), flag[0]).toBe(false);
    }
  });

  it('rejects an extractor the split columns cannot hold (exit 2, at parse time)', async () => {
    for (const bad of ['agent-transcription', 'agent/v2', 'Agent/1', 'agent/1.2']) {
      const r = await runIo(['ingest', write('report.pdf', BINARY), '--text-from', write('t.md', TRANSCRIPT), '--extractor', bad]);
      expect(r.code, bad).toBe(2);
      expect(r.json.issues.some((i) => i.code === 'INVALID_ARGUMENT'), bad).toBe(true);
    }
  });
});

describe('06 §1.3 row: same original re-ingested', () => {
  it('an exact repeat (same sidecar) is a plain duplicate', async () => {
    const original = write('report.pdf', BINARY);
    const side = write('report.extracted.md', TRANSCRIPT);
    const first = await runIo(['ingest', original, '--text-from', side]);
    const again = await runIo(['ingest', original, '--text-from', side]);
    expect(again.code).toBe(0);
    expect(again.json.data).toMatchObject({ status: 'duplicate', sourceId: first.json.data!.sourceId });
    expect(again.json.data!.text).toMatchObject({ extractor: 'agent-transcription/1' });
  });

  it('a DIFFERENT sidecar text is always rejected, and the printed recipe runs verbatim', async () => {
    const original = write('report.pdf', BINARY);
    const first = await runIo(['ingest', original, '--text-from', write('report.extracted.md', TRANSCRIPT)]);
    const oldId = first.json.data!.sourceId as string;

    const corrected = `${TRANSCRIPT}\nThe cache TTL is five minutes.\n`;
    const retry = await runIo(['ingest', original, '--text-from', write('report.extracted-fixed.md', corrected)]);
    expect(retry.code).toBe(1);
    const issue = retry.json.issues.find((i) => i.code === 'INVALID_ARGUMENT')!;
    expect(issue.hint).toContain('is immutable');
    expect(issue.hint).toContain('--supersedes');

    // Execute the recipe EXACTLY as printed: write the corrected transcription to the
    // file it names, then run its command line verbatim.
    const line = issue.hint!.split('\n').find((l) => l.trim().startsWith('kb ingest'))!.trim();
    const argv = shellSplit(line);
    expect(argv[0]).toBe('kb');
    writeFileSync(argv[2]!, corrected);
    const published = await runExact(argv.slice(1));

    expect(published.code).toBe(0);
    const newId = published.json.data!.sourceId as string;
    expect(newId).not.toBe(oldId);
    const newSource = await runIo(['source', 'show', newId]);
    const oldSource = await runIo(['source', 'show', oldId]);
    expect(newSource.json.data).toMatchObject({ supersedesSourceId: oldId, status: 'active' });
    expect(oldSource.json.data).toMatchObject({ status: 'superseded' });
    expect(newSource.json.data!.title).toBe('Widget Report (corrected transcription)');
  });
});

// --------------------------------------------------------------------------
// 06 §2 — source metadata write rules
// --------------------------------------------------------------------------

/** The metadata block recorded for `sourceId`, as `source show` reports it. */
async function metadataOf(sourceId: string): Promise<Record<string, unknown>> {
  const show = await runIo(['source', 'show', sourceId]);
  return JSON.parse((show.json.data as { metadataJson: string }).metadataJson);
}

describe('06 §2 duplicate-update matrix ({no flags, title, origin, extraction} × {first, duplicate})', () => {
  /** Each row's extra flags, applied to the SAME original bytes both times. */
  const ROWS = [
    { name: 'no flags', flags: [] as string[] },
    { name: 'title-only', flags: ['--title', 'Renamed report'] },
    { name: 'origin-only', flags: ['--origin-system', 'notion', '--origin-url', 'https://example.com/doc'] },
  ];

  it.each(ROWS)('$name: first ingest is new, the duplicate re-run reports the right updated flag', async (row) => {
    const original = write('report.pdf', BINARY);
    const side = write('report.extracted.md', TRANSCRIPT);
    const base = ['ingest', original, '--text-from', side];

    // FIRST: always a new source; the row's flags land on it.
    const first = await runIo([...base, ...row.flags]);
    expect(first.code, row.name).toBe(0);
    expect(first.json.data, row.name).toMatchObject({ status: 'new', updated: false });

    // DUPLICATE: same original + same sidecar + the same flags ⇒ nothing changes.
    const repeat = await runIo([...base, ...row.flags]);
    expect(repeat.json.data, row.name).toMatchObject({ status: 'duplicate', updated: false });
  });

  it('a duplicate carrying NEW --origin-* flags patch-merges them and reports updated:true', async () => {
    const original = write('report.pdf', BINARY);
    const side = write('report.extracted.md', TRANSCRIPT);
    const first = await runIo(['ingest', original, '--text-from', side, '--origin-system', 'notion']);
    const id = first.json.data!.sourceId as string;
    expect(await metadataOf(id)).toMatchObject({ origin: { system: 'notion' } });

    const updated = await runIo(['ingest', original, '--origin-url', 'https://example.com/doc', '--origin-id', 'PAGE-7']);
    expect(updated.code).toBe(0);
    expect(updated.json.data).toMatchObject({ status: 'duplicate', updated: true });
    // ONLY the supplied keys were overwritten — `system` survives untouched.
    expect(await metadataOf(id)).toMatchObject({
      origin: { system: 'notion', externalId: 'PAGE-7', url: 'https://example.com/doc' },
    });
  });

  it('a duplicate carrying a title change reports updated:true and keeps the extraction block', async () => {
    const original = write('report.pdf', BINARY);
    const side = write('report.extracted.md', TRANSCRIPT);
    const first = await runIo(['ingest', original, '--text-from', side]);
    const id = first.json.data!.sourceId as string;

    const renamed = await runIo(['ingest', original, '--title', 'Renamed report']);
    expect(renamed.json.data).toMatchObject({ status: 'duplicate', updated: true, title: 'Renamed report' });
    expect((await metadataOf(id)).extraction).toMatchObject({ method: 'agent-transcription/1' });
  });

  it('a duplicate attempting to CHANGE the extraction block is rejected (immutable after first write)', async () => {
    const original = write('report.pdf', BINARY);
    await runIo(['ingest', original, '--text-from', write('report.extracted.md', TRANSCRIPT)]);
    const attempt = await runIo([
      'ingest',
      original,
      '--text-from',
      write('report.extracted.md', TRANSCRIPT),
      '--extractor',
      'pdf-text/3',
    ]);
    expect(attempt.code).toBe(1);
    expect(attempt.json.issues.some((i) => i.code === 'INVALID_ARGUMENT')).toBe(true);
  });

  it('records verification none by default and visual only when stated', async () => {
    const side = write('report.extracted.md', TRANSCRIPT);
    const byDefault = await runIo(['ingest', write('a.pdf', BINARY), '--text-from', side]);
    expect((await metadataOf(byDefault.json.data!.sourceId as string)).extraction).toMatchObject({ verification: 'none' });

    const stated = await runIo(['ingest', write('b.pdf', Buffer.concat([BINARY, Buffer.from([0x42])])), '--text-from', side, '--verification', 'visual']);
    expect((await metadataOf(stated.json.data!.sourceId as string)).extraction).toMatchObject({ verification: 'visual' });
    expect(stated.json.data!.text).toMatchObject({ verification: 'visual' });
  });
});

describe('06 §2 origin surfacing', () => {
  it('source show and source list expose origin.system and origin.url', async () => {
    const first = await runIo([
      'ingest',
      write('report.pdf', BINARY),
      '--text-from',
      write('report.extracted.md', TRANSCRIPT),
      '--origin-system',
      'github',
      '--origin-url',
      'https://github.com/acme/repo/issues/12',
    ]);
    const id = first.json.data!.sourceId as string;

    const show = await runIo(['source', 'show', id]);
    expect(show.json.data!.origin).toEqual({ system: 'github', url: 'https://github.com/acme/repo/issues/12' });

    const list = await runIo(['source', 'list']);
    const listed = (list.json.data!.sources as Array<{ id: string; origin: unknown }>).find((s) => s.id === id);
    expect(listed!.origin).toEqual({ system: 'github', url: 'https://github.com/acme/repo/issues/12' });
  });

  it('reports origin as null for a source ingested without --origin-* flags', async () => {
    const r = await runIo(['ingest', write('notes.md', DOC)]);
    const show = await runIo(['source', 'show', r.json.data!.sourceId as string]);
    expect(show.json.data!.origin).toBeNull();
    const list = await runIo(['source', 'list']);
    expect((list.json.data!.sources as Array<{ origin: unknown }>)[0]!.origin).toBeNull();
  });
});

describe('kb ingest --help (06 §1.1 format table + §1.5 recipe)', () => {
  it('renders the media format table and the --text-from recipe in input.notes', async () => {
    const r = await runIo(['ingest', '--help']);
    expect(r.code).toBe(0);
    const notes = (r.json.data as unknown as HelpSpec).input?.notes ?? [];
    const rendered = notes.join('\n');
    // The table is DERIVED from the single 06 §1.1 map, so help can never drift from policy.
    for (const line of mediaFormatTable()) expect(rendered).toContain(line);
    expect(rendered).toContain('--text-from');
  });
});
