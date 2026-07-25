/**
 * OPS commands: init, status, propagate, render, verify. Behavior is ported
 * verbatim from the hand parser; only the parsing/dispatch layer changed.
 */

import { resolve } from 'node:path';
import type { Command } from 'commander';
import { success, result, type Issue, type Envelope } from '../output.js';
import { codeForVerifyCheck, hintFor } from '../issues.js';
import { bareAction, kbPathSuspectIssue, leaf, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { steeringFor } from '../steering.js';
import { initWorkspace, kbRootWarnings, type Workspace } from '../../kb/workspace.js';
import { writeScaffold } from '../../kb/scaffold.js';
import { renderAll, writeRender, checkRender } from '../../render/render.js';
import { verify } from '../../verify/verify.js';
import { coverage, type CoverageCode } from '../../coverage/coverage.js';
import { systemClock } from '../../domain/services/context.js';
import { currentSchemaVersion, readSchemaVersion } from '../../db/migrate.js';
import { cliVersion } from '../version.js';

function count(ws: Workspace, table: string): number {
  const r = ws.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

/** Per-check message stems for `kb coverage`; `(<shown> of <total> shown)` is appended. */
const COVERAGE_MESSAGES: Record<CoverageCode, (n: number) => string> = {
  SOURCE_NO_CLAIMS: (n) => `${n} active source(s) have no claim provenance`,
  CHUNK_UNCITED: (n) => `${n} chunk(s) are covered by no live claim or relationship span`,
  CLAIM_NOT_SYNTHESIZED: (n) => `${n} active claim(s) are cited in no synthesis body`,
  NODE_SINGLE_SOURCE: (n) => `${n} node(s) rely on a single source`,
  OPEN_QUESTION_NOT_SYNTHESIZED: (n) => `${n} open-question claim(s) are surfaced in no node`,
};

/** The maximum number of ids listed per coverage issue (06 §3; totals stay exact). */
const COVERAGE_ID_CAP = 20;

export function registerOps(program: Command, ctx: RunContext): void {
  defineHelp(leaf(program, 'init [dir]', 'Create or open a KB root, write scaffold files, and render the initial markdown.'), {
    command: 'init',
    group: 'setup',
    usage: 'kb init [dir]',
    summary: 'Create or open a KB root, write scaffold files, and render the initial markdown.',
    args: [{ name: 'dir', description: 'the KB directory (defaults to the current directory)', optional: true }],
    flags: [],
    output: ['root', 'created', 'scaffold (files written)', 'rendered (files count)'],
    sideEffects: ['creates the KB directory + sqlite DB', 'writes scaffold + initial rendered markdown'],
    atomic: false,
    supportsDryRun: false,
    workflow: 'The very first step: create the knowledge base.',
    related: ['ingest', 'status'],
    examples: [{ description: 'Initialize a KB here', command: 'kb init --json' }],
  }).action(
    bareAction(ctx, ({ args }) => {
      const dir = resolve(ctx.io.cwd, (args[0] as string | undefined) ?? '.');
      const { ws, result: initResult } = initWorkspace(dir);
      try {
        const { wrote } = writeScaffold(ws.root);
        const files = renderAll(ws.repos);
        writeRender(ws.root, files, ws.repos, systemClock());
        return success(
          { root: initResult.root, created: initResult.created, scaffold: wrote, rendered: files.length },
          { issues: kbRootWarnings(initResult.root).map(kbPathSuspectIssue) },
        );
      } finally {
        ws.close();
      }
    }),
  );

  defineHelp(leaf(program, 'status', 'Print source, chunk, node, stale-node, claim, span, entity, and relationship counts.'), {
    command: 'status',
    group: 'maintain',
    usage: 'kb status',
    summary: 'Print source, chunk, node, stale-node, claim, span, entity, and relationship counts.',
    args: [],
    flags: [],
    output: ['root', 'cli + schema (version fields)', 'counts: sources, chunks, nodes, staleNodes, claims, spans, entities, relationships'],
    sideEffects: [],
    atomic: false,
    supportsDryRun: false,
    workflow: 'Check KB contents and the tool/schema versions at a glance.',
    related: ['node tree', 'verify'],
    examples: [{ description: 'Show KB status', command: 'kb status --json' }],
  }).action(
    workspaceAction(ctx, (ws) =>
      success({
        root: ws.root,
        cli: cliVersion(),
        schema: { supported: currentSchemaVersion(), onDisk: readSchemaVersion(ws.db) },
        sources: count(ws, 'sources'),
        chunks: count(ws, 'source_chunks'),
        nodes: count(ws, 'nodes'),
        staleNodes: ws.repos.nodes.listStaleDeepestFirst().length,
        claims: count(ws, 'claims'),
        spans: count(ws, 'spans'),
        entities: count(ws, 'entities'),
        relationships: count(ws, 'relationships'),
      }),
    ),
  );

  defineHelp(leaf(program, 'propagate', 'Re-assert stale propagation from stale nodes to ancestors.'), {
    command: 'propagate',
    group: 'maintain',
    usage: 'kb propagate',
    summary: 'Re-assert stale propagation from stale nodes to ancestors.',
    args: [],
    flags: [],
    output: ['propagated stale set (nodes marked stale by ancestor propagation)'],
    sideEffects: ['marks ancestors of stale nodes stale'],
    atomic: true,
    supportsDryRun: false,
    workflow: 'Recompute staleness if the hierarchy was edited out of band.',
    related: ['node tree', 'verify'],
    examples: [{ description: 'Re-assert staleness', command: 'kb propagate --json' }],
  }).action(
    workspaceAction(ctx, (ws) => success(ws.nodes.propagate())),
  );

  defineHelp(
    leaf(program, 'render', 'Render generated markdown, or check rendered markdown for drift.').option(
      '--check',
      'check rendered markdown for drift instead of writing',
    ),
    {
      command: 'render',
      group: 'maintain',
      usage: 'kb render [options]',
      summary: 'Render generated markdown, or check rendered markdown for drift.',
      args: [],
      flags: [{ flags: '--check', description: 'check rendered markdown for drift instead of writing' }],
      output: ['written (files) when rendering', 'checked + drift (list) with --check'],
      sideEffects: ['writes generated markdown (without --check)'],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Regenerate the human-readable markdown after verify.',
      related: ['verify', 'status'],
      examples: [
        { description: 'Render the markdown', command: 'kb render --json' },
        { description: 'Check for render drift', command: 'kb render --check --json' },
      ],
    },
  ).action(
      workspaceAction(ctx, (ws, { opts }) => {
        const files = renderAll(ws.repos);
        // Steering from the normative table (01 §6.1), registry-filtered: a successful
        // render steers to `render --check` + the coverage hint. Drift is a failure → no steering.
        const steering = steeringFor('render', { ok: true }, ctx.registry);
        const extras = { nextActions: steering.nextActions, hints: steering.hints };
        if (opts['check']) {
          const results = checkRender(ws.root, files);
          const drift = results.filter((r) => r.status !== 'ok');
          return drift.length === 0
            ? success({ checked: results.length, drift: [] }, extras)
            : result(
                { checked: results.length, drift },
                // Drift is a real KB-state finding, not a kb bug: each drifted file gets its own
                // coded issue naming the path, with the registry hint (re-render, never hand-edit).
                drift.map((d): Issue => ({
                  code: 'RENDER_DRIFT',
                  severity: 'error',
                  message: `${d.status}: ${d.path}`,
                  ids: [d.path],
                  hint: hintFor('RENDER_DRIFT'),
                })),
              );
        }
        const { written } = writeRender(ws.root, files, ws.repos, systemClock());
        return success({ written, root: ws.root }, extras);
      }),
    );

  defineHelp(
    leaf(program, 'verify', 'Run provenance, citation, staleness, and FTS integrity checks.').option(
      '--strict',
      'treat warnings as failures',
    ),
    {
      command: 'verify',
      group: 'maintain',
      usage: 'kb verify [options]',
      summary: 'Run provenance, citation, staleness, and FTS integrity checks.',
      args: [],
      flags: [{ flags: '--strict', description: 'treat warnings as failures' }],
      output: ['findings: [{ check, code, severity, message, ids }]'],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Gate integrity before rendering; --strict fails on warnings.',
      related: ['render', 'node tree'],
      examples: [
        { description: 'Verify integrity', command: 'kb verify --json' },
        { description: 'Fail on any warning', command: 'kb verify --strict --json' },
      ],
    },
  ).action(
      workspaceAction(ctx, (ws, { opts }): Envelope<unknown> => {
        const strict = opts['strict'] === true;
        const report = verify(ws.repos, { strict });
        // Each finding keeps its legacy `check` + severity and GAINS the mapped stable
        // `code` (01 §3.2); the envelope mirrors each finding as an issue. In strict
        // mode every WARNING finding additionally yields an error-severity issue (same
        // code, `strict: ` prefix) so strict failure and the ok-invariant coexist.
        const issues: Issue[] = [];
        const findings = report.findings.map((f) => {
          const code = codeForVerifyCheck(f.check);
          const message = `${f.check}: ${f.message}`;
          issues.push({ code, severity: f.severity, message, hint: hintFor(code), ...(f.ids ? { ids: f.ids } : {}) });
          if (strict && f.severity === 'warning') {
            issues.push({ code, severity: 'error', message: `strict: ${message}`, hint: hintFor(code), ...(f.ids ? { ids: f.ids } : {}) });
          }
          return { ...f, code };
        });
        // Steering from the normative table (01 §6.1), registry-filtered: on success →
        // render next-action + coverage hint; a failing (or strict-failing) verify emits none.
        const ok = !issues.some((i) => i.severity === 'error');
        const steering = steeringFor('verify', { ok }, ctx.registry);
        return result({ ...report, findings }, issues, { nextActions: steering.nextActions, hints: steering.hints });
      }),
    );

  defineHelp(leaf(program, 'coverage', 'Report synthesis completeness gaps across sources, chunks, claims, and nodes.'), {
    command: 'coverage',
    group: 'maintain',
    usage: 'kb coverage',
    summary: 'Report synthesis completeness gaps across sources, chunks, claims, and nodes.',
    args: [],
    flags: [],
    output: [
      'summary: per-check { total, shown } for SOURCE_NO_CLAIMS, CHUNK_UNCITED, CLAIM_NOT_SYNTHESIZED, NODE_SINGLE_SOURCE, OPEN_QUESTION_NOT_SYNTHESIZED',
      'issues: one aggregated info issue per non-empty check (ids capped at 20; exact totals in summary)',
    ],
    sideEffects: [],
    atomic: false,
    supportsDryRun: false,
    workflow: 'Survey synthesis completeness after verify; descriptive, never an integrity gate.',
    related: ['verify', 'render'],
    examples: [{ description: 'Report coverage', command: 'kb coverage --json' }],
  }).action(
    workspaceAction(ctx, (ws): Envelope<unknown> => {
      // One aggregated INFO issue per non-empty check, ids capped but totals exact
      // (no-silent-truncation). `data.summary` always carries all five checks. Coverage
      // is descriptive: info severity never fails the run, so `ok` stays true / exit 0.
      const report = coverage(ws.repos);
      const summary: Record<string, { total: number; shown: number }> = {};
      const issues: Issue[] = [];
      for (const finding of report.findings) {
        const total = finding.ids.length;
        const shown = Math.min(total, COVERAGE_ID_CAP);
        summary[finding.code] = { total, shown };
        if (total === 0) continue;
        issues.push({
          code: finding.code,
          severity: 'info',
          message: `${COVERAGE_MESSAGES[finding.code](total)} (${shown} of ${total} shown)`,
          ids: finding.ids.slice(0, COVERAGE_ID_CAP),
          hint: hintFor(finding.code),
        });
      }
      return success(
        { summary },
        { issues, hints: ['Coverage is descriptive; kb verify --strict --json remains the integrity gate.'] },
      );
    }),
  );
}
