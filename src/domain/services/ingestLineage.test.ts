import { describe, it, expect } from 'vitest';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { Repositories } from '../../db/repositories/index.js';
import { MemorySourceStore } from '../../ingest/sourceStore.js';
import type { ServiceContext } from './context.js';
import {
  IngestService,
  correctedTranscriptionRecipe,
  parseExtractorRef,
  type IngestInput,
  type TextSidecar,
} from './ingestService.js';
import { DomainIssueError } from '../issueCodes.js';
import { KNOWN_BINARY_EXTENSIONS } from '../algorithms/media.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveSourceId } from '../algorithms/idDeriver.js';

/**
 * PHASE 4 — media policy and source lineage at the SERVICE level (06 §1).
 *
 * The original bytes own source identity; a sidecar supplies the canonical text.
 * Known-binary extensions are gated behind `--text-from` even when their bytes
 * happen to decode; everything else decodes strictly (fatal UTF-8 + NUL guard).
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
    now: () => `2026-07-24T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  return { ctx, repos };
}

function input(text = DOC, extra: Partial<IngestInput> = {}): IngestInput {
  return {
    bytes: Buffer.from(text, 'utf8'),
    ext: 'md',
    mediaType: 'text/markdown',
    originalPath: 'auth.md',
    ...extra,
  };
}

/** Assert `fn` throws a DomainIssueError with `code`, returning it for further checks. */
function expectIssue(fn: () => unknown, code: string): DomainIssueError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainIssueError);
    expect((err as DomainIssueError).code).toBe(code);
    return err as DomainIssueError;
  }
  expect.unreachable(`expected a ${code} DomainIssueError`);
}

describe('media policy (06 §1.1)', () => {
  it('gates EVERY known-binary extension behind --text-from, even when the bytes decode', () => {
    for (const ext of KNOWN_BINARY_EXTENSIONS) {
      const { ctx } = makeCtx();
      // Deliberately UTF-8-decodable bytes: the gate is the extension, not the content.
      const err = expectIssue(
        () => new IngestService(ctx).plan(input(DOC, { ext, originalPath: `report.${ext}`, mediaType: 'application/octet-stream' })),
        'UNSUPPORTED_MEDIA',
      );
      expect(err.message, ext).toContain('--text-from');
    }
  });

  it('rejects malformed UTF-8 instead of silently substituting U+FFFD', () => {
    const { ctx } = makeCtx();
    const err = expectIssue(
      () => new IngestService(ctx).plan(input('', { bytes: Buffer.from([0xff, 0xfe, 0x41]), ext: 'md' })),
      'UNSUPPORTED_MEDIA',
    );
    expect(err.message).toContain('--text-from');
  });

  it('accepts an UNKNOWN extension whose bytes are UTF-8 text (unchanged behavior)', () => {
    const { ctx, repos } = makeCtx();
    const r = new IngestService(ctx).ingest(input(DOC, { ext: 'weird', originalPath: 'notes.weird', mediaType: 'text/plain' }));
    expect(r.status).toBe('new');
    expect(r.chunks).toBeGreaterThan(0);
    expect(repos.sourceTexts.get(r.source.id)!.text).toContain('rotates refresh tokens');
  });

  it('the native path records extractor text-utf8/1', () => {
    const { ctx, repos } = makeCtx();
    const r = new IngestService(ctx).ingest(input());
    const text = repos.sourceTexts.get(r.source.id)!;
    expect(text.extractor).toBe('text-utf8');
    expect(text.extractorVersion).toBe(1);
    expect(r.text).toEqual({ extractor: 'text-utf8/1', verification: 'none', textHash: text.textHash });
  });
});

// --------------------------------------------------------------------------
// derived sources (06 §1.2–§1.4)
// --------------------------------------------------------------------------

const TRANSCRIPT = '# Widget Report\n\nThe widget service caches rendered results in Redis.\n';
/** Bytes that are NOT text — only the sidecar can supply canonical text for them. */
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0x01, 0xff]);

function sidecar(text = TRANSCRIPT, path = 'report.extracted.md'): TextSidecar {
  return { path, text, fileHash: sha256Hex(Buffer.from(text, 'utf8')) };
}

