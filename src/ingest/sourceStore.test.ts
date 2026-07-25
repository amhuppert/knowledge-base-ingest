import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsSourceStore, MemorySourceStore, type SourceStore } from './sourceStore.js';
import { deriveSourceId } from '../domain/algorithms/idDeriver.js';
import type { SourceId } from '../domain/ids.js';

/**
 * SOURCE STORE CONTRACT (03 §5, finding 19).
 *
 * `store()` is atomic-create (`wx`): the first writer of a content-addressed path gets
 * `created: true`; a second writer of the same path (identical content) gets
 * `created: false` and never overwrites. `remove(storedPath)` deletes a stored copy
 * (chmod +w first for the read-only FS copy) and ignores a missing target. Both the
 * filesystem store and the in-memory test store implement the same contract, so the
 * table below runs against each.
 */

const BYTES = Buffer.from('# Title\n\nSome source text.\n', 'utf8');
const SRC: SourceId = deriveSourceId(BYTES);

describe.each([
  ['FsSourceStore', (root: string) => new FsSourceStore(root)],
  ['MemorySourceStore', (_root: string) => new MemorySourceStore()],
] as const)('%s — SourceStore contract', (_name, make) => {
  let root: string;
  let store: SourceStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-store-'));
    store = make(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('store() creates the file atomically and reports created:true', () => {
    const { storedPath, created } = store.store(SRC, 'md', BYTES);
    expect(created).toBe(true);
    expect(store.has(storedPath)).toBe(true);
    expect(store.read(storedPath).equals(BYTES)).toBe(true);
  });

  it('store() on an existing content-addressed path reports created:false and never overwrites', () => {
    const first = store.store(SRC, 'md', BYTES);
    expect(first.created).toBe(true);
    // A second writer of the identical content converges on the same path but does not create.
    const second = store.store(SRC, 'md', BYTES);
    expect(second.created).toBe(false);
    expect(second.storedPath).toBe(first.storedPath);
    // Content is unchanged (the first bytes win; wx never overwrote).
    expect(store.read(second.storedPath).equals(BYTES)).toBe(true);
  });

  it('remove() deletes a stored copy (even a read-only one) so has() goes false', () => {
    const { storedPath } = store.store(SRC, 'md', BYTES);
    expect(store.has(storedPath)).toBe(true);
    store.remove(storedPath);
    expect(store.has(storedPath)).toBe(false);
  });

  it('remove() of a missing path is a no-op (ENOENT ignored), never throwing', () => {
    const { storedPath } = store.store(SRC, 'md', BYTES);
    store.remove(storedPath);
    // Removing again — the path is already gone — must not throw.
    expect(() => store.remove(storedPath)).not.toThrow();
    // Removing a path that never existed is also a no-op.
    expect(() => store.remove('sources/zz/never-existed.md')).not.toThrow();
  });
});

describe('FsSourceStore specifics', () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), 'kb-store-fs-'))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('makes the created file read-only (0444) and remove() still deletes it', () => {
    const store = new FsSourceStore(root);
    const { storedPath } = store.store(SRC, 'md', BYTES);
    const mode = statSync(join(root, storedPath)).mode & 0o777;
    expect(mode & 0o222).toBe(0); // no write bits
    store.remove(storedPath);
    expect(existsSync(join(root, storedPath))).toBe(false);
  });

  it('remove() refuses a path that escapes the source store (containment check reused)', () => {
    const store = new FsSourceStore(root);
    expect(() => store.remove('../../etc/passwd')).toThrow(/outside the source store/);
  });
});
