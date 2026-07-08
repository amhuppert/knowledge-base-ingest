#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import { emit, ok, fail, type Envelope } from './output.js';
import {
  resolveKbRoot,
  kbRootWarnings,
  openWorkspace,
  initWorkspace,
  type Workspace,
} from '../kb/workspace.js';
import { writeScaffold } from '../kb/scaffold.js';
import { renderAll, writeRender, checkRender } from '../render/render.js';
import { verify } from '../verify/verify.js';
import { search, askContext, answerCheck, type SearchScope } from '../query/query.js';
import { ClaimApplySchema, GraphApplySchema, SynthesizeSchema, AnswerCheckSchema } from '../domain/schemas/agent.js';
import { makeNodeId, makeClaimId, makeSourceId, type NodeId } from '../domain/ids.js';
import { NODE_KINDS, type NodeKind } from '../domain/schemas/enums.js';
import { systemClock } from '../domain/services/context.js';

const BOOL_FLAGS = new Set(['json', 'check', 'strict', 'text', 'help']);
const TWO_WORD = new Set(['claim', 'graph', 'node', 'source', 'entity']);

interface Args {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const MEDIA: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  rst: 'text/plain',
};
function guessMedia(ext: string): string {
  return MEDIA[ext.toLowerCase()] ?? 'text/plain';
}