function derivedInput(extra: Partial<IngestInput> = {}): IngestInput {
  return {
    bytes: PDF_BYTES,
    ext: 'pdf',
    mediaType: 'application/pdf',
    originalPath: 'report.pdf',
    sidecar: sidecar(),
    ...extra,
  };
}

describe('parseExtractorRef (06 §1.2 — name/<decimal integer>)', () => {
  it('accepts a lowercase name with a decimal version and splits it', () => {
    expect(parseExtractorRef('agent-transcription/1')).toEqual({ name: 'agent-transcription', version: 1 });
    expect(parseExtractorRef('pdf2text/17')).toEqual({ name: 'pdf2text', version: 17 });
  });

  it('rejects anything the two columns cannot hold', () => {
    for (const bad of ['agent-transcription', 'agent-transcription/1.2', 'Agent/1', '1agent/1', 'agent/v1', 'agent//1', 'agent/-1', '']) {
      expect(parseExtractorRef(bad), bad).toBeNull();
    }
  });
});

describe('derived path (06 §1.2–§1.3)', () => {
  it('takes identity from the ORIGINAL bytes and canonical text from the sidecar', () => {
    const { ctx, repos } = makeCtx();
    const r = new IngestService(ctx).ingest(derivedInput());

    expect(r.source.id).toBe(deriveSourceId(PDF_BYTES));
    expect(r.source.sha256).toBe(sha256Hex(PDF_BYTES));
    expect(r.source.byteSize).toBe(PDF_BYTES.byteLength);
    expect(r.source.mediaType).toBe('application/pdf');
    // Title derives from the SIDECAR text, not the original filename.
    expect(r.source.title).toBe('Widget Report');

    const text = repos.sourceTexts.get(r.source.id)!;
    expect(text.text).toBe(TRANSCRIPT);
    expect(text.textHash).toBe(sha256Hex(TRANSCRIPT));
    // The extractor is SPLIT across the two existing columns (no migration).
    expect(text.extractor).toBe('agent-transcription');
    expect(text.extractorVersion).toBe(1);
    expect(r.text.extractor).toBe('agent-transcription/1');
    expect(repos.chunks.listBySource(r.source.id).length).toBeGreaterThan(0);
  });

  it('records the extraction metadata block and honours an explicit extractor + verification', () => {
    const { ctx, repos } = makeCtx();
    const r = new IngestService(ctx).ingest(
      derivedInput({ extractor: { name: 'pdf-text', version: 3 }, verification: 'visual' }),
    );
    const text = repos.sourceTexts.get(r.source.id)!;
    expect([text.extractor, text.extractorVersion]).toEqual(['pdf-text', 3]);
    expect(JSON.parse(r.source.metadataJson).extraction).toEqual({
      method: 'pdf-text/3',
      verification: 'visual',
      textFileHash: sha256Hex(Buffer.from(TRANSCRIPT, 'utf8')),
      textFilePath: 'report.extracted.md',
    });
    expect(r.text).toEqual({ extractor: 'pdf-text/3', verification: 'visual', textHash: text.textHash });
  });
});

