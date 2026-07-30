/**
 * SOURCE group: list, show, chunks, impact.
 */

import type { Command } from 'commander';
import { success, result } from '../output.js';
import { choiceOption, leaf, optStr, unknownIdIssue, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { steeringFor } from '../steering.js';
import { makeNodeId, makeSourceId } from '../../domain/ids.js';
import { SOURCE_STATUSES, type SourceStatus } from '../../domain/schemas/enums.js';
import { parseSourceMetadata } from '../../domain/schemas/sourceMetadata.js';
import { classifyChunkText } from '../../domain/algorithms/chunkKind.js';
import {
  buildSourceImpact,
  buildSourceImpactNode,
} from '../../domain/services/sourceImpact.js';

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
      related: ['source show', 'source chunks', 'coverage'],
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
      output: [
        'sourceId',
        'chunks: [{ id, chunkIndex, headingPath, text, contentKind }] — copy quotes verbatim from text',
        "chunks with contentKind 'structural' (heading-only) need no claim extraction",
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Read chunk text to copy exact quotes into a claim/graph payload.',
      related: ['source show', 'claim apply', 'relationship list'],
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
        contentKind: classifyChunkText(c.text),
      }));
      return success({ sourceId: id, chunks });
    }),
  );

  defineHelp(
    leaf(
      group,
      'impact <source_id>',
      'Summarize what one source contributed, then optionally return one affected node’s synthesis working set.',
    ).option('--node <node_id>', 'return the source-scoped working set for one node'),
    {
      command: 'source impact',
      group: 'ingest',
      usage: 'kb source impact <source_id> [--node <node_id>]',
      summary:
        'Summarize what one source contributed, then optionally return one affected node’s synthesis working set.',
      args: [
        {
          name: 'source_id',
          description:
            'the source id (src_…) whose evidence-linked contribution to inspect',
        },
      ],
      flags: [
        {
          flags: '--node <node_id>',
          description: 'return the source-scoped working set for one node',
        },
      ],
      output: [
        'default: source metadata; introduced vs evidencedExisting claims and relationships with status totals and lexicographic ids capped at 20; affected nodes ordered by (depth DESC, sortOrder, nodeId); scoped coverage totals; complete candidate claim ids in lexicographic order',
        'the default is summaries and stable ids only — never claim or relationship bodies, quotes, provenance, or candidate bodies',
        '--node: node { id, title, bodyMd, bodyHash }; source-contributed subtree claims ordered by claimId with status and candidates; lexicographic node-context allowedCitationIds; children with ownClaimCount ordered by (sortOrder, nodeId)',
        'a valid node outside this source’s affected owner/ancestor set still returns successfully with one SOURCE_NO_CLAIMS info issue scoped to that node subtree',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow:
        'Inspect a compact source contribution first, then select a stale affected node for a synthesis-ready drill-down.',
      related: [
        'coverage',
        'relationship list',
        'claim candidates',
        'node show',
      ],
      examples: [
        {
          description: 'Summarize one source contribution',
          command: 'kb source impact src_1a2b3c --json',
        },
        {
          description: 'Read one affected node’s source-scoped working set',
          command:
            'kb source impact src_1a2b3c --node nod_1a2b3c --json',
        },
      ],
    },
  ).action(
    workspaceAction(ctx, (ws, { args, opts }) => {
      const sourceOption = args[0] as string;
      const sourceId = makeSourceId(sourceOption);
      if (!ws.repos.sources.getById(sourceId)) {
        return result(null, [
          {
            ...unknownIdIssue(
              'UNKNOWN_SOURCE',
              `unknown source ${sourceOption}`,
              sourceOption,
            ),
            hint: 'List sources: kb source list --json',
          },
        ]);
      }

      const nodeOption = optStr(opts, 'node');
      if (nodeOption === undefined) {
        const data = buildSourceImpact(ws.repos, sourceId);
        const firstStale = data.affectedNodes.find((node) => node.stale);
        const steering = steeringFor(
          'source impact',
          {
            ok: true,
            sourceId,
            staleIds: firstStale ? [firstStale.nodeId] : [],
          },
          ctx.registry,
        );
        return success(data, {
          nextActions: steering.nextActions,
          hints: steering.hints,
        });
      }

      const nodeId = makeNodeId(nodeOption);
      const drillDown = buildSourceImpactNode(ws.repos, sourceId, nodeId);
      if (!drillDown) {
        return result(null, [
          unknownIdIssue(
            'UNKNOWN_NODE',
            `unknown node ${nodeOption}`,
            nodeOption,
          ),
        ]);
      }
      return success(drillDown.data, {
        ...(drillDown.affected
          ? {}
          : {
              issues: [
                {
                  code: 'SOURCE_NO_CLAIMS',
                  severity: 'info' as const,
                  message: `Source ${sourceId} does not contribute claims to node ${nodeId} or its subtree.`,
                  ids: [sourceId, nodeId],
                },
              ],
            }),
      });
    }),
  );
}
