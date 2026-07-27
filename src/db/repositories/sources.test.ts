import { describe, it, expect } from 'vitest';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { Repositories } from './index.js';
import { makeSourceId, type SourceId } from '../../domain/ids.js';
import type { Source } from '../../domain/schemas/models.js';
import type { SourceStatus } from '../../domain/schemas/enums.js';

/**
 * Successor resolution for supersession chains (Phase 5 §1.1). `supersederOf` is
 * the reverse edge of `supersedes_source_id`; `activeSuccessorOf` walks it to the
 * first ACTIVE source, cycle-guarded, or undefined when the chain has no active
 * head.
 */

function makeRepos(): Repositories {
  const db = openDb(':memory:');
  migrate(db);
  return new Repositories(db);
}

function insertSource(
  repos: Repositories,
  args: { id: string; supersedes?: string; status?: SourceStatus; ingestedAt?: string },
): SourceId {
  const id = makeSourceId(args.id);
  const source: Source = {
    id,
    sha256: `sha-${args.id}`,
    storedPath: `sources/xx/${args.id}.md`,
    originalPath: null,
    title: args.id,
    mediaType: 'text/markdown',
    byteSize: 10,
    sourceDate: null,
    author: null,
    versionLabel: null,
    supersedesSourceId: args.supersedes ? makeSourceId(args.supersedes) : null,
    status: args.status ?? 'active',
    metadataJson: '{}',
    ingestedAt: args.ingestedAt ?? '2026-07-24T00:00:00.000Z',
  };
  repos.sources.insert(source);
  return id;
}

describe('SourceRepo.supersederOf', () => {
  it('returns the source that supersedes the given one', () => {
    const repos = makeRepos();
    const a = insertSource(repos, { id: 'src_aaaa000000000001', status: 'superseded' });
    const b = insertSource(repos, { id: 'src_bbbb000000000001', supersedes: 'src_aaaa000000000001' });
    expect(repos.sources.supersederOf(a)?.id).toBe(b);
  });

  it('returns undefined when nothing supersedes the source', () => {
    const repos = makeRepos();
    const a = insertSource(repos, { id: 'src_aaaa000000000001' });
    expect(repos.sources.supersederOf(a)).toBeUndefined();
  });

  it('picks the newest by (ingestedAt, id) when several claim the edge', () => {
    const repos = makeRepos();
    const a = insertSource(repos, { id: 'src_aaaa000000000001', status: 'superseded' });
    insertSource(repos, {
      id: 'src_bbbb000000000001',
      supersedes: 'src_aaaa000000000001',
      ingestedAt: '2026-07-24T00:00:01.000Z',
    });
    const newest = insertSource(repos, {
      id: 'src_cccc000000000001',
      supersedes: 'src_aaaa000000000001',
      ingestedAt: '2026-07-24T00:00:02.000Z',
    });
    expect(repos.sources.supersederOf(a)?.id).toBe(newest);
  });
});

describe('SourceRepo.activeSuccessorOf', () => {
  it('follows a chain A→B→C to the active head', () => {
    const repos = makeRepos();
    const a = insertSource(repos, { id: 'src_aaaa000000000001', status: 'superseded' });
    insertSource(repos, { id: 'src_bbbb000000000001', supersedes: 'src_aaaa000000000001', status: 'superseded' });
    const c = insertSource(repos, { id: 'src_cccc000000000001', supersedes: 'src_bbbb000000000001' });
    expect(repos.sources.activeSuccessorOf(a)?.id).toBe(c);
  });

  it('returns undefined when the chain dies out without an active head', () => {
    const repos = makeRepos();
    const a = insertSource(repos, { id: 'src_aaaa000000000001', status: 'superseded' });
    insertSource(repos, { id: 'src_bbbb000000000001', supersedes: 'src_aaaa000000000001', status: 'retracted' });
    expect(repos.sources.activeSuccessorOf(a)).toBeUndefined();
  });

  it('returns undefined for a source with no superseder', () => {
    const repos = makeRepos();
    const a = insertSource(repos, { id: 'src_aaaa000000000001', status: 'superseded' });
    expect(repos.sources.activeSuccessorOf(a)).toBeUndefined();
  });

  it('is cycle-guarded: mutually superseding sources terminate with undefined', () => {
    const repos = makeRepos();
    const a = insertSource(repos, { id: 'src_aaaa000000000001', status: 'superseded' });
    const b = insertSource(repos, { id: 'src_bbbb000000000001', supersedes: 'src_aaaa000000000001', status: 'superseded' });
    repos.sources.setSupersedes(a, b);
    expect(repos.sources.activeSuccessorOf(a)).toBeUndefined();
  });
});
