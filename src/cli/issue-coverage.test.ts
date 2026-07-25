import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, type CliIo } from './runCli.js';
import { ISSUE_CODES, type IssueCode } from '../domain/issueCodes.js';
import { hintFor } from './issues.js';

/**
 * ISSUE-CODE COVERAGE (01 §3.2, 03 deliverable 6).
 *
 * Two obligations the registry carries, enforced here:
 *
 *  1. **`LEGACY` is retired.** Phase 0 wrapped every uncoded domain/workspace failure
 *     in a `LEGACY` issue to hold envelope parity while the codes were introduced.
 *     From Phase 1 on its emission is FORBIDDEN (01 §3.2) — the registry entry stays
 *     forever (charter: registry-additive), but nothing may emit it. The end-to-end
 *     cases below pin each formerly-`LEGACY` path to the registry code 01 §1.4/§2
 *     assigns it, and a source scan proves no production module can emit `LEGACY`
 *     at all.
 *  2. **Every registered code is accounted for.** Each code is either EMITTED by a
 *     named test (the file is read back, so deleting the assertion breaks this test)
 *     or explicitly RESERVED with the reason it is unreachable from a test. The two
 *     sets partition `ISSUE_CODES` exactly, so a newly registered code cannot be
 *     added without either exercising it or declaring it reserved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

interface Issue {
  code: string;
  severity: string;
  message: string;
  path?: string;
  ids?: string[];
  hint?: string;
}
interface CliResult {
  code: number;
  json: { ok: boolean; data: unknown; issues: Issue[]; errors: string[]; warnings: string[] };
}

let kb: string;
let sourceId: string;
let chunkId: string;
let nodeId: string;

/** Run the CLI against `cwdOrKb`'s KB, in-process (01 §7). */
async function runIn(kbDir: string, args: string[]): Promise<CliResult> {
  let stdout = '';
  const io: CliIo = {
    stdout: (c) => (stdout += c),
    stderr: () => {},
    cwd: kbDir,
    // KB_DIR is cleared so the resolution under test is the one the case exercises.
    env: { ...process.env, KB_DIR: kbDir },
  };
  const code = await runCli([...args, '--json'], io);
  return { code, json: JSON.parse(stdout || '{}') };
}

const run = (args: string[]): Promise<CliResult> => runIn(kb, args);

function issue(r: CliResult, code: string): Issue | undefined {
  return r.json.issues.find((i) => i.code === code);
}

