/**
 * emit-nodes — flatten fixtures/corpus/hierarchy.json into pre-order lines
 *   <parentNodeId>|<slug>|<title>|<kind>
 * where <parentNodeId> is the DERIVED id of the parent ('' for the root). Because
 * `deriveNodeId` is deterministic, precomputing the parent id here lets a bash 3.2
 * baseline script create nodes without capturing ids or using associative arrays —
 * the id `kb node create` derives will equal the parent id fed to its children.
 *
 * Usage: tsx scripts/emit-nodes.ts [hierarchy.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flattenHierarchy, type HNode } from './fixtureKb.js';

const file = process.argv[2] ?? resolve(import.meta.dirname, '../fixtures/corpus/hierarchy.json');
const hierarchy = JSON.parse(readFileSync(file, 'utf8')) as { nodes: HNode[] };

const lines = flattenHierarchy(hierarchy).map((n) => [n.parentId ?? '', n.slug, n.title, n.kind].join('|'));
process.stdout.write(lines.join('\n') + '\n');
