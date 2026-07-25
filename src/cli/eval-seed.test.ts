/**
 * EVAL PREP GATE (07 §3).
 *
 * The paired old-vs-revised eval is human-driven, but everything it consumes must be
 * mechanical: the prompts are pinned verbatim, and both seeded stages are built BY
 * SCRIPT so neither variant ever starts from the other's output.
 *
 * This suite runs `scripts/eval-seed.ts` for real and asserts the properties the eval
 * depends on:
 *   - stage 2 seed = the deterministic fixture KB, untouched by the memo;
 *   - stage 3 seed = that fixture with the memo applied by script — the conflict
 *     recorded as a supersession, staleness cleared, `verify --strict` ok;
 *   - the planted open-question claim stage 3 must cite is still ACTIVE and citable;
 *   - the memo's ambiguous-quote trap really fires `QUOTE_AMBIGUOUS` (asserted by
 *     driving `claim apply --dry-run` with the bare repeated sentence, not by reading
 *     the memo text).
 *
 * The seeds are not built by a private helper: `beforeAll` executes the seed commands
 * RESULTS.md tells a human to run, verbatim and in order, into one directory. That makes
 * the documented procedure itself the thing under test — a doc that forgets a reset, or a
 * stage that seeds on top of leftovers, fails before any assertion runs.
 *
 * Seeding drives the real CLI, so this is slow; it happens once per file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const KB = join(ROOT, 'bin/kb');
const EVAL = join(ROOT, 'fixtures/eval');

/** The three stage prompts, verbatim from the 07 §3 table. */
const PROMPTS: Record<string, string> = {
  'stage-1-kb-create.txt':
    'Build a knowledge base at ./eval-kb from the four documents in fixtures/corpus/sources, organized by topic.',
  'stage-2-kb-ingest.txt': 'Ingest fixtures/eval/sources/update-memo.md into ./eval-kb.',
  'stage-3-kb-query.txt': 'Answer from ./eval-kb: what open questions remain about rate limiting?',
};

/** The open-question claim stage 3's terminal check requires the answer to cite. */
const PLANTED_OPEN_QUESTION = 'clm_b818b407b87ec929';

/** The memo sentence that appears twice in one chunk — the QUOTE_AMBIGUOUS trap. */
const TRAP_QUOTE = 'The default rate limit ships at 500 requests per second';

interface Envelope {
  ok: boolean;
  data?: unknown;
  issues?: { code: string; message: string }[];
}

/** Run the real CLI against a seeded KB and parse its envelope (never throws on ok:false). */
function kb(kbDir: string, args: string[], input?: string): Envelope {
  try {
    const stdout = execFileSync(KB, [...args, '--json'], {
      env: { ...process.env, KB_DIR: kbDir },
      ...(input !== undefined ? { input } : {}),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout) as Envelope;
  } catch (e) {
    const err = e as { stdout?: string };
    return JSON.parse(String(err.stdout ?? '{"ok":false}')) as Envelope;
  }
}

/** The runnable lines of a markdown doc — what a human would actually copy and paste. */
function fencedLines(md: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of md.split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence && raw.trim()) lines.push(raw.trim());
  }
  return lines;
}

/** The seed commands RESULTS.md tells a human to run, in the documented order. */
function documentedSeedCommands(): string[] {
  const results = readFileSync(join(EVAL, 'RESULTS.md'), 'utf8');
  return fencedLines(results).filter((line) => /eval-seed\.ts stage[123]\b/.test(line));
}

