/**
 * eval-seed — build the SCRIPT-BUILT seeds for the paired old-vs-revised skill eval
 * (07 §3). Every stage starts from a seed this script produces, identical for both
 * variants, so no run ever starts from the other variant's output.
 *
 *   stage1 — an empty directory (kb-create must do everything itself).
 *   stage2 — the deterministic fixture KB, exactly as `scripts/build-fixture.ts`
 *            assembles it (invariant gate included).
 *   stage3 — that fixture PLUS `fixtures/eval/sources/update-memo.md` applied BY THIS
 *            SCRIPT, so stage 3 never depends on how an agent happened to do stage 2.
 *
 * "Applied" means the whole stage-2 job done mechanically: ingest the memo, apply its
 * claims with unique quotes, record the conflict as the supersession chain
 * 100 rps → 1000 rps → 500 rps (the pair planted in fixtures/corpus/README.md, then the
 * memo's correction on top), and re-synthesize until nothing is stale and
 * `kb verify --strict` is ok.
 *
 * Two properties are deliberately PRESERVED rather than tidied up, because stage 3
 * tests retrieval:
 *   - the planted open-question claim (`burst credits roll over`) stays ACTIVE and
 *     stays uncited by any synthesis body;
 *   - the memo's own new open questions are likewise left uncited, so the query agent
 *     has to retrieve them instead of reading them off the rendered node.
 * Re-synthesis therefore only repairs what `verify --strict` requires: it rewrites
 * bodies that cite a now-superseded claim and clears the stale flags.
 *
 * The script is self-gating like build-fixture: every quote must be an exact, UNIQUE
 * substring of its chunk, the memo's ambiguous-quote trap must still be ambiguous, and
 * the final KB must verify strictly — otherwise it exits non-zero.
 *
 * Usage: tsx scripts/eval-seed.ts <stage1|stage2|stage3> <outDir>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const KB = join(REPO_ROOT, 'bin/kb');
const TSX = join(REPO_ROOT, 'node_modules/.bin/tsx');
const BUILD_FIXTURE = join(REPO_ROOT, 'scripts/build-fixture.ts');
const MEMO = join(REPO_ROOT, 'fixtures/eval/sources/update-memo.md');

const MEMO_TITLE = 'RateGuard Launch Follow-Up Memo';
const MEMO_DATE = '2026-06-01';

/**
 * The sentence the memo repeats inside ONE chunk. An agent that quotes it bare gets
 * `QUOTE_AMBIGUOUS` and has to extend the quote — that is the trap. This script quotes
 * the extended form instead, and asserts the bare form is still ambiguous.
 */
const TRAP_SENTENCE = 'The default rate limit ships at 500 requests per second';

interface MemoClaim {
  /** Node title in fixtures/corpus/hierarchy.json (resolved to an id at run time). */
  nodeTitle: string;
  /** Last segment of the chunk's headingPath. */
  section: string;
  text: string;
  claimType: string;
  /** Must be an exact substring of that chunk, occurring exactly once. */
  quote: string;
}

const MEMO_CLAIMS: MemoClaim[] = [
  {
    nodeTitle: 'Rate Limit Algorithm',
    section: 'Rate Limit Change',
    text: 'The default rate limit ships at 500 requests per second.',
    claimType: 'fact',
    quote: 'To be explicit for the on-call rotation: The default rate limit ships at 500 requests per second',
  },
  {
    nodeTitle: 'Monitoring',
    section: 'Monitoring',
    text: 'Alerts page the on-call engineer directly.',
    claimType: 'fact',
    quote: 'Alerts now page the on-call engineer directly instead of posting to the team channel',
  },
  {
    nodeTitle: 'Open Questions',
    section: 'Open Questions',
    text: 'It is undecided whether enterprise customers get a separate default limit.',
    claimType: 'open_question',
    quote: 'It is still undecided whether enterprise customers get a separate default limit',
  },
  {
    nodeTitle: 'Open Questions',
    section: 'Open Questions',
    text: 'It is undecided who approves a quota change.',
    claimType: 'open_question',
    quote: 'The team has not agreed on who approves a quota change',
  },
];

