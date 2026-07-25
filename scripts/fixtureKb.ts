/**
 * Shared assembler for the deterministic fixture KB (fixtures/corpus/). Used by
 * scripts/build-fixture.ts (which adds the invariant gate) and
 * scripts/eval-retrieval.ts (which queries the assembled KB). Assembles through the
 * same service layer the CLI commands wrap.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Workspace } from '../src/kb/workspace.js';
import { ClaimApplySchema, GraphApplySchema, SynthesizeSchema } from '../src/domain/schemas/agent.js';
import { deriveNodeId } from '../src/domain/algorithms/idDeriver.js';
import type { NodeId, SourceId } from '../src/domain/ids.js';

export const CORPUS = resolve(process.env.KB_FIXTURE_CORPUS ?? resolve(import.meta.dirname, '../fixtures/corpus'));

export const SOURCE_NAMES = ['design-notes', 'api-reference', 'meeting-transcript', 'press-release'] as const;
export const CLAIMED_SOURCES = ['design-notes', 'api-reference', 'meeting-transcript'] as const;

export interface HNode {
  ref: string;
  slug: string;
  title: string;
  kind: 'root' | 'topic' | 'leaf';
  children?: HNode[];
}

export function readCorpusJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(CORPUS, rel), 'utf8')) as T;
}

export interface FlatNode {
  parentId: NodeId | null;
  slug: string;
  title: string;
  kind: 'root' | 'topic' | 'leaf';
}

/**
 * Pre-order flatten of hierarchy.json, resolving each node's DERIVED parent id
 * (`deriveNodeId(parentId, slug)`). Because the derivation is deterministic, a
 * consumer can create nodes one-by-one (CLI `node create --parent <id>`) and the
 * id each `create` derives equals the parent id fed to its children — no id
 * capture needed. Single source of truth for `emit-nodes.ts`, `build-fixture.ts`,
 * and the hierarchy shape.
 */
export function flattenHierarchy(hierarchy: { nodes: HNode[] }): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (n: HNode, parentId: NodeId | null): void => {
    out.push({ parentId, slug: n.slug, title: n.title, kind: n.kind });
    const id = deriveNodeId(parentId, n.slug);
    for (const c of n.children ?? []) walk(c, id);
  };
  for (const root of hierarchy.nodes) walk(root, null);
  return out;
}

/**
 * Assemble the full fixture KB into `ws`: ingest sources, create the node
 * hierarchy, apply claims + graph, synthesize every node deepest-first. When a
 * `problems` array is passed, every span quote is checked to be an exact substring
 * of its referenced chunk BEFORE the apply (the headline gate) and violations are
 * pushed rather than only surfacing as a resolveSpan throw.
 */
export function assembleFixtureKb(ws: Workspace, problems?: string[]): { sourceIds: Record<string, SourceId> } {
  const sourceIds: Record<string, SourceId> = {};
  for (const name of SOURCE_NAMES) {
    const bytes = readFileSync(join(CORPUS, 'sources', `${name}.md`));
    sourceIds[name] = ws.ingest.ingest({ bytes, ext: 'md', mediaType: 'text/markdown', originalPath: `${name}.md` }).source.id;
  }

  const hierarchy = readCorpusJson<{ nodes: HNode[] }>('hierarchy.json');
  const walk = (n: HNode, parentId: NodeId | null): void => {
    const { node } = ws.nodes.createNode({ parentId, slug: n.slug, title: n.title, kind: n.kind });
    for (const child of n.children ?? []) walk(child, node.id);
  };
  for (const root of hierarchy.nodes) walk(root, null);

  const checkQuote = (chunkId: string, quote: string, where: string): void => {
    if (!problems) return;
    const chunk = ws.repos.chunks.getById(chunkId);
    if (!chunk) problems.push(`${where}: unknown chunk ${chunkId}`);
    else if (!chunk.text.includes(quote)) problems.push(`${where}: quote is not an exact substring of chunk ${chunkId}: ${JSON.stringify(quote)}`);
  };

  for (const name of CLAIMED_SOURCES) {
    const payload = ClaimApplySchema.parse(readCorpusJson(`claims/${name}.json`));
    payload.claims.forEach((claim, ci) =>
      claim.spans.forEach((span, si) => checkQuote(span.chunk_id, span.quote, `claims/${name}.json claims[${ci}].spans[${si}]`)),
    );
    ws.claims.apply(payload);
  }

  const graph = GraphApplySchema.parse(readCorpusJson('graph/api-reference.json'));
  graph.relationships.forEach((rel, ri) =>
    rel.evidence.forEach((ev, ei) => checkQuote(ev.chunk_id, ev.quote, `graph/api-reference.json relationships[${ri}].evidence[${ei}]`)),
  );
  ws.graph.apply(graph);

  for (const file of ['synthesis/leaves.json', 'synthesis/topics.json', 'synthesis/root.json']) {
    const { nodes } = readCorpusJson<{ nodes: unknown[] }>(file);
    for (const raw of nodes) ws.nodes.synthesize(SynthesizeSchema.parse(raw));
  }

  return { sourceIds };
}

/** A monotonic, reproducible clock so assembly does not depend on wall time. */
export function counterClock(): () => string {
  let tick = 0;
  return () => `2026-07-23T00:${String(Math.floor(tick / 60) % 60).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`;
}
