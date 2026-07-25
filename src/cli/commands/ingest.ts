/**
 * INGEST command. Registers an immutable source copy and creates chunks via the
 * IngestService `plan`/`commit` split (03 §5). `--dry-run` previews through `plan`
 * only (no store or DB writes); a real ingest commits and steers to the source's
 * chunks, keeping the deprecated `next` string alias for envelope v2.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import { emit, result, success, type Envelope, type Issue } from '../output.js';
import { choiceOption, leaf, optStr, shellQuoteArg, workspaceAction, type RunContext } from '../run.js';
import { hintFor } from '../issues.js';
import { steeringFor } from '../steering.js';
import { defineHelp } from '../help/spec.js';
import { makeSourceId } from '../../domain/ids.js';
import { DomainIssueError } from '../../domain/issueCodes.js';
import { decodeUtf8Strict, mediaFormatTable, mediaTypeFor } from '../../domain/algorithms/media.js';
import { TEXT_VERIFICATIONS, type TextVerification } from '../../domain/schemas/enums.js';
import { mergeOrigin, parseSourceMetadata, type SourceOrigin } from '../../domain/schemas/sourceMetadata.js';
import { sha256Hex } from '../../domain/algorithms/hash.js';
import {
  parseExtractorRef,
  type IngestInput,
  type IngestPlan,
  type TextSidecar,
} from '../../domain/services/ingestService.js';

/**
 * Commander argParser for `--origin-url`: an absolute URL, matching the
 * `z.string().url()` the metadata schema validates it with — rejected at PARSE time
 * (INVALID_ARGUMENT, exit 2) so a typo never reaches the workspace as a schema error.
 */
function urlOption(value: string): string {
  try {
    new URL(value);
  } catch {
    throw new InvalidArgumentError('expected an absolute URL, e.g. https://example.com/issues/12');
  }
  return value;
}

/**
 * Commander argParser for `--extractor`: the value must be `name/<decimal integer>`,
 * because `source_texts` stores the two parts in separate TEXT/INTEGER columns (06
 * §1.2 — no migration). A bad value is `INVALID_ARGUMENT` at PARSE time (exit 2),
 * before any workspace is opened. The raw string is kept; the split happens below.
 */
function extractorOption(value: string): string {
  if (parseExtractorRef(value) === null) {
    throw new InvalidArgumentError(
      'expected <name>/<version>, e.g. agent-transcription/1 — a lowercase name and a decimal integer version',
    );
  }
  return value;
}

/**
 * Read the `--text-from` sidecar: the file's bytes are hashed AS GIVEN (recorded as
 * `metadata.extraction.textFileHash`) and strictly decoded. Unreadable or
 * non-UTF-8 ⇒ `TEXT_SIDECAR_INVALID` (06 §1.3).
 */
function readSidecar(path: string): TextSidecar {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new DomainIssueError(
      'TEXT_SIDECAR_INVALID',
      `--text-from ${path} could not be read: ${(err as Error).message}`,
    );
  }
  const text = decodeUtf8Strict(bytes);
  if (text === null) {
    throw new DomainIssueError('TEXT_SIDECAR_INVALID', `--text-from ${path} is not decodable UTF-8 text.`);
  }
  return { path, text, fileHash: sha256Hex(bytes) };
}

/**
 * The PRE-WORKSPACE argument check (06 §1.3, finding 37): `--extractor` and
 * `--verification` describe a sidecar transcription, so without `--text-from` they are
 * a mistake — `INVALID_ARGUMENT`, exit 2, before the KB is even resolved. Returns the
 * issue to emit, or `null` when the combination is valid.
 */
export function sidecarFlagMisuse(opts: Record<string, unknown>): Issue | null {
  if (optStr(opts, 'textFrom') !== undefined) return null;
  const orphan = (['extractor', 'verification'] as const).find((key) => optStr(opts, key) !== undefined);
  if (!orphan) return null;
  return {
    code: 'INVALID_ARGUMENT',
    severity: 'error',
    message: `--${orphan === 'extractor' ? 'extractor' : 'verification'} describes a transcription supplied with --text-from; it is meaningless without it. Either add --text-from <file> or drop the flag.`,
    hint: hintFor('INVALID_ARGUMENT'),
  };
}

