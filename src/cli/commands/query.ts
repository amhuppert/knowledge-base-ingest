/**
 * QUERY / read-side commands: search, ask-context, answer-check, provenance.
 * Variadic queries join with spaces (parity with the hand parser); numeric flags
 * validate via `intOption`; `--scope` validates against the `SEARCH_SCOPES` const.
 */

import type { Command } from 'commander';
import { success, result, type Issue } from '../output.js';
import { choiceOption, intOption, leaf, readPayload, unknownIdIssue, workspaceAction, type RunContext } from '../run.js';
import { hintFor } from '../issues.js';
import { steeringFor } from '../steering.js';
import { defineHelp } from '../help/spec.js';
import {
  search,
  askContext,
  answerCheck,
  SEARCH_SCOPES,
  MATCH_MODES,
  type SearchScope,
  type MatchMode,
  type SearchResult,
  type AskContextResult,
  type AnswerCheckResult,
} from '../../query/query.js';
import { AnswerCheckSchema } from '../../domain/schemas/agent.js';
import { CLAIM_TYPES } from '../../domain/schemas/enums.js';
import { makeClaimId } from '../../domain/ids.js';

/** Map a hit's `kind` back to its concrete scope, for per-scope hint building. */
const KIND_TO_SCOPE = { chunk: 'chunks', claim: 'claims', node: 'nodes', entity: 'entities' } as const;

/**
 * Envelope hints for a search result (05 §1): one weaker-evidence warning per FTS
 * scope that fell back to any-term matching AND surfaced hits, plus — under `auto`
 * only — a rephrase/ask-context hint when nothing matched anywhere. The all-zero
 * hint never suggests `--match any` (auto already ran OR).
 */
function searchHints(res: SearchResult, mode: MatchMode): string[] {
  const hints: string[] = [];
  for (const scope of ['chunks', 'claims', 'nodes'] as const) {
    if (res.matchModes[scope] !== 'any-fallback') continue;
    if (!res.hits.some((h) => KIND_TO_SCOPE[h.kind] === scope)) continue;
    hints.push(
      `${scope}: no hits required all terms; showing any-term matches (weaker evidence). Use --match all for strict matching.`,
    );
  }
  if (mode === 'auto' && res.hits.length === 0) {
    hints.push(
      `No matches even with any-term fallback. Rephrase with distinctive terms or try: kb ask-context "${res.query}" --json`,
    );
  }
  return hints;
}

/**
 * Zero-result hints for ask-context (05 §2, finding 29). When claims came back
 * empty: if any filter was supplied, name ONLY the supplied flag(s) so the caller
 * knows exactly what to drop to widen; otherwise fall back to the search-style
 * rephrase hint. A non-empty result gets no hint.
 */
function askContextHints(res: AskContextResult): string[] {
  // A filter-fallback result IS non-empty, but it was NOT ranked by relevance — the
  // question matched no terms and the filter acted as a selector. Say so, or the
  // caller reads an arbitrary-order slice as a relevance ranking (charter:
  // no-silent-truncation applies to silent *degradation* too).
  if (res.retrieval === 'filter-fallback') {
    const supplied = [
      ...(res.applied.claimType !== null ? ['--claim-type'] : []),
      ...(res.applied.node !== null ? ['--node'] : []),
    ].join(' / ');
    return [
      `Some of these claims did not match your question's terms: ${supplied} was used as a ` +
        'selector to complete the set. Term matches are listed first; the rest follow by ' +
        'confidence. Raise --limit if the category may be larger.',
    ];
  }
  if (res.claims.length > 0) return [];
  const supplied: string[] = [];
  if (res.applied.claimType !== null) supplied.push('--claim-type');
  if (res.applied.node !== null) supplied.push('--node');
  if (supplied.length > 0) {
    return [`No matches with the applied filters — rerun without ${supplied.join(' / ')} to widen.`];
  }
  return [`No matching claims. Rephrase with distinctive terms or try: kb search "${res.question}" --json`];
}

/**
 * Build the ordered, coded issues for an answer-check report (05 §4.3, finding 33):
 * one CITATION_UNKNOWN per unknown id, then one CITATION_INACTIVE per inactive id
 * (each in first-occurrence order), then one UNCITED_ASSERTION per uncited sentence
 * in line order — every issue carrying its registry hint. The report arrays already
 * hold those orders, so this is a straight projection. Envelope `ok` (derived from
 * these error-severity issues) therefore equals `report.ok`.
 */
