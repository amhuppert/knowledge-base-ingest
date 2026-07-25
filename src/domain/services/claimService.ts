import type { ServiceContext } from './context.js';
import type { ClaimApply, ClaimInput, SpanRef } from '../schemas/agent.js';
import type { ClaimId, NodeId, SpanId } from '../ids.js';
import type { Claim, SourceText } from '../schemas/models.js';
import { normalizeClaimText } from '../algorithms/normalize.js';
import { deriveClaimId } from '../algorithms/idDeriver.js';
import { resolveSpanCandidate, persistSpan, spanIdFor, spanRangeKey, type SpanCandidate } from './spanResolver.js';
import { DomainIssueError, formatPath } from '../issueCodes.js';
import type { SpanRole } from '../schemas/enums.js';

export type ClaimOutcome = 'created' | 'updated' | 'unchanged';

/** Per-input span/link accounting. `spansCreated + spansReused === submitted`; same for links. */
export interface ClaimInputSpans {
  submitted: number;
  spansCreated: number;
  spansReused: number;
  linksCreated: number;
  linksReused: number;
}

/** The per-input receipt row (03 §3.1). */
export interface ClaimInputReceipt {
  inputIndex: number;
  claimId: ClaimId;
  outcome: ClaimOutcome;
  spans: ClaimInputSpans;
}

export interface ClaimApplyTotals {
  created: number;
  updated: number;
  unchanged: number;
  spansCreated: number;
  spansReused: number;
  linksCreated: number;
  linksReused: number;
  /** Existing links whose role or confidence changed (subset of linksReused). */
  linksUpdated: number;
}

/**
 * The `claim apply` receipt (03 §3.1). Authoritative fields: `claims`, `totals`,
 * `staleNodes`. Deprecated aliases retained for envelope-v2 compatibility (compat
 * matrix): `claimsCreated`/`claimsUpdated`/`affectedNodes` and `spansCreatedNet`
 * (the old net after-minus-before span count; the per-input accounting in `claims`/
 * `totals` is authoritative).
 */
export interface ClaimApplyReceipt {
  claims: ClaimInputReceipt[];
  totals: ClaimApplyTotals;
  /** Currently-stale node ids, deepest-first. */
  staleNodes: NodeId[];
  // --- deprecated aliases (compat matrix, 03 §3.1) ---
  claimsCreated: number;
  claimsUpdated: number;
  affectedNodes: number;
  spansCreatedNet: number;
}

/** One resolved span ref, classified against the DB *and* the batch before any write. */
interface RefPlan {
  candidate: SpanCandidate;
  role: SpanRef['role'];
  /** The id this ref's span has, or will have once persisted. */
  spanId: SpanId;
  /** This ref is the first in the batch to introduce the span row (it must persist it). */
  spanCreated: boolean;
  /** No `(claim_id, span_id)` link exists yet — in the DB or as planned by an earlier ref. */
  linkCreated: boolean;
  /** An already-planned/stored link whose role or confidence this ref changes. */
  linkUpdated: boolean;
  /** The confidence to persist on write (monotone max over the link's prior state). */
  writeConfidence: number;
}

/** One classified input: its target claim + per-ref plans + derived outcome. */
interface InputPlan {
  input: ClaimInput;
  claim: Claim;
  refs: RefPlan[];
  outcome: ClaimOutcome;
}

/** The link state a later ref of the same batch must classify itself against. */
interface LinkState {
  role: SpanRole;
  confidence: number;
}

/**
 * The batch's VIRTUAL post-write state, accumulated while classifying (03 §3.1, §4).
 *
 * Every input is classified before ANY write, so a payload that repeats the same claim
 * or the same span ref must be classified against what the EARLIER inputs will have
 * written — not against the untouched DB. Without this, one physical row is reported as
 * two creations (dishonest dedup) and a lower-confidence duplicate overwrites its
 * higher-confidence twin (a monotone-link violation, §4).
 */
interface BatchState {
  /** Claims already planned by this batch, keyed `${nodeId}|${normalizedText}`. */
  claims: Map<string, Claim>;
  /** Spans this batch will insert, keyed by `(source, range)` → the id they will carry. */
  spans: Map<string, SpanId>;
  /** Link state after the batch's earlier refs, keyed `${claimId}|${spanId}`. */
  links: Map<string, LinkState>;
}

