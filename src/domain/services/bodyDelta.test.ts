import { describe, expect, it, vi } from 'vitest';
import { computeBodyDelta } from './bodyDelta.js';

const active = new Set(['clm_aaaa', 'clm_bbbb']);

describe('computeBodyDelta', () => {
  it('reports citations added to the new body', () => {
    expect(
      computeBodyDelta('Before.[^clm_aaaa]', 'After.[^clm_aaaa][^clm_bbbb]', (id) => active.has(id)),
    ).toEqual({
      charsBefore: 18,
      charsAfter: 28,
      citationsAdded: ['clm_bbbb'],
      citationsRemoved: [],
      removedCurrent: [],
    });
  });

  it('does not classify a removed inactive citation as current', () => {
    expect(computeBodyDelta('Before.[^clm_cccc]', 'After.', (id) => active.has(id))).toEqual({
      charsBefore: 18,
      charsAfter: 6,
      citationsAdded: [],
      citationsRemoved: ['clm_cccc'],
      removedCurrent: [],
    });
  });

  it('classifies a removed active citation as current', () => {
    expect(computeBodyDelta('Before.[^clm_aaaa]', 'After.', (id) => active.has(id))).toEqual({
      charsBefore: 18,
      charsAfter: 6,
      citationsAdded: [],
      citationsRemoved: ['clm_aaaa'],
      removedCurrent: ['clm_aaaa'],
    });
  });

  it('reports no citation changes for unchanged bodies', () => {
    const body = 'Same.[^clm_aaaa]';
    const isCurrent = vi.fn(() => true);

    expect(computeBodyDelta(body, body, isCurrent)).toEqual({
      charsBefore: body.length,
      charsAfter: body.length,
      citationsAdded: [],
      citationsRemoved: [],
      removedCurrent: [],
    });
    expect(isCurrent).not.toHaveBeenCalled();
  });

  it('de-duplicates citations while preserving first-seen order', () => {
    const oldBody = 'Old.[^clm_bbbb][^clm_bbbb][^clm_aaaa]';
    const newBody = 'New.[^clm_dddd][^clm_dddd][^clm_cccc]';

    expect(computeBodyDelta(oldBody, newBody, (id) => active.has(id))).toEqual({
      charsBefore: oldBody.length,
      charsAfter: newBody.length,
      citationsAdded: ['clm_dddd', 'clm_cccc'],
      citationsRemoved: ['clm_bbbb', 'clm_aaaa'],
      removedCurrent: ['clm_bbbb', 'clm_aaaa'],
    });
  });
});
