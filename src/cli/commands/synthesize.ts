/**
 * SYNTHESIZE command. Sets node prose with inline claim citations and clears that
 * node's stale flag. Accepts ONE node (unchanged) or a `{"nodes":[…]}` batch applied
 * deepest-first in a single transaction (04 §3). Dry-run-capable (01 §6.2).
 */

import type { Command } from 'commander';
import type { z } from 'zod';
import { success } from '../output.js';
import { leaf, readPayload, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { formatPath } from '../issues.js';
import { steeringFor } from '../steering.js';
import {
  SynthesizeSchema,
  SynthesizeBatchSchema,
  SYNTHESIZE_BATCH_MAX,
  type Synthesize,
  type SynthesizeBatch,
} from '../../domain/schemas/agent.js';
import { DomainIssuesError, type DomainIssue } from '../../domain/issueCodes.js';

/** A Zod issue as a coded `PAYLOAD_SCHEMA` diagnostic with the canonical bracket-dot path. */
function payloadSchemaIssue(issue: z.ZodIssue): DomainIssue {
  const path = formatPath(issue.path);
  return {
    code: 'PAYLOAD_SCHEMA',
    message: path ? `${path}: ${issue.message}` : issue.message,
    ...(path ? { path } : {}),
  };
}

/** Whether the payload is the BATCH form — decided by the `nodes` key, before parsing. */
function isBatchShaped(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'nodes' in raw;
}

/**
 * Parse either accepted payload (04 §3). The form is discriminated on `nodes` BEFORE
 * parsing rather than through a Zod union, so a malformed payload reports its own field
 * errors instead of both union branches' — and every batch-shape violation (over the
 * {@link SYNTHESIZE_BATCH_MAX} cap, a duplicate `node_id` naming both indices, a bad entry
 * field) surfaces as a coded `PAYLOAD_SCHEMA` issue with its `nodes[i].field` path.
 */
export function parseSynthesizePayload(raw: unknown): Synthesize | SynthesizeBatch {
  if (!isBatchShaped(raw)) return SynthesizeSchema.parse(raw);
  const parsed = SynthesizeBatchSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new DomainIssuesError(parsed.error.issues.map(payloadSchemaIssue));
}

export function registerSynthesize(program: Command, ctx: RunContext): void {
  defineHelp(
    leaf(program, 'synthesize', 'Set node prose with inline claim citations and clear that node stale flag.', {
      dryRun: true,
    }).option('--file <path>', 'node payload file (defaults to stdin; - for stdin)'),
    {
      command: 'synthesize',
      group: 'synthesize',
      usage: 'kb synthesize [options]',
      summary: 'Set node prose with inline claim citations and clear that node stale flag.',
      args: [],
      flags: [{ flags: '--file <path>', description: 'node payload file (defaults to stdin; - for stdin)' }],
      input: {
        schema: 'SynthesizePayloadSchema',
        example: {
          node_id: 'nod_1a2b3c',
          title: 'Caching strategy',
          body_md: 'The service caches responses for 60s [^clm_1a2b3c].',
        },
      },
      output: [
        'single payload: nodeId, outcome (updated | unchanged | stale-cleared)',
        `batch payload: nodes[] (inputIndex, nodeId, depth, outcome) in apply order + totals`,
        'staleNodes (nodes still needing synthesis, deepest-first)',
      ],
      sideEffects: [
        'sets the node prose (body, and title/summary when provided)',
        'clears the node stale flag',
        'marks ancestor nodes stale when the title or summary changes (a body-only change does not)',
      ],
      atomic: true,
      // A payload command in the §6.2 dry-run scope — `--dry-run` is registered here
      // (via `leaf(..., { dryRun: true })`), so the spec MUST declare it (01 §4/§6.2).
      supportsDryRun: true,
      workflow: 'Write node prose citing active claims after claims are applied.',
      related: ['node show', 'verify'],
      examples: [
        { description: 'Synthesize one node from a file', command: 'kb synthesize --file ./node.json --json' },
        {
          description: `Synthesize a batch — {"nodes":[<payload>, …]}, up to ${SYNTHESIZE_BATCH_MAX}, applied deepest-first in one transaction`,
          command: 'kb synthesize --file ./batch.json --dry-run --json',
        },
      ],
    },
  ).action(
    workspaceAction(
      ctx,
      (ws, { opts }) => {
        const payload = parseSynthesizePayload(readPayload(opts));
        const receipt = 'nodes' in payload ? ws.nodes.synthesizeBatch(payload) : ws.nodes.synthesize(payload);
        // Steer per the normative table (01 §6.1): stale nodes remain → point at them
        // (deepest-first); none remain → suggest a verify. A batch reports the same
        // post-apply stale set, so clearing the last stale node lands on verify (04 §3).
        // On a dry-run this is discarded by the foundation runner in favor of the
        // exclusive dry-run steering (03 §2).
        const steering = steeringFor('synthesize', { ok: true, staleIds: receipt.staleNodes }, ctx.registry);
        return success(receipt, { nextActions: steering.nextActions, hints: steering.hints });
      },
      { dryRunCommand: 'synthesize' },
    ),
  );
}
