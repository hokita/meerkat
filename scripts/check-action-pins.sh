#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-$root/.github/workflows}"
pinned='^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$'

shopt -s nullglob
files=("$dir"/*.yml "$dir"/*.yaml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no workflow files in $dir"
  exit 1
fi

status=0
matches="$(grep -nHE '^[[:space:]]*(-[[:space:]]+)?uses:' "${files[@]}")" || status=$?
if [ "$status" -gt 1 ]; then
  echo "could not read workflow files in $dir"
  exit 1
fi

bad=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  location="${line%%:*}"
  rest="${line#*:}"
  location="$location:${rest%%:*}"
  text="${rest#*:}"
  value="${text#*uses:}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#[\'\"]}"
  value="${value%[\'\"]}"
  if ! grep -qE "$pinned" <<<"$value"; then
    echo "unpinned action: $location: ${text#"${text%%[![:space:]]*}"}"
    bad=1
  fi
done <<<"$matches"

if [ "$bad" -ne 0 ]; then
  echo "Some actions are not pinned by a full commit SHA"
  exit 1
fi
echo "All actions are pinned by SHA"
