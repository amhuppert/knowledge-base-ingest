import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_CODES, isIssueCode, DomainIssueError } from './issueCodes.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('issue-code registry', () => {
  it('registers LEGACY and every code is a unique SCREAMING_SNAKE token', () => {
    expect(ISSUE_CODES).toContain('LEGACY');
    expect(new Set(ISSUE_CODES).size).toBe(ISSUE_CODES.length);
    for (const code of ISSUE_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('registers the reserved coverage and media codes', () => {
    for (const code of [
      'SOURCE_NO_CLAIMS',
      'CHUNK_UNCITED',
      'CLAIM_NOT_SYNTHESIZED',
      'NODE_SINGLE_SOURCE',
      'OPEN_QUESTION_NOT_SYNTHESIZED',
      'UNSUPPORTED_MEDIA',
    ]) {
      expect(ISSUE_CODES).toContain(code);
    }
  });

  it('isIssueCode narrows registered codes only', () => {
    expect(isIssueCode('LEGACY')).toBe(true);
    expect(isIssueCode('NO_STALE_NODES')).toBe(true);
    expect(isIssueCode('NOT_A_CODE')).toBe(false);
  });
});

describe('DomainIssueError', () => {
  it('carries code/path/ids/details and is an Error', () => {
    const err = new DomainIssueError('QUOTE_AMBIGUOUS', 'ambiguous', {
      path: 'claims[0].spans[0].quote',
      ids: ['chk_1'],
      details: { count: 2 },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('QUOTE_AMBIGUOUS');
    expect(err.message).toBe('ambiguous');
    expect(err.path).toBe('claims[0].spans[0].quote');
    expect(err.ids).toEqual(['chk_1']);
    expect(err.details).toEqual({ count: 2 });
  });

  it('leaves optional fields undefined when omitted', () => {
    const err = new DomainIssueError('INTERNAL', 'boom');
    expect(err.path).toBeUndefined();
    expect(err.ids).toBeUndefined();
    expect(err.details).toBeUndefined();
  });
});

describe('DomainIssueError migration (03 §1)', () => {
  const servicesDir = join(here, 'services');
  const read = (name: string): string => readFileSync(join(servicesDir, name), 'utf8');

  it('no service defines or throws the retired ProvenanceError / NodeError classes', () => {
    for (const file of readdirSync(servicesDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = read(file);
      expect(src, `${file} still references ProvenanceError`).not.toMatch(/ProvenanceError/);
      expect(src, `${file} still references NodeError`).not.toMatch(/\bNodeError\b/);
    }
  });

  it('the migrated services throw DomainIssueError with registry codes', () => {
    for (const file of ['spanResolver.ts', 'claimService.ts', 'graphService.ts', 'nodeService.ts']) {
      expect(read(file), `${file} throws DomainIssueError`).toMatch(/throw new DomainIssueError\(/);
    }
  });
});

describe('domain dependency direction', () => {
  it('no module under src/domain imports from src/cli', () => {
    const domainRoot = here;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        const src = readFileSync(full, 'utf8');
        if (/from\s+['"][^'"]*\/cli\//.test(src) || /from\s+['"]\.\.?\/cli(\/|['"])/.test(src)) {
          offenders.push(full);
        }
      }
    };
    walk(domainRoot);
    expect(offenders).toEqual([]);
  });
});
