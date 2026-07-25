/**
 * build-fixture — assemble the deterministic fixture KB from fixtures/corpus/
 * THROUGH THE `kb` CLI and FAIL (non-zero exit) unless every planted content
 * invariant holds. This is the hard gate that keeps the corpus honest: if a
 * source is edited so a quote no longer lands exactly in its chunk, or a planted
 * property (uncited open question, uncovered chunks, zero-claim source,
 * supersession pair) is lost, the build breaks.
 *
 * Assembly goes through the real agent-facing command path — `kb init`, `kb
 * ingest`, `kb node create`, `kb claim apply`, `kb graph apply`, `kb synthesize`,
 * `kb verify --strict` — so the gate also proves CLI parsing, command wiring, and
 * envelopes work end-to-end on the fixture (not just the service layer). A quote
 * that is not an exact chunk substring makes `kb claim apply`/`kb graph apply`
 * emit `ok:false`, which fails the build; an explicit read-only pre-check first
 * reports ALL such quote problems at once with a precise source location.
 *
 * The planted-invariant checks then open the assembled KB READ-ONLY and introspect
 * it (the same way `kb verify` reads the repositories internally) — assembly is
 * 100% via the CLI; only inspection touches the DB directly.
 *
 * Usage: tsx scripts/build-fixture.ts [outDir]   (KB_FIXTURE_CORPUS overrides corpus)
 *   outDir defaults to a throwaway temp dir (removed on exit).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openWorkspace, type Workspace } from '../src/kb/workspace.js';
import { extractCitations } from '../src/domain/algorithms/citations.js';
import { deriveClaimId } from '../src/domain/algorithms/idDeriver.js';
import { normalizeClaimText } from '../src/domain/algorithms/normalize.js';
import { makeNodeId, type SourceId } from '../src/domain/ids.js';
import { ClaimApplySchema, GraphApplySchema } from '../src/domain/schemas/agent.js';
import {
  CORPUS,
  SOURCE_NAMES,
  CLAIMED_SOURCES,
  readCorpusJson,
  flattenHierarchy,
  type HNode,
} from './fixtureKb.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const KB = join(REPO_ROOT, 'bin/kb');

interface CliResult {
  status: number;
  env: { ok?: boolean; data?: unknown; errors?: string[]; warnings?: string[] } | null;
  stderr: string;
}

/** Invoke the real `kb` CLI with `--json`; parse the envelope from stdout. */
function kb(args: string[], opts: { input?: string; kbDir?: string } = {}): CliResult {
  const env = { ...process.env, ...(opts.kbDir ? { KB_DIR: opts.kbDir } : {}) };
  try {
    const stdout = execFileSync(KB, args, {
      input: opts.input,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, env: safeParse(stdout), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: err.status ?? 1,
      env: safeParse(String(err.stdout ?? '')),
      stderr: String(err.stderr ?? ''),
    };
  }
}

function safeParse(s: string): CliResult['env'] {
  try {
    return JSON.parse(s) as CliResult['env'];
  } catch {
    return null;
  }
}

/** Run a `kb` command that must succeed; throw a labelled error if it does not. */
function kbOrThrow(label: string, args: string[], opts: { input?: string; kbDir?: string } = {}): unknown {
  const r = kb(args, opts);
  if (r.status !== 0 || !r.env?.ok) {
    const errs = r.env?.errors?.join('; ') || r.stderr.trim() || `exit ${r.status}`;
    throw new Error(`${label} failed (kb ${args.join(' ')}): ${errs}`);
  }
  return r.env?.data;
}

/** Assemble the whole fixture KB through the CLI. Returns the name→sourceId map. */
function assembleViaCli(root: string, problems: string[]): Record<string, SourceId> {
  // 0. Fresh KB (dir as positional; KB_DIR steers every later command).
  kbOrThrow('init', ['init', root, '--json']);

  // 1. Ingest the four sources; capture the deterministic source ids.
  const sourceIds: Record<string, SourceId> = {};
  for (const name of SOURCE_NAMES) {
    const data = kbOrThrow('ingest', ['ingest', join(CORPUS, 'sources', `${name}.md`), '--json'], { kbDir: root });
    sourceIds[name] = (data as { sourceId: SourceId }).sourceId;
  }

  // 1a. Read-only substring pre-check: report ALL quote-not-a-substring problems
  //     at once with a precise location, before the CLI apply enforces the same.
  preCheckQuotes(root, problems);
  if (problems.length > 0) return sourceIds; // corpus is known-bad; skip the rest

  // 2. One `node create` per node (parents before children; derived parent ids).
  for (const n of flattenHierarchy(readCorpusJson<{ nodes: HNode[] }>('hierarchy.json'))) {
    kbOrThrow('node create', [
      'node', 'create',
      '--title', n.title,
      '--kind', n.kind,
      '--slug', n.slug,
      ...(n.parentId ? ['--parent', n.parentId] : []),
      '--json',
    ], { kbDir: root });
  }

  // 3. One `claim apply` per claimed source.
  for (const name of CLAIMED_SOURCES) {
    kbOrThrow('claim apply', ['claim', 'apply', '--file', join(CORPUS, 'claims', `${name}.json`), '--json'], { kbDir: root });
  }

  // 4. One `graph apply`.
  kbOrThrow('graph apply', ['graph', 'apply', '--file', join(CORPUS, 'graph', 'api-reference.json'), '--json'], { kbDir: root });

  // 5. One `synthesize` per node, deepest first (leaves → topics → root), stdin.
  for (const file of ['synthesis/leaves.json', 'synthesis/topics.json', 'synthesis/root.json']) {
    const { nodes } = readCorpusJson<{ nodes: unknown[] }>(file);
    for (const node of nodes) {
      kbOrThrow('synthesize', ['synthesize', '--file', '-', '--json'], { kbDir: root, input: JSON.stringify(node) });
    }
  }

  // 6. Strict verify through the CLI (render/check belong to baseline-old.sh).
  kbOrThrow('verify --strict', ['verify', '--strict', '--json'], { kbDir: root });

  return sourceIds;
}

/** Every claim/graph span quote must be an exact substring of its chunk. */
function preCheckQuotes(root: string, problems: string[]): void {
  const ws = openWorkspace(root);
  try {
    const check = (chunkId: string, quote: string, where: string): void => {
      const chunk = ws.repos.chunks.getById(chunkId as never);
      if (!chunk) problems.push(`${where}: unknown chunk ${chunkId}`);
      else if (!chunk.text.includes(quote)) {
        problems.push(`${where}: quote is not an exact substring of chunk ${chunkId}: ${JSON.stringify(quote)}`);
      }
    };
    for (const name of CLAIMED_SOURCES) {
      const payload = ClaimApplySchema.parse(readCorpusJson(`claims/${name}.json`));
      payload.claims.forEach((claim, ci) =>
        claim.spans.forEach((span, si) => check(span.chunk_id, span.quote, `claims/${name}.json claims[${ci}].spans[${si}]`)),
      );
    }
    const graph = GraphApplySchema.parse(readCorpusJson('graph/api-reference.json'));
    graph.relationships.forEach((rel, ri) =>
      rel.evidence.forEach((ev, ei) => check(ev.chunk_id, ev.quote, `graph/api-reference.json relationships[${ri}].evidence[${ei}]`)),
    );
  } finally {
    ws.close();
  }
}

/** Read-only introspection of the assembled KB: the planted-content invariants. */
function assertInvariants(ws: Workspace, sourceIds: Record<string, SourceId>, problems: string[]): void {
  const nodes = ws.repos.nodes.listAll();
  const allClaims = nodes.flatMap((n) => ws.repos.claims.listByNode(n.id));

  const cited = new Set<string>();
  for (const n of nodes) for (const id of extractCitations(n.bodyMd)) cited.add(id);

  // (b) >=1 open_question claim never cited in any synthesis body.
  const openQuestions = allClaims.filter((c) => c.claimType === 'open_question');
  if (openQuestions.length === 0) problems.push('invariant(open_question): no open_question claims were planted');
  if (openQuestions.filter((c) => !cited.has(c.id)).length < 1) {
    problems.push('invariant(open_question): every open_question claim is cited; at least one must stay uncited');
  }

  // (c) >=2 chunks in claimed sources covered by no span.
  const spanChunkIds = new Set<string>();
  for (const name of CLAIMED_SOURCES) for (const s of ws.repos.spans.listBySource(sourceIds[name]!)) if (s.chunkId) spanChunkIds.add(s.chunkId);
  let uncovered = 0;
  for (const name of CLAIMED_SOURCES) for (const c of ws.repos.chunks.listBySource(sourceIds[name]!)) if (!spanChunkIds.has(c.id)) uncovered++;
  if (uncovered < 2) problems.push(`invariant(uncovered-chunks): expected >=2 uncovered chunks in claimed sources, found ${uncovered}`);

  // (d) press-release: ingested but zero claim links.
  const prId = sourceIds['press-release']!;
  if (ws.repos.chunks.listBySource(prId).length === 0) problems.push('invariant(press-release): source has no chunks (not ingested?)');
  if (ws.repos.spans.listBySource(prId).length !== 0) problems.push('invariant(press-release): source has spans; it must carry zero claim links');
  if (allClaims.some((c) => c.firstSeenSourceId === prId)) problems.push('invariant(press-release): a claim was first seen in the press release');

  // (e) supersession pair for the eval memo: both claims present, active, same node.
  const oldId = deriveClaimId(normalizeClaimText('The default rate limit is 100 requests per second.'), sourceIds['design-notes']!);
  const newId = deriveClaimId(normalizeClaimText('The default rate limit is raised to 1000 requests per second.'), sourceIds['meeting-transcript']!);
  const oldClaim = ws.repos.claims.getById(oldId);
  const newClaim = ws.repos.claims.getById(newId);
  if (!oldClaim) problems.push(`invariant(supersession): old claim ${oldId} missing`);
  if (!newClaim) problems.push(`invariant(supersession): new claim ${newId} missing`);
  if (oldClaim && newClaim) {
    if (oldClaim.status !== 'active' || newClaim.status !== 'active') problems.push('invariant(supersession): both claims must start active');
    if (oldClaim.nodeId !== newClaim.nodeId) problems.push('invariant(supersession): both claims must own the same node');
    if (oldClaim.nodeId !== makeNodeId('nod_23b022cb91d8fa3b')) problems.push('invariant(supersession): pair is not on the rate-limit-algorithm node');
  }
}

function main(): void {
  const outArg = process.argv[2];
  const root = outArg ? resolve(outArg) : mkdtempSync(join(tmpdir(), 'kb-fixture-'));
  const problems: string[] = [];
  let sourceIds: Record<string, SourceId> = {};
  try {
    sourceIds = assembleViaCli(root, problems);
  } catch (e) {
    problems.push(`assembly threw: ${(e as Error).message}`);
  }

  // Only introspect if assembly completed without quote/command failures.
  if (problems.length === 0) {
    const ws = openWorkspace(root);
    try {
      assertInvariants(ws, sourceIds, problems);
    } catch (e) {
      problems.push(`invariant check threw: ${(e as Error).message}`);
    } finally {
      ws.close();
    }
  }

  if (!outArg) rmSync(root, { recursive: true, force: true });

  if (problems.length > 0) {
    console.error(`build-fixture FAILED (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('build-fixture OK: 4 sources, 21 nodes, claims + graph + synthesis assembled via the kb CLI; all invariants hold.');
  if (outArg) console.log(`  KB written to ${root}`);
}

main();
