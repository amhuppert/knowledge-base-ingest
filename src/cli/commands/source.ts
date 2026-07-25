/**
 * SOURCE group: list, show, chunks.
 */

import type { Command } from 'commander';
import { success, result } from '../output.js';
import { choiceOption, leaf, optStr, unknownIdIssue, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { steeringFor } from '../steering.js';
import { makeSourceId } from '../../domain/ids.js';
import { SOURCE_STATUSES, type SourceStatus } from '../../domain/schemas/enums.js';
import { parseSourceMetadata } from '../../domain/schemas/sourceMetadata.js';

/**
 * The origin a source row surfaces (06 §2): `system` + `url` from `metadata.origin`,
 * or `null` when no origin was recorded. The full block (including `externalId`)
 * stays available in `metadataJson`.
 */
function originOf(metadataJson: string): { system?: string; url?: string } | null {
  const origin = parseSourceMetadata(metadataJson).origin;
  if (!origin) return null;
  const surfaced = {
    ...(origin.system !== undefined ? { system: origin.system } : {}),
    ...(origin.url !== undefined ? { url: origin.url } : {}),
  };
  return Object.keys(surfaced).length > 0 ? surfaced : null;
}

export function registerSource(group: Command, ctx: RunContext): void {
  defineHelp(
    leaf(group, 'list', 'List sources with chunk and claim counts, plus global per-status totals.').addOption(
      choiceOption('--status <status>', 'filter the list by source status', SOURCE_STATUSES),
    ),
    {
      command: 'source list',
      group: 'ingest',
      usage: 'kb source list [options]',
      summary: 'List sources with chunk and claim counts, plus global per-status totals.',
      args: [],
      flags: [{ flags: '--status <status>', description: 'filter the list by source status', choices: SOURCE_STATUSES }],
      output: [
        'sources: [{ id, title, status, sourceDate, mediaType, chunks, claims, origin, ingestedAt }] ordered by (ingestedAt, id)',
        'counts: GLOBAL per-status source totals, unaffected by --status',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Survey ingested sources and their extraction coverage.',
      related: ['source show', 'source chunks'],
      examples: [
        { description: 'List all sources', command: 'kb source list --json' },
        { description: 'List only active sources', command: 'kb source list --status active --json' },
      ],
    },
  ).action(
    workspaceAction(ctx, (ws, { opts }) => {
      const statusFilter = optStr(opts, 'status') as SourceStatus | undefined;
      const chunkCounts = ws.repos.sources.chunkCountsBySource();
      const claimCounts = ws.repos.sources.distinctClaimCountsBySource();
      const all = ws.repos.sources.listAll(); // ordered (ingestedAt, id)
      const filtered = statusFilter ? all.filter((s) => s.status === statusFilter) : all;
      const sources = filtered.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        sourceDate: s.sourceDate,
        mediaType: s.mediaType,
        chunks: chunkCounts.get(s.id) ?? 0,
        claims: claimCounts.get(s.id) ?? 0,
        origin: originOf(s.metadataJson), // {system, url} from metadata.origin (06 §2)
        ingestedAt: s.ingestedAt,
      }));
      // `counts` are GLOBAL per-status totals — computed over EVERY source, never the
      // filtered subset (finding 40). Steering comes from the normative per-command table
      // (01 §6.1) via `steeringFor`, never inline, so the table is the single source of
      // steering behavior and stays registry-filtered (charter: drift-gates-green).
      const steering = steeringFor('source list', { ok: true }, ctx.registry);
      return success(
        { sources, counts: ws.repos.sources.countByStatus() },
        { nextActions: steering.nextActions, hints: steering.hints },
      );
    }),
  );

  defineHelp(leaf(group, 'show <source_id>', 'Show source metadata.'), {
    command: 'source show',
    group: 'ingest',
    usage: 'kb source show <source_id>',
    summary: 'Show source metadata.',
    args: [{ name: 'source_id', description: 'the source id (src_…) to show' }],
    flags: [],
    output: [
      'the full source row: id, title, status, mediaType, sourceDate, ingestedAt, storedPath, metadataJson',
      'origin: { system, url } from metadata.origin — null when no origin was recorded',
    ],
    sideEffects: [],
    atomic: false,
    supportsDryRun: false,
    workflow: 'Inspect an ingested source before extracting claims from it.',
    related: ['source list', 'source chunks'],
    examples: [{ description: 'Show one source', command: 'kb source show src_1a2b3c --json' }],
  }).action(
    workspaceAction(ctx, (ws, { args }) => {
      const id = args[0] as string;
      const src = ws.repos.sources.getById(makeSourceId(id));
      // `origin` is surfaced alongside the unchanged row (06 §2); `metadataJson` still
      // carries the full block, so nothing is removed (compatibility matrix).
      return src
        ? success({ ...src, origin: originOf(src.metadataJson) })
        : result(null, [unknownIdIssue('UNKNOWN_SOURCE', `unknown source ${id}`, id)]);
    }),
  );

  defineHelp(
    leaf(group, 'chunks <source_id>', 'List chunks with ids, heading paths, and exact text for quote selection.'),
    {
      command: 'source chunks',
      group: 'ingest',
      usage: 'kb source chunks <source_id>',
      summary: 'List chunks with ids, heading paths, and exact text for quote selection.',
      args: [{ name: 'source_id', description: 'the source id (src_…) whose chunks to list' }],
      flags: [],
      output: ['sourceId', 'chunks: [{ id, chunkIndex, headingPath, text }] — copy quotes verbatim from text'],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Read chunk text to copy exact quotes into a claim/graph payload.',
      related: ['source show', 'claim apply'],
      examples: [{ description: 'List a source’s chunks', command: 'kb source chunks src_1a2b3c --json' }],
    },
  ).action(
    workspaceAction(ctx, (ws, { args }) => {
      const id = args[0] as string;
      const chunks = ws.repos.chunks.listBySource(makeSourceId(id)).map((c) => ({
        id: c.id,
        chunkIndex: c.chunkIndex,
        headingPath: c.headingPath,
        text: c.text,
      }));
      return success({ sourceId: id, chunks });
    }),
  );
}
