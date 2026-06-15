import type { ServiceContext } from './context.js';
import type { Source } from '../schemas/models.js';
import type { SourceId } from '../ids.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveSourceId } from '../algorithms/idDeriver.js';
import { normalizeSourceText, SOURCE_TEXT_EXTRACTOR, SOURCE_TEXT_EXTRACTOR_VERSION } from '../algorithms/normalize.js';
import { chunk, CHUNKER_VERSION } from '../algorithms/chunker.js';
import { deriveChunkId } from '../algorithms/idDeriver.js';

export interface IngestInput {
  bytes: Buffer;
  ext: string;
  mediaType: string;
  originalPath?: string;
  title?: string;
  sourceDate?: string;
  author?: string;
  versionLabel?: string;
  supersedes?: SourceId;
}

export interface IngestResult {
  source: Source;
  status: 'new' | 'duplicate';
  updated: boolean;
  chunks: number;
}

const TEXT_DECODE_ERROR =
  'V1 ingests UTF-8 text sources (markdown, code, plain text). For PDFs/binaries, extract text first and ingest that.';

export class IngestService {
  constructor(private readonly ctx: ServiceContext) {}

  ingest(input: IngestInput): IngestResult {
    const sha = sha256Hex(input.bytes);
    const existing = this.ctx.repos.sources.getBySha256(sha);

    if (existing) {
      // Idempotent: identical bytes already known. Update light metadata only.
      let updated = false;
      return this.ctx.repos.tx(() => {
        if (
          (input.title && input.title !== existing.title) ||
          (input.sourceDate && input.sourceDate !== existing.sourceDate)
        ) {
          this.ctx.repos.sources.updateMeta(existing.id, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.sourceDate !== undefined ? { sourceDate: input.sourceDate } : {}),
          });
          updated = true;
        }
        if (input.supersedes) this.ctx.repos.sources.setSupersedes(existing.id, input.supersedes);
        const refreshed = this.ctx.repos.sources.getById(existing.id)!;
        return {
          source: refreshed,
          status: 'duplicate' as const,
          updated,
          chunks: this.ctx.repos.chunks.listBySource(existing.id).length,
        };
      });
    }

    const text = this.decodeText(input);
    const canonical = normalizeSourceText(text);
    const sourceId = deriveSourceId(input.bytes);
    const storedPath = this.ctx.store.store(sourceId, input.ext, input.bytes);
    const now = this.ctx.now();
    const chunks = chunk(canonical);

    const title = input.title ?? deriveTitle(canonical, input.originalPath);

    const source: Source = {
      id: sourceId,
      sha256: sha,
      storedPath,
      originalPath: input.originalPath ?? null,
      title,
      mediaType: input.mediaType,
      byteSize: input.bytes.byteLength,
      sourceDate: input.sourceDate ?? null,
      author: input.author ?? null,
      versionLabel: input.versionLabel ?? null,
      supersedesSourceId: input.supersedes ?? null,
      status: 'active',
      metadataJson: '{}',
      ingestedAt: now,
    };

    return this.ctx.repos.tx(() => {
      this.ctx.repos.sources.insert(source);
      this.ctx.repos.sourceTexts.insert({
        sourceId,
        extractor: SOURCE_TEXT_EXTRACTOR,
        extractorVersion: SOURCE_TEXT_EXTRACTOR_VERSION,
        text: canonical,
        textHash: sha256Hex(canonical),
      });
      for (const c of chunks) {
        this.ctx.repos.chunks.insert({
          id: deriveChunkId(sourceId, c.chunkIndex),
          sourceId,
          chunkIndex: c.chunkIndex,
          headingPath: c.headingPath,
          text: c.text,
          charStart: c.charStart,
          charEnd: c.charEnd,
          tokenEstimate: c.tokenEstimate,
          contentHash: sha256Hex(c.text),
          chunkerVersion: CHUNKER_VERSION,
        });
      }
      if (input.supersedes) {
        this.ctx.repos.sources.setStatus(input.supersedes, 'superseded');
      }
      this.ctx.repos.changelog.append({
        ts: now,
        op: 'ingest',
        sourceId,
        summary: `Ingested "${title}" (${chunks.length} chunks)`,
        detail: { sha256: sha, chunks: chunks.length },
      });
      return { source, status: 'new' as const, updated: false, chunks: chunks.length };
    });
  }

  private decodeText(input: IngestInput): string {
    if (/pdf$/i.test(input.ext) || input.mediaType === 'application/pdf') {
      throw new Error(TEXT_DECODE_ERROR);
    }
    const text = input.bytes.toString('utf8');
    // Reject obvious binary: a NUL byte never appears in valid UTF-8 text sources.
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0) throw new Error(TEXT_DECODE_ERROR);
    return text;
  }
}

/** Best-effort title: first markdown H1, else first non-empty line, else filename. */
function deriveTitle(canonical: string, originalPath?: string): string {
  for (const line of canonical.split('\n')) {
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1) return h1[1]!.trim();
    if (line.trim()) return line.trim().slice(0, 120);
  }
  if (originalPath) return originalPath.split('/').pop() ?? originalPath;
  return 'Untitled source';
}
