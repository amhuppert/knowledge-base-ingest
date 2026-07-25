import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService, type IngestInput, type IngestPlan } from './ingestService.js';
import { DomainIssueError } from '../issueCodes.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveSourceId } from '../algorithms/idDeriver.js';
import type { Source } from '../schemas/models.js';

/**
 * INGEST SPLIT — prepare / plan / commit (03 §5, findings 19–20).
 *
 * `plan` is read-only and computes sha256 BEFORE decoding, so a duplicate never runs
 * `prepareContent` (the decode). `commit` stores the file first (capturing `created`),
 * re-checks the duplicate inside `BEGIN IMMEDIATE`, and on a transaction failure removes
 * the file it created — cleaning up an orphan while leaving a pre-existing file (and a
 * concurrent winner's file) untouched.
 */

const DOC = '# Auth\n\nThe auth service rotates refresh tokens on every use.\n';

function makeCtx(): { ctx: ServiceContext; repos: Repositories } {
  const db = openDb(':memory:');
  migrate(db);
  const repos = new Repositories(db);
  let tick = 0;
  const ctx: ServiceContext = {
    repos,
    store: new MemorySourceStore(),
    now: () => `2026-06-14T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  return { ctx, repos };
}

function input(text = DOC, extra: Partial<IngestInput> = {}): IngestInput {
  return { bytes: Buffer.from(text, 'utf8'), ext: 'md', mediaType: 'text/markdown', originalPath: 'auth.md', ...extra };
}

function throwing(msg: string): () => never {
  return () => {
    throw new Error(msg);
  };
}

describe('IngestService.plan (read-only, sha-before-decode)', () => {
  it('a NEW source plans with prepared content and runs prepareContent exactly once', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    const spy = vi.spyOn(svc, 'prepareContent');
    const plan = svc.plan(input());
    expect(plan.kind).toBe('new');
    expect(spy).toHaveBeenCalledTimes(1);
    if (plan.kind === 'new') {
      expect(plan.prepared.title).toBe('Auth');
      expect(plan.prepared.chunks.length).toBeGreaterThan(0);
      expect(plan.sha).toBe(sha256Hex(input().bytes));
    }
  });

  it('a DUPLICATE never decodes — plan checks getBySha256 before prepareContent (spy test)', () => {
    const { ctx } = makeCtx();
    // First ingest establishes the source.
    new IngestService(ctx).ingest(input());
    // Second plan on identical bytes must resolve as duplicate WITHOUT decoding.
    const svc = new IngestService(ctx);
    const spy = vi.spyOn(svc, 'prepareContent');
    const plan = svc.plan(input());
    expect(plan.kind).toBe('duplicate');
    expect(spy).not.toHaveBeenCalled();
  });

  it('plan performs zero writes (no source row created by planning a new input)', () => {
    const { ctx, repos } = makeCtx();
    new IngestService(ctx).plan(input());
    expect(repos.sources.listAll()).toHaveLength(0);
  });
});

describe('IngestService.prepareContent (pure) + decode policy', () => {
  it('a decode failure throws a DomainIssueError coded UNSUPPORTED_MEDIA wrapping the current message', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    try {
      svc.plan(input('ignored', { bytes: Buffer.from([0x00, 0x01, 0x02]), ext: 'bin', mediaType: 'application/octet-stream' }));
      expect.unreachable('decode should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainIssueError);
      expect((err as DomainIssueError).code).toBe('UNSUPPORTED_MEDIA');
      expect((err as Error).message).toMatch(/UTF-8 text/);
    }
  });
});

describe('IngestService.commit (store-first, re-check, cleanup)', () => {
  it('a new commit inserts the source, its text, and chunks', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const r = svc.commit(svc.plan(input()));
    expect(r.status).toBe('new');
    expect(repos.sources.listAll()).toHaveLength(1);
    expect(repos.sourceTexts.get(r.source.id)?.text).toBe(DOC);
    expect(repos.chunks.listBySource(r.source.id).length).toBe(r.chunks);
  });

  it('an injected transaction failure removes the file it CREATED, then rethrows', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const plan = svc.plan(input());
    const storeSpy = vi.spyOn(ctx.store, 'store');
    repos.changelog.append = throwing('injected tx failure') as never;
    expect(() => svc.commit(plan)).toThrow(/injected tx failure/);
    const { storedPath, created } = storeSpy.mock.results[0]!.value as { storedPath: string; created: boolean };
    expect(created).toBe(true);
    expect(ctx.store.has(storedPath)).toBe(false); // orphan removed
    expect(repos.sources.listAll()).toHaveLength(0);
  });

  it('a PRE-EXISTING file (created:false) is left in place when the transaction fails', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const plan = svc.plan(input());
    if (plan.kind !== 'new') throw new Error('expected new plan');
    // Pre-create the content-addressed file so commit's store() reports created:false.
    const { storedPath } = ctx.store.store(plan.sourceId, plan.input.ext, plan.input.bytes);
    repos.changelog.append = throwing('injected tx failure') as never;
    expect(() => svc.commit(plan)).toThrow(/injected tx failure/);
    expect(ctx.store.has(storedPath)).toBe(true); // NOT removed — commit did not create it
  });

  it('a cleanup failure is tolerated: the commit error stays primary, cleanup becomes a warning', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const plan = svc.plan(input());
    repos.changelog.append = throwing('injected tx failure') as never;
    ctx.store.remove = throwing('cleanup boom') as never;
    try {
      svc.commit(plan);
      expect.unreachable('commit should have thrown');
    } catch (err) {
      // The ORIGINAL transaction error is primary (not the cleanup error).
      expect((err as Error).message).toMatch(/injected tx failure/);
      expect((err as { cleanupWarning?: string }).cleanupWarning).toMatch(/cleanup boom/);
    }
  });

  /** A concurrent winner row with the same content identity, stored at `storedPath`. */
  function winnerRow(plan: Extract<IngestPlan, { kind: 'new' }>, storedPath: string): Source {
    return {
      id: plan.sourceId,
      sha256: plan.sha,
      storedPath,
      originalPath: null,
      title: 'Concurrent winner',
      mediaType: 'text/markdown',
      byteSize: plan.input.bytes.byteLength,
      sourceDate: null,
      author: null,
      versionLabel: null,
      supersedesSourceId: null,
      status: 'active',
      metadataJson: '{}',
      ingestedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('ordinary concurrent winner (same path, created:false) returns duplicate and deletes nothing', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const plan = svc.plan(input());
    if (plan.kind !== 'new') throw new Error('expected new plan');
    // The winner stored the file at the SAME content-addressed path and inserted its row.
    const { storedPath } = ctx.store.store(plan.sourceId, plan.input.ext, plan.input.bytes);
    repos.sources.insert(winnerRow(plan, storedPath));

    const storeSpy = vi.spyOn(ctx.store, 'store');
    const r = svc.commit(plan);
    expect(r.status).toBe('duplicate');
    expect(r.source.id).toBe(plan.sourceId);
    // Same extension => same path => commit's store() saw created:false, so nothing is removed.
    const loser = storeSpy.mock.results[0]!.value as { storedPath: string; created: boolean };
    expect(loser.created).toBe(false);
    expect(ctx.store.has(storedPath)).toBe(true); // the winner's file is untouched
    expect(repos.sources.listAll()).toHaveLength(1); // no second row inserted
  });

  it('concurrent winner under a DIFFERENT extension: the loser removes its own created:true orphan, keeps the winner', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    // The loser arrives as `.md`; the winner stored the identical bytes as `.txt` first.
    const plan = svc.plan(input(DOC, { ext: 'md' }));
    if (plan.kind !== 'new') throw new Error('expected new plan');
    const winner = ctx.store.store(plan.sourceId, 'txt', plan.input.bytes);
    expect(winner.created).toBe(true);
    repos.sources.insert(winnerRow(plan, winner.storedPath));

    const storeSpy = vi.spyOn(ctx.store, 'store');
    const r = svc.commit(plan);
    expect(r.status).toBe('duplicate');
    const loser = storeSpy.mock.results[0]!.value as { storedPath: string; created: boolean };
    // Different extension => different path => the loser genuinely created a new file...
    expect(loser.created).toBe(true);
    expect(loser.storedPath).not.toBe(winner.storedPath);
    // ...which is now unreferenced and MUST be removed (03 §5), while the winner file stays.
    expect(ctx.store.has(loser.storedPath)).toBe(false);
    expect(ctx.store.has(winner.storedPath)).toBe(true);
    expect(repos.sources.listAll()).toHaveLength(1);
  });
});

describe('IngestService.ingest (plan + commit convenience)', () => {
  it('deriveSourceId matches the committed source id (identity is content-addressed)', () => {
    const { ctx } = makeCtx();
    const r = new IngestService(ctx).ingest(input());
    expect(r.source.id).toBe(deriveSourceId(input().bytes));
  });
});
