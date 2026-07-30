/**
 * COMMAND-DOCS GENERATOR GATE (07 §4).
 *
 * `docs/USER_GUIDE.md`'s CLI reference is generated FROM THE CLI: the generator shells
 * out to `./bin/kb --help --json` for the command list and `./bin/kb <cmd> --help --json`
 * for each contract, then rewrites only the marker-delimited block. That makes the tool
 * the single source of truth and makes doc drift a test failure instead of a surprise.
 *
 * Three properties matter and are asserted by running the real generator:
 *   - idempotent: a second run produces no diff;
 *   - surgical: everything outside the markers survives verbatim, and a corrupted block
 *     is restored;
 *   - complete: every command the CLI advertises is documented.
 *
 * The suite writes to the real `docs/USER_GUIDE.md` (that is what it is testing) and
 * restores the on-disk content afterwards, so a failure cannot leave the file dirty.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const GENERATOR = join(ROOT, 'scripts/gen-command-docs.mjs');
const GUIDE = join(ROOT, 'docs/USER_GUIDE.md');
const KB = join(ROOT, 'bin/kb');
const START = '<!-- generated:commands:start -->';
const END = '<!-- generated:commands:end -->';

function generate(): void {
  execFileSync(process.execPath, [GENERATOR], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function guide(): string {
  return readFileSync(GUIDE, 'utf8');
}

function block(text: string): string {
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  expect(from, 'the start marker must exist').toBeGreaterThan(-1);
  expect(to, 'the end marker must exist').toBeGreaterThan(from);
  return text.slice(from + START.length, to);
}

describe('gen-command-docs (07 §4)', () => {
  let committed = '';
  let generated = '';

  beforeAll(() => {
    committed = guide();
    generate();
    generated = guide();
  }, 300_000);

  afterAll(() => {
    // Guard: if `beforeAll` died before reading the guide, restoring "" would delete it.
    if (committed) writeFileSync(GUIDE, committed);
  });

  it('leaves the committed USER_GUIDE up to date (regenerating changes nothing)', () => {
    expect(generated).toBe(committed);
  });

  it('is idempotent — a second run produces no diff', () => {
    generate();
    expect(guide()).toBe(generated);
  });

  it('rewrites only the marker block, restoring a corrupted one', () => {
    const text = guide();
    const from = text.indexOf(START) + START.length;
    const to = text.indexOf(END);
    writeFileSync(GUIDE, `${text.slice(0, from)}\n\nJUNK — this block was clobbered.\n\n${text.slice(to)}`);
    generate();
    const restored = guide();
    expect(restored).not.toContain('JUNK');
    expect(restored).toBe(generated);
    // Prose outside the markers is human-owned and untouched.
    expect(restored.slice(0, restored.indexOf(START))).toBe(generated.slice(0, generated.indexOf(START)));
    expect(restored.slice(restored.indexOf(END))).toBe(generated.slice(generated.indexOf(END)));
  });

  it('documents every command the CLI advertises', () => {
    const help = JSON.parse(execFileSync(KB, ['--help', '--json'], { encoding: 'utf8' })) as {
      data: { commands: string[] };
    };
    const body = block(generated);
    const missing = help.data.commands.filter((cmd) => !body.includes(`kb ${cmd}`));
    expect(missing).toEqual([]);
  });

  it('keeps the hand-authored synthesize payload aligned with the required body hash contract', () => {
    const manualStart = generated.indexOf('### `synthesize`', generated.indexOf(END));
    const manualEnd = generated.indexOf('### `answer-check`', manualStart);
    const manual = generated.slice(manualStart, manualEnd);

    expect(manual).toContain('"expected_body_hash"');
    expect(manual).toContain('kb node show <node_id> --context --json');
    expect(manual).toContain('bodyHash');
  });
});
