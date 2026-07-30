import { describe, it, expect } from 'vitest';
import {
  HINTS,
  hintFor,
  VERIFY_CHECK_CODES,
  codeForVerifyCheck,
  formatPath,
  parseJsonPayload,
  domainErrorToIssue,
  REMOVED_GRAPH_FIELD_HINTS,
  ISSUE_CODES,
  VERIFY_CHECKS,
} from './issues.js';
import { isIssueCode, DomainIssueError } from '../domain/issueCodes.js';
import { parseGraphApply } from '../domain/schemas/agent.js';
import { COMMAND_NAMES } from './runCli.js';

const REGISTERED_COMMANDS = new Set(COMMAND_NAMES);

/**
 * Pull every `kb …` command referenced in a hint. Prefer the two-word group form
 * when it names a registered command; otherwise fall back to the head word (which
 * is then validated — a bogus reference like `kb claim list` yields `claim`, which
 * is not a registered command and fails the test).
 */
function embeddedKbCommands(hint: string): string[] {
  const re = /(?:^|\s)kb\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;
  const cmds: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(hint)) !== null) {
    const head = m[1]!;
    const two = m[2] ? `${head} ${m[2]}` : undefined;
    cmds.push(two && REGISTERED_COMMANDS.has(two) ? two : head);
  }
  return cmds;
}

describe('hint registry', () => {
  it('every registered code has a non-empty hint', () => {
    for (const code of ISSUE_CODES) {
      expect(HINTS[code], `hint for ${code}`).toBeTruthy();
      expect(hintFor(code).length).toBeGreaterThan(0);
    }
    // No stray hints for unregistered codes.
    expect(Object.keys(HINTS).sort()).toEqual([...ISSUE_CODES].sort());
  });

  it('every kb command embedded in a hint names a registered command', () => {
    // Sanity-check the extractor against the known good/bad shapes first.
    expect(embeddedKbCommands('find one with kb node show <id> --json')).toEqual(['node show']);
    expect(embeddedKbCommands('do not use kb claim list please')).toEqual(['claim']); // bogus → head word
    expect(REGISTERED_COMMANDS.has('claim')).toBe(false);

    for (const code of ISSUE_CODES) {
      for (const cmd of embeddedKbCommands(HINTS[code])) {
        expect(REGISTERED_COMMANDS.has(cmd), `${code} hint references unregistered command "${cmd}"`).toBe(true);
      }
    }
  });

  it('keeps CITATIONS_REMOVED informational rather than reminder-style guidance', () => {
    expect(HINTS.CITATIONS_REMOVED).toBe(
      'The ids field lists current claims whose citations were removed from the node body.',
    );
  });
});

describe('verify-check → code map', () => {
  it('is total over VERIFY_CHECKS and every target is a registered code', () => {
    for (const check of VERIFY_CHECKS) {
      const code = codeForVerifyCheck(check);
      expect(code, `no code for verify check ${check}`).toBeTruthy();
      expect(isIssueCode(code)).toBe(true);
    }
    expect(Object.keys(VERIFY_CHECK_CODES).sort()).toEqual([...VERIFY_CHECKS].sort());
  });

  it('reuses the semantic citation codes', () => {
    expect(codeForVerifyCheck('citation-resolves')).toBe('CITATION_UNKNOWN');
    expect(codeForVerifyCheck('parent-cites-subtree')).toBe('CITATION_OUT_OF_SUBTREE');
    expect(codeForVerifyCheck('citation-active')).toBe('CITATION_INACTIVE');
    expect(codeForVerifyCheck('no-stale-nodes')).toBe('NO_STALE_NODES');
  });
});

describe('formatPath', () => {
  it('produces bracket-dot style', () => {
    expect(formatPath(['claims', 2, 'spans', 0, 'quote'])).toBe('claims[2].spans[0].quote');
    expect(formatPath(['nodes', 3, 'body_md'])).toBe('nodes[3].body_md');
    expect(formatPath([0, 'x'])).toBe('[0].x');
    expect(formatPath([])).toBe('');
  });
});

describe('parseJsonPayload', () => {
  it('parses valid JSON', () => {
    expect(parseJsonPayload('{"a":1}')).toEqual({ a: 1 });
  });

  it('reports a CHARACTER offset (not byte) for malformed non-ASCII JSON', () => {
    // A multi-byte "é" precedes the syntax error, so the character offset (10)
    // differs from the byte offset (11) — proving we report characters.
    const raw = '{"café":1 2}';
    const errorChar = 10;
    expect(Buffer.byteLength(raw.slice(0, errorChar))).toBe(11); // byte offset would be 11
    let thrown: unknown;
    try {
      parseJsonPayload(raw);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DomainIssueError);
    const err = thrown as DomainIssueError;
    expect(err.code).toBe('PAYLOAD_PARSE_ERROR');
    expect(err.message).toContain(`character ${errorChar}`);
    expect(err.details).toEqual({ character: errorChar });
  });
});

