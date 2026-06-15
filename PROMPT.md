I want you to design and implement a system for using Claude Code to create a knowledge base, maintain it, and ingest new source material into the knowledge base.

Here's how the knowledge base should work:

- Given some source materials, I want Claude to create a set of documents that are the current, complete, up-to-date view of the knowledge base.
- Use hierarchical summarization and synthesis. We have a top-level document at the highest level, which can then be broken down into a hierarchy of arbitrary depth depending on the nature of the material.
- Parent documents are the synthesis of all of their child documents.
- Maintain an index document that links to all source documents along with short descriptions
- Copies of the source documents should be kept in the knowledge base. 
  - They should be immutable and segregated from everything that's derived or generated. 
- The system should strictly maintain provenance of all generated information so that every part can be traced back to a source document.
- After a knowledge base has been initially created from a set of source documents, it should be able to ingest new source documents into the knowledge base, and the agent must ensure that the generated knowledge base documents are updated to incorporate the new information.
- During ingestion, agents will extract basic items for the knowledge graph: entities of different types and the relationships between them.

**Goals:**
- Agents should be able to use these knowledge bases to answer questions about the subject matter.
- System should maintain human-readable documents

**Tech:**
- One or more Claude Code skills
- SQLite
- TypeScript, Zod
- CLI tools that agents can use to efficiently find/update information

**Context:**
- This will be a local, single user application
- Initial focus for subject material (handle this well): technical documentation, software development topics, software engineering principles 
  - Ideally, can be used for any subject material, but optimize for the above and design so that greater generality can be at least be achieved in future versions

**Rules:**
- Prioritize type safety
- Follow a Red/Green/Refactor TDD workflow

**Outcomes for V1:**
- Humans have a view of the knowledge base as readable markdown files
- Claude Code can efficiently and accurately find information and answer questions about the knowledge base

---

These requirements are deliberately underspecified. I want you to use your judgment to build something maximally useful that best accomplishes these objectives. You must operate fully autonomously and use your judgment to make decisions, fill in the gaps, and resolve ambiguities.

Design, review, and implement this using a dynamic workflow. I also want you to use an independent agent to augment the design and verification during this effort. To do so, use one-and-done prompts sent to Codex via the Codex CLI tool. You should run `unsafe-codex` to run Codex in YOLO mode.

Design and brainstorm using both your own sub-agents and Codex, and use your judgment to extract the best ideas.
