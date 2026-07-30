/**
 * VOCABULARY group: list. Exposes schema enums and graph types observed in this KB.
 */

import type { Command } from 'commander';
import { ENTITY_TYPES, CLAIM_TYPES, RELATIONSHIP_TYPES, SPAN_ROLES } from '../../domain/schemas/enums.js';
import { defineHelp } from '../help/spec.js';
import { hintFor } from '../issues.js';
import { result, success } from '../output.js';
import { leaf, optStr, workspaceAction, type RunContext } from '../run.js';

const VOCABULARY_KINDS = ['claim', 'span-role', 'entity', 'relationship'] as const;
type VocabularyKind = (typeof VOCABULARY_KINDS)[number];

interface TypeCountRow {
  type: string;
  count: number;
}

interface ObservedType extends TypeCountRow {
  recommended: boolean;
}

function isVocabularyKind(value: string): value is VocabularyKind {
  return (VOCABULARY_KINDS as readonly string[]).includes(value);
}

export function registerVocabulary(group: Command, ctx: RunContext): void {
  defineHelp(
    leaf(group, 'list', 'List recommended and observed claim, span, entity, and relationship vocabularies.').option(
      '--kind <claim|span-role|entity|relationship>',
      'return only one vocabulary section',
    ),
    {
      command: 'vocabulary list',
      group: 'extract',
      usage: 'kb vocabulary list [options]',
      summary: 'List recommended and observed claim, span, entity, and relationship vocabularies.',
      args: [],
      flags: [
        {
          flags: '--kind <claim|span-role|entity|relationship>',
          description: 'return only claim, span-role, entity, or relationship vocabulary',
        },
      ],
      output: [
        'claimTypes: the schema claim-type enum',
        'spanRoles: supports, contradicts, context, supersedes',
        'entityTypes: { recommended, observed: [{ type, count, recommended }] }',
        'relationshipTypes: { recommended, observed: [{ type, count, recommended }] }',
        'observed types are ordered by (count DESC, type)',
      ],
      sideEffects: [],
      atomic: false,
      supportsDryRun: false,
      workflow: 'Discover established vocabulary before authoring a graph payload.',
      related: ['graph apply', 'entity list', 'relationship list'],
      examples: [
        { description: 'List every vocabulary section', command: 'kb vocabulary list --json' },
        {
          description: 'List only relationship vocabulary',
          command: 'kb vocabulary list --kind relationship --json',
        },
      ],
    },
  ).action(
    workspaceAction(ctx, (ws, { opts }) => {
      const kind = optStr(opts, 'kind');
      if (kind !== undefined && !isVocabularyKind(kind)) {
        return result(null, [
          {
            code: 'INVALID_ARGUMENT',
            severity: 'error',
            message: `invalid vocabulary kind "${kind}"; expected one of: ${VOCABULARY_KINDS.join(', ')}`,
            path: 'kind',
            hint: hintFor('INVALID_ARGUMENT'),
          },
        ]);
      }

      const observed = (table: 'entities' | 'relationships', recommendedTypes: readonly string[]): ObservedType[] => {
        const recommended = new Set<string>(recommendedTypes);
        const rows = ws.repos.db
          .prepare(`SELECT type, COUNT(*) AS count FROM ${table} GROUP BY type ORDER BY count DESC, type ASC`)
          .all() as TypeCountRow[];
        return rows.map((row) => ({ ...row, recommended: recommended.has(row.type) }));
      };

      const sections = {
        claim: { claimTypes: CLAIM_TYPES },
        'span-role': { spanRoles: SPAN_ROLES },
        entity: {
          entityTypes: {
            recommended: ENTITY_TYPES,
            observed: observed('entities', ENTITY_TYPES),
          },
        },
        relationship: {
          relationshipTypes: {
            recommended: RELATIONSHIP_TYPES,
            observed: observed('relationships', RELATIONSHIP_TYPES),
          },
        },
      } satisfies Record<VocabularyKind, object>;

      return success(
        kind === undefined
          ? { ...sections.claim, ...sections['span-role'], ...sections.entity, ...sections.relationship }
          : sections[kind],
      );
    }),
  );
}
