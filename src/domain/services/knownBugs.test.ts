import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import { IngestService } from './ingestService.js';
import { ClaimService } from './claimService.js';
import { NodeService } from './nodeService.js';

/**
 * Known-bug pins (red now, flipped green by a later phase). These document the
 * DESIRED behavior of not-yet-implemented work so the fix has a ready assertion.
 */

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

/** The planted ambiguous-quote trap lives in the design-notes fixture. */
const AMBIGUOUS_QUOTE = 'The limit is enforced at the edge.';

describe('ambiguous quote yields a structured QUOTE_AMBIGUOUS issue', () => {
  // Phase 1 (03 §1, 01 §3.1) migrated spanResolver from a plain ProvenanceError to a
  // DomainIssueError carrying the authoritative shape `{ code, path?, ids?, details? }`.
  // The offending chunk id is asserted through `ids`, and the payload location through
  // the canonical `formatPath` path — never a bespoke field or a message substring.
  it('a claim apply with a non-unique span quote reports code+path+chunk id', () => {
    const { ctx, repos } = makeCtx();
    // Ingest the real fixture so the ambiguous "Constraints" chunk is exercised.
    const bytes = readFileSync(
      resolve(import.meta.dirname, '../../../fixtures/corpus/sources/design-notes.md'),
    );
    const src = new IngestService(ctx).ingest({
      bytes,
      ext: 'md',
      mediaType: 'text/markdown',
      originalPath: 'design-notes.md',
    }).source.id;
    const node = new NodeService(ctx).createNode({ parentId: null, title: 'Constraints', kind: 'root' }).node;
    const chunk = repos.chunks.listBySource(src).find((c) => c.text.includes(AMBIGUOUS_QUOTE));
    expect(chunk).toBeDefined();

    let err: unknown;
    try {
      new ClaimService(ctx).apply({
        source_id: src,
        claims: [
          {
            node_id: node.id,
            text: AMBIGUOUS_QUOTE,
            claim_type: 'fact',
            confidence: 0.9,
            spans: [{ chunk_id: chunk!.id, quote: AMBIGUOUS_QUOTE, role: 'supports', confidence: 0.9 }],
          },
        ],
      });
    } catch (e) {
      err = e;
    }

    // The apply MUST reject the ambiguous quote — that part is already true.
    expect(err).toBeDefined();
    // ...but the rejection must be a STRUCTURED issue, not an opaque message.
    // Shape is the authoritative DomainIssueError contract (01 §3.1, 03 §1):
    // { code, path?, ids?, details? } — the offending chunk id lives in `ids`.
    expect(err).toMatchObject({
      code: 'QUOTE_AMBIGUOUS',
      path: 'claims[0].spans[0].quote',
      ids: expect.arrayContaining([expect.stringMatching(/^chk_/)]),
    });
  });
});
