/**
 * GRAPH group: apply. Persists entities + quote-verified relationships atomically.
 * Dry-run-capable (01 §6.2).
 */

import type { Command } from 'commander';
import { success } from '../output.js';
import { leaf, readPayload, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { steeringFor } from '../steering.js';
import { parseGraphApply } from '../../domain/schemas/agent.js';
import { domainIssueToIssue } from '../issues.js';
import type { DomainIssue } from '../../domain/issueCodes.js';

export function registerGraph(group: Command, ctx: RunContext): void {
  defineHelp(
    leaf(group, 'apply', 'Persist entities and quote-verified relationships atomically.', { dryRun: true }).option(
      '--file <path>',
      'graph payload file (defaults to stdin; - for stdin)',
    ),
    {
      command: 'graph apply',
      group: 'extract',
      usage: 'kb graph apply [options]',
      summary: 'Persist entities and quote-verified relationships atomically.',
      args: [],
      flags: [{ flags: '--file <path>', description: 'graph payload file (defaults to stdin; - for stdin)' }],
      input: {
        schema: 'GraphApplySchema',
        example: {
          source_id: 'src_1a2b3c',
          entities: [{ type: 'Service', name: 'Billing' }],
          relationships: [
            {
              type: 'depends_on',
              subject: { type: 'Service', name: 'Billing' },
              object: { type: 'Service', name: 'Auth' },
              evidence: [{ chunk_id: 'chk_1a2b3c', quote: 'Billing calls Auth' }],
            },
          ],
        },
      },
      // The receipt surface (03 §3.2) + the compatibility matrix: the per-input
      // `entities[]`/`relationships[]` rows and `totals` are AUTHORITATIVE; the aggregate
      // counters are advertised as deprecated aliases (charter: compat-aliases). There is
      // deliberately NO staleNodes field — graph mutations never stale nodes.
      output: [
        'entities[] — one receipt per input entity: {inputIndex, entityId, outcome (created|updated|unchanged)}',
        'relationships[] — one receipt per input relationship: {inputIndex, relationshipId, outcome, evidence:{submitted, spansCreated, spansReused, linksCreated, linksReused}}; per relationship spansCreated + spansReused === submitted (same for links)',
        'totals — {entitiesCreated, entitiesUpdated, entitiesUnchanged, entitiesReferenced, relationshipsCreated, relationshipsUpdated, relationshipsUnchanged, spansCreated, spansReused, linksCreated, linksReused}',
        'entitiesCreated, entitiesUpdated, entitiesUnchanged, entitiesReferenced, relationshipsCreated, relationshipsUpdated, relationshipsUnchanged, spansCreated — deprecated aliases kept for envelope v2; read entities[]/relationships[]/totals instead',
        'no stale-node field: graph mutations never mark nodes stale',
      ],
      sideEffects: [
        'persists created/updated entities',
        'persists created/updated relationships and their quote-verified evidence spans',
        'writes one changelog entry iff created + updated > 0 — an exact repeat writes nothing at all',
      ],
      atomic: true,
      // A payload command in the §6.2 dry-run scope — `--dry-run` is registered here
      // (via `leaf(..., { dryRun: true })`), so the spec MUST declare it (01 §4/§6.2).
      supportsDryRun: true,
      workflow: 'Extract the knowledge graph from a source alongside its claims.',
      related: ['entity show', 'relationship list', 'source chunks', 'vocabulary list'],
      examples: [{ description: 'Apply a graph payload', command: 'kb graph apply --file ./graph.json --json' }],
    },
  ).action(
    workspaceAction(
      ctx,
      (ws, { opts }) => {
        const payload = parseGraphApply(readPayload(opts));
        let diagnostics: readonly DomainIssue[] = [];
        const receipt = ws.graph.apply(payload, {
          onDiagnostics: (issues) => {
            diagnostics = issues;
          },
        });
        // Review the exact contribution from the payload source; graph mutations never
        // produce a stale-node chain.
        const steering = steeringFor('graph apply', { ok: true, sourceId: payload.source_id }, ctx.registry);
        return success(receipt, {
          issues: diagnostics.map(domainIssueToIssue),
          nextActions: steering.nextActions,
          hints: steering.hints,
        });
      },
      { dryRunCommand: 'graph apply' },
    ),
  );
}
