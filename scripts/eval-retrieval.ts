/**
 * eval-retrieval — run fixtures/retrieval/queries.json against the fixture KB and
 * report, per case, the CURRENT retrieval behavior: matchMode, recall@k, and whether
 * the query returned zero results. This documents the pre-fix baseline — natural-
 * language questions returning zero hits under the static AND join is EXPECTED here.
 * Phase 3 (05 §3) hardens this into a gate once the AND->OR fallback lands.
 *
 * Usage: tsx scripts/eval-retrieval.ts   (KB_FIXTURE_CORPUS overrides corpus)
 * Prints a human table and a machine-readable JSON summary on the last line.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../src/kb/workspace.js';
import { search } from '../src/query/query.js';
import { assembleFixtureKb, counterClock, readCorpusJson } from './fixtureKb.js';

interface Case {
  id: string;
  type: string;
  query: string;
  expectAnyOf: string[];
}
interface Queries {
  scope: 'chunks' | 'claims' | 'nodes' | 'entities' | 'all';
  k: number;
  cases: Case[];
}

// The claims scope currently joins query tokens with AND (query.ts `ftsMatch`
// default) with no OR fallback — that static mode is exactly what Phase 3 changes.
const CURRENT_MATCH_MODE = 'and';

const spec = readCorpusJson<Queries>('../retrieval/queries.json');
const root = mkdtempSync(join(tmpdir(), 'kb-eval-'));
const { ws } = initWorkspace(root, counterClock());

interface Row {
  id: string;
  type: string;
  matchMode: string;
  hits: number;
  recallAtK: number;
  zeroResults: boolean;
  found: string[];
}

const rows: Row[] = [];
try {
  assembleFixtureKb(ws);
  for (const c of spec.cases) {
    const hits = search(ws.repos, c.query, { scope: spec.scope, limit: spec.k });
    const ids = hits.map((h) => h.id);
    const found = c.expectAnyOf.filter((id) => ids.includes(id));
    rows.push({
      id: c.id,
      type: c.type,
      matchMode: CURRENT_MATCH_MODE,
      hits: ids.length,
      recallAtK: found.length / c.expectAnyOf.length,
      zeroResults: ids.length === 0,
      found,
    });
  }
} finally {
  ws.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`Retrieval eval — scope=${spec.scope} k=${spec.k} (CURRENT behavior; zero results are expected pre-fix)\n`);
console.log('case      type              matchMode  hits  recall@k  zeroResults');
console.log('--------  ----------------  ---------  ----  --------  -----------');
for (const r of rows) {
  console.log(
    `${r.id.padEnd(8)}  ${r.type.padEnd(16)}  ${r.matchMode.padEnd(9)}  ${String(r.hits).padStart(4)}  ${r.recallAtK.toFixed(2).padStart(8)}  ${String(r.zeroResults).padStart(11)}`,
  );
}
const meanRecall = rows.reduce((s, r) => s + r.recallAtK, 0) / rows.length;
const zeroCount = rows.filter((r) => r.zeroResults).length;
console.log(`\nmean recall@${spec.k} = ${meanRecall.toFixed(2)} · zero-result cases = ${zeroCount}/${rows.length}`);
console.log('JSON ' + JSON.stringify({ scope: spec.scope, k: spec.k, meanRecall, zeroResults: zeroCount, cases: rows }));
