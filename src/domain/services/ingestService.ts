import type { ServiceContext } from './context.js';
import type { Source } from '../schemas/models.js';
import type { TextVerification } from '../schemas/enums.js';
import type { SourceId } from '../ids.js';
import { DomainIssueError } from '../issueCodes.js';
import { sha256Hex } from '../algorithms/hash.js';
import { deriveSourceId } from '../algorithms/idDeriver.js';
import { normalizeSourceText, SOURCE_TEXT_EXTRACTOR, SOURCE_TEXT_EXTRACTOR_VERSION } from '../algorithms/normalize.js';
import { chunk, CHUNKER_VERSION, type Chunk as ChunkPiece } from '../algorithms/chunker.js';
import { deriveChunkId } from '../algorithms/idDeriver.js';
import { decodeUtf8Strict, requiresTextSidecar, unsupportedMediaMessage } from '../algorithms/media.js';
import { shellQuoteArg } from '../algorithms/shellQuote.js';
import {
  mergeOrigin,
  parseSourceMetadata,
  serializeSourceMetadata,
  type SourceExtraction,
  type SourceMetadata,
  type SourceOrigin,
} from '../schemas/sourceMetadata.js';

export type { TextVerification };

/** A `name/version` extractor reference, split across the two `source_texts` columns. */
export interface ExtractorRef {
  /** The `extractor` TEXT column, e.g. `agent-transcription`. */
  name: string;
  /** The `extractor_version` INTEGER column. */
  version: number;
}

/**
 * A `--text-from` sidecar: the agent's transcription of an original the tool cannot
 * decode itself. The CLI reads and strictly decodes the file (raising
 * `TEXT_SIDECAR_INVALID`); the service only sees the decoded text plus the two facts
 * recorded in `metadata.extraction`.
 */
export interface TextSidecar {
  /** The sidecar path AS GIVEN (recorded as `metadata.extraction.textFilePath`). */
  path: string;
  /** The decoded sidecar text; normalization to canonical text happens here. */
  text: string;
  /** sha256 of the sidecar file BYTES as given (`metadata.extraction.textFileHash`). */
  fileHash: string;
}

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
  /**
   * The DERIVED path (06 §1.2): the original still owns identity (id + sha256 + the
   * stored bytes) while this sidecar supplies the canonical text, chunks, and title.
   */
  sidecar?: TextSidecar;
  /** `--extractor name/version`; defaults to `agent-transcription/1` with a sidecar. */
  extractor?: ExtractorRef;
  /** `--verification`; `none` unless the agent explicitly states `visual` (06 §2). */
  verification?: TextVerification;
  /** `--origin-*` flags; PATCH-merged into `metadata.origin` (06 §2). */
  origin?: SourceOrigin;
}

/** The canonical-text lineage of a source, as the ingest receipt reports it (06 §1.5). */
export interface TextLineage {
  /** The recombined `name/version` extractor label. */
  extractor: string;
  verification: TextVerification;
  textHash: string;
}

export interface IngestResult {
  source: Source;
  status: 'new' | 'duplicate';
  updated: boolean;
  chunks: number;
  /** The canonical-text lineage recorded for this source. */
  text: TextLineage;
}

/** Recombine the split extractor columns for display and `metadata.extraction.method`. */
export function extractorLabel(ref: ExtractorRef): string {
  return `${ref.name}/${ref.version}`;
}

/**
 * The `--extractor` grammar (06 §1.2). `source_texts` stores `extractor TEXT` +
 * `extractor_version INTEGER`, so the version must be a decimal integer — there is no
 * migration and no place to put `v2` or `1.2`.
 */
export const EXTRACTOR_REF_PATTERN = /^[a-z][a-z0-9-]*\/[0-9]+$/;

/** The default extractor for a sidecar-supplied text (06 §1.2). */
export const DEFAULT_SIDECAR_EXTRACTOR: ExtractorRef = { name: 'agent-transcription', version: 1 };

/**
 * Split a `name/version` extractor into its two columns, or `null` when it does not
 * match {@link EXTRACTOR_REF_PATTERN} (or the version exceeds exact integer range).
 * The CLI turns `null` into `INVALID_ARGUMENT` at parse time (exit 2).
 */
export function parseExtractorRef(value: string): ExtractorRef | null {
  if (!EXTRACTOR_REF_PATTERN.test(value)) return null;
  const slash = value.lastIndexOf('/');
  const version = Number(value.slice(slash + 1));
  if (!Number.isSafeInteger(version)) return null;
  return { name: value.slice(0, slash), version };
}

/**
 * The corrected-transcription recovery recipe (06 §1.4), verbatim-runnable. A source's
 * identity is its ORIGINAL bytes and its canonical text is immutable, so the same
 * original can never yield a second source — the fix is a NEW (byte-distinct) UTF-8
 * source that supersedes this one. The suggested filename sits beside the original so
 * the command runs as printed; the title is shell-quoted for the same reason.
 */
