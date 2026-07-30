import { describe, it, expect } from 'vitest';
import { success, result, emit, type Issue, type Envelope, type OutputStreams } from './output.js';

/**
 * ENVELOPE V2 unit contract. The `success()`/`result()` constructors are the ONLY
 * way to build an envelope (§2). `errors`/`warnings` are derived from `issues`
 * inside the constructors, and the load-bearing invariant
 * `ok === !issues.some(i => i.severity === 'error')` must hold for every envelope.
 */

const err = (message: string): Issue => ({ code: 'X_ERR', severity: 'error', message });
const warn = (message: string): Issue => ({ code: 'X_WARN', severity: 'warning', message });
const info = (message: string): Issue => ({ code: 'X_INFO', severity: 'info', message });

/** The invariant every emitted envelope must satisfy. */
function invariant(env: Envelope<unknown>): boolean {
  return env.ok === !env.issues.some((i) => i.severity === 'error');
}

describe('envelope v2 constructors', () => {
  it('result() derives ok from error-severity issues (ok-invariant)', () => {
    expect(invariant(result({}, []))).toBe(true);
    expect(result({}, []).ok).toBe(true);

    const withError = result(null, [err('boom')]);
    expect(withError.ok).toBe(false);
    expect(invariant(withError)).toBe(true);

    const withWarn = result({}, [warn('careful')]);
    expect(withWarn.ok).toBe(true);
    expect(invariant(withWarn)).toBe(true);
  });

  it('derives errors/warnings arrays from issue messages, in order', () => {
    const env = result(null, [warn('w1'), err('e1'), info('i1'), err('e2'), warn('w2')]);
    expect(env.errors).toEqual(['e1', 'e2']);
    expect(env.warnings).toEqual(['w1', 'w2']);
    expect(invariant(env)).toBe(true);
  });

  it('info issues never affect ok', () => {
    const env = result({ n: 1 }, [info('fyi'), info('also')]);
    expect(env.ok).toBe(true);
    expect(env.errors).toEqual([]);
    expect(env.warnings).toEqual([]);
    expect(invariant(env)).toBe(true);
  });

  it('success() forces ok true and carries warnings/info', () => {
    const env = success({ n: 1 }, { issues: [warn('careful'), info('fyi')] });
    expect(env.ok).toBe(true);
    expect(env.warnings).toEqual(['careful']);
    expect(invariant(env)).toBe(true);
  });

  it('success() throws when given an error-severity issue (programming error)', () => {
    expect(() => success({ n: 1 }, { issues: [err('should not happen')] })).toThrow(/error-severity/i);
  });

  it('failures may carry non-null data (result keeps its report on failure)', () => {
    const env = result({ report: true }, [err('bad')]);
    expect(env.ok).toBe(false);
    expect(env.data).toEqual({ report: true });
    expect(invariant(env)).toBe(true);
  });

  it('carries nextActions and hints through both constructors', () => {
    const na = [{ title: 'do it', command: 'kb verify --json' }];
    expect(success({}, { nextActions: na, hints: ['tip'] }).nextActions).toEqual(na);
    expect(result(null, [err('x')], { hints: ['tip'] }).hints).toEqual(['tip']);
  });

  it('carries instruction only when explicitly set', () => {
    const absent = success({});
    expect('instruction' in absent).toBe(false);

    const present = success({}, { instruction: 'Review this before continuing.' });
    expect(present.instruction).toBe('Review this before continuing.');
    expect(JSON.parse(JSON.stringify(present)).instruction).toBe(
      'Review this before continuing.',
    );
  });
});

describe('emit', () => {
  function capture(env: Envelope<unknown>, json: boolean): { stdout: string; stderr: string } {
    const cap = { stdout: '', stderr: '' };
    const out: OutputStreams = { stdout: (c) => (cap.stdout += c), stderr: (c) => (cap.stderr += c) };
    emit(env, json, out);
    return cap;
  }

  it('renders the whole envelope as JSON in --json mode', () => {
    const env = result({ n: 1 }, [warn('careful')]);
    const { stdout } = capture(env, true);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { n: 1 }, issues: [{ code: 'X_WARN' }] });
  });

  it('renders issues with glyph + code + hint on stderr, data + next/tip on stdout', () => {
    const env = result(
      { n: 1 },
      [{ code: 'X_WARN', severity: 'warning', message: 'careful', hint: 'do less' }],
      { nextActions: [{ title: 'run verify', command: 'kb verify --json' }], hints: ['a tip'] },
    );
    const { stdout, stderr } = capture(env, false);
    expect(stderr).toContain('! [X_WARN] careful');
    expect(stderr).toContain('↳ do less');
    expect(stdout).toContain('next:');
    expect(stdout).toContain('kb verify --json');
    expect(stdout).toContain('tip: a tip');
  });

  it('renders one instruction line after diagnostics and before hints', () => {
    const events: string[] = [];
    const out: OutputStreams = {
      stdout: (chunk) => events.push(`stdout:${chunk.trim()}`),
      stderr: (chunk) => events.push(`stderr:${chunk.trim()}`),
    };
    emit(
      result({}, [warn('careful')], {
        instruction: 'Review candidates.',
        hints: ['a tip'],
      }),
      false,
      out,
    );

    expect(events.findIndex((event) => event.includes('[X_WARN] careful'))).toBeLessThan(
      events.findIndex((event) => event === 'stdout:instruction: Review candidates.'),
    );
    expect(
      events.findIndex((event) => event === 'stdout:instruction: Review candidates.'),
    ).toBeLessThan(events.findIndex((event) => event === 'stdout:tip: a tip'));
  });
});