/** The conflict the memo forces, recorded oldest-first. `null` = the memo's own claim. */
const SUPERSESSIONS: { oldText: string; byText: string | null }[] = [
  {
    oldText: 'The default rate limit is 100 requests per second.',
    byText: 'The default rate limit is raised to 1000 requests per second.',
  },
  { oldText: 'The default rate limit is raised to 1000 requests per second.', byText: null },
];

/** Bodies this script authors outright, because the memo makes the old prose wrong. */
const BODY_TEMPLATES: Record<string, (cite: (claimText: string) => string) => string> = {
  'Rate Limit Algorithm': (cite) =>
    `RateGuard uses a token-bucket algorithm.${cite('RateGuard uses a token-bucket algorithm.')} ` +
    `The default rate limit ships at 500 requests per second.${cite('The default rate limit ships at 500 requests per second.')}`,
};

interface Envelope {
  ok?: boolean;
  data?: unknown;
  errors?: string[];
  issues?: { code: string }[];
}

function run(args: string[], opts: { input?: string; kbDir?: string } = {}): { status: number; env: Envelope | null } {
  const env = { ...process.env, ...(opts.kbDir ? { KB_DIR: opts.kbDir } : {}) };
  try {
    const stdout = execFileSync(KB, args, {
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, env: safeParse(stdout) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, env: safeParse(String(err.stdout ?? '')) };
  }
}

function safeParse(s: string): Envelope | null {
  try {
    return JSON.parse(s) as Envelope;
  } catch {
    return null;
  }
}

/** Run a `kb` command that must succeed; throw a labelled error if it does not. */
function kb(label: string, args: string[], opts: { input?: string; kbDir?: string } = {}): unknown {
  const r = run(args, opts);
  if (r.status !== 0 || !r.env?.ok) {
    const why = r.env?.errors?.join('; ') || r.env?.issues?.map((i) => i.code).join(',') || `exit ${r.status}`;
    throw new Error(`${label} failed (kb ${args.join(' ')}): ${why}`);
  }
  return r.env.data;
}

function fail(message: string): never {
  console.error(`eval-seed FAILED: ${message}`);
  process.exit(1);
}

/**
 * Refusing a populated directory is what stops a seed being contaminated by the previous
 * run — so the refusal carries the executable fix, not just the complaint. Every stage
 * builds its KB from scratch (stage 3 rebuilds the stage-2 fixture first), so the seeds
 * never stack.
 */
function emptyDirRecipe(stage: string, root: string): string {
  return (
    `${stage} builds its KB from scratch and will not seed on top of leftovers: ${root} is not empty.\n` +
    `  Reset it first, in one line:\n` +
    `    rm -rf ${root} && pnpm exec tsx scripts/eval-seed.ts ${stage} ${root}\n` +
    `  Rebuild the seed before EVERY run — including the second variant of a stage you just ran.`
  );
}

// --- stage 1 -----------------------------------------------------------------

function stage1(root: string): void {
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length > 0) fail(emptyDirRecipe('stage1', root));
}

// --- stage 2 -----------------------------------------------------------------

/**
 * The fixture KB, assembled and invariant-gated by build-fixture itself. `requested` is
 * the stage the CALLER asked for — stage 3 builds this first, and a recovery recipe that
 * told them to re-run stage2 would hand back the wrong seed.
 */
function stage2(root: string, requested = 'stage2'): void {
  if (existsSync(root) && readdirSync(root).length > 0) fail(emptyDirRecipe(requested, root));
  execFileSync(TSX, [BUILD_FIXTURE, root], { cwd: REPO_ROOT, stdio: 'inherit' });
}

// --- stage 3 -----------------------------------------------------------------

interface Chunk {
  id: string;
  headingPath: string;
  text: string;
}
interface TreeNode {
  id: string;
  title: string;
  depth: number;
  isStale: boolean;
}
interface ShownClaim {
  id: string;
  text: string;
  status: string;
}

