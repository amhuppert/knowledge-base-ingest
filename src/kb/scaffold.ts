import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files written into a KB root by `kb init`. AGENTS.md documents the operating
 * rules; CLAUDE.md imports it so Claude Code autoloads them when working here.
 */

export const AGENTS_MD = `# Knowledge Base — Operating Rules

This directory is a knowledge base managed by the \`kb\` CLI. **SQLite (\`kb.sqlite\`)
is the source of truth.** The markdown under \`kb/\` is a generated, read-only
projection — never hand-edit it; run \`kb render\` to regenerate it.

## Layout
- \`kb.sqlite\` — source of truth (sources, chunks, spans, synthesis nodes, claims,
  provenance, entities, relationships).
- \`sources/\` — immutable, content-addressed copies of every source. Never edit.
- \`kb/\` — generated human-readable markdown (index, changelog, open-questions,
  synthesis tree, knowledge graph). Read-only.

## Non-negotiables
1. **Evidence is a source span.** Every claim must cite an exact quote that the CLI
   verifies against the immutable source. Paraphrased/invented quotes are rejected.
2. **Do not trust memory.** Extract claims only from ingested source text.
3. **Generated markdown is output, not input.** Mutate knowledge only through \`kb\`
   commands, which update SQLite and re-render.
4. **Every synthesized sentence must trace to a claim** via an inline \`[^clm_…]\`
   citation. Leaf nodes own claims; a parent may cite any claim in its subtree.
5. **Keep it fresh.** After ingesting, re-synthesize stale nodes bottom-up
   (\`kb verify\` warns about stale nodes; \`kb node tree\` shows the hierarchy).

## Workflow (use the skills)
- Create a KB from a corpus → skill **kb-create**.
- Add one new source → skill **kb-ingest**.
- Answer a question with provenance → skill **kb-query**.

## CLI cheatsheet
\`\`\`
kb status --json
kb ingest <path> [--title T] [--source-date D] [--supersedes <src_id>] --json
kb ask-context "question" --json          # retrieve claims+provenance to answer
kb search "term" --scope claims --json
kb node create --parent <root|node_id> --title "T" --kind <root|topic|leaf> --json
kb claim apply --file claims.json --json  # see kb-ingest skill for the JSON shape
kb graph apply --file graph.json --json
kb synthesize --file node.json --json     # { node_id, body_md, title?, summary? }
kb verify --strict --json
kb render --json                          # regenerate kb/*.md (use --check to detect drift)
\`\`\`
`;

export const CLAUDE_MD = `@AGENTS.md
`;

export function writeScaffold(root: string): { wrote: string[] } {
  const wrote: string[] = [];
  const files: Array<[string, string]> = [
    ['AGENTS.md', AGENTS_MD],
    ['CLAUDE.md', CLAUDE_MD],
  ];
  for (const [name, content] of files) {
    const path = join(root, name);
    if (!existsSync(path)) {
      writeFileSync(path, content);
      wrote.push(name);
    }
  }
  return { wrote };
}
