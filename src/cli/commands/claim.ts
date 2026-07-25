/**
 * CLAIM group: apply, conflict, supersede. Behavior ported verbatim from the hand
 * parser. `apply` is dry-run-capable (01 §6.2); `conflict` is variadic.
 */

import type { Command } from 'commander';
import { success, result } from '../output.js';
import { leaf, optStr, readPayload, unknownIdIssue, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { steeringFor } from '../steering.js';
import { domainErrorToIssue } from '../issues.js';
import { ClaimApplySchema } from '../../domain/schemas/agent.js';
import { makeClaimId } from '../../domain/ids.js';
import { systemClock } from '../../domain/services/context.js';
import { DomainIssueError } from '../../domain/issueCodes.js';

export function registerClaim(group: Command, ctx: RunContext): void {
  defineHelp(
    leaf(group, 'apply', 'Persist quote-verified claims atomically.', { dryRun: true }).option(
      '--file <path>',
      'claims payload file (defaults to stdin; - for stdin)',
    ),
    {
      command: 'claim apply',
      group: 'extract',
      usage: 'kb claim apply [options]',
      summary: 'Persist quote-verified claims atomically.',
      args: [],
      flags: [{ flags: '--file <path>', description: 'claims payload file (defaults to stdin; - for stdin)' }],
      input: {
        schema: 'ClaimApplySchema',
        example: {
          source_id: 'src_1a2b3c',
          claims: [
            {
              node_id: 'nod_1a2b3c',
              text: 'The service is written in Rust.',
              claim_type: 'fact',
              spans: [{ chunk_id: 'chk_1a2b3c', quote: 'written in Rust' }],
            },
          ],
        },
      },
      // The receipt surface (03 §3.1) + the compatibility matrix: the per-input `claims[]`
      // rows and `totals` are AUTHORITATIVE; the four retained old fields are advertised
      // as deprecated aliases so an agent reading only `--help --json` never treats them
      // as the accounting (charter: compat-aliases).
      output: [
        'claims[] — one receipt per input: {inputIndex, claimId, outcome (created|updated|unchanged), spans:{submitted, spansCreated, spansReused, linksCreated, linksReused}}; per input spansCreated + spansReused === submitted (same for links)',
        'totals — {created, updated, unchanged, spansCreated, spansReused, linksCreated, linksReused, linksUpdated} summed over the inputs (linksUpdated counts reused links whose role or confidence changed)',
        'staleNodes — the currently-stale node ids, deepest-first (only owners of created/updated claims are staled)',
        'claimsCreated, claimsUpdated, affectedNodes, spansCreatedNet — deprecated aliases kept for envelope v2; read claims[]/totals instead',
      ],
      sideEffects: [
        'persists created/updated claims and their quote-verified spans',
        'marks the owning nodes (and ancestors) of created/updated claims stale',
        'writes one changelog entry iff created + updated > 0 — an exact repeat writes nothing at all',
      ],
      atomic: true,
      // A payload command in the §6.2 dry-run scope — `--dry-run` is registered here
      // (via `leaf(..., { dryRun: true })`), so the spec MUST declare it (01 §4/§6.2).
      supportsDryRun: true,
      workflow: 'Extract claims from a source’s chunks and attach them to nodes.',
      related: ['source chunks', 'node show'],
      examples: [{ description: 'Apply a claims payload', command: 'kb claim apply --file ./claims.json --json' }],
    },
  ).action(
    workspaceAction(
      ctx,
      (ws, { opts }) => {
        const payload = ClaimApplySchema.parse(readPayload(opts));
        try {
          const receipt = ws.claims.apply(payload);
          // Steer per the normative table (01 §6.1), never inline: the nodes this apply
          // staled must be re-synthesized, so point at the deepest-first stale set through
          // the v2 `--context` bundle (the named stale-target flip); with nothing stale
          // left, the table suggests a verify instead. On a `--dry-run` the foundation
          // runner discards this in favor of the exclusive dry-run steering (03 §2).
          // The stale set comes from the receipt itself — `staleNodes` is already the
          // deepest-first list this apply observed (03 §3.1), so no second query is needed.
          const steering = steeringFor('claim apply', { ok: true, staleIds: receipt.staleNodes }, ctx.registry);
          return success(receipt, { nextActions: steering.nextActions, hints: steering.hints });
        } catch (e) {
          // A quote failure steers back to the source chunks so the agent can re-copy the
          // exact quote (01 §6.1). Caught here so the failure envelope carries recovery
          // steering; every other domain error keeps the generic mapping in `runAction`.
          if (e instanceof DomainIssueError && (e.code === 'QUOTE_NOT_FOUND' || e.code === 'QUOTE_AMBIGUOUS')) {
            const steering = steeringFor('claim apply', { ok: false, quoteIssue: true, sourceId: payload.source_id }, ctx.registry);
            return result(null, [domainErrorToIssue(e)], { nextActions: steering.nextActions, hints: steering.hints });
          }
          throw e;
        }
      },
      { dryRunCommand: 'claim apply' },
    ),
  );

  defineHelp(
    leaf(group, 'conflict <claim_id...>', 'Mark one or more unresolved claims as conflicted and stale their owning nodes.'),
    {
      command: 'claim conflict',
      group: 'extract',
      usage: 'kb claim conflict <claim_id...>',
      summary: 'Mark one or more unresolved claims as conflicted and stale their owning nodes.',
      args: [{ name: 'claim_id', description: 'one or more claim ids (clm_…) to mark conflicted', variadic: true }],
      flags: [],
      output: ['conflicted (the claim ids)', 'staleNodes (count marked stale)'],
      sideEffects: ['sets the claims to conflicted', 'marks owning nodes (and ancestors) stale'],
      atomic: true,
      supportsDryRun: false,
      workflow: 'Flag contradictory claims so their nodes get re-synthesized.',
      related: ['claim supersede', 'node show'],
      examples: [{ description: 'Conflict two claims', command: 'kb claim conflict clm_1a2b3c clm_4d5e6f --json' }],
    },
  ).action(
    workspaceAction(ctx, (ws, { args }) => {
      const ids = (args[0] as string[] | undefined) ?? [];
      const claimIds = ids.map((id) => makeClaimId(id));
      const claims = claimIds.map((id) => ws.repos.claims.getById(id));
      const missing = claimIds.filter((_, i) => claims[i] === undefined);
      if (missing.length > 0)
        return result(
          null,
          missing.map((id) => unknownIdIssue('UNKNOWN_CLAIM', `unknown claim ${id}`, id)),
        );

      const now = systemClock();
      ws.repos.tx(() => {
        for (const claim of claims) {
          if (!claim) continue;
          ws.repos.claims.setStatus(claim.id, 'conflicted', null, now);
          if (claim.nodeId) ws.repos.nodes.markStaleWithAncestors(claim.nodeId, now);
        }
        ws.repos.changelog.append({
          ts: now,
          op: 'claim_conflict',
          summary: `Marked ${claimIds.length} claim(s) conflicted`,
          detail: { claims: claimIds },
        });
      });
      return success({ conflicted: claimIds, staleNodes: ws.repos.nodes.listStaleDeepestFirst().length });
    }),
  );

  defineHelp(
    leaf(group, 'supersede <old_claim_id>', 'Mark an older claim superseded by another claim and stale affected nodes.').requiredOption(
      '--by <new_claim_id>',
      'the superseding claim id',
    ),
    {
      command: 'claim supersede',
      group: 'extract',
      usage: 'kb claim supersede [options] <old_claim_id>',
      summary: 'Mark an older claim superseded by another claim and stale affected nodes.',
      args: [{ name: 'old_claim_id', description: 'the claim id (clm_…) being superseded' }],
      flags: [{ flags: '--by <new_claim_id>', description: 'the superseding claim id', required: true }],
      output: ['superseded (the old claim id)', 'by (the new claim id)', 'staleNodes (count marked stale)'],
      sideEffects: ['sets the old claim to superseded', 'marks affected nodes (and ancestors) stale'],
      atomic: true,
      supportsDryRun: false,
      workflow: 'Retire an outdated claim in favor of a newer one.',
      related: ['claim conflict', 'provenance'],
      examples: [{ description: 'Supersede a claim', command: 'kb claim supersede clm_1a2b3c --by clm_4d5e6f --json' }],
    },
  ).action(
      workspaceAction(ctx, (ws, { args, opts }) => {
        const oldId = args[0] as string;
        const by = optStr(opts, 'by')!;
        const oldClaim = ws.repos.claims.getById(makeClaimId(oldId));
        const newClaim = ws.repos.claims.getById(makeClaimId(by));
        if (!oldClaim) return result(null, [unknownIdIssue('UNKNOWN_CLAIM', `unknown claim ${oldId}`, oldId)]);
        if (!newClaim) return result(null, [unknownIdIssue('UNKNOWN_CLAIM', `unknown superseding claim ${by}`, by)]);
        const now = systemClock();
        ws.repos.tx(() => {
          ws.repos.claims.setStatus(oldClaim.id, 'superseded', newClaim.id, now);
          if (oldClaim.nodeId) ws.repos.nodes.markStaleWithAncestors(oldClaim.nodeId, now);
          if (newClaim.nodeId) ws.repos.nodes.markStaleWithAncestors(newClaim.nodeId, now);
          ws.repos.changelog.append({
            ts: now,
            op: 'claim_supersede',
            summary: `Claim ${oldClaim.id} superseded by ${newClaim.id}`,
            detail: { old: oldClaim.id, by: newClaim.id },
          });
        });
        return success({ superseded: oldClaim.id, by: newClaim.id, staleNodes: ws.repos.nodes.listStaleDeepestFirst().length });
      }),
    );
}
