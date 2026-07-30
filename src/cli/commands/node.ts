/**
 * NODE group: create, tree, show. Behavior ported verbatim from the hand parser;
 * `--kind` now validates against the `NODE_KINDS` runtime const via Commander
 * choices (invalid kind → INVALID_ARGUMENT, exit 2) instead of a usage string.
 *
 * `show --context` adds the Phase-2 synthesis bundle (04 §1): one read returning
 * everything a synthesize write needs. Without the flag, `show` is unchanged.
 */

import type { Command } from 'commander';
import { success, result } from '../output.js';
import { choiceOption, leaf, optStr, readPayload, unknownIdIssue, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { domainIssueToIssue } from '../issues.js';
import { steeringFor } from '../steering.js';
import { makeNodeId, type NodeId } from '../../domain/ids.js';
import { NODE_KINDS, type NodeKind } from '../../domain/schemas/enums.js';
import { NodeApplySchema } from '../../domain/schemas/agent.js';
import { buildNodeContext } from '../../domain/services/nodeContext.js';

export function registerNode(group: Command, ctx: RunContext): void {
  defineHelp(
    leaf(group, 'create', 'Create a synthesis node.')
      .requiredOption('--title <title>', 'node title')
      .addOption(choiceOption('--kind <kind>', 'node kind', NODE_KINDS).makeOptionMandatory())
      .option('--parent <node_id>', 'parent node id (omit or "root" for the root)')
      .option('--slug <slug>', 'explicit slug (defaults to a slugified title)'),
    {
      command: 'node create',
      group: 'structure',
      usage: 'kb node create [options]',
      summary: 'Create a synthesis node.',
      args: [],
      flags: [
        { flags: '--title <title>', description: 'node title', required: true },
        { flags: '--kind <kind>', description: 'node kind', choices: NODE_KINDS, required: true },
        { flags: '--parent <node_id>', description: 'parent node id (omit or "root" for the root)' },
        { flags: '--slug <slug>', description: 'explicit slug (defaults to a slugified title)' },
      ],
      output: ['nodeId', 'created', 'kind', 'depth'],
      sideEffects: ['creates a node in the synthesis hierarchy'],
      atomic: true,
      supportsDryRun: false,
      workflow: 'Build the synthesis hierarchy that claims are attached to.',
      related: ['node tree', 'claim apply'],
      examples: [
        { description: 'Create the root node', command: 'kb node create --title "KB" --kind root --json' },
        { description: 'Create a leaf under the root', command: 'kb node create --title "Caching" --kind leaf --json' },
      ],
    },
  ).action(
      workspaceAction(ctx, (ws, { opts }) => {
        const title = optStr(opts, 'title')!;
        const kind = opts['kind'] as NodeKind;
        const parentFlag = optStr(opts, 'parent');
        const parentId: NodeId | null = !parentFlag || parentFlag === 'root' ? null : makeNodeId(parentFlag);
        const r = ws.nodes.createNode({
          parentId,
          title,
          kind,
          ...(optStr(opts, 'slug') ? { slug: optStr(opts, 'slug')! } : {}),
        });
        return success({ nodeId: r.node.id, created: r.created, kind: r.node.kind, depth: r.node.depth });
      }),
    );

  defineHelp(
    leaf(group, 'apply', 'Create a whole node hierarchy from a manifest, atomically.', { dryRun: true }).option(
      '--file <path>',
      'hierarchy manifest file (defaults to stdin; - for stdin)',
    ),
    {
      command: 'node apply',
      group: 'structure',
      usage: 'kb node apply [options]',
      summary: 'Create a whole node hierarchy from a manifest, atomically.',
      args: [],
      flags: [{ flags: '--file <path>', description: 'hierarchy manifest file (defaults to stdin; - for stdin)' }],
      input: {
        schema: 'NodeApplySchema',
        example: {
          nodes: [
            {
              ref: 'root',
              title: 'Knowledge Base',
              kind: 'root',
              children: [{ ref: 'caching', title: 'Caching', kind: 'leaf' }],
            },
          ],
        },
      },
      output: ['nodes: [{ ref, nodeId, outcome }]', 'totals { created, existing }', 'staleNodes'],
      sideEffects: ['creates the manifest nodes in one transaction (parents before children)', 'marks created nodes and their ancestors stale'],
      atomic: true,
      // A payload command in the §6.2 dry-run scope — `--dry-run` is registered here (via
      // `leaf(..., { dryRun: true })`), closing the Phase-1 deferral, so the spec MUST declare it.
      supportsDryRun: true,
      workflow: 'Stand up the synthesis hierarchy in one command before extracting claims into it.',
      related: ['node create', 'node tree', 'claim apply'],
      examples: [
        { description: 'Preview a hierarchy manifest', command: 'kb node apply --file ./hierarchy.json --dry-run --json' },
        { description: 'Apply a hierarchy manifest', command: 'kb node apply --file ./hierarchy.json --json' },
      ],
    },
  ).action(
    workspaceAction(
      ctx,
      (ws, { opts }) => {
        const receipt = ws.nodes.applyManifest(NodeApplySchema.parse(readPayload(opts)));
        // Steering comes from the normative per-command table (01 §6.1 / 04 §2) via
        // `steeringFor`: the ref→nodeId hint always, plus an ingest-first or claim-apply hint
        // depending on whether the KB has any sources yet. A `--dry-run` receipt is steered
        // exclusively to its replay by the dry-run runner, so this steering is ignored then.
        const hasSources = ws.repos.sources.listAll().length > 0;
        const steering = steeringFor('node apply', { ok: true, hasSources }, ctx.registry);
        return success(receipt, { nextActions: steering.nextActions, hints: steering.hints });
      },
      { dryRunCommand: 'node apply' },
    ),
  );

  defineHelp(leaf(group, 'tree', 'List the synthesis hierarchy with depth, kind, stale flag, and claim counts.'), {
    command: 'node tree',
    group: 'structure',
    usage: 'kb node tree',
    summary: 'List the synthesis hierarchy with depth, kind, stale flag, and claim counts.',
    args: [],
    flags: [],
    output: ['nodes: [{ id, parentId, title, kind, depth, isStale, claims (count) }]'],
    sideEffects: [],
    atomic: false,
    supportsDryRun: false,
    workflow: 'See the whole hierarchy and which nodes are stale.',
    related: ['node show', 'node create'],
    examples: [{ description: 'List the hierarchy', command: 'kb node tree --json' }],
  }).action(
    workspaceAction(ctx, (ws) => {
      const nodes = ws.repos.nodes.listAll().map((n) => ({
        id: n.id,
        parentId: n.parentId,
        title: n.title,
        kind: n.kind,
        depth: n.depth,
        isStale: n.isStale,
        claims: ws.repos.claims.listByNode(n.id).length,
      }));
      return success({ nodes });
    }),
  );

  defineHelp(
    leaf(group, 'show <node_id>', 'Show a node and the claims it owns.').option(
      '--context',
      'return the synthesis-ready bundle for the node’s whole subtree',
    ),
    {
      command: 'node show',
      group: 'structure',
      usage: 'kb node show [options] <node_id>',
      summary: 'Show a node and the claims it owns.',
      args: [{ name: 'node_id', description: 'the node id (nod_…) to show' }],
      flags: [
        { flags: '--context', description: 'return the synthesis-ready bundle for the node’s whole subtree' },
      ],
      output: [
        'node, claims owned by the node (with ids to cite during synthesis)',
        '--context: node (bodyMd + bodyHash included), children [{…, ownClaims: citable claims owned directly}], claims (the whole subtree, active + conflicted, owner-tagged, each with provenance snippets carrying sourceStatus + supersededBy), sources [{ id, title, claimCount: bundle claims quoting it }], allowedCitationIds, stats { descendantNodes, claims, approxTokens, complete }',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Inspect a node’s claims before synthesizing its prose; --context returns everything one synthesize write needs.',
      related: ['node tree', 'synthesize', 'provenance', 'source impact'],
      examples: [
        { description: 'Show a node and its claims', command: 'kb node show nod_1a2b3c --json' },
        { description: 'Read the synthesis bundle for a node', command: 'kb node show nod_1a2b3c --context --json' },
      ],
    },
  ).action(
    workspaceAction(ctx, (ws, { args, opts }) => {
      const id = args[0] as string;
      if (opts['context'] !== true) {
        const node = ws.repos.nodes.getById(makeNodeId(id));
        if (!node) return result(null, [unknownIdIssue('UNKNOWN_NODE', `unknown node ${id}`, id)]);
        return success({ node, claims: ws.repos.claims.listByNode(node.id) });
      }

      // The 04 §1 bundle. Assembly (ordering, snippets, token measurement) lives in the
      // domain builder; the command only turns it into an envelope and steers per the
      // normative table (01 §6.1) — never inline, so steering stays registry-filtered.
      //
      // Every diagnostic this Phase-2 path can produce carries a REAL registry code with
      // its hint: `LEGACY` emission is forbidden from Phase 1 on (01 §3.2), so a malformed
      // id is INVALID_ARGUMENT and a resolvable-but-absent one is UNKNOWN_NODE.
      let nodeId: NodeId;
      try {
        nodeId = makeNodeId(id);
      } catch (e) {
        return result(null, [
          domainIssueToIssue({ code: 'INVALID_ARGUMENT', message: (e as Error).message, path: 'node_id' }),
        ]);
      }
      const bundle = buildNodeContext(ws.repos, nodeId);
      if (!bundle) {
        return result(null, [
          domainIssueToIssue({ code: 'UNKNOWN_NODE', message: `unknown node ${id}`, path: 'node_id', ids: [nodeId] }),
        ]);
      }
      const steering = steeringFor(
        'node show',
        {
          ok: true,
          context: true,
          snippetsTruncated: bundle.snippetsTruncated,
          approxTokens: bundle.data.stats.approxTokens,
        },
        ctx.registry,
      );
      return success(bundle.data, { nextActions: steering.nextActions, hints: steering.hints });
    }),
  );
}
