import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../kb/workspace.js';
import { search, askContext } from './query.js';
import { assembleFixtureKb, counterClock, readCorpusJson } from '../../scripts/fixtureKb.js';

/**
 * PHASE 3 RETRIEVAL HARD GATE (05 §3, finding 30).
 *
 * Converts the pre-fix baseline in scripts/eval-retrieval.ts into an enforced
 * gate: build the deterministic fixture KB, run every fixtures/retrieval/queries.json
 * case through the NEW `auto` search path (strict AND per scope, OR fallback only
 * where AND found nothing), and require
 *   - ≥7/8 cases return an expected claim in the top 5, AND
 *   - ≤1 case is a false zero-result (an expected-answerable query returning nothing).
 * A regression that reintroduces the recall-hostile static-AND default fails here.
 */

interface Case {
  id: string;
  type: string;
  query: string;
  expectAnyOf: string[];
}
/**
 * A CATEGORY case (eval run 1, finding 1): the caller wants "every claim of type X",
 * so the question deliberately shares no vocabulary with the claim texts. These run
 * through `askContext` with a `--claim-type` selector, not `search()`, and are kept
 * out of `cases` so the 7/8 recall-gate arithmetic above is unchanged.
 */
interface CategoryCase {
  id: string;
  claimType: string;
  query: string;
  /** EVERY claim of that type must come back — a category answer is not a ranking. */
  expectAll: string[];
}

interface Queries {
  scope: 'chunks' | 'claims' | 'nodes' | 'entities' | 'all';
  k: number;
  cases: Case[];
  categoryCases: CategoryCase[];
}

const spec = readCorpusJson<Queries>('../retrieval/queries.json');

interface CaseResult {
  id: string;
  /** An expected claim id appears in this case's top-k hits. */
  hit: boolean;
  /** The auto path returned no hits at all — a false zero for an answerable query. */
  zeroResult: boolean;
  topIds: string[];
}

let ws: Workspace;
let root: string;
let results: CaseResult[];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-retrieval-gate-'));
  ws = initWorkspace(root, counterClock()).ws;
  assembleFixtureKb(ws);

  results = spec.cases.map((c) => {
    // The gate exercises the DEFAULT recall path explicitly (05 §3): auto = strict
    // AND per scope with an OR fallback for any scope that found nothing.
    const { hits } = search(ws.repos, c.query, { scope: spec.scope, limit: spec.k, match: 'auto' });
    const topIds = hits.slice(0, spec.k).map((h) => h.id);
    return {
      id: c.id,
      hit: c.expectAnyOf.some((id) => topIds.includes(id)),
      zeroResult: hits.length === 0,
      topIds,
    };
  });
});

afterAll(() => {
  ws?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('retrieval fixture gate (05 §3)', () => {
  it(`returns an expected claim in the top ${spec.k} for ≥7/8 cases`, () => {
    const recallHits = results.filter((r) => r.hit).length;
    // Report every miss so a failure names the offending case, not just a count.
    const misses = results.filter((r) => !r.hit).map((r) => `${r.id} → [${r.topIds.join(', ')}]`);
    expect(recallHits, `misses: ${misses.join('; ')}`).toBeGreaterThanOrEqual(7);
  });

  it('produces at most one false zero-result across the 8 cases', () => {
    const zeros = results.filter((r) => r.zeroResult).map((r) => r.id);
    expect(zeros.length, `zero-result cases: ${zeros.join(', ')}`).toBeLessThanOrEqual(1);
  });

  it('runs the full fixtures/retrieval/queries.json suite (all 8 cases)', () => {
    expect(spec.scope).toBe('claims');
    expect(spec.k).toBe(5);
    expect(results).toHaveLength(8);
  });
});

/**
 * CATEGORY-QUERY GATE (eval run 1, finding 1).
 *
 * The 8-case gate above measures term-matching recall, which is why it stayed green
 * while category retrieval was broken: `--claim-type` could only narrow FTS hits, so
 * "what open questions remain" returned 1 of 4 on one phrasing and 0 on another. This
 * block closes that coverage gap — the class is now gated, not just fixed.
 */
describe('retrieval fixture — category queries (askContext selector)', () => {
  it.each(spec.categoryCases.map((c) => [c.id, c] as const))(
    '%s returns the whole category regardless of question vocabulary',
    (_id, c) => {
      const res = askContext(ws.repos, c.query, { claimType: c.claimType, limit: 20 });
      const ids = res.claims.map((cl) => cl.id).sort();
      expect(ids).toEqual([...c.expectAll].sort());
    },
  );

  it('keeps term matches ranked FIRST while completing the category', () => {
    // The selector must not flatten relevance: a question whose terms match exactly one
    // member of the category should still lead with that member, then complete the set.
    // (This is the 1-of-4 case from the eval — partial coverage, not zero.)
    const res = askContext(ws.repos, 'burst credits roll over between windows', {
      claimType: 'open_question',
      limit: 20,
    });
    expect(res.claims[0]!.id).toBe('clm_b818b407b87ec929');
    expect(res.claims.map((c) => c.id).sort()).toEqual(
      ['clm_b818b407b87ec929', 'clm_cd88de4eb8add55a'].sort(),
    );
    // Augmented, not a pure ranking — the label has to say so.
    expect(res.retrieval).toBe('filter-fallback');
  });

  it('reports `fts` when term matching already covers the whole category', () => {
    // Build a query out of the category's OWN claim texts, so every member term-matches
    // (askContext OR-joins). Nothing is left to complete, so the result is a pure
    // ranking and must NOT be labelled a fallback. Deterministic — no conditional
    // assertion that could silently never run.
    const category = 'open_question';
    const members = spec.categoryCases[0]!.expectAll;
    const query = members
      .map((id) => ws.repos.claims.getById(id as Parameters<typeof ws.repos.claims.getById>[0])!.text)
      .join(' ');
    const res = askContext(ws.repos, query, { claimType: category, limit: 20 });
    expect(res.claims.map((c) => c.id).sort()).toEqual([...members].sort());
    expect(res.retrieval).toBe('fts');
  });

  it('never invents claims: an empty category stays empty', () => {
    const res = askContext(ws.repos, 'anything at all', { claimType: 'warning', limit: 20 });
    expect(res.claims).toEqual([]);
    expect(res.retrieval).toBe('fts');
  });
});
