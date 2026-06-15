import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { SourceId } from '../domain/ids.js';

/** Reduce an extension to a safe, separator-free token (e.g. "../x" -> "x"). */
function safeExt(ext: string): string {
  return ext.replace(/[^a-z0-9]/gi, '').slice(0, 16);
}

/**
 * Immutable source storage. Sources are content-addressed and written once, read-
 * only. Injected so services stay testable (the in-memory variant lives in tests).
 */
export interface SourceStore {
  /** Persist raw bytes for a source; returns the stored path (relative to the KB root). */
  store(sourceId: SourceId, ext: string, bytes: Buffer): string;
  /** Read raw bytes back (used to re-verify immutability). */
  read(storedPath: string): Buffer;
  has(storedPath: string): boolean;
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

  store(sourceId: SourceId, ext: string, bytes: Buffer): string {
    const rel = this.relPath(sourceId, ext);
    const abs = join(this.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (!existsSync(abs)) {
      writeFileSync(abs, bytes);
      try {
        chmodSync(abs, 0o444);
      } catch {
        /* best-effort read-only */
      }
    }
    return rel;
  }

  read(storedPath: string): Buffer {
    return readFileSync(this.safeAbs(storedPath));
  }

  has(storedPath: string): boolean {
    return existsSync(this.safeAbs(storedPath));
  }
}

/** In-memory store for tests. */
export class MemorySourceStore implements SourceStore {
  private readonly files = new Map<string, Buffer>();

  store(sourceId: SourceId, ext: string, bytes: Buffer): string {
    const hex = sourceId.slice('src_'.length);
    const cleanExt = safeExt(ext);
    const rel = `sources/${hex.slice(0, 2)}/${hex}${cleanExt ? '.' + cleanExt : ''}`;
    if (!this.files.has(rel)) this.files.set(rel, Buffer.from(bytes));
    return rel;
  }

  read(storedPath: string): Buffer {
    const b = this.files.get(storedPath);
    if (!b) throw new Error(`no stored source at ${storedPath}`);
    return b;
  }

  has(storedPath: string): boolean {
    return this.files.has(storedPath);
  }
}