export function answerCheckIssues(report: AnswerCheckResult): Issue[] {
  const issues: Issue[] = [];
  for (const id of report.unknownCitations) {
    issues.push({ code: 'CITATION_UNKNOWN', severity: 'error', ids: [id], message: `cited claim ${id} does not exist`, hint: hintFor('CITATION_UNKNOWN') });
  }
  for (const id of report.inactiveCitations) {
    issues.push({ code: 'CITATION_INACTIVE', severity: 'error', ids: [id], message: `cited claim ${id} is superseded or retracted`, hint: hintFor('CITATION_INACTIVE') });
  }
  for (const u of report.uncited) {
    issues.push({ code: 'UNCITED_ASSERTION', severity: 'error', message: `line ${u.line}: "${u.text}"`, hint: hintFor('UNCITED_ASSERTION') });
  }
  return issues;
}

export function registerQuery(program: Command, ctx: RunContext): void {
  defineHelp(
    leaf(program, 'search <query...>', 'Search chunks, claims, nodes, entities, or all scopes.')
      .addOption(choiceOption('--scope <scope>', 'search scope', SEARCH_SCOPES, 'all'))
      .addOption(choiceOption('--match <mode>', 'match strategy', MATCH_MODES, 'auto'))
      .option('--limit <n>', 'max hits per scope (1–200)', intOption(1, 200), 20),
    {
      command: 'search',
      group: 'query',
      usage: 'kb search [options] <query...>',
      summary: 'Search chunks, claims, nodes, entities, or all scopes.',
      args: [{ name: 'query', description: 'the search terms (joined with spaces)', variadic: true }],
      flags: [
        { flags: '--scope <scope>', description: 'search scope', choices: SEARCH_SCOPES },
        { flags: '--match <mode>', description: 'match strategy', choices: MATCH_MODES },
        { flags: '--limit <n>', description: 'max hits per scope (1–200)' },
      ],
      output: [
        'query (the joined terms)',
        'matchModes (strategy applied per scope: all | any | any-fallback | phrase | like)',
        'hits scope-major (chunks, claims, nodes, entities), each with id, matchMode, and rank (raw bm25; null for entity hits; comparable only within a scope)',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Find ids to inspect, cite, or answer from.',
      related: ['ask-context', 'node show'],
      examples: [
        { description: 'Search all scopes (auto AND→OR fallback)', command: 'kb search caching layer --json' },
        { description: 'Require every term (strict)', command: 'kb search caching layer --match all --json' },
        { description: 'Search only claims', command: 'kb search caching --scope claims --json' },
      ],
    },
  ).action(
      workspaceAction(ctx, (ws, { args, opts }) => {
        const q = (args[0] as string[]).join(' ');
        const scope = opts['scope'] as SearchScope;
        const limit = opts['limit'] as number;
        const match = opts['match'] as MatchMode;
        const res = search(ws.repos, q, { scope, limit, match });
        const hints = searchHints(res, match);
        return success(res, hints.length > 0 ? { hints } : {});
      }),
    );

  defineHelp(
    leaf(program, 'ask-context <question...>', 'Retrieve relevant claims with provenance, plus related nodes and entities.')
      .option('--limit <n>', 'max claims (1–50)', intOption(1, 50), 12)
      .addOption(choiceOption('--claim-type <type>', 'restrict claims to this type', CLAIM_TYPES))
      .option('--node <node_id>', 'restrict claims to this node’s subtree'),
    {
      command: 'ask-context',
      group: 'query',
      usage: 'kb ask-context [options] <question...>',
      summary: 'Retrieve relevant claims with provenance, plus related nodes and entities.',
      args: [{ name: 'question', description: 'the question (joined with spaces)', variadic: true }],
      flags: [
        { flags: '--limit <n>', description: 'max claims (1–50)' },
        { flags: '--claim-type <type>', description: 'restrict claims to this type', choices: CLAIM_TYPES },
        { flags: '--node <node_id>', description: 'restrict claims to this node’s subtree' },
      ],
      output: ['claims with provenance', 'related nodes', 'related entities', 'applied: the { claimType, node } filters echoed back'],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Gather cited context before drafting an answer.',
      related: ['search', 'answer-check'],
      examples: [
        { description: 'Ask for context', command: 'kb ask-context how does caching work --json' },
        { description: 'Only open questions', command: 'kb ask-context caching --claim-type open_question --json' },
      ],
    },
  ).action(
      workspaceAction(ctx, (ws, { args, opts }) => {
        const q = (args[0] as string[]).join(' ');
        const limit = opts['limit'] as number;
        const claimType = (opts['claimType'] as string | undefined) ?? null;
        const nodeId = (opts['node'] as string | undefined) ?? null;
        const res = askContext(ws.repos, q, { limit, claimType, nodeId });
        const hints = askContextHints(res);
        return success(res, hints.length > 0 ? { hints } : {});
      }),
    );

  defineHelp(
    leaf(program, 'answer-check', 'Structurally validate that a drafted answer cites supported active claims.').option(
      '--file <path>',
      'answer payload file (defaults to stdin; - for stdin)',
    ),
    {
      command: 'answer-check',
      group: 'query',
      usage: 'kb answer-check [options]',
      summary: 'Structurally validate that a drafted answer cites supported active claims.',
      args: [],
      flags: [{ flags: '--file <path>', description: 'answer payload file (defaults to stdin; - for stdin)' }],
      input: {
        schema: 'AnswerCheckSchema',
        example: {
          answer: 'The service is written in Rust [^clm_1a2b3c].',
          claim_ids: ['clm_1a2b3c'],
        },
      },
      output: [
        'ok (mirrors envelope ok)',
        'citedClaims / unknownCitations / inactiveCitations',
        'uncited: [{ text, line }] (uncitedSentences retained as a deprecated alias)',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Validate a drafted answer’s citations before finalizing it.',
      related: ['ask-context', 'provenance'],
      examples: [{ description: 'Check an answer', command: 'kb answer-check --file ./answer.json --json' }],
    },
  ).action(
    workspaceAction(ctx, (ws, { opts }) => {
      const payload = AnswerCheckSchema.parse(readPayload(opts));
      const report = answerCheck(ws.repos, payload.answer, payload.claim_ids);
      // Envelope ok is DERIVED from the coded issues, so it equals report.ok; the
      // report is kept as `data` even on failure so the agent sees every finding.
      // Steering (the failure hint) comes from the normative per-command table via
      // `steeringFor`, never inline, so the table stays the single source and is
      // registry-filtered (charter: drift-gates-green).
      const steering = steeringFor('answer-check', { ok: report.ok }, ctx.registry);
      return result(report, answerCheckIssues(report), {
        nextActions: steering.nextActions,
        hints: steering.hints,
      });
    }),
  );

  defineHelp(
    leaf(program, 'provenance <claim_id>', 'Show a claim and its source quotes, offsets, source titles, and stored paths.'),
    {
      command: 'provenance',
      group: 'query',
      usage: 'kb provenance <claim_id>',
      summary: 'Show a claim and its source quotes, offsets, source titles, and stored paths.',
      args: [{ name: 'claim_id', description: 'the claim id (clm_…) whose provenance to show' }],
      flags: [],
      output: ['claim', 'provenance: [{ quote, charStart, charEnd, sourceTitle, storedPath }]'],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Trace a claim back to its exact source quotes.',
      related: ['node show', 'source show'],
      examples: [{ description: 'Show a claim’s provenance', command: 'kb provenance clm_1a2b3c --json' }],
    },
  ).action(
    workspaceAction(ctx, (ws, { args }) => {
      const id = args[0] as string;
      const claim = ws.repos.claims.getById(makeClaimId(id));
      if (!claim) return result(null, [unknownIdIssue('UNKNOWN_CLAIM', `unknown claim ${id}`, id)]);
      const spans = ws.repos.claimSpans.spansForClaim(claim.id).map((s) => {
        const src = ws.repos.sources.getById(s.sourceId);
        return { quote: s.quote, charStart: s.charStart, charEnd: s.charEnd, sourceTitle: src?.title, storedPath: src?.storedPath };
      });
      return success({ claim, provenance: spans });
    }),
  );
}
