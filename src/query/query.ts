/**
 * QUERY module: search, ask-context, and answer-check.
 *
 * This is the read side of the knowledge base — what lets an AI agent find
 * information and answer questions with provenance. All three functions are
 * pure with respect to the DB (read-only) and deterministic given the same
 * data.
 *
 * FTS note: SQLite FTS5 MATCH parses its argument as a query expression, so raw
 * user text containing punctuation (quotes, parens, `*`, `-`, `:` …) can throw a
 * syntax error. We defend against this by quoting each token (see `ftsMatch`)
 * AND by catching any residual error per-scope and degrading to empty results
 * rather than throwing out of `search`/`askContext`.
 */

import type { Repositories } from '../db/repositories/index.js';
import { ClaimRow, NodeRow, ChunkRow } from '../db/rows.js';
import type { Claim, Node, Chunk } from '../domain/schemas/models.js';
import type { ClaimId, NodeId } from '../domain/ids.js';
import { DomainIssueError } from '../domain/issueCodes.js';
import { extractCitations } from '../domain/algorithms/citations.js';
import { scanRegions, splitSentenceSpans } from '../domain/algorithms/markdown.js';

const SNIPPET_LEN = 200;

/** Trim text to ~`max` chars, collapsing internal whitespace, with an ellipsis. */
function snippet(text: string, max = SNIPPET_LEN): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * Build a safe FTS5 MATCH expression from free text. Each whitespace-separated
 * token is wrapped in double quotes (escaping embedded quotes per FTS5 rules) so
 * punctuation inside a token is literal, not query syntax. `mode`:
 *   - `AND` — every token required (precise; keyword search);
 *   - `OR`  — any token (recall; natural-language questions);
 *   - `PHRASE` — the whole query as ONE quoted FTS phrase (adjacent tokens only).
 * Returns the empty string when there is nothing to match.
 */
