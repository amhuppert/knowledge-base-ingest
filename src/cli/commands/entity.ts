/**
 * ENTITY group: list, show. Enumerates the knowledge graph and inspects one entity.
 */

import type { Command } from 'commander';
import { success, result } from '../output.js';
import { leaf, optStr, unknownIdIssue, workspaceAction, type RunContext } from '../run.js';
import { defineHelp } from '../help/spec.js';
import { steeringFor } from '../steering.js';

export function registerEntity(group: Command, ctx: RunContext): void {
  /**
   * `kb entity list` (eval run 1, finding 3). `entity show` needs an `ent_…` id, and
   * nothing enumerated them — in the paired eval both skill variants independently
   * invented a listing command. `EntityRepo.listAll()` already existed; this exposes it.
   */
  defineHelp(
    leaf(group, 'list', 'List knowledge-graph entities with their relationship counts.').option(
      '--type <type>',
      'filter the list to one entity type (e.g. Service, DataStore)',
    ),
    {
      command: 'entity list',
      group: 'extract',
      usage: 'kb entity list [options]',
      summary: 'List knowledge-graph entities with their relationship counts.',
      args: [],
      flags: [{ flags: '--type <type>', description: 'filter the list to one entity type' }],
      output: [
        'entities: [{ id, type, canonicalName, description, relationships }] ordered by (type, canonicalName)',
        'counts: GLOBAL per-type entity totals, unaffected by --type',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Survey the knowledge graph after graph apply, then inspect one entity.',
      related: ['entity show', 'graph apply', 'search'],
      examples: [
        { description: 'List every entity', command: 'kb entity list --json' },
        { description: 'List only data stores', command: 'kb entity list --type DataStore --json' },
      ],
    },
  ).action(
    workspaceAction(ctx, (ws, { opts }) => {
      const typeFilter = optStr(opts, 'type');
      const all = ws.repos.entities.listAll();
      // One relationship pass, not one query per entity: an entity is counted once for
      // each relationship it participates in, on either side.
      const relCounts = new Map<string, number>();
      for (const rel of ws.repos.relationships.listAll()) {
        for (const id of new Set([rel.subjectEntityId, rel.objectEntityId])) {
          relCounts.set(id, (relCounts.get(id) ?? 0) + 1);
        }
      }
      const entities = all
        .filter((e) => typeFilter === undefined || e.type === typeFilter)
        .map((e) => ({
          id: e.id,
          type: e.type,
          canonicalName: e.canonicalName,
          description: e.description,
          relationships: relCounts.get(e.id) ?? 0,
        }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.canonicalName.localeCompare(b.canonicalName));
      // Global per-type totals, never the filtered subset — same rule `source list`
      // follows (02 §3, finding 40).
      const counts: Record<string, number> = {};
      for (const e of all) counts[e.type] = (counts[e.type] ?? 0) + 1;
      const steering = steeringFor('entity list', { ok: true }, ctx.registry);
      return success({ entities, counts }, { nextActions: steering.nextActions, hints: steering.hints });
    }),
  );

  defineHelp(leaf(group, 'show <entity_id>', 'Show an entity and its relationships.'), {
    command: 'entity show',
    group: 'extract',
    usage: 'kb entity show <entity_id>',
    summary: 'Show an entity and its relationships.',
    args: [{ name: 'entity_id', description: 'the entity id (ent_…) to show' }],
    flags: [],
    output: ['entity', 'relationships owned by the entity'],
    sideEffects: [],
    atomic: false,
    supportsDryRun: false,
    workflow: 'Inspect the knowledge graph after graph apply.',
    related: ['graph apply', 'search'],
    examples: [{ description: 'Show one entity', command: 'kb entity show ent_1a2b3c --json' }],
  }).action(
    workspaceAction(ctx, (ws, { args }) => {
      const id = args[0] as string;
      const entity = ws.repos.entities.listAll().find((e) => e.id === id);
      if (!entity) return result(null, [unknownIdIssue('UNKNOWN_ENTITY', `unknown entity ${id}`, id)]);
      return success({ entity, relationships: ws.repos.relationships.listByEntity(entity.id) });
    }),
  );
}