describe('extraction immutability (06 §1.4)', () => {
  it('accepts an exact repeat of the same original + same sidecar as a plain duplicate', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    const first = svc.ingest(derivedInput());
    const again = svc.ingest(derivedInput());
    expect(again.status).toBe('duplicate');
    expect(again.source.id).toBe(first.source.id);
  });

  it('ALWAYS rejects the same original with different sidecar text, carrying the recovery recipe', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    const first = svc.ingest(derivedInput());
    const err = expectIssue(
      () => svc.plan(derivedInput({ sidecar: sidecar(`${TRANSCRIPT}\nA corrected sentence.\n`) })),
      'INVALID_ARGUMENT',
    );
    expect(err.hint).toBe(correctedTranscriptionRecipe(first.source.id, first.source.title, 'report.pdf'));
    expect(err.hint).toContain('--supersedes');
    expect(err.ids).toEqual([first.source.id]);
  });

  it('rejects a re-ingest that changes the extractor or the sidecar path (extraction is immutable)', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    svc.ingest(derivedInput());
    expectIssue(() => svc.plan(derivedInput({ extractor: { name: 'pdf-text', version: 3 } })), 'INVALID_ARGUMENT');
    expectIssue(() => svc.plan(derivedInput({ sidecar: sidecar(TRANSCRIPT, 'other.md') })), 'INVALID_ARGUMENT');
  });

  it('rejects attaching a sidecar to a source that was ingested natively', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    svc.ingest(input(TRANSCRIPT));
    expectIssue(
      () => svc.plan(input(TRANSCRIPT, { sidecar: sidecar(TRANSCRIPT) })),
      'INVALID_ARGUMENT',
    );
  });

  it('preserves unknown metadata keys verbatim through a duplicate origin update (passthrough)', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const first = svc.ingest(derivedInput({ origin: { system: 'notion' } }));

    // A key this tool never writes — e.g. left by another tool or a future version.
    const withExtra = JSON.parse(first.source.metadataJson) as Record<string, unknown>;
    withExtra['custom'] = { importedBy: 'legacy-loader', tags: ['a', 'b'] };
    repos.sources.updateMetadata(first.source.id, JSON.stringify(withExtra));

    const { sidecar: _dropped, ...withoutSidecar } = derivedInput();
    const dup = svc.ingest({ ...withoutSidecar, origin: { url: 'https://example.com/doc' } });
    expect(dup.status).toBe('duplicate');
    expect(dup.updated).toBe(true);

    const metadata = JSON.parse(dup.source.metadataJson);
    expect(metadata.custom).toEqual({ importedBy: 'legacy-loader', tags: ['a', 'b'] });
    // origin PATCH-merges: the supplied url is added, the untouched system survives.
    expect(metadata.origin).toEqual({ system: 'notion', url: 'https://example.com/doc' });
    // extraction is untouched by an origin update.
    expect(metadata.extraction.method).toBe('agent-transcription/1');
  });

  it('reports updated:false when a duplicate carries no metadata changes at all', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    svc.ingest(derivedInput({ origin: { system: 'notion' } }));
    const dup = svc.ingest(derivedInput({ origin: { system: 'notion' } }));
    expect(dup.status).toBe('duplicate');
    expect(dup.updated).toBe(false);
  });

  it('leaves a duplicate WITHOUT a sidecar on the ordinary duplicate path', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    const first = svc.ingest(derivedInput());
    const { sidecar: _dropped, ...withoutSidecar } = derivedInput();
    const plain = svc.ingest({ ...withoutSidecar, title: 'Renamed report' });
    expect(plain.status).toBe('duplicate');
    expect(plain.updated).toBe(true);
    expect(plain.source.title).toBe('Renamed report');
    expect(plain.source.id).toBe(first.source.id);
    expect(plain.text.extractor).toBe('agent-transcription/1');
  });
});

// --------------------------------------------------------------------------
// concurrency (03 §5 recheck × 06 §1.4/§2)
//
// `plan` reads OUTSIDE the write lock, so every row it saw may have changed by the
// time `commit` takes `BEGIN IMMEDIATE`. Splitting plan/commit makes that window
// reachable deterministically: interleave a second ingest between the two calls.
// The §1.4 immutability rule and the §2 patch-merge must both be enforced against
// the row as it exists INSIDE the transaction, never against the copy `plan` read.
// --------------------------------------------------------------------------

