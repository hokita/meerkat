#!/usr/bin/env bash
set -euo pipefail

expected="${1:-24.22.3}"
cd "$(dirname "$0")/.."

bad=0

check() {
  local label="$1" want="$2" pattern="$3" good="$4"
  shift 4
  local lines count=0
  lines="$(grep -nHE "$pattern" "$@" || true)"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    count=$((count + 1))
    if ! grep -qE "$good" <<<"${line#*:*:}"; then
      echo "wrong $label: $line"
      bad=1
    fi
  done <<<"$lines"
  if [ "$count" -ne "$want" ]; then
    echo "expected $want $label line(s), found $count"
    bad=1
  fi
}

v="${expected//./\\.}"
check "setup-node node-version" 3 'node-version:' "node-version: '${v}'$" .github/workflows/*.yml
check "Volta node" 1 '"node":' "\"node\": \"${v}\"$" package.json

if [ "$bad" -ne 0 ]; then
  echo "Node pins are not all ${expected}"
  exit 1
fi
echo "All Node pins are ${expected}"
