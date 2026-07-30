import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from './runCli.js';

interface ChunkRow {
  id: string;
  chunkIndex: number;
  headingPath: string;
  text: string;
  contentKind: 'structural' | 'substantive';
}

let kb: string;

async function run(args: string[]) {
  let stdout = '';
  const io: CliIo = {
    stdout: (chunk) => (stdout += chunk),
    stderr: () => {},
    cwd: kb,
    env: { KB_DIR: kb },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(stdout || '{}') as { ok: boolean; data: unknown } };
}

describe('kb source chunks contentKind', () => {
  let sourceId: string;

  beforeAll(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-source-chunks-'));
    await run(['init', kb]);
    const documentPath = join(kb, 'chunk-kinds.md');
    writeFileSync(
      documentPath,
      ['# Structural', '## Heading only', '# Substantive', 'This paragraph contains knowledge.'].join('\n'),
    );
    const ingested = await run(['ingest', documentPath]);
    sourceId = (ingested.json.data as { sourceId: string }).sourceId;
  });

  afterAll(() => rmSync(kb, { recursive: true, force: true }));

  it('classifies every chunk through the real JSON CLI', async () => {
    const response = await run(['source', 'chunks', sourceId]);
    expect(response.code).toBe(0);
    expect(response.json.ok).toBe(true);
    const chunks = (response.json.data as { chunks: ChunkRow[] }).chunks;

    expect(chunks.find((chunk) => chunk.text.trim() === '# Structural')?.contentKind).toBe('structural');
    expect(chunks.find((chunk) => chunk.text.trim() === '## Heading only')?.contentKind).toBe('structural');
    expect(chunks.find((chunk) => chunk.text.includes('This paragraph'))?.contentKind).toBe('substantive');
    expect(chunks.every((chunk) => chunk.contentKind !== undefined)).toBe(true);
  });

  it('documents contentKind and the structural-chunk extraction rule in registered help', async () => {
    const response = await run(['source', 'chunks', '--help']);
    expect(response.code).toBe(0);
    const help = response.json.data as { summary: string; output: string[] };
    expect(help.output.join(' ')).toContain('contentKind');
    expect(`${help.summary} ${help.output.join(' ')}`).toContain(
      "contentKind 'structural' (heading-only) need no claim extraction",
    );
  });
});