let payloadN = 0;
async function applyPayload(path: string[], payload: unknown): Promise<CliResult> {
  const file = join(kb, `icov-${payloadN++}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return run([...path, '--file', file]);
}

beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-issuecov-'));
  await run(['init', kb]);
  const doc = join(kb, 'doc.md');
  writeFileSync(doc, '# Topic\n\nThe widget service caches results in Redis for speed.\n');
  const ing = await run(['ingest', doc]);
  sourceId = (ing.json.data as { sourceId: string }).sourceId;
  const chunks = await run(['source', 'chunks', sourceId]);
  chunkId = (chunks.json.data as { chunks: Array<{ id: string; text: string }> }).chunks.find((c) =>
    c.text.includes('caches results in Redis'),
  )!.id;
  const node = await run(['node', 'create', '--title', 'Topic', '--kind', 'root']);
  nodeId = (node.json.data as { nodeId: string }).nodeId;
});

afterAll(() => rmSync(kb, { recursive: true, force: true }));

describe('the Phase-0 LEGACY paths now emit their registry codes (01 §1.4, §2, §3.2)', () => {
  it('a command outside any KB → NO_KB with the registry hint (the most common agent failure)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'kb-nokb-'));
    try {
      let stdout = '';
      const io: CliIo = { stdout: (c) => (stdout += c), stderr: () => {}, cwd: empty, env: {} };
      const code = await runCli(['status', '--json'], io);
      const env = JSON.parse(stdout) as CliResult['json'];
      expect(code).toBe(1);
      const noKb = env.issues.find((i) => i.code === 'NO_KB');
      expect(noKb, `issues were ${JSON.stringify(env.issues)}`).toBeDefined();
      expect(noKb!.severity).toBe('error');
      expect(noKb!.hint).toBe(hintFor('NO_KB'));
      expect(env.issues.some((i) => i.code === 'LEGACY')).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('a doubled KB root → KB_PATH_SUSPECT at warning severity (the command still runs)', async () => {
    // `kbRootWarnings` fires on a repeated path suffix, e.g. …/a/b/a/b.
    const base = mkdtempSync(join(tmpdir(), 'kb-suspect-'));
    const doubled = join(base, 'a', 'b', 'a', 'b');
    mkdirSync(doubled, { recursive: true });
    try {
      const r = await runIn(doubled, ['init', doubled]);
      const suspect = r.json.issues.find((i) => i.code === 'KB_PATH_SUSPECT');
      expect(suspect, `issues were ${JSON.stringify(r.json.issues)}`).toBeDefined();
      expect(suspect!.severity).toBe('warning');
      expect(suspect!.hint).toBe(hintFor('KB_PATH_SUSPECT'));
      // A warning never flips ok/exit (01 §2).
      expect(r.json.ok).toBe(true);
      expect(r.code).toBe(0);

      // The same warning reaches a workspace-opening command, merged by runAction.
      const status = await runIn(doubled, ['status']);
      expect(status.json.issues.find((i) => i.code === 'KB_PATH_SUSPECT')).toBeDefined();
      expect(status.json.issues.some((i) => i.code === 'LEGACY')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  const unknownLookups: Array<[code: IssueCode, argv: string[], id: string]> = [
    ['UNKNOWN_NODE', ['node', 'show', 'nod_zzzzzz'], 'nod_zzzzzz'],
    ['UNKNOWN_SOURCE', ['source', 'show', 'src_zzzzzz'], 'src_zzzzzz'],
    ['UNKNOWN_CLAIM', ['provenance', 'clm_zzzzzz'], 'clm_zzzzzz'],
    ['UNKNOWN_ENTITY', ['entity', 'show', 'ent_zzzzzz'], 'ent_zzzzzz'],
  ];

  for (const [code, argv, id] of unknownLookups) {
    it(`kb ${argv.join(' ')} → ${code} with the registry hint and the id`, async () => {
      const r = await run(argv);
      expect(r.code).toBe(1);
      const found = issue(r, code);
      expect(found, `issues were ${JSON.stringify(r.json.issues)}`).toBeDefined();
      expect(found!.severity).toBe('error');
      expect(found!.hint).toBe(hintFor(code));
      expect(found!.ids).toEqual([id]);
      expect(issue(r, 'LEGACY')).toBeUndefined();
    });
  }

  it('a schema-invalid payload → one PAYLOAD_SCHEMA issue per Zod issue, with a formatPath path', async () => {
    const r = await applyPayload(['claim', 'apply'], {
      source_id: sourceId,
      claims: [{ node_id: nodeId, text: 'x', claim_type: 'not_a_type', spans: [] }],
    });
    expect(r.code).toBe(1);
    const schemaIssues = r.json.issues.filter((i) => i.code === 'PAYLOAD_SCHEMA');
    expect(schemaIssues.length, `issues were ${JSON.stringify(r.json.issues)}`).toBeGreaterThan(0);
    for (const i of schemaIssues) {
      expect(i.severity).toBe('error');
      expect(i.hint).toBeTruthy();
      // Canonical bracket-dot path (01 §3.1), e.g. `claims[0].claim_type`.
      expect(i.path, `path missing on ${i.message}`).toMatch(/^claims\[0\]\./);
    }
    expect(issue(r, 'LEGACY')).toBeUndefined();
  });

  it('a hand-edited rendered file → render --check emits RENDER_DRIFT naming the path', async () => {
    // `render --check` reported drift as an uncoded string; it is a real KB-state finding
    // (someone edited generated markdown), so it carries its own code, the path, and the
    // "re-render, never hand-edit" hint — and the report survives on the failure (01 §2).
    const drifted = mkdtempSync(join(tmpdir(), 'kb-drift-'));
    try {
      await runIn(drifted, ['init', drifted]);
      await runIn(drifted, ['render']);
      const index = join(drifted, 'kb', 'index.md');
      writeFileSync(index, `${readFileSync(index, 'utf8')}\n\nHand-edited line.\n`);

      const r = await runIn(drifted, ['render', '--check']);
      expect(r.code).toBe(1);
      const found = r.json.issues.find((i) => i.code === 'RENDER_DRIFT');
      expect(found, `issues were ${JSON.stringify(r.json.issues)}`).toBeDefined();
      expect(found!.severity).toBe('error');
      expect(found!.hint).toBe(hintFor('RENDER_DRIFT'));
      expect(found!.ids).toEqual([found!.message.split(': ')[1]]);
      // The drift report is kept on failure (a failed envelope MAY carry data, 01 §2).
      expect((r.json.data as { drift: unknown[] }).drift.length).toBeGreaterThan(0);
      expect(r.json.issues.some((i) => i.code === 'LEGACY')).toBe(false);
    } finally {
      rmSync(drifted, { recursive: true, force: true });
    }
  });

  it('an active claim with no supporting span → verify emits CLAIM_HAS_PROVENANCE', async () => {
    // A `context`-role span links the claim to the source but is not SUPPORT, so the
    // claim-has-provenance check fires (the only route to this code that does not
    // require hand-corrupting the DB).
    const applied = await applyPayload(['claim', 'apply'], {
      source_id: sourceId,
      claims: [
        {
          node_id: nodeId,
          text: 'Context-only claim with no supporting span.',
          claim_type: 'fact',
          spans: [{ chunk_id: chunkId, quote: 'caches results in Redis', role: 'context' }],
        },
      ],
    });
    expect(applied.code).toBe(0);

    const v = await run(['verify']);
    const found = issue(v, 'CLAIM_HAS_PROVENANCE');
    expect(found, `verify issues were ${JSON.stringify(v.json.issues.map((i) => i.code))}`).toBeDefined();
    expect(found!.hint).toBe(hintFor('CLAIM_HAS_PROVENANCE'));
    expect(issue(v, 'LEGACY')).toBeUndefined();
  });
});

describe('LEGACY emission is forbidden from Phase 1 on (01 §3.2, 03 deliverable 6)', () => {
  /** Every non-test `.ts` module under `src/`, with its repo-relative path. */
  function productionModules(): Array<{ path: string; src: string }> {
    const out: Array<{ path: string; src: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        out.push({ path: full.slice(srcRoot.length + 1), src: readFileSync(full, 'utf8') });
      }
    };
    walk(srcRoot);
    return out;
  }

  /**
   * The two modules that legitimately NAME `LEGACY`: the registry (the entry is retained
   * forever — charter: registry-additive) and the hint table (which is total over the
   * registry). Neither constructs an issue with it.
   */
  const NAMING_ALLOWED = new Set(['domain/issueCodes.ts', 'cli/issues.ts']);

  it('no production module constructs a LEGACY issue', () => {
    const offenders = productionModules()
      .filter((m) => !NAMING_ALLOWED.has(m.path))
      .filter((m) => /['"]LEGACY['"]/.test(m.src))
      .map((m) => m.path);
    expect(offenders, 'LEGACY emission is forbidden from Phase 1 on (01 §3.2)').toEqual([]);
  });

  it('the Phase-0 legacyError/legacyWarning wrappers are gone', () => {
    const offenders = productionModules()
      .filter((m) => /\blegacy(Error|Warning)\b/.test(m.src))
      .map((m) => m.path);
    expect(offenders, 'the mechanical LEGACY wrappers must be deleted, not merely unused').toEqual([]);
  });
});

describe('every registered issue code is exercised or explicitly reserved (01 §3.2)', () => {
  /**
   * code → the test file that drives an envelope carrying it. The file is read back and
   * must mention the code, so deleting the assertion (or the file) fails this test rather
   * than silently leaving the code unexercised.
   */
  const EMITTED_BY: Partial<Record<IssueCode, string>> = {
    // --- Argument & payload parsing (router / Commander mapping) ---
    UNKNOWN_COMMAND: 'cli/error-mapping.test.ts',
    UNKNOWN_OPTION: 'cli/error-mapping.test.ts',
    MISSING_ARGUMENT: 'cli/error-mapping.test.ts',
    INVALID_ARGUMENT: 'cli/error-mapping.test.ts',
    PAYLOAD_PARSE_ERROR: 'cli/issues.test.ts',
    PAYLOAD_SCHEMA: 'cli/issue-coverage.test.ts',

    // --- Workspace resolution ---
    NO_KB: 'cli/issue-coverage.test.ts',
    KB_PATH_SUSPECT: 'cli/issue-coverage.test.ts',

    // --- Unknown entity lookups ---
    UNKNOWN_NODE: 'cli/issue-coverage.test.ts',
    UNKNOWN_SOURCE: 'cli/issue-coverage.test.ts',
    UNKNOWN_CLAIM: 'cli/issue-coverage.test.ts',
    UNKNOWN_ENTITY: 'cli/issue-coverage.test.ts',
    UNKNOWN_PARENT_REF: 'domain/services/nodeManifest.test.ts',

    // --- Quote / provenance ---
    QUOTE_NOT_FOUND: 'cli/domain-errors.test.ts',
    QUOTE_AMBIGUOUS: 'cli/domain-errors.test.ts',
    CLAIM_HAS_PROVENANCE: 'cli/issue-coverage.test.ts',

    // --- Citations ---
    CITATION_UNKNOWN: 'cli/domain-errors.test.ts',
    CITATION_OUT_OF_SUBTREE: 'cli/synthesize.test.ts',
    CITATION_INACTIVE: 'domain/services/synthesisValidator.test.ts',

    // --- Hierarchy / batch structure ---
    ROOT_HAS_PARENT: 'domain/services/nodeManifest.test.ts',
    MULTIPLE_ROOTS: 'domain/services/nodeManifest.test.ts',
    DUPLICATE_REF: 'domain/services/nodeManifest.test.ts',
    DUPLICATE_SLUG: 'domain/services/nodeManifest.test.ts',
    NODE_KIND_MISMATCH: 'domain/services/nodeManifest.test.ts',
    NODE_TITLE_MISMATCH: 'domain/services/nodeManifest.test.ts',

    // --- Staleness & render drift ---
    NO_STALE_NODES: 'cli/cli.test.ts',
    RENDER_DRIFT: 'cli/issue-coverage.test.ts',

    // --- Media & lineage ---
    UNSUPPORTED_MEDIA: 'cli/ingest-lineage.test.ts',
    TEXT_SIDECAR_INVALID: 'cli/ingest-lineage.test.ts',

    // --- Answer-check ---
    UNCITED_ASSERTION: 'cli/cli.test.ts',

    // --- Coverage (info severity) ---
    SOURCE_NO_CLAIMS: 'cli/coverage.test.ts',
    CHUNK_UNCITED: 'cli/coverage.test.ts',
    CLAIM_NOT_SYNTHESIZED: 'cli/coverage.test.ts',
    NODE_SINGLE_SOURCE: 'cli/coverage.test.ts',
    OPEN_QUESTION_NOT_SYNTHESIZED: 'cli/coverage.test.ts',

    // --- Meta ---
    INTERNAL: 'cli/ingest.test.ts',
  };

  /** Codes deliberately not driven by a test, each with the reason. */
  const RESERVED: Partial<Record<IssueCode, string>> = {
    LEGACY:
      'Transitional Phase-0 wrapper. Emission is FORBIDDEN from Phase 1 on (01 §3.2) and asserted absent by the suite scan above; the registry entry is retained forever (charter: registry-additive).',
    FTS_INTEGRITY:
      'Emitted only when SQLite reports an FTS5 integrity-check failure — i.e. real index corruption. No fixture corrupts a shadow table, so the code is reachable only through the VERIFY_CHECK_CODES map, whose totality over VERIFY_CHECKS is asserted in cli/issues.test.ts.',
  };

  it('EMITTED_BY and RESERVED partition the registry exactly', () => {
    const accounted = [...Object.keys(EMITTED_BY), ...Object.keys(RESERVED)].sort();
    expect(accounted).toEqual([...ISSUE_CODES].sort());
    // Disjoint: no code may be both driven and reserved.
    for (const code of Object.keys(RESERVED)) {
      expect(EMITTED_BY[code as IssueCode], `${code} is both emitted and reserved`).toBeUndefined();
    }
  });

  it('every EMITTED_BY test file exists and names its code', () => {
    for (const [code, file] of Object.entries(EMITTED_BY)) {
      const full = join(srcRoot, file!);
      expect(() => statSync(full), `${code}: ${file} does not exist`).not.toThrow();
      expect(readFileSync(full, 'utf8'), `${code}: ${file} no longer mentions it`).toContain(code);
    }
  });

  it('every RESERVED entry carries a non-empty reason', () => {
    for (const [code, reason] of Object.entries(RESERVED)) {
      expect(reason!.length, `${code} reserved without a reason`).toBeGreaterThan(40);
    }
  });
});
