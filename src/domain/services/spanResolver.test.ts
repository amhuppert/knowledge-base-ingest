import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { resolveSpanCandidate, persistSpan } from './spanResolver.js';
import type { SourceId } from '../ids.js';
import type { SpanRef } from '../schemas/agent.js';

/**
 * Unit tests for the span-resolution split (03 §4.1). `resolveSpanCandidate` is
 * READ-ONLY: it locates + quote-verifies the reference and reports whether that
 * exact (source, range) span already exists, so a service can classify an input as
 * created/updated/unchanged BEFORE any write. `persistSpan` is the ONLY writer and
 * inserts iff the candidate has no existing span. Quote verification semantics are
 * byte-identical to the pre-split resolver (locked architecture).
 */

const DOC = ['# Cache', '', '## Redis', '', 'The widget service caches results in Redis for low latency.'].join('\n');

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

function seed(ctx: ServiceContext, repos: Repositories): { sourceId: SourceId; chunkId: string } {
  const sourceId = new IngestService(ctx)
    .ingest({ bytes: Buffer.from(DOC, 'utf8'), ext: 'md', mediaType: 'text/markdown', originalPath: 'cache.md' })
    .source.id;
  const chunkId = repos.chunks.listBySource(sourceId).find((c) => c.text.includes('caches results in Redis'))!.id;
  return { sourceId, chunkId };
}

const NOW = '2026-06-14T00:01:00.000Z';

describe('resolveSpanCandidate / persistSpan (03 §4.1)', () => {
  it('resolveSpanCandidate is read-only: a candidate for a not-yet-stored span has existingSpanId null and writes nothing', () => {
    const { ctx, repos } = makeCtx();
    const { sourceId, chunkId } = seed(ctx, repos);
    const text = repos.sourceTexts.get(sourceId)!;
    const ref: SpanRef = { chunk_id: chunkId as never, quote: 'caches results in Redis', role: 'supports', confidence: 0.9 };

    const cand = resolveSpanCandidate(repos, sourceId, text, ref);
    expect(cand.existingSpanId).toBeNull();
    expect(cand.quote).toBe('caches results in Redis');
    // Read-only: no span row appeared.
    expect(repos.spans.listBySource(sourceId)).toHaveLength(0);
  });

  it('persistSpan creates the span once; a later candidate carries its id and persistSpan re-uses it (no duplicate)', () => {
    const { ctx, repos } = makeCtx();
    const { sourceId, chunkId } = seed(ctx, repos);
    const text = repos.sourceTexts.get(sourceId)!;
    const ref: SpanRef = { chunk_id: chunkId as never, quote: 'caches results in Redis', role: 'supports', confidence: 0.9 };

    const first = persistSpan(repos, resolveSpanCandidate(repos, sourceId, text, ref), NOW);
    expect(repos.spans.listBySource(sourceId)).toHaveLength(1);

    // A fresh candidate for the SAME reference now reports the existing span's id...
    const cand2 = resolveSpanCandidate(repos, sourceId, text, ref);
    expect(cand2.existingSpanId).toBe(first);
    // ...and persisting it is a no-op that returns that same id.
    const second = persistSpan(repos, cand2, NOW);
    expect(second).toBe(first);
    expect(repos.spans.listBySource(sourceId)).toHaveLength(1);
  });

  it('a quote absent from the chunk still throws QUOTE_NOT_FOUND with the canonical path + chunk id', () => {
    const { ctx, repos } = makeCtx();
    const { sourceId, chunkId } = seed(ctx, repos);
    const text = repos.sourceTexts.get(sourceId)!;
    const ref: SpanRef = { chunk_id: chunkId as never, quote: 'not in the source at all', role: 'supports', confidence: 0.9 };

    let err: unknown;
    try {
      resolveSpanCandidate(repos, sourceId, text, ref, ['claims', 2, 'spans', 0]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: 'QUOTE_NOT_FOUND',
      path: 'claims[2].spans[0].quote',
      ids: [chunkId],
    });
  });

  it('a non-unique quote still throws QUOTE_AMBIGUOUS (verification semantics unchanged)', () => {
    const { ctx, repos } = makeCtx();
    const sourceId = new IngestService(ctx)
      .ingest({ bytes: Buffer.from('# T\n\nthe cache the cache the cache is warm.', 'utf8'), ext: 'md', mediaType: 'text/markdown' })
      .source.id;
    const chunkId = repos.chunks.listBySource(sourceId)[0]!.id;
    const text = repos.sourceTexts.get(sourceId)!;
    const ref: SpanRef = { chunk_id: chunkId as never, quote: 'the cache', role: 'supports', confidence: 0.9 };

    let err: unknown;
    try {
      resolveSpanCandidate(repos, sourceId, text, ref, ['claims', 0, 'spans', 0]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: 'QUOTE_AMBIGUOUS',
      path: 'claims[0].spans[0].quote',
    });
  });
});
