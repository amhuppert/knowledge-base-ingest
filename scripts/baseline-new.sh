#!/usr/bin/env bash
#
# baseline-new.sh — assemble the SAME fixture KB as scripts/baseline-old.sh, but with
# the Phase-2 batching commands, and report the orchestration cost as COMMANDS=<n>
# (every `kb` invocation is counted, identical mechanism to the old script). This is
# the "new" side of the Phase 2 command-count comparison (04 §4):
#
#   old                                new
#   ---                                ---
#   node create ×21                    node apply ×1        (one hierarchy manifest)
#   synthesize ×21                     synthesize ×3        (leaves / topics / root batches)
#   (context assembled by hand)        node show --context ×6
#
# The `--context` reads are the synthesis prep an agent actually pays for: one read
# returning everything a synthesize write needs (04 §1). They are counted like every
# other invocation. There is deliberately NO bare `node show` here — re-assembling
# context from single-node reads is the cost this phase removes, and a greppable test
# (src/cli/baseline.test.ts) enforces it.
#
# Both scripts end with `kb verify --strict`, then `kb render`, then `kb render --check`
# (render BEFORE check — finding 26) and fail on any non-zero exit.
#
# Usage: scripts/baseline-new.sh [kbDir]
#   kbDir defaults to a throwaway temp dir (removed on exit). Pass a path to keep the
#   assembled KB (used by the equivalence test to snapshot-diff it against the old one).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
KB="$ROOT/bin/kb"
CORPUS="$ROOT/fixtures/corpus"

KEEP=1
if [[ $# -ge 1 ]]; then
  KBDIR="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  KBDIR="$(mktemp -d "${TMPDIR:-/tmp}/kb-baseline-new.XXXXXX")"
  KEEP=0
fi
cleanup() { [[ "$KEEP" -eq 0 ]] && rm -rf "$KBDIR" || true; }
trap cleanup EXIT

COMMANDS=0
bump() { COMMANDS=$((COMMANDS + 1)); }

# 0. Fresh KB.
"$KB" init "$KBDIR" >/dev/null; bump
export KB_DIR="$KBDIR"

# 1. Ingest the four sources.
for name in design-notes api-reference meeting-transcript press-release; do
  "$KB" ingest "$CORPUS/sources/$name.md" --json >/dev/null; bump
done

# 2. One `node apply`: the whole 21-node hierarchy in one atomic manifest. The receipt
#    carries the ref→nodeId map, so no id has to be precomputed or guessed downstream.
APPLY_RECEIPT="$("$KB" node apply --file "$CORPUS/hierarchy.json" --json)"; bump

# Resolve manifest refs to the ids the apply just created (receipt on argv[1], refs after).
ids_for_refs() {
  node -e '
    const receipt = JSON.parse(process.argv[1]);
    const byRef = new Map(receipt.data.nodes.map((n) => [n.ref, n.nodeId]));
    for (const ref of process.argv.slice(2)) {
      const id = byRef.get(ref);
      if (!id) { console.error(`baseline-new: no nodeId for ref ${ref}`); process.exit(1); }
      console.log(id);
    }
  ' "$@"
}

# The manifest itself says which refs are topics (in manifest order — deterministic).
TOPIC_REFS="$(node -e '
  const manifest = require("./fixtures/corpus/hierarchy.json");
  const refs = [];
  const walk = (nodes) => { for (const n of nodes) { if (n.kind === "topic") refs.push(n.ref); walk(n.children ?? []); } };
  walk(manifest.nodes);
  console.log(refs.join(" "));
')"
# shellcheck disable=SC2086  # word splitting is the point: one id per topic ref
TOPIC_IDS="$(ids_for_refs "$APPLY_RECEIPT" $TOPIC_REFS)"
ROOT_ID="$(ids_for_refs "$APPLY_RECEIPT" root)"

# 3. One `claim apply` per claimed source (unchanged from the old path).
for name in design-notes api-reference meeting-transcript; do
  "$KB" claim apply --file "$CORPUS/claims/$name.json" --json >/dev/null; bump
done

# 4. One `graph apply` (unchanged from the old path).
"$KB" graph apply --file "$CORPUS/graph/api-reference.json" --json >/dev/null; bump

# 5. Synthesis, deepest-first, as three batches. Each batch is preceded by the
#    `--context` reads that supply its inputs — and by nothing else.
#
# 5a. Leaves: one read of the root subtree returns every claim in the KB, owner-tagged,
#     with its allowed citation ids — everything the 16 leaf bodies cite.
"$KB" node show "$ROOT_ID" --context --json >/dev/null; bump
"$KB" synthesize --file "$CORPUS/synthesis/leaves.json" --json >/dev/null; bump

# 5b. Topics: one read per topic, now that its leaves carry fresh summaries.
while IFS= read -r topicId; do
  [[ -z "$topicId" ]] && continue
  "$KB" node show "$topicId" --context --json >/dev/null; bump
done <<< "$TOPIC_IDS"
"$KB" synthesize --file "$CORPUS/synthesis/topics.json" --json >/dev/null; bump

# 5c. Root: one read, now that the topics carry fresh summaries.
"$KB" node show "$ROOT_ID" --context --json >/dev/null; bump
"$KB" synthesize --file "$CORPUS/synthesis/root.json" --json >/dev/null; bump

# 6. Verify, then render, then check the render (render BEFORE check).
"$KB" verify --strict --json >/dev/null; bump
"$KB" render --json >/dev/null; bump
"$KB" render --check --json >/dev/null; bump

echo "COMMANDS=$COMMANDS"
