import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDb, type Db } from '../db/connection.js';
import { migrate, assertSchemaCompatible } from '../db/migrate.js';
import { Repositories } from '../db/repositories/index.js';
import { FsSourceStore } from '../ingest/sourceStore.js';
import { systemClock, type ServiceContext } from '../domain/services/context.js';
import { IngestService } from '../domain/services/ingestService.js';
import { ClaimService } from '../domain/services/claimService.js';
import { GraphService } from '../domain/services/graphService.js';
import { NodeService } from '../domain/services/nodeService.js';
import { DomainIssueError } from '../domain/issueCodes.js';

export const DB_FILENAME = 'kb.sqlite';

/** An open knowledge base: its connection, repositories, and services. */
export interface Workspace {
  root: string;
  db: Db;
  repos: Repositories;
  ctx: ServiceContext;
  ingest: IngestService;
  claims: ClaimService;
  graph: GraphService;
  nodes: NodeService;
  close(): void;
}

/** How the KB root was resolved (Phase 5 §5) — surfaced by `kb status` so a wrong-KB mistake shows in preflight. */
export type KbRootVia = 'flag' | 'env' | 'walk-up';

/** Which of the three resolution paths `resolveKbRoot` takes for these inputs. */
export function kbRootVia(explicit?: string, env: NodeJS.ProcessEnv = process.env): KbRootVia {
  if (explicit) return 'flag';
  if (env.KB_DIR) return 'env';
  return 'walk-up';
}

/**
 * Find the KB root: an explicit dir, else the `KB_DIR` env var, else walk up from
 * `cwd` looking for a `kb.sqlite`, else `cwd`.
 */
export function resolveKbRoot(cwd: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return resolve(cwd, explicit);
  if (env.KB_DIR) return resolve(cwd, env.KB_DIR);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, DB_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}

function repeatedPathSuffix(root: string): string | undefined {
  const parts = resolve(root).split(/[\\/]+/).filter(Boolean);
  for (let length = Math.floor(parts.length / 2); length >= 2; length--) {
    const suffix = parts.slice(-length).join('/');
    const previous = parts.slice(-2 * length, -length).join('/');
    if (suffix === previous) return suffix;
  }
  return undefined;
}

export function kbRootWarnings(root: string): string[] {
  const suffix = repeatedPathSuffix(root);
  if (!suffix) return [];
  return [
    `Resolved KB root "${root}" contains repeated path suffix "${suffix}". Check --kb/KB_DIR; if using KB_DIR, prefer an absolute KB_DIR so later cd commands cannot rebase it.`,
  ];
}

function build(root: string, db: Db, now: () => string): Workspace {
  const repos = new Repositories(db);
  const ctx: ServiceContext = { repos, store: new FsSourceStore(root), now };
  return {
    root,
    db,
    repos,
    ctx,
    ingest: new IngestService(ctx),
    claims: new ClaimService(ctx),
    graph: new GraphService(ctx),
    nodes: new NodeService(ctx),
    close: () => db.close(),
  };
}

/** Open an existing KB (must contain kb.sqlite). Applies pending migrations. */
export function openWorkspace(root: string, now: () => string = systemClock): Workspace {
  const dbPath = join(root, DB_FILENAME);
  if (!existsSync(dbPath)) {
    // A coded diagnostic, not a bare Error: the CLI maps it to the `NO_KB` issue (and its
    // registry hint) by CODE (01 §1.4) — never by matching this message text.
    throw new DomainIssueError('NO_KB', `No knowledge base at ${root} (missing ${DB_FILENAME}). Run "kb init" first.`, {
      ids: [root],
    });
  }
  const db = openDb(dbPath);
  assertSchemaCompatible(db);
  migrate(db);
  return build(root, db, now);
}

export interface InitResult {
  root: string;
  created: boolean;
}

/** Create a new KB at `root` (idempotent: re-running on an existing KB is a no-op migrate). */
export function initWorkspace(root: string, now: () => string = systemClock): { ws: Workspace; result: InitResult } {
  const abs = resolve(root);
  const existed = existsSync(join(abs, DB_FILENAME));
  mkdirSync(abs, { recursive: true });
  mkdirSync(join(abs, 'sources'), { recursive: true });
  mkdirSync(join(abs, 'kb'), { recursive: true });
  const db = openDb(join(abs, DB_FILENAME));
  migrate(db);
  const ws = build(abs, db, now);
  return { ws, result: { root: abs, created: !existed } };
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
