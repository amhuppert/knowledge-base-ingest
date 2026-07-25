/**
 * `kb version` and root `--version` (02 §2) — router-owned and WORKSPACE-FREE.
 *
 * Commander's `.version()` is prohibited (it prints raw text and exits during parse;
 * 01 §1.1), so the router builds this envelope itself. It resolves the KB root only to
 * REPORT it and probes the on-disk schema READ-ONLY (never migrating, never throwing on
 * a too-new schema), so `kb version` answers even when the KB is broken or missing — a
 * stale binary must be distinguishable from a missing feature (02 §2).
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { success, type Envelope } from './output.js';
import { currentSchemaVersion, probeSchemaVersion } from '../db/migrate.js';
import { resolveKbRoot, DB_FILENAME } from '../kb/workspace.js';
import type { CliIo } from './io.js';

/** The version reported by `kb version`, `kb --version`, and `kb status`. */
export interface VersionData {
  /** The CLI version from package.json. */
  cli: string;
  /** The Node.js runtime version (`process.version`). */
  node: string;
  /** The resolved launcher entry (`io.entry`), or null when unknown (in-process tests). */
  entry: string | null;
  schema: {
    /** The highest schema version this binary knows (`currentSchemaVersion()`). */
    supported: number;
    /** The on-disk schema version — null when no KB resolves; the raw number even if too-new. */
    onDisk: number | null;
  };
  /** The resolved KB root when a KB exists there, else null. */
  kbRoot: string | null;
}

let cachedCliVersion: string | undefined;

/** The CLI version string from package.json (read once, module-relative). */
export function cliVersion(): string {
  if (cachedCliVersion === undefined) {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    cachedCliVersion = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  }
  return cachedCliVersion;
}

/**
 * Build the version payload for `io` (honoring `--kb`/`KB_DIR`/walk-up for the root it
 * reports). `kbRoot`/`schema.onDisk` are non-null only when a `kb.sqlite` actually
 * exists at the resolved root; the probe never migrates and never throws.
 */
export function buildVersion(io: CliIo, kbFlag?: string): VersionData {
  const root = resolveKbRoot(io.cwd, kbFlag, io.env);
  const dbPath = join(root, DB_FILENAME);
  const hasDb = existsSync(dbPath);
  return {
    cli: cliVersion(),
    node: process.version,
    entry: io.entry ? resolve(io.cwd, io.entry) : null,
    schema: {
      supported: currentSchemaVersion(),
      onDisk: hasDb ? probeSchemaVersion(dbPath) : null,
    },
    kbRoot: hasDb ? root : null,
  };
}

/** The `kb version` / `kb --version` envelope (always ok; workspace-free). */
export function versionEnvelope(io: CliIo, kbFlag?: string): Envelope<VersionData> {
  return success(buildVersion(io, kbFlag), {
    hints: ['kb status --json shows KB contents; kb --help lists the workflow.'],
  });
}