function stage3(root: string): void {
  stage2(root, 'stage3');

  // 1. Ingest the memo (dry-run first, like the skill does).
  kb('ingest --dry-run', ['ingest', MEMO, '--title', MEMO_TITLE, '--source-date', MEMO_DATE, '--dry-run', '--json'], { kbDir: root });
  const ingested = kb('ingest', ['ingest', MEMO, '--title', MEMO_TITLE, '--source-date', MEMO_DATE, '--json'], { kbDir: root }) as {
    sourceId: string;
  };

  // 2. Resolve chunks; gate the quotes and the planted trap.
  const chunks = (kb('source chunks', ['source', 'chunks', ingested.sourceId, '--json'], { kbDir: root }) as { chunks: Chunk[] }).chunks;
  const trapChunks = chunks.filter((c) => c.text.split(TRAP_SENTENCE).length - 1 >= 2);
  if (trapChunks.length !== 1) {
    fail(`the ambiguous-quote trap is gone: ${JSON.stringify(TRAP_SENTENCE)} must repeat inside exactly ONE chunk (found ${trapChunks.length})`);
  }

  const chunkFor = (section: string): Chunk => {
    const hit = chunks.filter((c) => c.headingPath.endsWith(section));
    if (hit.length !== 1) fail(`memo section ${JSON.stringify(section)} must map to exactly one chunk (found ${hit.length})`);
    return hit[0]!;
  };

  // 3. Resolve node ids by title, and author the claim payload.
  const tree = (kb('node tree', ['node', 'tree', '--json'], { kbDir: root }) as { nodes: TreeNode[] }).nodes;
  const nodeIdFor = (title: string): string => {
    const hit = tree.filter((n) => n.title === title);
    if (hit.length !== 1) fail(`node title ${JSON.stringify(title)} must be unique in the fixture (found ${hit.length})`);
    return hit[0]!.id;
  };

  const payload = {
    source_id: ingested.sourceId,
    claims: MEMO_CLAIMS.map((c) => {
      const chunk = chunkFor(c.section);
      const occurrences = chunk.text.split(c.quote).length - 1;
      if (occurrences !== 1) fail(`quote for ${JSON.stringify(c.text)} occurs ${occurrences}x in chunk ${chunk.id}; it must be unique`);
      return {
        node_id: nodeIdFor(c.nodeTitle),
        text: c.text,
        claim_type: c.claimType,
        confidence: 0.9,
        spans: [{ chunk_id: chunk.id, quote: c.quote, role: 'supports' }],
      };
    }),
  };

  const body = JSON.stringify(payload);
  kb('claim apply --dry-run', ['claim', 'apply', '--file', '-', '--dry-run', '--json'], { kbDir: root, input: body });
  const applied = kb('claim apply', ['claim', 'apply', '--file', '-', '--json'], { kbDir: root, input: body }) as {
    claims: { inputIndex: number; claimId: string }[];
  };
  const memoClaimIds = new Map<string, string>();
  for (const receipt of applied.claims) memoClaimIds.set(MEMO_CLAIMS[receipt.inputIndex]!.text, receipt.claimId);

  // 4. Record the conflict: 100 rps → 1000 rps (the planted pair) → the memo's 500 rps.
  const rateLimitNode = nodeIdFor('Rate Limit Algorithm');
  const claimIdByText = (text: string): string => {
    const owned = (kb('node show', ['node', 'show', rateLimitNode, '--json'], { kbDir: root }) as { claims: ShownClaim[] }).claims;
    const hit = owned.filter((c) => c.text === text);
    if (hit.length !== 1) fail(`claim ${JSON.stringify(text)} must exist exactly once on the rate-limit node (found ${hit.length})`);
    return hit[0]!.id;
  };
  const superseded: string[] = [];
  for (const step of SUPERSESSIONS) {
    const oldId = claimIdByText(step.oldText);
    const byId = step.byText === null ? memoClaimIds.get(MEMO_CLAIMS[0]!.text)! : claimIdByText(step.byText);
    kb('claim supersede', ['claim', 'supersede', oldId, '--by', byId, '--json'], { kbDir: root });
    superseded.push(oldId);
  }

  // 5. Re-synthesize only what verify --strict requires: drop citations to superseded
  //    claims, then clear every stale flag (deepest-first).
  resynthesize(root, superseded, memoClaimIds);

  // 6. Gates: strict verify, and the planted open question still active + uncited.
  kb('verify --strict', ['verify', '--strict', '--json'], { kbDir: root });
  assertPlantedOpenQuestion(root);
}