describe('eval prep (07 §3)', () => {
  let commands: string[] = [];
  let stage2 = '';
  let stage3 = '';

  /**
   * The eval is human-driven, so RESULTS.md IS the procedure — and the way to know it
   * works is to run it. Every seed below is produced by executing the documented lines
   * verbatim, in the documented order, into ONE directory: exactly what a human types.
   * A stage that silently seeded on top of the previous one (or a doc that forgot the
   * reset) fails here before a single assertion runs.
   */
  beforeAll(() => {
    commands = documentedSeedCommands();
    const work = mkdtempSync(join(tmpdir(), 'kb-eval-run-'));
    for (const line of commands) {
      execFileSync('/bin/sh', ['-c', line.split('./eval-kb').join(work)], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      // Keep the stage-2 seed before the next line resets the directory.
      if (/stage2\b/.test(line)) {
        stage2 = mkdtempSync(join(tmpdir(), 'kb-eval-stage2-'));
        cpSync(work, stage2, { recursive: true });
      }
    }
    stage3 = work;
  }, 600_000);

  afterAll(() => {
    for (const dir of [stage2, stage3]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe('pinned inputs', () => {
    it.each(Object.entries(PROMPTS))('%s is the plan prompt verbatim', (file, prompt) => {
      expect(readFileSync(join(EVAL, 'prompts', file), 'utf8').trim()).toBe(prompt);
    });

    it('RESULTS.md carries the pinned-settings header, metrics, and scoring rules', () => {
      const results = readFileSync(join(EVAL, 'RESULTS.md'), 'utf8');
      expect(results).toContain('docs/plans/07 §3');
      // Pinned-settings header.
      for (const key of ['Model', 'Settings', 'Date', 'CLI version']) expect(results).toContain(key);
      // Per-run metrics.
      for (const metric of ['kb-invocation', 'payload-retry', 'terminal check']) expect(results).toContain(metric);
      // Scoring rules (§3): correctness gate first, efficiency only between passing runs.
      expect(results).toContain('Correctness gate');
      expect(results).toContain('20 %');
    });

    /**
     * RESULTS.md must never *overstate* the eval. Before any run that meant asserting an
     * "EVAL PENDING" banner; once a run lands, the durable invariant is the one that
     * banner existed to protect: the file's claim about the active-development note has
     * to match the skills on disk. Removing the note while RESULTS.md still says it is
     * retained (or vice versa) fails here.
     */
    it('RESULTS.md agrees with the skills about whether the note is still on', () => {
      const results = readFileSync(join(EVAL, 'RESULTS.md'), 'utf8');
      // Format-agnostic: find the status line, then read its polarity. Matching a
      // specific bold/punctuation layout would make this pass for the wrong reason.
      const statusLine =
        results.split('\n').find((l) => /Active-development note removed/i.test(l)) ?? '';
      expect(statusLine, 'RESULTS.md must state whether the note was removed').not.toBe('');
      const claimsRemoved = !/\bno\b|retained/i.test(statusLine);
      const noteOnDisk = ['kb-create', 'kb-ingest', 'kb-query'].some((skill) =>
        readFileSync(join(ROOT, '.claude/skills', skill, 'SKILL.md'), 'utf8').includes(
          '<note>Skill in active development',
        ),
      );
      expect(
        claimsRemoved,
        noteOnDisk
          ? 'RESULTS.md says the note was removed, but it is still in the skills'
          : 'the note is gone from the skills, but RESULTS.md still says it is retained',
      ).toBe(!noteOnDisk);
    });

    it('documents a seed procedure that is executable as written', () => {
      // `beforeAll` already ran these lines verbatim into one directory; getting here at
      // all means the documented sequence works. What is left to pin is its shape.
      expect(commands.map((line) => (/stage([123])/.exec(line) ?? [])[1])).toEqual(['1', '2', '3']);
      const withoutReset = commands.filter((line) => !line.includes('rm -rf'));
      expect(withoutReset, 'every documented seed line must reset its target first').toEqual([]);
    });

    it('tells the human to rebuild the seed before every paired run', () => {
      const results = readFileSync(join(EVAL, 'RESULTS.md'), 'utf8');
      expect(results).toMatch(/rebuild the seed/i);
      // 3 stages x 2 variants, each from its own fresh seed.
      expect(results).toContain('six runs');
    });

    it('the skills keep the active-development note until the eval passes', () => {
      for (const skill of ['kb-create', 'kb-ingest', 'kb-query']) {
        const text = readFileSync(join(ROOT, '.claude/skills', skill, 'SKILL.md'), 'utf8');
        expect(text).toContain('<note>Skill in active development');
      }
    });
  });

  describe('stage 2 seed', () => {
    it('is the fixture KB, with the memo NOT applied', () => {
      const sources = kb(stage2, ['source', 'list']);
      expect(sources.ok).toBe(true);
      const titles = (sources.data as { sources: { title: string }[] }).sources.map((s) => s.title);
      expect(titles).toHaveLength(4);
      expect(titles.some((t) => /memo/i.test(t))).toBe(false);
      expect(kb(stage2, ['verify', '--strict']).ok).toBe(true);
    });
  });

  describe('stage 3 seed', () => {
    it('applies the memo by script and stays verify --strict clean', () => {
      const sources = kb(stage3, ['source', 'list']);
      const titles = (sources.data as { sources: { title: string }[] }).sources.map((s) => s.title);
      expect(titles).toHaveLength(5);
      expect(titles.some((t) => /memo/i.test(t))).toBe(true);
      expect(kb(stage3, ['verify', '--strict']).ok, 'stage 3 must start from a clean KB').toBe(true);
    });

    it('records the memo conflict as a supersession of the 1000 rps decision', () => {
      const ctx = kb(stage3, ['node', 'show', 'nod_23b022cb91d8fa3b', '--context']);
      const bundle = ctx.data as { claims: { id: string; text: string; status: string }[] };
      // The superseded claim leaves the citable bundle; the memo's 500 rps claim is in it.
      expect(bundle.claims.some((c) => /1000 requests per second/.test(c.text))).toBe(false);
      expect(bundle.claims.some((c) => /500 requests per second/.test(c.text) && c.status === 'active')).toBe(true);
    });

    it('keeps the planted open-question claim active and citable', () => {
      const prov = kb(stage3, ['provenance', PLANTED_OPEN_QUESTION]);
      expect(prov.ok).toBe(true);
      expect((prov.data as { claim: { status: string } }).claim.status).toBe('active');
      const check = kb(
        stage3,
        ['answer-check', '--file', '-'],
        JSON.stringify({ answer: `Burst credit roll-over is unresolved.[^${PLANTED_OPEN_QUESTION}]` }),
      );
      expect(check.ok, 'the stage 3 terminal check must be reachable').toBe(true);
    });

    it('plants an ambiguous-quote trap that really fires QUOTE_AMBIGUOUS', () => {
      const list = kb(stage3, ['source', 'list']);
      const memo = (list.data as { sources: { id: string; title: string }[] }).sources.find((s) => /memo/i.test(s.title));
      expect(memo).toBeDefined();
      const chunks = (kb(stage3, ['source', 'chunks', memo!.id]).data as { chunks: { id: string; text: string }[] }).chunks;
      const trapChunk = chunks.find((c) => c.text.split(TRAP_QUOTE).length - 1 >= 2);
      expect(trapChunk, 'the trap sentence must repeat inside ONE chunk').toBeDefined();

      const payload = {
        source_id: memo!.id,
        claims: [
          {
            node_id: 'nod_23b022cb91d8fa3b',
            text: 'The default rate limit ships at 500 requests per second.',
            claim_type: 'fact',
            spans: [{ chunk_id: trapChunk!.id, quote: TRAP_QUOTE }],
          },
        ],
      };
      const dry = kb(stage3, ['claim', 'apply', '--file', '-', '--dry-run'], JSON.stringify(payload));
      expect(dry.ok).toBe(false);
      expect(dry.issues?.map((i) => i.code)).toContain('QUOTE_AMBIGUOUS');
    });
  });
});
