#!/usr/bin/env bash
#
# baseline-old.sh — assemble the fixture KB with Phase-0 commands ONLY and report
# the orchestration cost as COMMANDS=<n> (every `kb` invocation is counted). This is
# the "old" side of the Phase 2 command-count comparison (04 §4): one `node create`
# per node, one `claim apply` per source, one `graph apply`, one `synthesize` per
# node. It ends with `kb verify --strict`, then `kb render`, then `kb render --check`
# (render BEFORE check — finding 26) and fails on any non-zero exit.
#
# Usage: scripts/baseline-old.sh [kbDir]
#   kbDir defaults to a throwaway temp dir (removed on exit). Pass a path to keep the
#   assembled KB (used by scripts/gen-baseline.sh to snapshot-hash the corpus).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
KB="$ROOT/bin/kb"
CORPUS="$ROOT/fixtures/corpus"

KEEP=1
if [[ $# -ge 1 ]]; then
  KBDIR="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  KBDIR="$(mktemp -d "${TMPDIR:-/tmp}/kb-baseline-old.XXXXXX")"
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

# 2. One `node create` per node, parents before children. Parent ids are precomputed
#    by the deterministic deriver (scripts/emit-nodes.ts), so the id `node create`
#    derives matches the --parent id fed to that node's children (bash 3.2 friendly).
while IFS='|' read -r parentId slug title kind; do
  [[ -z "$slug" ]] && continue
  if [[ -z "$parentId" ]]; then
    "$KB" node create --title "$title" --kind "$kind" --slug "$slug" --json >/dev/null
  else
    "$KB" node create --title "$title" --kind "$kind" --slug "$slug" --parent "$parentId" --json >/dev/null
  fi
  bump
done < <("$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/emit-nodes.ts")

# 3. One `claim apply` per claimed source.
for name in design-notes api-reference meeting-transcript; do
  "$KB" claim apply --file "$CORPUS/claims/$name.json" --json >/dev/null; bump
done

# 4. One `graph apply`.
"$KB" graph apply --file "$CORPUS/graph/api-reference.json" --json >/dev/null; bump

# 5. One `synthesize` per node, deepest first: leaves, then topics, then root.
for file in leaves topics root; do
  count="$(node -e "console.log(require('./fixtures/corpus/synthesis/$file.json').nodes.length)")"
  for ((i = 0; i < count; i++)); do
    node -e "process.stdout.write(JSON.stringify(require('./fixtures/corpus/synthesis/$file.json').nodes[$i]))" \
      | "$KB" synthesize --file - --json >/dev/null
    bump
  done
done

# 6. Verify, then render, then check the render (render BEFORE check).
"$KB" verify --strict --json >/dev/null; bump
"$KB" render --json >/dev/null; bump
"$KB" render --check --json >/dev/null; bump

echo "COMMANDS=$COMMANDS"
