/**
 * kb-snapshot — print the normalized semantic snapshot (02 §4.2) of a KB to stdout.
 *
 * Thin CLI wrapper over `src/snapshot/snapshot.ts` (which holds the logic so the
 * determinism test can import it in-process). Phase 2 diffs the old-script KB
 * against the new-script KB with this output.
 *
 * Usage: tsx scripts/kb-snapshot.ts [kbRoot]
 *   kbRoot defaults to the resolved KB root (explicit dir > KB_DIR > walk up > cwd).
 */
import { resolveKbRoot, openWorkspace } from '../src/kb/workspace.js';
import { snapshotJson } from '../src/snapshot/snapshot.js';

const root = resolveKbRoot(process.cwd(), process.argv[2]);
const ws = openWorkspace(root);
try {
  process.stdout.write(snapshotJson(ws.repos) + '\n');
} finally {
  ws.close();
}
