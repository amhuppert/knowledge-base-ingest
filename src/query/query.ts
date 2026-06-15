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
import type { ClaimId } from '../domain/ids.js';
import { extractCitations } from '../domain/algorithms/citations.js';

const SNIPPET_LEN = 200;

/** Trim text to ~`max` chars, collapsing internal whitespace, with an ellipsis. */
function snippet(text: string, max = SNIPPET_LEN): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * Build a safe FTS5 MATCH expression from free text. Each whitespace-separated
 * token is wrapped in double quotes (escaping embedded quotes per FTS5 rules) so
 * punctuation inside a token is literal, not query syntax. Tokens are joined with
 * AND (precise; for keyword search) or OR (recall; for natural-language
 * questions). Returns the empty string when there is nothing to match.
 */
function ftsMatch(query: string, joiner: 'AND' | 'OR' = 'AND'): string {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  const quoted = tokens.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(joiner === 'OR' ? ' OR ' : ' ');
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export type SearchScope = 'chunks' | 'claims' | 'nodes' | 'entities' | 'all';

export interface SearchHit {
  kind: 'chunk' | 'claim' | 'node' | 'entity';
  id: string;
  title: string;
  snippet: string;
  sourceId?: string;
}

const ALL_SCOPES: readonly Exclude<SearchScope, 'all'>[] = ['chunks', 'claims', 'nodes', 'entities'];

function searchChunks(repos: Repositories, match: string, limit: number): SearchHit[] {
  try {
    const rows = repos.db
      .prepare(
        `SELECT c.* FROM chunks_fts f JOIN source_chunks c ON c.rowid = f.rowid
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as unknown[];
    return rows.map((r): SearchHit => {
      const chunk: Chunk = ChunkRow.parse(r);
      const source = repos.sources.getById(chunk.sourceId);
      const title = chunk.headingPath.trim() || source?.title || chunk.sourceId;
      return {
        kind: 'chunk',
        id: chunk.id,
        title,
        snippet: snippet(chunk.text),
        sourceId: chunk.sourceId,
      };
    });
  } catch {
    return [];
  }
}

function searchClaims(repos: Repositories, match: string, limit: number): SearchHit[] {
  try {
    const rows = repos.db
      .prepare(
        `SELECT c.* FROM claims_fts f JOIN claims c ON c.rowid = f.rowid
         WHERE claims_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as unknown[];
    return rows.map((r): SearchHit => {
      const claim: Claim = ClaimRow.parse(r);
      return {
        kind: 'claim',
        id: claim.id,
        title: claim.claimType,
        snippet: snippet(claim.text),
        sourceId: claim.firstSeenSourceId,
      };
    });
  } catch {
    return [];
  }
}

function searchNodes(repos: Repositories, match: string, limit: number): SearchHit[] {
  try {
    const rows = repos.db
      .prepare(
        `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
         WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as unknown[];
    return rows.map((r): SearchHit => {
      const node: Node = NodeRow.parse(r);
      return {
        kind: 'node',
        id: node.id,
        title: node.title,
        snippet: snippet(node.bodyMd),
      };
    });
  } catch {
    return [];
  }
}

function searchEntities(repos: Repositories, query: string, limit: number): SearchHit[] {
  // EntityRepo.search uses LIKE, not FTS, so it cannot throw on FTS syntax.
  return repos.entities.search(query, limit).map(
    (e): SearchHit => ({
      kind: 'entity',
      id: e.id,
      title: e.canonicalName,
      snippet: snippet(e.description || `${e.type}: ${e.canonicalName}`),
    }),
  );
}

/**
 * Full-text search across the requested scope(s). For `'all'`, every scope is
 * searched and the hits are concatenated (each scope honoring `limit`).
 *
 * FTS MATCH is sanitized via `ftsMatch` and wrapped in try/catch per scope, so a
 * malformed query degrades to empty results for that scope instead of throwing.
 */
export function search(
  repos: Repositories,
  query: string,
  opts: { scope?: SearchScope; limit?: number } = {},
): SearchHit[] {
  const scope = opts.scope ?? 'all';
  const limit = opts.limit ?? 20;
  const match = ftsMatch(query);

  const scopes = scope === 'all' ? ALL_SCOPES : [scope];
  const hits: SearchHit[] = [];
  for (const s of scopes) {
    switch (s) {
      case 'chunks':
        if (match) hits.push(...searchChunks(repos, match, limit));
        break;
      case 'claims':
        if (match) hits.push(...searchClaims(repos, match, limit));
        break;
      case 'nodes':
        if (match) hits.push(...searchNodes(repos, match, limit));
        break;
      case 'entities':
        hits.push(...searchEntities(repos, query, limit));
        break;
    }
  }
  return hits;
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

export interface AskContextResult {
  question: string;
  claims: ClaimContext[];
  nodes: Array<{ id: string; title: string; snippet: string }>;
  entities: Array<{ id: string; type: string; name: string }>;
}

/** Statuses whose claims are surfaced by askContext (active + conflicted). */
const SURFACED_CLAIM_STATUSES = new Set(['active', 'conflicted']);

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
 */
export function askContext(
  repos: Repositories,
  question: string,
  opts: { limit?: number } = {},
): AskContextResult {
  const limit = opts.limit ?? 12;
  // Questions are natural language; OR-join for recall (AND would require every
  // token — including "how"/"are" — to appear in a claim).
  const match = ftsMatch(question, 'OR');

  let claims: ClaimContext[] = [];
  if (match) {
    try {
      // Over-fetch so that filtering out non-surfaced statuses still leaves us
      // up to `limit` results.
      const rows = repos.db
        .prepare(
          `SELECT c.* FROM claims_fts f JOIN claims c ON c.rowid = f.rowid
           WHERE claims_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, limit * 4) as unknown[];
      claims = rows
        .map((r): Claim => ClaimRow.parse(r))
        .filter((c) => SURFACED_CLAIM_STATUSES.has(c.status))
        .slice(0, limit)
        .map((c) => enrichClaim(repos, c));
    } catch {
      claims = [];
    }
  }

  const nodes = (match ? searchNodes(repos, match, limit) : []).map((h) => ({
    id: h.id,
    title: h.title,
    snippet: h.snippet,
  }));

  const entities = repos.entities.search(question, limit).map((e) => ({
    id: e.id,
    type: e.type,
    name: e.canonicalName,
  }));

  return { question, claims, nodes, entities };
}

// ---------------------------------------------------------------------------
// answerCheck
// ---------------------------------------------------------------------------

export interface AnswerCheckResult {
  ok: boolean;
  citedClaims: string[];
  unknownCitations: string[];
  inactiveCitations: string[];
  uncitedSentences: string[];
}

/** Claim statuses that make a citation "inactive" (stale provenance). */
const INACTIVE_STATUSES = new Set(['superseded', 'retracted']);

const CITATION_TOKEN_RE = /\[\^clm_[0-9a-f]+\]/;

/**
 * Split prose into sentences, keeping trailing citation tokens attached to the
 * sentence they belong to. A citation typically follows the terminal period with
 * no space (`"…use.[^clm_x] Next…"`), so a naive split on `[.!?]\s+` would never
 * break there. We insert a boundary after sentence-ending punctuation plus any
 * trailing closing-quotes and citation tokens, then split on it.
 */
function splitSentences(text: string): string[] {
  return text
    .replace(/([.!?]['")\]]*(?:\s*\[\^clm_[0-9a-f]+\])*)\s+/g, '$1\n')
    .split('\n');
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
 * STRUCTURAL provenance check for a synthesized answer. This validates the
 * *shape* of citations only:
 *   - every `[^clm_…]` citation resolves to a real claim,
 *   - no cited claim is superseded/retracted,
 *   - every assertive sentence carries at least one citation.
 *
 * It does NOT check semantic entailment — i.e. whether the cited claim actually
 * supports the sentence's content. That requires NL inference and is explicitly
 * out of scope here (deferred to a future semantic-verification pass).
 */
export function answerCheck(
  repos: Repositories,
  answer: string,
  claimIds?: string[],
): AnswerCheckResult {
  const cited = extractCitations(answer);
  // `claimIds`, when provided, is an explicit list the caller claims to have
  // cited; union it with what we parsed so an id passed out-of-band is still
  // validated for existence/status.
  const allIds = [...new Set([...cited, ...(claimIds ?? [])])];

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

  const uncitedSentences = splitSentences(answer)
    .map((s) => s.trim())
    .filter((s) => isAssertive(s) && !CITATION_TOKEN_RE.test(s));

  const ok =
    unknownCitations.length === 0 &&
    inactiveCitations.length === 0 &&
    uncitedSentences.length === 0;

  return { ok, citedClaims: cited, unknownCitations, inactiveCitations, uncitedSentences };
}