/** Clear staleness with the smallest edit that keeps every citation active. */
function resynthesize(root: string, superseded: string[], memoClaimIds: Map<string, string>): void {
  for (let pass = 0; pass < 5; pass++) {
    const nodes = (kb('node tree', ['node', 'tree', '--json'], { kbDir: root }) as { nodes: TreeNode[] }).nodes;
    const stale = nodes.filter((n) => n.isStale).sort((a, b) => b.depth - a.depth);
    if (stale.length === 0) return;
    for (const node of stale) {
      const ctx = kb('node show --context', ['node', 'show', node.id, '--context', '--json'], { kbDir: root }) as {
        node: { bodyMd: string };
        claims: ShownClaim[];
      };
      const template = BODY_TEMPLATES[node.title];
      const cite = (claimText: string): string => {
        const fromMemo = memoClaimIds.get(claimText);
        const id = fromMemo ?? ctx.claims.find((c) => c.text === claimText)?.id;
        if (!id) fail(`template for ${JSON.stringify(node.title)} cites an unknown claim: ${JSON.stringify(claimText)}`);
        return `[^${id}]`;
      };
      let bodyMd = template ? template(cite) : ctx.node.bodyMd;
      if (!template) for (const id of superseded) bodyMd = bodyMd.split(`[^${id}]`).join('');
      kb('synthesize', ['synthesize', '--file', '-', '--json'], {
        kbDir: root,
        input: JSON.stringify({ node_id: node.id, body_md: bodyMd }),
      });
    }
  }
  fail('re-synthesis did not converge: nodes are still stale after 5 passes');
}

/**
 * The stage-3 terminal check needs the planted open question to be CITABLE (active) and
 * still UNCITED by any synthesis body — otherwise the query agent can read it off the
 * rendered node instead of retrieving it.
 */
function assertPlantedOpenQuestion(root: string): void {
  const PLANTED = 'clm_b818b407b87ec929';
  const prov = run(['provenance', PLANTED, '--json'], { kbDir: root });
  const claim = (prov.env?.data as { claim?: { status?: string } } | undefined)?.claim;
  if (!prov.env?.ok || claim?.status !== 'active') {
    fail(`the planted open-question claim ${PLANTED} must still be active (got ${claim?.status ?? 'missing'})`);
  }
  const nodes = (kb('node tree', ['node', 'tree', '--json'], { kbDir: root }) as { nodes: TreeNode[] }).nodes;
  for (const node of nodes) {
    const shown = kb('node show', ['node', 'show', node.id, '--json'], { kbDir: root }) as { node: { bodyMd: string } };
    if (shown.node.bodyMd.includes(PLANTED)) fail(`the planted open-question claim ${PLANTED} must stay uncited; ${node.title} cites it`);
  }
}

// --- entry -------------------------------------------------------------------

function main(): void {
  const stage = process.argv[2];
  const outArg = process.argv[3];
  if (!stage || !outArg) fail('usage: tsx scripts/eval-seed.ts <stage1|stage2|stage3> <outDir>');
  const root = resolve(outArg);

  switch (stage) {
    case 'stage1':
      stage1(root);
      break;
    case 'stage2':
      stage2(root);
      break;
    case 'stage3':
      stage3(root);
      break;
    default:
      fail(`unknown stage ${JSON.stringify(stage)} — expected stage1, stage2, or stage3`);
  }
  console.log(`eval-seed OK: ${stage} seed written to ${root}`);
}

main();
