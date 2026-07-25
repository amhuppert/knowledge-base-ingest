import { describe, it, expect } from 'vitest';
import { answerCheckIssues } from './query.js';
import type { AnswerCheckResult } from '../../query/query.js';

/** A report with every failure kind populated, to pin the issue ordering. */
function report(overrides: Partial<AnswerCheckResult> = {}): AnswerCheckResult {
  const uncited = overrides.uncited ?? [];
  return {
    ok: false,
    citedClaims: [],
    unknownCitations: [],
    inactiveCitations: [],
    uncited,
    uncitedSentences: uncited.map((u) => u.text),
    ...overrides,
  };
}

describe('answerCheckIssues', () => {
  it('emits unknown, then inactive, then uncited — each in list order, each with a hint', () => {
    const issues = answerCheckIssues(
      report({
        unknownCitations: ['clm_a1', 'clm_a2'],
        inactiveCitations: ['clm_b1'],
        uncited: [
          { text: 'First uncited assertion here.', line: 4 },
          { text: 'Second uncited assertion there.', line: 9 },
        ],
      }),
    );

    expect(issues.map((i) => i.code)).toEqual([
      'CITATION_UNKNOWN',
      'CITATION_UNKNOWN',
      'CITATION_INACTIVE',
      'UNCITED_ASSERTION',
      'UNCITED_ASSERTION',
    ]);
    // First-occurrence order preserved within each group.
    expect(issues[0]!.ids).toEqual(['clm_a1']);
    expect(issues[1]!.ids).toEqual(['clm_a2']);
    expect(issues[2]!.ids).toEqual(['clm_b1']);
    // Uncited issues carry the line + sentence, in line order.
    expect(issues[3]!.message).toBe('line 4: "First uncited assertion here."');
    expect(issues[4]!.message).toBe('line 9: "Second uncited assertion there."');
    // Every issue is an error and carries a non-empty registry hint.
    for (const i of issues) {
      expect(i.severity).toBe('error');
      expect(i.hint).toBeTruthy();
    }
  });

  it('produces no issues for a clean report', () => {
    expect(answerCheckIssues(report({ ok: true }))).toEqual([]);
  });
});
