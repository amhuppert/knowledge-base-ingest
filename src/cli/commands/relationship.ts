/**
 * RELATIONSHIP group: list. Enumerates graph relationships with complete evidence.
 */

import type { Command } from 'commander';
import { success, result } from '../output.js';
import {
  choiceOption,
  leaf,
  optStr,
  unknownIdIssue,
  workspaceAction,
  type RunContext,
} from '../run.js';
import { defineHelp } from '../help/spec.js';
import { CLAIM_STATUSES, type ClaimStatus } from '../../domain/schemas/enums.js';
import type { EntityId, SourceId } from '../../domain/ids.js';
import { buildRelationshipList } from '../../domain/services/relationshipList.js';
import { RelationshipListSchema } from '../../domain/schemas/readModels.js';

const SUMMARY =
  'List graph relationships with resolved entities and complete evidence. --source matches any live evidence span contributed by that source, not the source that first created the claim';

export function registerRelationship(group: Command, ctx: RunContext): void {
  defineHelp(
    leaf(group, 'list', SUMMARY)
      .option('--source <source_id>', 'filter by any live evidence contributed by a source')
      .option('--entity <entity_id>', 'filter by subject or object entity')
      .option('--type <type>', 'filter by exact relationship type')
      .addOption(
        choiceOption(
          '--status <status>',
          'filter by relationship status',
          CLAIM_STATUSES,
        ),
      ),
    {
      command: 'relationship list',
      group: 'extract',
      usage: 'kb relationship list [options]',
      summary: SUMMARY,
      args: [],
      flags: [
        {
          flags: '--source <source_id>',
          description: 'filter by any live evidence contributed by a source',
        },
        {
          flags: '--entity <entity_id>',
          description: 'filter by subject or object entity',
        },
        { flags: '--type <type>', description: 'filter by exact relationship type' },
        {
          flags: '--status <status>',
          description: 'filter by relationship status',
          choices: CLAIM_STATUSES,
        },
      ],
      output: [
        'RelationshipListSchema',
        'filter: the supplied sourceId, entityId, type, and status filters',
        'relationships: [{ id, type, status, description, confidence, firstSeenSource, subject, object, evidence }] ordered by (type, subject canonicalName, object canonicalName, id)',
        'evidence is ordered by (sourceId, charStart, spanId)',
        'totals: { relationships, evidenceLinks, matchingEvidenceLinks?, byStatus, byType }',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Inspect graph contributions after graph apply.',
      related: ['entity show', 'entity list', 'graph apply', 'coverage', 'source chunks', 'source impact'],
      examples: [
        {
          description:
            'Select relationships first created from source A after source B added evidence',
          command: 'kb relationship list --source src_B --json',
        },
      ],
    },
  ).action(
    workspaceAction(ctx, (ws, { opts }) => {
      const sourceId = optStr(opts, 'source') as SourceId | undefined;
      const entityId = optStr(opts, 'entity') as EntityId | undefined;
      const type = optStr(opts, 'type');
      const status = optStr(opts, 'status') as ClaimStatus | undefined;

      if (sourceId !== undefined && ws.repos.sources.getById(sourceId) === undefined) {
        return result(null, [
          {
            ...unknownIdIssue('UNKNOWN_SOURCE', `unknown source ${sourceId}`, sourceId),
            hint: 'List sources: kb source list --json',
          },
        ]);
      }
      if (entityId !== undefined && ws.repos.entities.getById(entityId) === undefined) {
        return result(null, [
          {
            ...unknownIdIssue('UNKNOWN_ENTITY', `unknown entity ${entityId}`, entityId),
            hint: 'List entities: kb entity list --json',
          },
        ]);
      }

      const filter = {
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(entityId === undefined ? {} : { entityId }),
        ...(type === undefined ? {} : { type }),
        ...(status === undefined ? {} : { status }),
      };
      return success(RelationshipListSchema.parse(buildRelationshipList(ws.repos, filter)));
    }),
  );
}