describe('concurrent duplicates (06 §1.4, §2 under the BEGIN IMMEDIATE recheck)', () => {
  it('rejects a losing sidecar that differs from the concurrent winner’s', () => {
    const { ctx, repos } = makeCtx();
    const store = ctx.store as MemorySourceStore;
    const svc = new IngestService(ctx);
    // The loser plans while no row exists — it plans as `new` and never sees the winner.
    const losing = svc.plan(derivedInput({ sidecar: sidecar(`${TRANSCRIPT}\nA corrected sentence.\n`) }));
    expect(losing.kind).toBe('new');

    // A concurrent writer wins the row race with a DIFFERENT transcription.
    const winner = svc.ingest(derivedInput());

    // §1.4 is "always rejected": winning the race must not launder a second extraction in.
    const err = expectIssue(() => svc.commit(losing), 'INVALID_ARGUMENT');
    expect(err.hint).toBe(correctedTranscriptionRecipe(winner.source.id, winner.source.title, 'report.pdf'));
    expect(err.ids).toEqual([winner.source.id]);
    // The winner's canonical text is untouched by the rejected loser, and the loser's
    // post-failure cleanup does not take the winner's stored original with it (03 §5:
    // the loser removes a file only when IT created one).
    expect(repos.sourceTexts.get(winner.source.id)!.text).toBe(TRANSCRIPT);
    expect(store.has(winner.source.storedPath)).toBe(true);
  });

  it('applies the metadata patch-merge to a concurrent winner and reports updated:true', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    const losing = svc.plan(derivedInput({ title: 'Renamed report', origin: { url: 'https://example.com/doc' } }));
    expect(losing.kind).toBe('new');

    const winner = svc.ingest(derivedInput({ origin: { system: 'notion' } }));

    const result = svc.commit(losing);
    expect(result.status).toBe('duplicate');
    expect(result.source.id).toBe(winner.source.id);
    // A concurrent winner is still a duplicate re-ingest: its updates must land (§2).
    expect(result.updated).toBe(true);
    expect(result.source.title).toBe('Renamed report');
    expect(JSON.parse(result.source.metadataJson).origin).toEqual({
      system: 'notion',
      url: 'https://example.com/doc',
    });
    expect(result.text.extractor).toBe('agent-transcription/1');
  });

  it('reports updated:false for a concurrent winner that carries no metadata changes', () => {
    const { ctx } = makeCtx();
    const svc = new IngestService(ctx);
    const losing = svc.plan(derivedInput());
    expect(losing.kind).toBe('new');
    svc.ingest(derivedInput());
    const result = svc.commit(losing);
    expect(result.status).toBe('duplicate');
    expect(result.updated).toBe(false);
  });

  it('merges origin against the row inside the transaction, not the copy plan read', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const first = svc.ingest(derivedInput({ origin: { system: 'notion' } }));
    const { sidecar: _dropped, ...withoutSidecar } = derivedInput();

    // A duplicate plan is prepared against the metadata as it reads NOW...
    const pending = svc.plan({ ...withoutSidecar, origin: { url: 'https://example.com/doc' } });
    expect(pending.kind).toBe('duplicate');

    // ...then a concurrent writer patches a different origin key and an unknown key.
    const intervening = JSON.parse(first.source.metadataJson) as Record<string, unknown>;
    intervening['origin'] = { system: 'notion', externalId: 'PAGE-42' };
    intervening['custom'] = { importedBy: 'legacy-loader' };
    repos.sources.updateMetadata(first.source.id, JSON.stringify(intervening));

    // Committing the pending plan patches its own key without resurrecting the stale read.
    const result = svc.commit(pending);
    expect(JSON.parse(result.source.metadataJson)).toMatchObject({
      origin: { system: 'notion', externalId: 'PAGE-42', url: 'https://example.com/doc' },
      custom: { importedBy: 'legacy-loader' },
      extraction: { method: 'agent-transcription/1' },
    });
  });

  it('rejects a pending duplicate whose extraction was made stale by an intervening write', () => {
    const { ctx, repos } = makeCtx();
    const svc = new IngestService(ctx);
    const first = svc.ingest(derivedInput());

    // Planned when the recorded extraction still matched this exact sidecar...
    const pending = svc.plan(derivedInput());
    expect(pending.kind).toBe('duplicate');

    // ...but the row's extraction block reads differently by commit time.
    const rewritten = JSON.parse(first.source.metadataJson) as Record<string, unknown>;
    (rewritten['extraction'] as Record<string, unknown>)['method'] = 'pdf-text/3';
    repos.sources.updateMetadata(first.source.id, JSON.stringify(rewritten));

    expectIssue(() => svc.commit(pending), 'INVALID_ARGUMENT');
  });
});
