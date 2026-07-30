import { extractCitations } from '../algorithms/citations.js';

export interface BodyDelta {
  charsBefore: number;
  charsAfter: number;
  citationsAdded: string[];
  citationsRemoved: string[];
  removedCurrent: string[];
}

export function computeBodyDelta(
  oldBody: string,
  newBody: string,
  isCurrent: (claimId: string) => boolean,
): BodyDelta {
  const before = extractCitations(oldBody);
  const after = extractCitations(newBody);
  const beforeIds = new Set(before);
  const afterIds = new Set(after);
  const citationsAdded = after.filter((id) => !beforeIds.has(id));
  const citationsRemoved = before.filter((id) => !afterIds.has(id));

  return {
    charsBefore: oldBody.length,
    charsAfter: newBody.length,
    citationsAdded,
    citationsRemoved,
    removedCurrent: citationsRemoved.filter(isCurrent),
  };
}
