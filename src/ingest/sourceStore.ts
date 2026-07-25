import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { SourceId } from '../domain/ids.js';

/** Reduce an extension to a safe, separator-free token (e.g. "../x" -> "x"). */
function safeExt(ext: string): string {
  return ext.replace(/[^a-z0-9]/gi, '').slice(0, 16);
}

/** The outcome of a `store()` call (03 §5, finding 19). */
export interface StoreResult {
  /** The stored path, relative to the KB root. */
  storedPath: string;
  /** True iff THIS call created the file; false when it already existed (EEXIST). */
  created: boolean;
}

/**
 * Immutable source storage. Sources are content-addressed and written once, read-
 * only. Injected so services stay testable (the in-memory variant lives in tests).
 */
export interface SourceStore {
  /**
   * Persist raw bytes for a source via ATOMIC create. Content-addressed paths mean
   * concurrent same-source writers converge on one path: exactly one call gets
   * `created: true` (it wrote the file); every other gets `created: false` and never
   * overwrites. Returns the stored path (relative to the KB root) either way.
   */
  store(sourceId: SourceId, ext: string, bytes: Buffer): StoreResult;
  /** Read raw bytes back (used to re-verify immutability). */
  read(storedPath: string): Buffer;
  has(storedPath: string): boolean;
  /**
   * Delete a stored copy, ignoring a missing target (ENOENT). Used by `commit` to
   * clean up a file it created when the DB transaction later fails (03 §5). The path
   * is subject to the same containment check as `read`/`has`.
   */
  remove(storedPath: string): void;
}

/** Filesystem store under `<root>/sources/<ab>/<sha>.<ext>`, chmod 0444. */
export class FsSourceStore implements SourceStore {
  constructor(private readonly root: string) {}

  private relPath(sourceId: SourceId, ext: string): string {
    const hex = sourceId.slice('src_'.length);
    const shard = hex.slice(0, 2);
    const cleanExt = safeExt(ext);
    return join('sources', shard, `${hex}${cleanExt ? '.' + cleanExt : ''}`);
  }

  /** Resolve a stored path and assert it stays under `<root>/sources`. */
  private safeAbs(storedPath: string): string {
    const base = resolve(this.root, 'sources');
    const abs = resolve(this.root, storedPath);
    if (abs !== base && !abs.startsWith(base + '/')) {
      throw new Error(`refusing to access path outside the source store: ${storedPath}`);
    }
    return abs;
  }

  store(sourceId: SourceId, ext: string, bytes: Buffer): StoreResult {
    const rel = this.relPath(sourceId, ext);
    const abs = join(this.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    try {
      // Atomic create: `wx` fails with EEXIST if the path already exists, so we never
      // overwrite and the winner of a concurrent same-source race is the sole creator.
      writeFileSync(abs, bytes, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { storedPath: rel, created: false };
      throw err;
    }
    try {
      chmodSync(abs, 0o444);
    } catch {
      /* best-effort read-only */
    }
    return { storedPath: rel, created: true };
  }

  read(storedPath: string): Buffer {
    return readFileSync(this.safeAbs(storedPath));
  }

  has(storedPath: string): boolean {
    return existsSync(this.safeAbs(storedPath));
  }

  remove(storedPath: string): void {
    const abs = this.safeAbs(storedPath);
    // The stored copy is 0444; restore write permission before unlinking. Both the
    // chmod and the unlink tolerate a missing file (ENOENT) so cleanup is idempotent.
    try {
      chmodSync(abs, 0o644);
    } catch {
      /* the file may be gone already, or chmod may be unsupported — unlink still tries */
    }
    try {
      unlinkSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** In-memory store for tests. */
export class MemorySourceStore implements SourceStore {
  private readonly files = new Map<string, Buffer>();

  store(sourceId: SourceId, ext: string, bytes: Buffer): StoreResult {
    const hex = sourceId.slice('src_'.length);
    const cleanExt = safeExt(ext);
    const rel = `sources/${hex.slice(0, 2)}/${hex}${cleanExt ? '.' + cleanExt : ''}`;
    // Atomic-create semantics mirrored: the first writer creates, later writers of the
    // same content-addressed path never overwrite and report created:false.
    if (this.files.has(rel)) return { storedPath: rel, created: false };
    this.files.set(rel, Buffer.from(bytes));
    return { storedPath: rel, created: true };
  }

  read(storedPath: string): Buffer {
    const b = this.files.get(storedPath);
    if (!b) throw new Error(`no stored source at ${storedPath}`);
    return b;
  }

  has(storedPath: string): boolean {
    return this.files.has(storedPath);
  }

  remove(storedPath: string): void {
    // Deleting a missing path is a no-op (mirrors the FS store's ENOENT tolerance).
    this.files.delete(storedPath);
  }
}