describe('domainErrorToIssue', () => {
  it('maps code, message, hint, and present optional fields', () => {
    const issue = domainErrorToIssue(
      new DomainIssueError('UNKNOWN_NODE', 'no such node', { path: 'nodes[0]', ids: ['nod_1'] }),
    );
    expect(issue).toEqual({
      code: 'UNKNOWN_NODE',
      severity: 'error',
      message: 'no such node',
      hint: hintFor('UNKNOWN_NODE'),
      path: 'nodes[0]',
      ids: ['nod_1'],
    });
  });

  it('omits absent optional fields', () => {
    const issue = domainErrorToIssue(new DomainIssueError('INTERNAL', 'boom'));
    expect(issue.path).toBeUndefined();
    expect(issue.ids).toBeUndefined();
    expect(issue).toMatchObject({ code: 'INTERNAL', severity: 'error', message: 'boom' });
  });

  it('routes by CODE, never by message text (03 §1: no message-string matching)', () => {
    // Two domain errors with the SAME code but WILDLY different messages must map to
    // the same code/severity/hint. If the CLI matched on message text, these would
    // diverge — so identical routing proves the mapping is code-driven only.
    const a = domainErrorToIssue(new DomainIssueError('QUOTE_NOT_FOUND', 'quote not found in chunk chk_a'));
    const b = domainErrorToIssue(new DomainIssueError('QUOTE_NOT_FOUND', 'zzz totally unrelated wording zzz'));
    expect(a.code).toBe('QUOTE_NOT_FOUND');
    expect(b.code).toBe('QUOTE_NOT_FOUND');
    expect(a.severity).toBe(b.severity);
    expect(a.hint).toBe(b.hint);
    expect(a.hint).toBe(hintFor('QUOTE_NOT_FOUND'));
    // The message is carried through verbatim (copied, never inspected for routing).
    expect(a.message).toBe('quote not found in chunk chk_a');
    expect(b.message).toBe('zzz totally unrelated wording zzz');
  });

  /**
   * HINT OWNERSHIP (01 §3.1, finding 12). A domain diagnostic carries only
   * `code`/`path`/`ids`/`details` — never agent-facing hint text. Where one code covers
   * several distinct failures (the two removed graph payload fields both raise
   * `PAYLOAD_SCHEMA`, 03 §3.2), the domain reports WHICH one via `details.removedField`
   * and the CLI derives the field-specific guidance from its own table.
   */
  describe('field-specific PAYLOAD_SCHEMA guidance is derived at the CLI boundary', () => {
    it('refines the registry hint per removed graph field, from details.removedField only', () => {
      const entity = domainErrorToIssue(
        new DomainIssueError('PAYLOAD_SCHEMA', 'entities[0].evidence is no longer accepted', {
          path: 'entities[0].evidence',
          details: { removedField: 'entity.evidence' },
        }),
      );
      const relEvidence = domainErrorToIssue(
        new DomainIssueError('PAYLOAD_SCHEMA', 'relationships[0].evidence[0].confidence is no longer accepted', {
          path: 'relationships[0].evidence[0].confidence',
          details: { removedField: 'relationship.evidence.confidence' },
        }),
      );

      expect(entity.hint).toBe(REMOVED_GRAPH_FIELD_HINTS['entity.evidence']);
      expect(entity.hint).toMatch(/entity evidence is not stored/i);
      expect(relEvidence.hint).toBe(REMOVED_GRAPH_FIELD_HINTS['relationship.evidence.confidence']);
      expect(relEvidence.hint).toMatch(/no confidence/i);
      // Distinct guidance per field, and neither is the generic registry hint.
      expect(entity.hint).not.toBe(relEvidence.hint);
      expect(entity.hint).not.toBe(hintFor('PAYLOAD_SCHEMA'));
    });

    it('falls back to the registry hint for any other PAYLOAD_SCHEMA failure', () => {
      const plain = domainErrorToIssue(new DomainIssueError('PAYLOAD_SCHEMA', 'claims[0].text: too short', { path: 'claims[0].text' }));
      const unknownDetails = domainErrorToIssue(
        new DomainIssueError('PAYLOAD_SCHEMA', 'nope', { details: { removedField: 'not.a.known.field' } }),
      );
      expect(plain.hint).toBe(hintFor('PAYLOAD_SCHEMA'));
      expect(unknownDetails.hint).toBe(hintFor('PAYLOAD_SCHEMA'));
    });

    it('a domain error never carries hint text of its own', () => {
      // The graph payload check is the domain-side source of these diagnostics: it must
      // report the removed field structurally and leave the wording to this module.
      let thrown: unknown;
      try {
        parseGraphApply({ source_id: 'src_1a2b3c', entities: [{ type: 'Service', name: 'Gateway', evidence: [] }], relationships: [] });
      } catch (e) {
        thrown = e;
      }
      const err = thrown as DomainIssueError & { hint?: unknown };
      expect(err).toBeInstanceOf(DomainIssueError);
      expect(err.code).toBe('PAYLOAD_SCHEMA');
      expect(err.details).toEqual({ removedField: 'entity.evidence' });
      expect(err.hint).toBeUndefined();
      // The hint the agent sees comes from the CLI table, not from the thrown error.
      expect(domainErrorToIssue(err).hint).toBe(REMOVED_GRAPH_FIELD_HINTS['entity.evidence']);
    });
  });
});
