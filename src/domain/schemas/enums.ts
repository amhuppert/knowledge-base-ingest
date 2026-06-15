/** Controlled vocabularies, defined once and shared by Zod schemas and SQL CHECKs. */

export const SOURCE_STATUSES = ['active', 'superseded', 'duplicate', 'retracted'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const NODE_KINDS = ['root', 'topic', 'leaf'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const CLAIM_TYPES = [
  'fact',
  'definition',
  'decision',
  'requirement',
  'constraint',
  'procedure',
  'warning',
  'example',
  'open_question',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const CLAIM_STATUSES = ['active', 'superseded', 'conflicted', 'retracted'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const SPAN_ROLES = ['supports', 'contradicts', 'context', 'supersedes'] as const;
export type SpanRole = (typeof SPAN_ROLES)[number];

export const EXTRACTORS = ['agent', 'cli', 'human'] as const;
export type Extractor = (typeof EXTRACTORS)[number];

/**
 * Recommended knowledge-graph vocabulary for the software/technical domain.
 * NOT enforced by the DB (entity/relationship `type` is free TEXT) — the skills
 * point the agent at these so usage stays consistent, while remaining extensible.
 */
export const ENTITY_TYPES = [
  'System', 'Service', 'Component', 'Module', 'Library', 'Framework', 'Language',
  'API', 'Endpoint', 'Function', 'Class', 'DataStore', 'Schema', 'Table', 'Config',
  'Environment', 'Protocol', 'Format', 'Tool', 'Concept', 'Pattern', 'Decision',
  'Requirement', 'Constraint', 'Risk', 'Person', 'Team', 'Version', 'Repository', 'File',
] as const;

export const RELATIONSHIP_TYPES = [
  'depends_on', 'calls', 'implements', 'extends', 'exposes', 'consumes', 'produces',
  'stores_in', 'configured_by', 'deployed_to', 'owned_by', 'authored_by', 'supersedes',
  'deprecates', 'alternative_to', 'part_of', 'references', 'decided_by', 'constrains',
  'tested_by', 'documented_by', 'example_of', 'equivalent_to',
] as const;