function str(flags: Args['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function readPayload(flags: Args['flags']): unknown {
  const file = str(flags, 'file');
  const raw = file && file !== '-' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  return JSON.parse(raw);
}

function count(ws: Workspace, table: string): number {
  const r = ws.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

// --------------------------------------------------------------------------
// Command handlers — each returns an Envelope. Throwing is caught into fail().
// --------------------------------------------------------------------------

type Handler = (args: Args) => Envelope<unknown>;

interface CommandHelp {
  command: string;
  usage: string;
  summary: string;
  input?: string;
  output?: string;
}

const commandHelp: Record<string, CommandHelp> = {
  init: {
    command: 'init',
    usage: 'kb init [<dir>] [--json]',
    summary: 'Create or open a KB root, write scaffold files, and render the initial markdown.',
    output: '{ root, created, scaffold, rendered }',
  },
  status: {
    command: 'status',
    usage: 'kb status [--json]',
    summary: 'Print source, chunk, node, stale-node, claim, span, entity, and relationship counts.',
  },
  ingest: {
    command: 'ingest',
    usage: 'kb ingest <path> [--title T] [--source-date D] [--supersedes <src_id>] [--json]',
    summary: 'Register an immutable source copy, normalize text, and create deterministic chunks.',
    output: '{ sourceId, title, status, updated, chunks, next }',
  },
  'source show': {
    command: 'source show',
    usage: 'kb source show <source_id> [--json]',
    summary: 'Show source metadata.',
  },
  'source chunks': {
    command: 'source chunks',
    usage: 'kb source chunks <source_id> [--json]',
    summary: 'List chunks with ids, heading paths, and exact text for quote selection.',
  },
  'node create': {
    command: 'node create',
    usage: 'kb node create --title T --kind <root|topic|leaf> [--parent <node_id>] [--slug S] [--json]',
    summary: 'Create a synthesis node.',
  },
  'node tree': {
    command: 'node tree',
    usage: 'kb node tree [--json]',
    summary: 'List the synthesis hierarchy with depth, kind, stale flag, and claim counts.',
  },
  'node show': {
    command: 'node show',
    usage: 'kb node show <node_id> [--json]',
    summary: 'Show a node and the claims it owns.',
  },
  'claim apply': {
    command: 'claim apply',
    usage: 'kb claim apply --file <claims.json> [--json]',
    summary: 'Persist quote-verified claims atomically.',
    input: '{ source_id, claims: [{ node_id, text, claim_type, confidence?, spans }] }',
  },
  'claim conflict': {
    command: 'claim conflict',
    usage: 'kb claim conflict <claim_id> [<claim_id> ...] [--json]',
    summary: 'Mark one or more unresolved claims as conflicted and stale their owning nodes.',
    output: '{ conflicted, staleNodes }',
  },
  'claim supersede': {
    command: 'claim supersede',
    usage: 'kb claim supersede <old_claim_id> --by <new_claim_id> [--json]',
    summary: 'Mark an older claim superseded by another claim and stale affected nodes.',
  },
  'graph apply': {
    command: 'graph apply',
    usage: 'kb graph apply --file <graph.json> [--json]',
    summary: 'Persist entities and quote-verified relationships atomically.',
    input: '{ source_id, entities?, relationships? }',
  },
  synthesize: {
    command: 'synthesize',
    usage: 'kb synthesize --file <node.json> [--json]',
    summary: 'Set node prose with inline claim citations and clear that node stale flag.',
    input: '{ node_id, body_md, title?, summary? }',
  },
  propagate: {
    command: 'propagate',
    usage: 'kb propagate [--json]',
    summary: 'Re-assert stale propagation from stale nodes to ancestors.',
  },
  render: {
    command: 'render',
    usage: 'kb render [--check] [--json]',
    summary: 'Render generated markdown, or check rendered markdown for drift.',
  },
  verify: {
    command: 'verify',
    usage: 'kb verify [--strict] [--json]',
    summary: 'Run provenance, citation, staleness, and FTS integrity checks.',
  },
  search: {
    command: 'search',
    usage: 'kb search <query> [--scope chunks|claims|nodes|entities|all] [--limit N] [--json]',
    summary: 'Search chunks, claims, nodes, entities, or all scopes.',
  },
  'ask-context': {
    command: 'ask-context',
    usage: 'kb ask-context "<question>" [--limit N] [--json]',
    summary: 'Retrieve relevant claims with provenance, plus related nodes and entities.',
  },
  'answer-check': {
    command: 'answer-check',
    usage: 'kb answer-check --file <answer.json> [--json]',
    summary: 'Structurally validate that a drafted answer cites supported active claims.',
  },
  provenance: {
    command: 'provenance',
    usage: 'kb provenance <claim_id> [--json]',
    summary: 'Show a claim and its source quotes, offsets, source titles, and stored paths.',
  },
  'entity show': {
    command: 'entity show',
    usage: 'kb entity show <entity_id> [--json]',
    summary: 'Show an entity and its relationships.',
  },
};

function globalHelp(): { commands: string[]; usage: string; help: string } {
  return {
    commands: Object.keys(handlers).sort(),
    usage: 'kb <command> [args] [--json]',
    help: 'Run kb <command> --help --json for command-specific usage.',
  };
}

function withWs(args: Args, fn: (ws: Workspace) => Envelope<unknown>): Envelope<unknown> {
  const root = resolveKbRoot(process.cwd(), str(args.flags, 'kb'));
  const rootWarnings = kbRootWarnings(root);
  let ws: Workspace;
  try {
    ws = openWorkspace(root);
  } catch (e) {
    return fail([(e as Error).message], rootWarnings);
  }
  try {
    const env = fn(ws);
    return { ...env, warnings: [...rootWarnings, ...env.warnings] };
  } finally {
    ws.close();
  }
}

const handlers: Record<string, Handler> = {
  init: (args) => {
    const dir = args.positionals[0] ?? '.';
    const { ws, result } = initWorkspace(dir);
    try {
      const { wrote } = writeScaffold(ws.root);
      const files = renderAll(ws.repos);
      writeRender(ws.root, files, ws.repos, systemClock());
      return ok({ root: result.root, created: result.created, scaffold: wrote, rendered: files.length }, kbRootWarnings(result.root));
    } finally {
      ws.close();
    }
  },

  status: (args) =>
    withWs(args, (ws) =>
      ok({
        root: ws.root,
        sources: count(ws, 'sources'),
        chunks: count(ws, 'source_chunks'),
        nodes: count(ws, 'nodes'),
        staleNodes: ws.repos.nodes.listStaleDeepestFirst().length,
        claims: count(ws, 'claims'),
        spans: count(ws, 'spans'),
        entities: count(ws, 'entities'),
        relationships: count(ws, 'relationships'),
      }),
    ),

  ingest: (args) =>
    withWs(args, (ws) => {
      const path = args.positionals[0];
      if (!path) return fail(['usage: kb ingest <path> [--title T] [--source-date D] [--supersedes <src_id>]']);
      const bytes = readFileSync(path);
      const ext = extname(path).slice(1);
      const supersedes = str(args.flags, 'supersedes');
      const r = ws.ingest.ingest({
        bytes,
        ext,
        mediaType: guessMedia(ext),
        originalPath: path,
        ...(str(args.flags, 'title') ? { title: str(args.flags, 'title')! } : {}),
        ...(str(args.flags, 'source-date') ? { sourceDate: str(args.flags, 'source-date')! } : {}),
        ...(supersedes ? { supersedes: makeSourceId(supersedes) } : {}),
      });
      return ok({
        sourceId: r.source.id,
        title: r.source.title,
        status: r.status,
        updated: r.updated,
        chunks: r.chunks,
        next: `Read chunks with: kb source chunks ${r.source.id} --json`,
      });
    }),

  'source show': (args) =>
    withWs(args, (ws) => {
      const id = args.positionals[0];
      if (!id) return fail(['usage: kb source show <source_id>']);
      const src = ws.repos.sources.getById(makeSourceId(id));
      return src ? ok(src) : fail([`unknown source ${id}`]);
    }),

  'source chunks': (args) =>
    withWs(args, (ws) => {
      const id = args.positionals[0];
      if (!id) return fail(['usage: kb source chunks <source_id>']);
      const chunks = ws.repos.chunks.listBySource(makeSourceId(id)).map((c) => ({
        id: c.id,
        chunkIndex: c.chunkIndex,
        headingPath: c.headingPath,
        text: c.text,
      }));
      return ok({ sourceId: id, chunks });
    }),

  'claim apply': (args) => withWs(args, (ws) => ok(ws.claims.apply(ClaimApplySchema.parse(readPayload(args.flags))))),

  'graph apply': (args) => withWs(args, (ws) => ok(ws.graph.apply(GraphApplySchema.parse(readPayload(args.flags))))),

  'claim conflict': (args) =>
    withWs(args, (ws) => {
      if (args.positionals.length === 0) return fail(['usage: kb claim conflict <claim_id> [<claim_id> ...]']);
      const claimIds = args.positionals.map((id) => makeClaimId(id));
      const claims = claimIds.map((id) => ws.repos.claims.getById(id));
      const missing = claimIds.filter((_, i) => claims[i] === undefined);
      if (missing.length > 0) return fail(missing.map((id) => `unknown claim ${id}`));

      const now = systemClock();
      ws.repos.tx(() => {
        for (const claim of claims) {
          if (!claim) continue;
          ws.repos.claims.setStatus(claim.id, 'conflicted', null, now);
          if (claim.nodeId) ws.repos.nodes.markStaleWithAncestors(claim.nodeId, now);
        }
        ws.repos.changelog.append({
          ts: now,
          op: 'claim_conflict',
          summary: `Marked ${claimIds.length} claim(s) conflicted`,
          detail: { claims: claimIds },
        });
      });
      return ok({ conflicted: claimIds, staleNodes: ws.repos.nodes.listStaleDeepestFirst().length });
    }),

  'claim supersede': (args) =>
    withWs(args, (ws) => {
      const oldId = args.positionals[0];
      const by = str(args.flags, 'by');
      if (!oldId || !by) return fail(['usage: kb claim supersede <old_claim_id> --by <new_claim_id>']);
      const oldClaim = ws.repos.claims.getById(makeClaimId(oldId));
      const newClaim = ws.repos.claims.getById(makeClaimId(by));
      if (!oldClaim) return fail([`unknown claim ${oldId}`]);
      if (!newClaim) return fail([`unknown superseding claim ${by}`]);
      const now = systemClock();
      ws.repos.tx(() => {
        ws.repos.claims.setStatus(oldClaim.id, 'superseded', newClaim.id, now);
        if (oldClaim.nodeId) ws.repos.nodes.markStaleWithAncestors(oldClaim.nodeId, now);
        if (newClaim.nodeId) ws.repos.nodes.markStaleWithAncestors(newClaim.nodeId, now);
        ws.repos.changelog.append({
          ts: now,
          op: 'claim_supersede',
          summary: `Claim ${oldClaim.id} superseded by ${newClaim.id}`,
          detail: { old: oldClaim.id, by: newClaim.id },
        });
      });
      return ok({ superseded: oldClaim.id, by: newClaim.id, staleNodes: ws.repos.nodes.listStaleDeepestFirst().length });
    }),

  'node create': (args) =>
    withWs(args, (ws) => {
      const title = str(args.flags, 'title');
      const kind = str(args.flags, 'kind') as NodeKind | undefined;
      if (!title || !kind || !NODE_KINDS.includes(kind)) {
        return fail(['usage: kb node create --title T --kind <root|topic|leaf> [--parent <node_id>] [--slug S]']);
      }
      const parentFlag = str(args.flags, 'parent');
      const parentId: NodeId | null = !parentFlag || parentFlag === 'root' ? null : makeNodeId(parentFlag);
      const r = ws.nodes.createNode({
        parentId,
        title,
        kind,
        ...(str(args.flags, 'slug') ? { slug: str(args.flags, 'slug')! } : {}),
      });
      return ok({ nodeId: r.node.id, created: r.created, kind: r.node.kind, depth: r.node.depth });
    }),

  'node tree': (args) =>
    withWs(args, (ws) => {
      const nodes = ws.repos.nodes.listAll().map((n) => ({
        id: n.id,
        parentId: n.parentId,
        title: n.title,
        kind: n.kind,
        depth: n.depth,
        isStale: n.isStale,
        claims: ws.repos.claims.listByNode(n.id).length,
      }));
      return ok({ nodes });
    }),

  'node show': (args) =>
    withWs(args, (ws) => {
      const id = args.positionals[0];
      if (!id) return fail(['usage: kb node show <node_id>']);
      const node = ws.repos.nodes.getById(makeNodeId(id));
      if (!node) return fail([`unknown node ${id}`]);
      return ok({ node, claims: ws.repos.claims.listByNode(node.id) });
    }),

  synthesize: (args) => withWs(args, (ws) => ok(ws.nodes.synthesize(SynthesizeSchema.parse(readPayload(args.flags))))),

  propagate: (args) => withWs(args, (ws) => ok(ws.nodes.propagate())),

  render: (args) =>
    withWs(args, (ws) => {
      const files = renderAll(ws.repos);
      if (args.flags.check) {
        const results = checkRender(ws.root, files);
        const drift = results.filter((r) => r.status !== 'ok');
        return drift.length === 0
          ? ok({ checked: results.length, drift: [] })
          : { ok: false, data: { checked: results.length, drift }, warnings: [], errors: drift.map((d) => `${d.status}: ${d.path}`) };
      }
      const { written } = writeRender(ws.root, files, ws.repos, systemClock());
      return ok({ written, root: ws.root });
    }),

  verify: (args) =>
    withWs(args, (ws) => {
      const report = verify(ws.repos, { strict: args.flags.strict === true });
      return {
        ok: report.ok,
        data: report,
        warnings: report.findings.filter((f) => f.severity === 'warning').map((f) => `${f.check}: ${f.message}`),
        errors: report.ok ? [] : report.findings.filter((f) => f.severity === 'error').map((f) => `${f.check}: ${f.message}`),
      };
    }),

  search: (args) =>
    withWs(args, (ws) => {
      const q = args.positionals.join(' ');
      if (!q) return fail(['usage: kb search <query> [--scope chunks|claims|nodes|entities|all] [--limit N]']);
      const scope = (str(args.flags, 'scope') ?? 'all') as SearchScope;
      const limit = Number(str(args.flags, 'limit') ?? '20');
      return ok({ query: q, hits: search(ws.repos, q, { scope, limit }) });
    }),

  'ask-context': (args) =>
    withWs(args, (ws) => {
      const q = args.positionals.join(' ');
      if (!q) return fail(['usage: kb ask-context "<question>" [--limit N]']);
      const limit = Number(str(args.flags, 'limit') ?? '12');
      return ok(askContext(ws.repos, q, { limit }));
    }),

  'answer-check': (args) =>
    withWs(args, (ws) => {
      const payload = AnswerCheckSchema.parse(readPayload(args.flags));
      const result = answerCheck(ws.repos, payload.answer, payload.claim_ids);
      return { ok: result.ok, data: result, warnings: [], errors: result.ok ? [] : ['answer has unsupported or uncited assertions'] };
    }),

  provenance: (args) =>
    withWs(args, (ws) => {
      const id = args.positionals[0];
      if (!id) return fail(['usage: kb provenance <claim_id>']);
      const claim = ws.repos.claims.getById(makeClaimId(id));
      if (!claim) return fail([`unknown claim ${id}`]);
      const spans = ws.repos.claimSpans.spansForClaim(claim.id).map((s) => {
        const src = ws.repos.sources.getById(s.sourceId);
        return { quote: s.quote, charStart: s.charStart, charEnd: s.charEnd, sourceTitle: src?.title, storedPath: src?.storedPath };
      });
      return ok({ claim, provenance: spans });
    }),

  'entity show': (args) =>
    withWs(args, (ws) => {
      const id = args.positionals[0];
      if (!id) return fail(['usage: kb entity show <entity_id>']);
      const list = ws.repos.entities.listAll().find((e) => e.id === id);
      if (!list) return fail([`unknown entity ${id}`]);
      return ok({ entity: list, relationships: ws.repos.relationships.listByEntity(list.id) });
    }),
};

function resolveCommand(positionals: string[]): { cmd: string; rest: string[] } {
  const first = positionals[0] ?? '';
  if (TWO_WORD.has(first) && positionals[1]) {
    return { cmd: `${first} ${positionals[1]}`, rest: positionals.slice(2) };
  }
  return { cmd: first, rest: positionals.slice(1) };
}

function main(): void {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const json = parsed.flags.json === true;
  const { cmd, rest } = resolveCommand(parsed.positionals);

  if (!cmd) {
    emit(ok(globalHelp()), json);
    return;
  }

  if (parsed.flags.help) {
    const help = commandHelp[cmd];
    if (help) {
      emit(ok(help), json);
      return;
    }
    emit(fail([`unknown command: ${cmd}`, `known: ${Object.keys(handlers).sort().join(', ')}`]), json);
    process.exitCode = 1;
    return;
  }

  const handler = handlers[cmd];
  if (!handler) {
    emit(fail([`unknown command: ${cmd}`, `known: ${Object.keys(handlers).sort().join(', ')}`]), json);
    process.exitCode = 1;
    return;
  }

  try {
    const env = handler({ positionals: rest, flags: parsed.flags });
    emit(env, json);
    if (!env.ok) process.exitCode = 1;
  } catch (e) {
    if (e instanceof z.ZodError) {
      emit(fail(e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)), json);
    } else {
      emit(fail([(e as Error).message]), json);
    }
    process.exitCode = 1;
  }
}

main();