export class ClaimService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Persist agent-extracted claims with quote-verified provenance, atomically, and
   * return an actionable per-input receipt (03 §3.1). Each input is CLASSIFIED from
   * span candidates + `(claim_id, span_id)` link lookups BEFORE any write (03 §4.1),
   * so an exact repeat is a true no-op: `unchanged` inputs write nothing, only owners
   * of `created`/`updated` claims are staled, and the changelog is appended iff
   * `created + updated > 0`. Any failure (unknown node/chunk, unverifiable quote)
   * rolls the whole batch back.
   */
  apply(payload: ClaimApply): ClaimApplyReceipt {
    const { repos } = this.ctx;
    const now = this.ctx.now();
    const source = repos.sources.getById(payload.source_id);
    if (!source) {
      throw new DomainIssueError('UNKNOWN_SOURCE', `unknown source ${payload.source_id}`, { path: 'source_id', ids: [payload.source_id] });
    }
    const sourceText = repos.sourceTexts.get(payload.source_id);
    if (!sourceText) {
      throw new DomainIssueError('UNKNOWN_SOURCE', `no canonical text for source ${payload.source_id}`, { path: 'source_id', ids: [payload.source_id] });
    }

    return repos.tx(() => {
      const spansBefore = repos.spans.listBySource(payload.source_id).length;

      // ---- Phase 1: classify every input read-only (candidates + link lookups), each
      // against the DB PLUS what the batch's earlier inputs will have written. ----
      const batch: BatchState = { claims: new Map(), spans: new Map(), links: new Map() };
      const plans: InputPlan[] = payload.claims.map((input, ci) => this.classify(input, ci, payload, sourceText, now, batch));

      // ---- Phase 2: write only created/updated inputs; unchanged inputs write nothing. ----
      const affected = new Set<NodeId>();
      const rows: ClaimInputReceipt[] = [];
      const totals: ClaimApplyTotals = {
        created: 0, updated: 0, unchanged: 0,
        spansCreated: 0, spansReused: 0, linksCreated: 0, linksReused: 0, linksUpdated: 0,
      };

      for (let ci = 0; ci < plans.length; ci++) {
        const plan = plans[ci]!;
        const acc: ClaimInputSpans = {
          submitted: plan.refs.length,
          spansCreated: plan.refs.filter((r) => r.spanCreated).length,
          spansReused: plan.refs.filter((r) => !r.spanCreated).length,
          linksCreated: plan.refs.filter((r) => r.linkCreated).length,
          linksReused: plan.refs.filter((r) => !r.linkCreated).length,
        };

        if (plan.outcome !== 'unchanged') {
          repos.claims.upsert(plan.claim);
          for (const ref of plan.refs) {
            // Only the ref that CLAIMED the creation persists the span; a batch-local
            // duplicate reuses the id its twin will have written (they are identical).
            if (ref.spanCreated) persistSpan(repos, ref.candidate, now);
            if (ref.linkCreated || ref.linkUpdated) {
              repos.claimSpans.upsert({ claimId: plan.claim.id, spanId: ref.spanId, role: ref.role, confidence: ref.writeConfidence, extractor: 'agent' });
            }
          }
          affected.add(plan.claim.nodeId as NodeId);
        }

        totals[plan.outcome]++;
        totals.spansCreated += acc.spansCreated;
        totals.spansReused += acc.spansReused;
        totals.linksCreated += acc.linksCreated;
        totals.linksReused += acc.linksReused;
        totals.linksUpdated += plan.refs.filter((r) => r.linkUpdated).length;
        rows.push({ inputIndex: ci, claimId: plan.claim.id, outcome: plan.outcome, spans: acc });
      }

      for (const nodeId of affected) repos.nodes.markStaleWithAncestors(nodeId, now);

      const written = totals.created + totals.updated;
      if (written > 0) {
        repos.changelog.append({
          ts: now,
          op: 'claim_apply',
          sourceId: payload.source_id,
          summary: `Applied ${payload.claims.length} claim(s): ${totals.created} new, ${totals.updated} updated, ${totals.unchanged} unchanged`,
          detail: { ...totals, nodes: [...affected] },
        });
      }

      const spansCreatedNet = repos.spans.listBySource(payload.source_id).length - spansBefore;
      const staleNodes = repos.nodes.listStaleDeepestFirst().map((n) => n.id);

      return {
        claims: rows,
        totals,
        staleNodes,
        claimsCreated: totals.created,
        claimsUpdated: totals.updated,
        affectedNodes: affected.size,
        spansCreatedNet,
      };
    });
  }

  /**
   * Read-only classification of one input against the current DB PLUS `batch` — the
   * virtual state the batch's earlier inputs will have written (no writes here). `batch`
   * is advanced as each ref is classified, so duplicates inside one payload are honest:
   * the twin is `reused`, and a link's confidence only ever rises (03 §3.1, §4).
   */
  private classify(
    input: ClaimInput,
    ci: number,
    payload: ClaimApply,
    sourceText: SourceText,
    now: string,
    batch: BatchState,
  ): InputPlan {
    const { repos } = this.ctx;
    const node = repos.nodes.getById(input.node_id);
    if (!node) {
      throw new DomainIssueError('UNKNOWN_NODE', `unknown node ${input.node_id} for claim`, {
        path: formatPath(['claims', ci, 'node_id']),
        ids: [input.node_id],
      });
    }

    const normalizedText = normalizeClaimText(input.text);
    // Identity is (node_id, normalized_text). Re-extraction of an existing assertion
    // attaches provenance and PRESERVES its status (never resurrects a superseded claim).
    const claimKey = `${input.node_id}|${normalizedText}`;
    const existingClaim = batch.claims.get(claimKey) ?? repos.claims.getByNodeNormalized(input.node_id, normalizedText);
    const claimId = existingClaim ? existingClaim.id : deriveClaimId(normalizedText, payload.source_id);

    const refs: RefPlan[] = input.spans.map((ref, si) => {
      const candidate = resolveSpanCandidate(repos, payload.source_id, sourceText, ref, ['claims', ci, 'spans', si]);
      const rangeKey = spanRangeKey(candidate);
      const spanId = spanIdFor(candidate);
      // The span is "created" by the FIRST ref that introduces it — in the DB or in this batch.
      const spanCreated = candidate.existingSpanId === null && !batch.spans.has(rangeKey);
      if (spanCreated) batch.spans.set(rangeKey, spanId);

      const linkKey = `${claimId}|${spanId}`;
      const priorLink: LinkState | undefined =
        batch.links.get(linkKey) ??
        (existingClaim && candidate.existingSpanId !== null ? repos.claimSpans.getLink(claimId, candidate.existingSpanId) : undefined);
      const linkCreated = priorLink === undefined;
      const linkUpdated = priorLink !== undefined && (priorLink.role !== ref.role || ref.confidence > priorLink.confidence);
      const writeConfidence = priorLink ? Math.max(priorLink.confidence, ref.confidence) : ref.confidence;
      // Record the link's post-write state (unchanged refs write nothing, so they leave it).
      batch.links.set(linkKey, linkCreated || linkUpdated ? { role: ref.role, confidence: writeConfidence } : priorLink);

      return { candidate, role: ref.role, spanId, spanCreated, linkCreated, linkUpdated, writeConfidence };
    });

    // Outcome (03 §4): new claim → created. Existing claim → unchanged iff its
    // confidence is not raised AND no ref adds or changes a span/link; else updated.
    const confidenceRaised = existingClaim !== undefined && input.confidence > existingClaim.confidence;
    const anyRefChange = refs.some((r) => r.linkCreated || r.linkUpdated);
    const outcome: ClaimOutcome = existingClaim === undefined ? 'created' : !confidenceRaised && !anyRefChange ? 'unchanged' : 'updated';

    const claim: Claim = existingClaim
      ? { ...existingClaim, confidence: Math.max(existingClaim.confidence, input.confidence), updatedAt: now }
      : {
          id: claimId,
          nodeId: input.node_id,
          text: input.text,
          normalizedText,
          claimType: input.claim_type,
          confidence: input.confidence,
          status: 'active',
          supersededByClaimId: null,
          firstSeenSourceId: payload.source_id,
          createdAt: now,
          updatedAt: now,
        };

    // An `unchanged` input writes nothing, so the batch's view of this claim stays as it was.
    batch.claims.set(claimKey, outcome === 'unchanged' && existingClaim ? existingClaim : claim);
    return { input, claim, refs, outcome };
  }
}