/**
 * The `--origin-*` patch: ONLY the flags actually supplied appear, so a duplicate
 * re-ingest overwrites those keys and leaves the rest of `metadata.origin` alone
 * (06 §2 patch-merge). `undefined` when no origin flag was given.
 */
function originPatch(opts: Record<string, unknown>): SourceOrigin | undefined {
  const patch: SourceOrigin = {
    ...(optStr(opts, 'originSystem') !== undefined ? { system: optStr(opts, 'originSystem')! } : {}),
    ...(optStr(opts, 'originId') !== undefined ? { externalId: optStr(opts, 'originId')! } : {}),
    ...(optStr(opts, 'originUrl') !== undefined ? { url: optStr(opts, 'originUrl')! } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Build the service input from the parsed positional path + options. */
function ingestInput(path: string, opts: Record<string, unknown>): IngestInput {
  const ext = extname(path).slice(1);
  const bytes = readFileSync(path);
  const supersedes = optStr(opts, 'supersedes');
  const textFrom = optStr(opts, 'textFrom');
  const extractor = optStr(opts, 'extractor');
  const verification = optStr(opts, 'verification');
  const origin = originPatch(opts);
  return {
    bytes,
    ext,
    // THE media table is the domain's single 06 §1.1 map (rendered into this command's
    // HelpSpec below), so help, the media-type column, and the decode gate cannot drift.
    mediaType: mediaTypeFor(ext, bytes),
    originalPath: path,
    ...(optStr(opts, 'title') ? { title: optStr(opts, 'title')! } : {}),
    ...(optStr(opts, 'sourceDate') ? { sourceDate: optStr(opts, 'sourceDate')! } : {}),
    ...(supersedes ? { supersedes: makeSourceId(supersedes) } : {}),
    // The DERIVED path: the original above still owns identity; this text becomes canonical.
    ...(textFrom !== undefined ? { sidecar: readSidecar(textFrom) } : {}),
    ...(extractor !== undefined ? { extractor: parseExtractorRef(extractor)! } : {}),
    ...(verification !== undefined ? { verification: verification as TextVerification } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

/**
 * The verbatim ingest re-run WITHOUT `--dry-run` a preview steers to (03 §2). Every
 * outcome-affecting flag is preserved (so the replay reproduces the previewed result)
 * and shell-quoted, using the attached `--opt=value` form so a dash-prefixed value is
 * never misparsed (matches the DB-only dry-run re-run in run.ts).
 *
 * OPTIONS come first, then the `--` terminator, then the positional path — so a
 * dash-prefixed path (a valid preview like `kb ingest --dry-run -- -notes.md`) replays
 * as `kb ingest --json -- -notes.md` and is taken literally, never parsed as an unknown
 * option (charter: verbatim-next-actions).
 */
export function ingestReapplyCommand(path: string, opts: Record<string, unknown>): string {
  const parts = ['kb', 'ingest'];
  const passthrough: Array<[string, string]> = [
    ['kb', 'kb'],
    ['title', 'title'],
    ['sourceDate', 'source-date'],
    ['supersedes', 'supersedes'],
    ['textFrom', 'text-from'],
    ['extractor', 'extractor'],
    ['verification', 'verification'],
    ['originSystem', 'origin-system'],
    ['originId', 'origin-id'],
    ['originUrl', 'origin-url'],
  ];
  for (const [key, flag] of passthrough) {
    const value = optStr(opts, key);
    if (value !== undefined) parts.push(`--${flag}=${shellQuoteArg(value)}`);
  }
  parts.push('--json', '--', shellQuoteArg(path));
  return parts.join(' ');
}

/** The `plan`-only dry-run receipt (03 §5): the exact duplicate/new shapes. */
function dryRunReceipt(path: string, plan: IngestPlan, opts: Record<string, unknown>, ctx: RunContext): Envelope<unknown> {
  const steering = steeringFor(
    'ingest',
    { ok: true, dryRun: { command: ingestReapplyCommand(path, opts), payloadFrom: 'file' } },
    ctx.registry,
  );
  const data =
    plan.kind === 'duplicate'
      ? {
          dryRun: true,
          status: 'duplicate' as const,
          sourceId: plan.existing.id,
          wouldUpdate: wouldUpdate(plan),
        }
      : {
          dryRun: true,
          status: 'new' as const,
          sourceId: plan.sourceId,
          title: plan.prepared.title,
          chunks: plan.prepared.chunks.length,
          byteSize: plan.input.bytes.byteLength,
          mediaType: plan.input.mediaType,
        };
  return success(data, { nextActions: steering.nextActions, hints: steering.hints });
}

/**
 * Wrap a leaf action with the pre-workspace argument check. An argument error is
 * emitted through the envelope constructors and reports exit code 2 (the CLI's
 * argument-error code, matching the router's own pre-parse rejections) WITHOUT
 * resolving a KB root, opening a workspace, or reading the input file.
 */
function preWorkspaceGuard(ctx: RunContext, action: (...args: unknown[]) => void) {
  return (...actionArgs: unknown[]): void => {
    const cmd = actionArgs[actionArgs.length - 1] as Command;
    const misuse = sidecarFlagMisuse(cmd.optsWithGlobals());
    if (misuse) {
      emit(result(null, [misuse]), ctx.json, ctx.io);
      ctx.outcome.code = 2;
      return;
    }
    action(...actionArgs);
  };
}

/** The metadata a duplicate commit WOULD change (empty when nothing differs). */
function wouldUpdate(
  plan: Extract<IngestPlan, { kind: 'duplicate' }>,
): { title?: string; sourceDate?: string; origin?: SourceOrigin } {
  const { input, existing } = plan;
  const w: { title?: string; sourceDate?: string; origin?: SourceOrigin } = {};
  if (input.title && input.title !== existing.title) w.title = input.title;
  if (input.sourceDate && input.sourceDate !== existing.sourceDate) w.sourceDate = input.sourceDate;
  // The origin PATCH the commit would apply — reported only when it actually changes
  // something, so a preview never advertises a no-op update (06 §2).
  const merged = mergeOrigin(parseSourceMetadata(existing.metadataJson), input.origin);
  if (merged.changed && merged.metadata.origin) w.origin = merged.metadata.origin;
  return w;
}

export function registerIngest(program: Command, ctx: RunContext): void {
  defineHelp(
    leaf(
      program,
      'ingest <path>',
      'Register an immutable source copy, normalize text, and create deterministic chunks.',
      { dryRun: true },
    )
      .option('--title <title>', 'source title (defaults to the first heading or filename)')
      .option('--source-date <date>', 'source authorship date')
      .option('--supersedes <src_id>', 'the source id this ingest supersedes')
      .option('--text-from <path>', 'sidecar file supplying the canonical text for this original')
      .option(
        '--extractor <name/version>',
        'how the sidecar text was produced (default agent-transcription/1)',
        extractorOption,
      )
      .addOption(choiceOption(
        '--verification <mode>',
        'whether the transcription was checked against the original',
        TEXT_VERIFICATIONS,
      ))
      .option('--origin-system <system>', 'the system this source came from, e.g. github, notion')
      .option('--origin-id <id>', 'the source’s id in that system')
      .option('--origin-url <url>', 'the source’s canonical URL in that system', urlOption),
    {
      command: 'ingest',
      group: 'ingest',
      usage: 'kb ingest [options] <path>',
      summary: 'Register an immutable source copy, normalize text, and create deterministic chunks.',
      args: [{ name: 'path', description: 'the ORIGINAL file to ingest (it owns source identity)' }],
      // `ingest` takes a FILE, not a JSON payload, so its input block documents the 06
      // §1.1 format table (derived from the single media map) plus the §1.5 two-step
      // recipe for anything that needs a transcription.
      input: {
        notes: [
          'accepted formats (extension → media type):',
          ...mediaFormatTable().map((line) => `  ${line}`),
          'for a format that requires --text-from, transcribe or extract the text first, then:',
          '  1. write the extracted text to a UTF-8 file, e.g. extracted.md',
          '  2. kb ingest report.pdf --text-from extracted.md --json',
          'the ORIGINAL bytes own source identity (id + sha256); the sidecar becomes the canonical text.',
          'canonical text is immutable: to publish a corrected transcription, ingest the corrected file itself',
          '  with --supersedes <src_id> — re-ingesting the same original with different text is rejected.',
        ],
      },
      flags: [
        { flags: '--title <title>', description: 'source title (defaults to the first heading or filename)' },
        { flags: '--source-date <date>', description: 'source authorship date' },
        { flags: '--supersedes <src_id>', description: 'the source id this ingest supersedes' },
        { flags: '--text-from <path>', description: 'sidecar file supplying the canonical text for this original' },
        {
          flags: '--extractor <name/version>',
          description: 'how the sidecar text was produced (default agent-transcription/1)',
        },
        {
          flags: '--verification <mode>',
          description: 'whether the transcription was checked against the original',
          choices: TEXT_VERIFICATIONS,
        },
        { flags: '--origin-system <system>', description: 'the system this source came from, e.g. github, notion' },
        { flags: '--origin-id <id>', description: 'the source’s id in that system' },
        { flags: '--origin-url <url>', description: 'the source’s canonical URL in that system' },
      ],
      output: [
        'sourceId',
        'title',
        'status',
        'updated',
        'chunks (count)',
        'original: { mediaType, byteSize, sha256 } — the bytes that own source identity',
        'text: { extractor, verification, textHash } — the canonical-text lineage',
        'next (a source-chunks pointer)',
      ],
      sideEffects: ['stores an immutable copy of the source', 'creates deterministic chunks'],
      atomic: true,
      // A payload command in the §6.2 dry-run scope — `--dry-run` is registered here
      // (via `leaf(..., { dryRun: true })`), so the spec MUST declare it (01 §4/§6.2).
      supportsDryRun: true,
      workflow: 'The first step: ingest a source, then read its chunks and extract claims.',
      related: ['source chunks', 'claim apply'],
      examples: [{ description: 'Ingest a markdown file', command: 'kb ingest ./notes.md --json' }],
    },
  ).action(
      // The §1.3 pre-workspace guard runs FIRST: `--extractor`/`--verification` without
      // `--text-from` is an argument error (exit 2), decided before the KB is resolved or
      // the input file is read — so it can never be masked by a NO_KB or read failure.
      preWorkspaceGuard(ctx, workspaceAction(ctx, (ws, { args, opts }) => {
        const path = args[0] as string;
        const plan = ws.ingest.plan(ingestInput(path, opts));
        // `--dry-run` (router-set `ctx.dryRun`) previews via `plan` only — ingest is NOT
        // in the DB-only sentinel-rollback scope (its store write is outside the DB tx),
        // so it does not opt into `workspaceAction`'s `dryRunCommand` path (03 §5).
        if (ctx.dryRun) return dryRunReceipt(path, plan, opts, ctx);

        const r = ws.ingest.commit(plan);
        // Steer to the new source's chunks (01 §6.1). `next` is a deprecated string alias
        // mirroring the primary next-action verbatim (03 §3 compatibility matrix).
        const steering = steeringFor('ingest', { ok: true, newSourceId: r.source.id }, ctx.registry);
        return success(
          {
            sourceId: r.source.id,
            title: r.source.title,
            status: r.status,
            updated: r.updated,
            chunks: r.chunks,
            // Lineage blocks (06 §1.5): the ORIGINAL owns identity; `text` describes the
            // canonical text — `text-utf8/1` natively, the sidecar's extractor when derived.
            original: { mediaType: r.source.mediaType, byteSize: r.source.byteSize, sha256: r.source.sha256 },
            text: r.text,
            next: steering.nextActions[0]?.command ?? `kb source chunks ${r.source.id} --json`,
          },
          { nextActions: steering.nextActions, hints: steering.hints },
        );
      })),
    );
}
