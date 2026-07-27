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
    staleSourceCitations: [],
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

  it('appends warning-severity PROVENANCE_SOURCE_INACTIVE issues after the error blocks (Phase 5 §1.2)', () => {
    const issues = answerCheckIssues(
      report({
        ok: false,
        unknownCitations: ['clm_a1'],
        staleSourceCitations: [
          { claimId: 'clm_s1', sourceIds: ['src_old1'], successorId: 'src_new1', quoteSurvives: true },
          { claimId: 'clm_s2', sourceIds: ['src_old2'], successorId: 'src_new2', quoteSurvives: false },
          { claimId: 'clm_s3', sourceIds: ['src_old3'], successorId: null, quoteSurvives: null },
        ],
      }),
    );

    expect(issues.map((i) => i.code)).toEqual([
      'CITATION_UNKNOWN',
      'PROVENANCE_SOURCE_INACTIVE',
      'PROVENANCE_SOURCE_INACTIVE',
      'PROVENANCE_SOURCE_INACTIVE',
    ]);
    const [, survives, dated, dead] = issues;
    // Warnings, never errors: a stranded-but-verified citation must not flip ok.
    for (const i of [survives!, dated!, dead!]) {
      expect(i.severity).toBe('warning');
      expect(i.hint).toBeTruthy();
    }
    expect(survives!.ids).toEqual(['clm_s1']);
    // The dynamic hint names the concrete ids and states the survival verdict.
    expect(survives!.hint).toContain('src_new1');
    expect(survives!.hint).toContain('survive');
    expect(dated!.hint).toContain('src_new2');
    expect(dated!.hint).toContain('does not appear');
    expect(dead!.hint).toContain('no active successor');
  });

  it('emits only warnings for a stale-but-otherwise-clean report (envelope ok derives from errors)', () => {
    const issues = answerCheckIssues(
      report({
        ok: true,
        staleSourceCitations: [{ claimId: 'clm_s1', sourceIds: ['src_old1'], successorId: 'src_new1', quoteSurvives: true }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.code).toBe('PROVENANCE_SOURCE_INACTIVE');
  });
});
