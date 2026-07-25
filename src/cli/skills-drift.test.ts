/**
 * SKILL DRIFT GUARD (07 §4).
 *
 * The three skills are thin orchestrators over the CLI: payload shapes come from
 * `kb <cmd> --help --json` (`input.example`), never from a schema copied into the
 * skill text. A copied schema is the drift that this suite exists to prevent — it
 * goes stale silently the moment a payload field changes.
 *
 * The guard is deliberately a grep, not a parser: any `"claims"` / `"relationships"`
 * / `"nodes"` JSON key anywhere in a skill file fails, whether or not it sits in a
 * fenced block. The pinned baselines under `fixtures/eval/skills-v0/` are the OLD
 * skill texts and are exempt by construction — only `.claude/skills/` is scanned.
 *
 * It also pins the parts of 07 §1 that are contract, not prose: the six stage names,
 * a recovery table keyed by REGISTERED issue codes (an invented code is a bug), and
 * the exact five-command `--dry-run` scope (01 §6.2 — never "everywhere").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_CODES } from './issues.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SKILLS = ['kb-create', 'kb-ingest', 'kb-query'] as const;

/** The six stages of the shared skeleton (07 §1). */
const STAGES = ['preflight', 'discover', 'preview', 'apply', 'resume', 'finish'] as const;

/**
 * Recovery rows every skill carries, keyed by issue code (07 §1). This is the WHOLE
 * shared table, not the subset each skill happens to need — a skill that drops a row
 * silently loses a recovery path the moment the agent hits that code.
 */
const REQUIRED_CODES = [
  'QUOTE_AMBIGUOUS',
  'QUOTE_NOT_FOUND',
  'CITATION_OUT_OF_SUBTREE',
  'CITATION_INACTIVE',
  'NODE_TITLE_MISMATCH',
  'NODE_KIND_MISMATCH',
  'UNSUPPORTED_MEDIA',
  'INVALID_ARGUMENT',
  'PAYLOAD_SCHEMA',
] as const;

/** The exact commands that accept `--dry-run` (01 §6.2). */
const DRY_RUN_COMMANDS = ['ingest', 'node apply', 'claim apply', 'graph apply', 'synthesize'] as const;

/** A JSON payload key that must not be pasted into a skill. */
const PAYLOAD_KEY = /"(claims|relationships|nodes)"\s*:/;

/** Backticked SHOUTY tokens that are environment, not issue codes. */
const NOT_A_CODE = new Set(['KB_DIR']);

function skillText(name: string): string {
  return readFileSync(join(ROOT, '.claude/skills', name, 'SKILL.md'), 'utf8');
}

/**
 * The command lines inside fenced blocks — i.e. what the skill tells the agent to RUN,
 * as opposed to prose that merely names a command (the five-command scope sentence).
 */
function fencedLines(md: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of md.split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) lines.push(raw.trim());
  }
  return lines;
}

describe('skill drift guard (07 §4)', () => {
  describe.each(SKILLS)('%s', (skill) => {
    const text = skillText(skill);
    const lines = text.split('\n');

    it('embeds no payload schema (claims / relationships / nodes JSON keys)', () => {
      const offenders = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => PAYLOAD_KEY.test(line))
        .map(({ line, n }) => `.claude/skills/${skill}/SKILL.md:${n}: ${line.trim()}`);
      expect(offenders, 'payload shapes belong in `kb <cmd> --help --json`, not the skill').toEqual([]);
    });

    it('names all six skeleton stages', () => {
      const missing = STAGES.filter((stage) => !new RegExp(`\\b${stage}\\b`, 'i').test(text));
      expect(missing).toEqual([]);
    });

    it('carries the issue-code recovery table', () => {
      const missing = REQUIRED_CODES.filter((code) => !text.includes(code));
      expect(missing).toEqual([]);
    });

    it('cites only registered issue codes', () => {
      const registered = new Set<string>(ISSUE_CODES);
      const cited = new Set(
        [...text.matchAll(/`([A-Z][A-Z_]{3,})`/g)]
          .map((m) => m[1] as string)
          .filter((token) => !NOT_A_CODE.has(token)),
      );
      const unregistered = [...cited].filter((code) => !registered.has(code)).sort();
      expect(unregistered, 'every SHOUTY backticked token must be a registered issue code').toEqual([]);
    });

    it('scopes --dry-run to the exact five commands, never "everywhere"', () => {
      expect(text, 'no skill may claim dry-run applies everywhere').not.toMatch(/dry[- ]?run\s+everywhere/i);
      if (!text.includes('--dry-run')) return;
      // The scope statement is prose and wraps, so match it on the unwrapped text.
      const unwrapped = text.replace(/\s+/g, ' ');
      const at = unwrapped.indexOf('exactly five commands');
      expect(at, 'a skill that uses --dry-run must state the five-command scope').toBeGreaterThan(-1);
      const sentence = unwrapped.slice(at, at + 220);
      const missing = DRY_RUN_COMMANDS.filter((cmd) => !sentence.includes(cmd));
      expect(missing).toEqual([]);
    });

    it('previews every mutating command it invokes before applying it', () => {
      // The preview/apply contract is only real if the WORKED EXAMPLES honour it: a skill
      // that shows `kb ingest … --json` with no `--dry-run` anywhere teaches the apply.
      // `--help` reads a contract; it mutates nothing and needs no preview.
      const invocations = fencedLines(text).filter((line) => !line.includes('--help'));
      const unpreviewed = DRY_RUN_COMMANDS.filter((cmd) => {
        const calls = invocations.filter((line) => line.startsWith(`kb ${cmd} `) || line === `kb ${cmd}`);
        if (calls.length === 0) return false; // the skill never invokes it — nothing to preview
        return !calls.some((line) => line.includes('--dry-run'));
      });
      expect(unpreviewed, 'each of these is invoked but never shown with --dry-run').toEqual([]);
    });

    it('keeps the active-development note until the 07 §3 eval passes', () => {
      expect(text).toContain('<note>Skill in active development');
    });
  });
});
