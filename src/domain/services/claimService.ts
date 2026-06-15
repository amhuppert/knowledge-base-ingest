import type { ServiceContext } from './context.js';
import type { ClaimApply } from '../schemas/agent.js';
import type { NodeId } from '../ids.js';
import { normalizeClaimText } from '../algorithms/normalize.js';
import { deriveClaimId } from '../algorithms/idDeriver.js';
import { resolveSpan, ProvenanceError } from './spanResolver.js';

export interface ClaimApplyResult {
  claimsCreated: number;
  claimsUpdated: number;
  spansCreated: number;
  affectedNodes: number;
}

export class ClaimService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Persist agent-extracted claims with quote-verified provenance, atomically.
   * Any failure (unknown node/chunk, unverifiable quote) rolls the whole batch
   * back. Affected nodes and their ancestors are marked stale for re-synthesis.
   */
  apply(payload: ClaimApply): ClaimApplyResult {
    const { repos, now } = { repos: this.ctx.repos, now: this.ctx.now() };
    const source = repos.sources.getById(payload.source_id);
    if (!source) throw new ProvenanceError(`unknown source ${payload.source_id}`);
    const sourceText = repos.sourceTexts.get(payload.source_id);
    if (!sourceText) throw new ProvenanceError(`no canonical text for source ${payload.source_id}`);

    return repos.tx(() => {
      const spansBefore = repos.spans.listBySource(payload.source_id).length;
      let created = 0;
      let updated = 0;
      const affected = new Set<NodeId>();

      for (const input of payload.claims) {
        const node = repos.nodes.getById(input.node_id);
        if (!node) throw new ProvenanceError(`unknown node ${input.node_id} for claim`);

        const normalizedText = normalizeClaimText(input.text);
        // Identity is (node_id, normalized_text). If this assertion already exists
        // on this node — even from a different source — attach new provenance to it
        // rather than minting a colliding id, and PRESERVE its status (a re-extraction
        // must never resurrect a superseded/conflicted claim).
        const existing = repos.claims.getByNodeNormalized(input.node_id, normalizedText);
        const claim = existing
          ? { ...existing, confidence: Math.max(existing.confidence, input.confidence), updatedAt: now }
          : {
              id: deriveClaimId(normalizedText, payload.source_id),
              nodeId: input.node_id,
              text: input.text,
              normalizedText,
              claimType: input.claim_type,
              confidence: input.confidence,
              status: 'active' as const,
              supersededByClaimId: null,
              firstSeenSourceId: payload.source_id,
              createdAt: now,
              updatedAt: now,
            };
        const res = repos.claims.upsert(claim);
        const claimId = claim.id;
        if (res.created) created++;
        else updated++;

        for (const ref of input.spans) {
          const spanId = resolveSpan(repos, payload.source_id, sourceText, ref, now);
          repos.claimSpans.upsert({
            claimId,
            spanId,
            role: ref.role,
            confidence: ref.confidence,
            extractor: 'agent',
          });
        }
        affected.add(input.node_id);
      }

      for (const nodeId of affected) repos.nodes.markStaleWithAncestors(nodeId, now);

      const spansCreated = repos.spans.listBySource(payload.source_id).length - spansBefore;
      repos.changelog.append({
        ts: now,
        op: 'claim_apply',
        sourceId: payload.source_id,
        summary: `Applied ${payload.claims.length} claim(s): ${created} new, ${updated} updated`,
        detail: { created, updated, spansCreated, nodes: [...affected] },
      });

      return { claimsCreated: created, claimsUpdated: updated, spansCreated, affectedNodes: affected.size };
    });
  }
}