export function correctedTranscriptionRecipe(sourceId: SourceId, title: string, originalPath: string | null): string {
  const corrected = originalPath ? `${originalPath.replace(/\.[^./]*$/, '')}.extracted-v2.md` : 'report.extracted-v2.md';
  return [
    `Canonical text for ${sourceId} is immutable. To publish a corrected transcription:`,
    `  kb ingest ${shellQuoteArg(corrected)} --supersedes ${sourceId} --title ${shellQuoteArg(`${title} (corrected transcription)`)} --json`,
    'The corrected transcription file itself becomes a new UTF-8 source (byte-distinct, so it gets its own',
    'identity) that supersedes the derived source record. Re-extract claims from the new source; staleness',
    'will drive re-synthesis.',
  ].join('\n');
}

/**
 * The pure product of decoding an input (03 §5): canonical text, chunks, a derived
 * title, and the canonical text hash. No repos/store/clock — depends only on `input`,
 * so it can be computed for a preview without any state read or write.
 */
export interface PreparedContent {
  canonical: string;
  chunks: ChunkPiece[];
  title: string;
  textHash: string;
}

/** A duplicate input: identical bytes are already known; decoding is skipped entirely. */
export interface DuplicateIngestPlan {
  kind: 'duplicate';
  input: IngestInput;
  sha: string;
  /** The existing source id (== derived id for these bytes). */
  sourceId: SourceId;
  existing: Source;
}

/** A new input: prepared content is ready to commit. */
export interface NewIngestPlan {
  kind: 'new';
  input: IngestInput;
  sha: string;
  sourceId: SourceId;
  prepared: PreparedContent;
}

/** The read-only outcome of `plan` (03 §5) — a preview computes its receipt from this. */
export type IngestPlan = DuplicateIngestPlan | NewIngestPlan;

/**
 * A rethrown `commit` error may carry a note that cleaning up the orphaned file also
 * failed. The CLI boundary surfaces it as a WARNING while keeping the commit error the
 * primary error (03 §5). Domain-owned so no CLI type leaks into the service.
 */
export interface CommitErrorMeta {
  cleanupWarning?: string;
}