function ftsMatch(query: string, mode: 'AND' | 'OR' | 'PHRASE'): string {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  const esc = (t: string): string => t.replace(/"/g, '""');
  if (mode === 'PHRASE') return `"${tokens.map(esc).join(' ')}"`;
  const quoted = tokens.map((t) => `"${esc(t)}"`);
  return quoted.join(mode === 'OR' ? ' OR ' : ' ');
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Search scope vocabulary as a RUNTIME const (not a type-only union) so it can
 * feed Commander's `Option.choices(...)` at the CLI edge (01 §1.3, finding 28).
 * `SearchScope` is derived from it, so the two can never drift. `'all'` is a
 * meta-scope expanding to the four concrete scopes.
 */
export const SEARCH_SCOPES = ['chunks', 'claims', 'nodes', 'entities', 'all'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** A concrete search scope (everything except the `'all'` meta-scope). */
export type Scope = Exclude<SearchScope, 'all'>;

/**
 * Requested match strategy, a RUNTIME const feeding the `--match` Commander
 * choices (05 §1, finding 27). `auto` is the recall-friendly default (strict AND
 * per scope, falling back to OR only where AND found nothing); `all` is strict AND
 * with no fallback; `any` is OR; `phrase` is a single adjacent FTS phrase.
 */
export const MATCH_MODES = ['auto', 'all', 'any', 'phrase'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

/**
 * The strategy ACTUALLY applied to a scope, reported in `matchModes` and on each
 * hit (05 §1). Differs from the requested `MatchMode`: `auto` resolves per scope to
 * `'all'` (AND hit) or `'any-fallback'` (OR fallback), and the entities scope is
 * always `'like'` (its LIKE search is unaffected by `--match`).
 */
export type AppliedMatchMode = 'all' | 'any' | 'any-fallback' | 'phrase' | 'like';

export interface SearchHit {
  kind: 'chunk' | 'claim' | 'node' | 'entity';
  id: string;
  title: string;
  snippet: string;
  sourceId?: string;
  /** The match strategy applied to this hit's scope. */
  matchMode: AppliedMatchMode;
  /** Raw FTS5 bm25 (more negative = better); comparable only within a scope. `null` for entity (LIKE) hits. */
  rank: number | null;
}

export interface SearchResult {
  query: string;
  /** The strategy applied per concrete scope that ran. */
  matchModes: Partial<Record<Scope, AppliedMatchMode>>;
  /** Scope-major (chunks, claims, nodes, entities), rank-ordered within each FTS scope. */
  hits: SearchHit[];
}

const ALL_SCOPES: readonly Scope[] = ['chunks', 'claims', 'nodes', 'entities'];

/** A hit's identity fields, before its scope's `matchMode`/`rank` are stamped on. */
type HitCore = Omit<SearchHit, 'matchMode' | 'rank'>;

/** An FTS hit paired with its raw bm25 rank (selected as `f.rank`). */
interface RankedCore {
  core: HitCore;
  rank: number;
}

function searchChunks(repos: Repositories, match: string, limit: number): RankedCore[] {
  try {
    const rows = repos.db
      .prepare(
        `SELECT c.*, f.rank AS __rank FROM chunks_fts f JOIN source_chunks c ON c.rowid = f.rowid
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows.map((r): RankedCore => {
      const chunk: Chunk = ChunkRow.parse(r);
      const source = repos.sources.getById(chunk.sourceId);
      const title = chunk.headingPath.trim() || source?.title || chunk.sourceId;
      return {
        core: { kind: 'chunk', id: chunk.id, title, snippet: snippet(chunk.text), sourceId: chunk.sourceId },
        rank: r['__rank'] as number,
      };
    });
  } catch {
    return [];
  }
}

function searchClaims(repos: Repositories, match: string, limit: number): RankedCore[] {
  try {
    const rows = repos.db
      .prepare(
        `SELECT c.*, f.rank AS __rank FROM claims_fts f JOIN claims c ON c.rowid = f.rowid
         WHERE claims_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows.map((r): RankedCore => {
      const claim: Claim = ClaimRow.parse(r);
      return {
        core: { kind: 'claim', id: claim.id, title: claim.claimType, snippet: snippet(claim.text), sourceId: claim.firstSeenSourceId },
        rank: r['__rank'] as number,
      };
    });
  } catch {
    return [];
  }
}

function searchNodes(repos: Repositories, match: string, limit: number): RankedCore[] {
  try {
    const rows = repos.db
      .prepare(
        `SELECT n.*, f.rank AS __rank FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
         WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows.map((r): RankedCore => {
      const node: Node = NodeRow.parse(r);
      return {
        core: { kind: 'node', id: node.id, title: node.title, snippet: snippet(node.bodyMd) },
        rank: r['__rank'] as number,
      };
    });
  } catch {
    return [];
  }
}

function searchEntities(repos: Repositories, query: string, limit: number): HitCore[] {
  // EntityRepo.search uses LIKE, not FTS, so it cannot throw on FTS syntax.
  return repos.entities.search(query, limit).map(
    (e): HitCore => ({
      kind: 'entity',
      id: e.id,
      title: e.canonicalName,
      snippet: snippet(e.description || `${e.type}: ${e.canonicalName}`),
    }),
  );
}

/** The three FTS-backed scopes, keyed for the per-scope runner. */
type FtsScope = 'chunks' | 'claims' | 'nodes';
const FTS_RUNNERS: Record<FtsScope, (repos: Repositories, match: string, limit: number) => RankedCore[]> = {
  chunks: searchChunks,
  claims: searchClaims,
  nodes: searchNodes,
};

/**
 * Run one FTS scope under `mode`, returning its hits and the strategy actually
 * applied. Fallback is decided INDEPENDENTLY per scope (05 §1): under `auto` the
 * AND pass runs first and this scope reruns with OR only when its AND found nothing
 * — a hit in another scope must not suppress this one's fallback. `any` skips the
 * AND pass entirely; `all`/`phrase` never fall back.
 */
function runFtsScope(
  repos: Repositories,
  scope: FtsScope,
  query: string,
  limit: number,
  mode: MatchMode,
): { hits: RankedCore[]; applied: AppliedMatchMode } {
  const run = FTS_RUNNERS[scope];
  switch (mode) {
    case 'phrase':
      return { hits: run(repos, ftsMatch(query, 'PHRASE'), limit), applied: 'phrase' };
    case 'any':
      return { hits: run(repos, ftsMatch(query, 'OR'), limit), applied: 'any' };
    case 'all':
      return { hits: run(repos, ftsMatch(query, 'AND'), limit), applied: 'all' };
    case 'auto': {
      const andHits = run(repos, ftsMatch(query, 'AND'), limit);
      if (andHits.length > 0) return { hits: andHits, applied: 'all' };
      return { hits: run(repos, ftsMatch(query, 'OR'), limit), applied: 'any-fallback' };
    }
  }
}

/**
 * Full-text search across the requested scope(s), returning a {@link SearchResult}
 * whose `matchModes` reports the strategy applied per scope and whose `hits` are
 * scope-major (chunks, claims, nodes, entities) and rank-ordered within each FTS
 * scope. For `'all'`, every scope runs (each honoring `limit`).
 *
 * FTS MATCH is sanitized via `ftsMatch` and wrapped in try/catch per scope, so a
 * malformed query degrades to empty results for that scope instead of throwing.
 */
export function search(
  repos: Repositories,
  query: string,
  opts: { scope?: SearchScope; limit?: number; match?: MatchMode } = {},
): SearchResult {
  const scope = opts.scope ?? 'all';
  const limit = opts.limit ?? 20;
  const mode = opts.match ?? 'auto';

  const scopes = scope === 'all' ? ALL_SCOPES : [scope];
  const hasTokens = query.split(/\s+/).some((t) => t.length > 0);

  const matchModes: Partial<Record<Scope, AppliedMatchMode>> = {};
  const hits: SearchHit[] = [];

  for (const s of scopes) {
    if (s === 'entities') {
      matchModes.entities = 'like';
      for (const core of searchEntities(repos, query, limit)) hits.push({ ...core, matchMode: 'like', rank: null });
      continue;
    }
    // No FTS tokens (empty/whitespace query) → nothing to match for this scope.
    if (!hasTokens) continue;
    const { hits: scopeHits, applied } = runFtsScope(repos, s, query, limit, mode);
    matchModes[s] = applied;
    for (const { core, rank } of scopeHits) hits.push({ ...core, matchMode: applied, rank });
  }

  return { query, matchModes, hits };
}

// ---------------------------------------------------------------------------
// askContext
// ---------------------------------------------------------------------------

export interface ClaimContext {
  id: string;
  text: string;
  claimType: string;
  confidence: number;
  status: string;
  nodeId: string | null;
  nodeTitle: string | null;
  provenance: Array<{ sourceTitle: string; quote: string; storedPath: string }>;
}

/**
 * How the returned claims were retrieved:
 *   - `fts`             — every returned claim matched the question's terms;
 *   - `filter-fallback` — the supplied filter(s) acted as a SELECTOR and contributed
 *     claims that did NOT match the terms, so the set is complete rather than purely
 *     ranked (term matches still lead — see `askContext`).
 */
export type AskRetrieval = 'fts' | 'filter-fallback';

export interface AskContextResult {
  question: string;
  claims: ClaimContext[];
  nodes: Array<{ id: string; title: string; snippet: string }>;
  entities: Array<{ id: string; type: string; name: string }>;
  /** Echo of the filters actually applied (05 §2), so the caller can widen. */
  applied: { claimType: string | null; node: string | null };
  /** Which path produced `claims` — labelled so a fallback is never silent. */
  retrieval: AskRetrieval;
}

/** Statuses whose claims are surfaced by askContext (active + conflicted). */
const SURFACED_CLAIM_STATUSES = ['active', 'conflicted'] as const;

function enrichClaim(repos: Repositories, claim: Claim): ClaimContext {
  const node = claim.nodeId ? repos.nodes.getById(claim.nodeId) : undefined;
  const provenance = repos.claimSpans.spansForClaim(claim.id).map((span) => {
    const source = repos.sources.getById(span.sourceId);
    return {
      sourceTitle: source?.title ?? span.sourceId,
      quote: span.quote,
      storedPath: source?.storedPath ?? '',
    };
  });
  return {
    id: claim.id,
    text: claim.text,
    claimType: claim.claimType,
    confidence: claim.confidence,
    status: claim.status,
    nodeId: claim.nodeId,
    nodeTitle: node?.title ?? null,
    provenance,
  };
}

/**
 * Primary Q&A retrieval: find the claims most relevant to `question` (via the
 * claims FTS index), each enriched with its owning node's title and full
 * provenance (source title + quote + stored path). Only ACTIVE claims are
 * returned, except `conflicted` claims are also surfaced (with their status) so
 * the caller can see and flag the conflict. Top matching nodes and entities are
 * included as additional context.
 *
 * Optional filters (05 §2). `nodeId` is validated FIRST — an unknown node throws
 * `UNKNOWN_NODE` before any retrieval. The status, `claimType`, and subtree filters
 * are all pushed INTO the FTS query's WHERE (before `ORDER BY rank LIMIT`), so
 * ranking only ever sees qualifying rows — this eliminates the former `limit*4`
 * over-fetch, which could drop a qualifying claim ranked past a window filled with
 * excluded (e.g. superseded) rows (finding 29).
 */
export function askContext(
  repos: Repositories,
  question: string,
  opts: { limit?: number; claimType?: string | null; nodeId?: string | null } = {},
): AskContextResult {
  const limit = opts.limit ?? 12;
  const claimType = opts.claimType ?? null;
  const nodeId = opts.nodeId ?? null;

  // --node is validated FIRST, before any retrieval: an unknown node is a hard
  // error, not a silent empty result. The subtree is the set of node ids owning a
  // claim anywhere under `nodeId` (derived from listInSubtree).
  let subtreeNodeIds: NodeId[] | null = null;
  if (nodeId !== null) {
    const node = repos.nodes.getById(nodeId as NodeId);
    if (!node) {
      throw new DomainIssueError('UNKNOWN_NODE', `No such node ${nodeId}`, { ids: [nodeId] });
    }
    subtreeNodeIds = [
      ...new Set(repos.claims.listInSubtree(node.id).map((c) => c.nodeId).filter((n): n is NodeId => n !== null)),
    ];
  }

  // Questions are natural language; OR-join for recall (AND would require every
  // token — including "how"/"are" — to appear in a claim).
  const match = ftsMatch(question, 'OR');

  let claims: ClaimContext[] = [];
  if (match) {
    try {
      // Every filter lives in the WHERE clause so `ORDER BY rank LIMIT` ranks only
      // qualifying rows (no over-fetch, no post-filter).
      const where: string[] = [
        'claims_fts MATCH ?',
        `c.status IN (${SURFACED_CLAIM_STATUSES.map(() => '?').join(', ')})`,
      ];
      const params: unknown[] = [match, ...SURFACED_CLAIM_STATUSES];
      if (claimType !== null) {
        where.push('c.claim_type = ?');
        params.push(claimType);
      }
      if (subtreeNodeIds !== null) {
        // Empty subtree → `IN (NULL)` never matches (correctly zero claims).
        const placeholders = subtreeNodeIds.length > 0 ? subtreeNodeIds.map(() => '?').join(', ') : 'NULL';
        where.push(`c.node_id IN (${placeholders})`);
        params.push(...subtreeNodeIds);
      }
      params.push(limit);
      const rows = repos.db
        .prepare(
          `SELECT c.* FROM claims_fts f JOIN claims c ON c.rowid = f.rowid
           WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
        )
        .all(...params) as unknown[];
      claims = rows.map((r): Claim => ClaimRow.parse(r)).map((c) => enrichClaim(repos, c));
    } catch {
      claims = [];
    }
  }

  /**
   * CATEGORY SELECTOR (eval run 1, finding 1).
   *
   * `claims_fts MATCH ?` is mandatory above, so a filter could only ever NARROW term
   * matches. But agents reach for `--claim-type`/`--node` as a SELECTOR ("show me the
   * open questions"), and a category question shares little or no vocabulary with the
   * claim texts it wants: "what open questions remain about rate limiting?" term-matched
   * exactly ONE of four open questions, and a broader phrasing matched none.
   *
   * So when a filter is supplied, the filtered set — not the term match — defines the
   * answer. Term matches keep their rank and lead; the rest of the set is appended by
   * (confidence, id) so a category answer is complete AND still relevance-ordered.
   * `limit` caps the whole thing, and `retrieval` labels any augmentation so a
   * completed set is never mistaken for a pure ranking.
   *
   * Note the trigger is under-coverage, NOT emptiness: firing only on zero results
   * would have left the reported 1-of-4 case broken. With no filter there is nothing
   * to complete — the whole KB is not an answer to an unmatched question.
   */
  let retrieval: AskRetrieval = 'fts';
  const hasFilter = claimType !== null || subtreeNodeIds !== null;
  if (hasFilter && claims.length < limit) {
    const where: string[] = [`c.status IN (${SURFACED_CLAIM_STATUSES.map(() => '?').join(', ')})`];
    const params: unknown[] = [...SURFACED_CLAIM_STATUSES];
    if (claimType !== null) {
      where.push('c.claim_type = ?');
      params.push(claimType);
    }
    if (subtreeNodeIds !== null) {
      const placeholders = subtreeNodeIds.length > 0 ? subtreeNodeIds.map(() => '?').join(', ') : 'NULL';
      where.push(`c.node_id IN (${placeholders})`);
      params.push(...subtreeNodeIds);
    }
    params.push(limit);
    const rows = repos.db
      .prepare(
        `SELECT c.* FROM claims c WHERE ${where.join(' AND ')}
         ORDER BY c.confidence DESC, c.id LIMIT ?`,
      )
      .all(...params) as unknown[];
    const seen = new Set(claims.map((c) => c.id));
    const remainder = rows
      .map((r): Claim => ClaimRow.parse(r))
      .filter((c) => !seen.has(c.id))
      .map((c) => enrichClaim(repos, c));
    if (remainder.length > 0) {
      claims = [...claims, ...remainder].slice(0, limit);
      retrieval = 'filter-fallback';
    }
  }

  const nodes = (match ? searchNodes(repos, match, limit) : []).map(({ core }) => ({
    id: core.id,
    title: core.title,
    snippet: core.snippet,
  }));

  const entities = repos.entities.search(question, limit).map((e) => ({
    id: e.id,
    type: e.type,
    name: e.canonicalName,
  }));

  return { question, claims, nodes, entities, applied: { claimType, node: nodeId }, retrieval };
}

// ---------------------------------------------------------------------------
// answerCheck
// ---------------------------------------------------------------------------

/** An assertive prose sentence that carries no citation, located by line. */
export interface UncitedAssertion {
  text: string;
  line: number;
}

export interface AnswerCheckResult {
  /** Mirrors the envelope `ok`: true iff no unknown/inactive citation and nothing uncited. */
  ok: boolean;
  citedClaims: string[];
  unknownCitations: string[];
  inactiveCitations: string[];
  uncited: UncitedAssertion[];
  /**
   * @deprecated Alias of `uncited[].text`; RETAINED for all of envelope v2
   * (05 §4.3, finding 33). New consumers should read `uncited` for line numbers.
   */
  uncitedSentences: string[];
}

/** Claim statuses that make a citation "inactive" (stale provenance). */
const INACTIVE_STATUSES = new Set(['superseded', 'retracted']);

const CITATION_TOKEN_RE = /\[\^clm_[0-9a-f]+\]/;

/** 1-based line of an offset in `text` (derives sentence lines from their offset). */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** True if a sentence makes an assertion that ought to carry a citation. */
function isAssertive(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return false;
  // Skip markdown headings and list/quote markers — these are structural, not
  // assertions of fact.
  if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  return words.length > 4;
}

/**
 * STRUCTURAL provenance check for a synthesized answer, Markdown-aware (05 §4).
 * The answer is first partitioned into regions so checks run only where they
 * should:
 *   - Assertions are evaluated over PROSE regions only. Quoted questions in a
 *     footnote definition, a blockquote, or a code block no longer masquerade as
 *     uncited assertions (findings 31–33).
 *   - Citations are extracted from prose + footnote-definition + blockquote
 *     regions but NOT from code — a `[^clm_…]` shown as a code sample is neither
 *     validated nor counted. Footnote-definition citations still validate.
 *
 * It validates the *shape* of citations only (existence, active status, and that
 * every assertive prose sentence carries one). It does NOT check semantic
 * entailment — whether the cited claim supports the sentence — which needs NL
 * inference and is deferred to a future semantic-verification pass.
 */
export function answerCheck(
  repos: Repositories,
  answer: string,
  claimIds?: string[],
): AnswerCheckResult {
  const regions = scanRegions(answer);

  // Citations: every non-code region, merged in document order (first occurrence).
  const citedClaims: string[] = [];
  const citedSet = new Set<string>();
  for (const r of regions) {
    if (r.kind === 'fence' || r.kind === 'inlineCode') continue;
    for (const id of extractCitations(answer.slice(r.startOffset, r.endOffset))) {
      if (!citedSet.has(id)) {
        citedSet.add(id);
        citedClaims.push(id);
      }
    }
  }

  // `claimIds`, when provided, is an explicit list the caller claims to have
  // cited; union it with what we parsed so an id passed out-of-band is still
  // validated for existence/status.
  const allIds = [...new Set([...citedClaims, ...(claimIds ?? [])])];
  const unknownCitations: string[] = [];
  const inactiveCitations: string[] = [];
  for (const id of allIds) {
    const claim = repos.claims.getById(id as ClaimId);
    if (!claim) {
      unknownCitations.push(id);
      continue;
    }
    if (INACTIVE_STATUSES.has(claim.status)) inactiveCitations.push(id);
  }

  // Assertions: prose regions only, one span per sentence, line from its offset.
  const uncited: UncitedAssertion[] = [];
  for (const r of regions) {
    if (r.kind !== 'prose') continue;
    for (const span of splitSentenceSpans(answer.slice(r.startOffset, r.endOffset), r.startOffset)) {
      if (isAssertive(span.text) && !CITATION_TOKEN_RE.test(span.text)) {
        uncited.push({ text: span.text, line: lineAt(answer, span.startOffset) });
      }
    }
  }

  const ok = unknownCitations.length === 0 && inactiveCitations.length === 0 && uncited.length === 0;

  return {
    ok,
    citedClaims,
    unknownCitations,
    inactiveCitations,
    uncited,
    uncitedSentences: uncited.map((u) => u.text),
  };
}