export class IngestService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Decode + normalize + chunk + title an input. PURE (no repos/store/clock reads or
   * writes) so a preview can prepare content without touching state. On the DERIVED
   * path the ORIGINAL bytes are never decoded — the sidecar text is the canonical text
   * and the title derives from it (06 §1.3). A native decode failure raises
   * `UNSUPPORTED_MEDIA` with the §1.5 recipe.
   */
  prepareContent(input: IngestInput): PreparedContent {
    const text = input.sidecar ? input.sidecar.text : this.decodeText(input);
    const canonical = normalizeSourceText(text);
    return {
      canonical,
      chunks: chunk(canonical),
      title: input.title ?? deriveTitle(canonical, input.originalPath),
      textHash: sha256Hex(canonical),
    };
  }

  /**
   * READ-ONLY: hash the raw bytes FIRST and check `getBySha256` BEFORE decoding, so a
   * duplicate never decodes (03 §5, finding 20). Only a NEW input runs `prepareContent`.
   * A duplicate carrying a sidecar is checked against the recorded extraction block
   * here, so `--dry-run` reports the §1.4 rejection too. Performs no writes.
   */
  plan(input: IngestInput): IngestPlan {
    const sha = sha256Hex(input.bytes);
    const existing = this.ctx.repos.sources.getBySha256(sha);
    if (existing) {
      this.assertExtractionUnchanged(input, existing);
      return { kind: 'duplicate', input, sha, sourceId: existing.id, existing };
    }
    return { kind: 'new', input, sha, sourceId: deriveSourceId(input.bytes), prepared: this.prepareContent(input) };
  }

  /**
   * The §1.4 rule: `extraction` is immutable after its first write, so re-ingesting the
   * same original with ANY different extraction — different sidecar text, extractor,
   * sidecar path, or verification, including attaching a sidecar to a natively decoded
   * source — is rejected. An EXACT repeat is a no-op and stays on the duplicate path.
   * The rejection carries the executable corrected-transcription recipe as its hint.
   */
  private assertExtractionUnchanged(input: IngestInput, existing: Source): void {
    if (!input.sidecar) return;
    const incoming = extractionBlockFor(input);
    const recorded = parseSourceMetadata(existing.metadataJson).extraction;
    if (recorded && JSON.stringify(recorded) === JSON.stringify(incoming)) return;
    throw new DomainIssueError(
      'INVALID_ARGUMENT',
      `${existing.id} already exists with these exact original bytes, and its canonical text cannot be replaced. ` +
        'A source\'s identity is its original bytes, so the same original can never yield a second source ' +
        '(not even with --supersedes).',
      { ids: [existing.id], hint: correctedTranscriptionRecipe(existing.id, existing.title, existing.originalPath) },
    );
  }

  /**
   * Persist a plan. A duplicate updates light metadata only (no store write). A new
   * plan stores the file FIRST (capturing `created`), then opens a `BEGIN IMMEDIATE`
   * transaction that RE-CHECKS `getBySha256` (concurrent-winner detection) before
   * inserting. On any transaction failure the file is removed IFF this call created it,
   * then the original error is rethrown; a failing cleanup is downgraded to a warning
   * carried on the rethrown error (03 §5).
   */
  commit(plan: IngestPlan): IngestResult {
    return plan.kind === 'duplicate' ? this.commitDuplicate(plan) : this.commitNew(plan);
  }

  /** Plan then commit in one call — the ordinary ingest entry point. */
  ingest(input: IngestInput): IngestResult {
    return this.commit(this.plan(input));
  }

  /**
   * The receipt's `text` block for an already-persisted source: the recombined
   * extractor from the split `source_texts` columns plus the recorded verification
   * (absent ⇒ `none`, the 06 §2 default).
   */
  private textLineageOf(sourceId: SourceId, source: Source): TextLineage {
    const row = this.ctx.repos.sourceTexts.get(sourceId);
    const extraction = parseSourceMetadata(source.metadataJson).extraction;
    return {
      extractor: row ? extractorLabel({ name: row.extractor, version: row.extractorVersion }) : '',
      verification: extraction?.verification ?? 'none',
      textHash: row?.textHash ?? '',
    };
  }

  private commitDuplicate(plan: DuplicateIngestPlan): IngestResult {
    return this.ctx.repos.tx(() => this.applyDuplicateUpdate(plan.input, plan.sourceId));
  }

  /**
   * The duplicate re-ingest, applied INSIDE `BEGIN IMMEDIATE`. Everything here reads the
   * row RE-FETCHED under the write lock, never the copy `plan` took outside it: a
   * concurrent writer may have changed the extraction block or patched a different
   * origin key since, and merging against the stale copy would silently revert it.
   *
   * Both duplicate routes land here — the plain one and `commitNew`'s concurrent-winner
   * recheck — so winning or losing a row race cannot change whether §1.4 immutability is
   * enforced or whether the §2 metadata patch is applied.
   */
  private applyDuplicateUpdate(input: IngestInput, sourceId: SourceId): IngestResult {
    const current = this.ctx.repos.sources.getById(sourceId)!;
    this.assertExtractionUnchanged(input, current);
    let updated = false;
    if (
      (input.title && input.title !== current.title) ||
      (input.sourceDate && input.sourceDate !== current.sourceDate)
    ) {
      this.ctx.repos.sources.updateMeta(sourceId, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.sourceDate !== undefined ? { sourceDate: input.sourceDate } : {}),
      });
      updated = true;
    }
    // Origin PATCH-merge (06 §2): read-modify-write, so only the supplied `--origin-*`
    // keys are overwritten and every other key — including the immutable extraction
    // block and unknown keys the passthrough schema preserves — survives verbatim.
    const merged = mergeOrigin(parseSourceMetadata(current.metadataJson), input.origin);
    if (merged.changed) {
      this.ctx.repos.sources.updateMetadata(sourceId, serializeSourceMetadata(merged.metadata));
      updated = true;
    }
    if (input.supersedes) this.ctx.repos.sources.setSupersedes(sourceId, input.supersedes);
    const refreshed = this.ctx.repos.sources.getById(sourceId)!;
    return {
      source: refreshed,
      status: 'duplicate' as const,
      updated,
      chunks: this.ctx.repos.chunks.listBySource(sourceId).length,
      text: this.textLineageOf(sourceId, refreshed),
    };
  }

  private commitNew(plan: NewIngestPlan): IngestResult {
    const { input, sha, sourceId, prepared } = plan;
    const extractor = extractorFor(input);
    const extraction = extractionBlockFor(input);
    const metadata: SourceMetadata = mergeOrigin(extraction ? { extraction } : {}, input.origin).metadata;
    const { storedPath, created } = this.ctx.store.store(sourceId, input.ext, input.bytes);
    let result: IngestResult;
    try {
      result = this.ctx.repos.tx(() => {
        // Re-check inside BEGIN IMMEDIATE: a concurrent writer may have won the row race
        // since `plan` read. If so, take the ORDINARY duplicate path WITHOUT inserting
        // (avoids the unique-key failure) — losing the race must not skip the §1.4
        // immutability check or the §2 metadata patch. A rejection here rolls the tx back
        // and is rethrown below. The stored path is content-addressed by (bytes,
        // EXTENSION), so the winner and loser only converge when the extension also
        // matches; a loser that arrived with a different extension created its own
        // now-unreferenced file, cleaned up after the tx below.
        const concurrent = this.ctx.repos.sources.getBySha256(sha);
        if (concurrent) return this.applyDuplicateUpdate(input, concurrent.id);
        const now = this.ctx.now();
        const source: Source = {
          id: sourceId,
          sha256: sha,
          storedPath,
          originalPath: input.originalPath ?? null,
          title: prepared.title,
          mediaType: input.mediaType,
          byteSize: input.bytes.byteLength,
          sourceDate: input.sourceDate ?? null,
          author: input.author ?? null,
          versionLabel: input.versionLabel ?? null,
          supersedesSourceId: input.supersedes ?? null,
          status: 'active',
          metadataJson: serializeSourceMetadata(metadata),
          ingestedAt: now,
        };
        this.ctx.repos.sources.insert(source);
        // The extractor is SPLIT across the two existing columns (`extractor` TEXT +
        // `extractor_version` INTEGER — no migration, 06 §1.2) and recombined for display.
        this.ctx.repos.sourceTexts.insert({
          sourceId,
          extractor: extractor.name,
          extractorVersion: extractor.version,
          text: prepared.canonical,
          textHash: prepared.textHash,
        });
        for (const c of prepared.chunks) {
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
          summary: `Ingested "${prepared.title}" (${prepared.chunks.length} chunks)`,
          detail: { sha256: sha, chunks: prepared.chunks.length },
        });
        return {
          source,
          status: 'new' as const,
          updated: false,
          chunks: prepared.chunks.length,
          text: {
            extractor: extractorLabel(extractor),
            verification: extraction?.verification ?? 'none',
            textHash: prepared.textHash,
          },
        };
      });
    } catch (err) {
      // The transaction failed. Remove the file only when THIS call created it (never a
      // pre-existing or a concurrent winner's file). If removal itself fails, keep the
      // original error primary and attach the cleanup failure as a warning note.
      if (created) {
        try {
          this.ctx.store.remove(storedPath);
        } catch (cleanupErr) {
          if (err && typeof err === 'object') {
            (err as CommitErrorMeta).cleanupWarning =
              `Failed to remove the orphaned source copy at ${storedPath} after a failed commit: ${(cleanupErr as Error).message}`;
          }
        }
      }
      throw err;
    }
    // A concurrent winner already owns this content (a NEW plan that committed as a
    // duplicate can only come from the in-tx recheck). If THIS call created the file — it
    // did when the winner stored the same bytes under a different extension — that file is
    // now unreferenced, so remove it (03 §5: "the loser removes its file only if
    // created === true"). Best-effort: the commit itself succeeded.
    if (result.status === 'duplicate' && created) {
      try {
        this.ctx.store.remove(storedPath);
      } catch {
        /* best-effort orphan cleanup; the content is safely stored under the winner's path */
      }
    }
    return result;
  }

  /**
   * The media policy (06 §1.1). A known-binary extension always requires a sidecar —
   * the gate is the EXTENSION, so a `.png` that happens to hold UTF-8 bytes is still
   * rejected. Everything else decodes strictly (fatal UTF-8 + NUL guard), replacing
   * the old lossy `Buffer.toString('utf8')`. Both failures carry the §1.5 recipe.
   */
  private decodeText(input: IngestInput): string {
    if (requiresTextSidecar(input.ext)) {
      throw new DomainIssueError('UNSUPPORTED_MEDIA', unsupportedMediaMessage(input.originalPath));
    }
    const text = decodeUtf8Strict(input.bytes);
    if (text === null) {
      throw new DomainIssueError('UNSUPPORTED_MEDIA', unsupportedMediaMessage(input.originalPath));
    }
    return text;
  }
}

/**
 * The extractor recorded for an input. The NATIVE path (kb decoded the bytes itself)
 * is always `text-utf8/1` — the existing `SOURCE_TEXT_EXTRACTOR` constant (06 §1.1);
 * a sidecar defaults to `agent-transcription/1` unless `--extractor` says otherwise.
 */
function extractorFor(input: IngestInput): ExtractorRef {
  if (input.extractor) return input.extractor;
  if (input.sidecar) return DEFAULT_SIDECAR_EXTRACTOR;
  return { name: SOURCE_TEXT_EXTRACTOR, version: SOURCE_TEXT_EXTRACTOR_VERSION };
}

/** The `metadata.extraction` block a sidecar input records (06 §2); `undefined` natively. */
function extractionBlockFor(input: IngestInput): SourceExtraction | undefined {
  if (!input.sidecar) return undefined;
  return {
    method: extractorLabel(extractorFor(input)),
    verification: input.verification ?? 'none',
    textFileHash: input.sidecar.fileHash,
    textFilePath: input.sidecar.path,
  };
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
