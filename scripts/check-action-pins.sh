#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-$root/.github/workflows}"
pinned='^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$'
mentions='(^|[^A-Za-z0-9_-])["'"'"']?uses["'"'"']?[[:space:]]*:'
explicit_key='^[[:space:]]*(-[[:space:]]+)?\?'
escaped_key='("[^"]*\\[^"]*"|'"'"'[^'"'"']*\\[^'"'"']*'"'"')[[:space:]]*:'
supported='^[[:space:]]*(-[[:space:]]+)?(uses|"uses"|'"'"'uses'"'"')[[:space:]]*:'

shopt -s nullglob
files=("$dir"/*.yml "$dir"/*.yaml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no workflow files in $dir"
  exit 1
fi

status=0
matches="$(grep -nHE -e "$mentions" -e "$explicit_key" -e "$escaped_key" "${files[@]}")" || status=$?
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
  shown="${text#"${text%%[![:space:]]*}"}"
  if ! [[ "$text" =~ $supported ]]; then
    echo "unsupported uses syntax: $location: $shown"
    bad=1
    continue
  fi
  value="${text#"${BASH_REMATCH[0]}"}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#[\'\"]}"
  value="${value%[\'\"]}"
  if ! grep -qE "$pinned" <<<"$value"; then
    echo "unpinned action: $location: $shown"
    bad=1
  fi
done <<<"$matches"

if [ "$bad" -ne 0 ]; then
  echo "Some actions are not pinned by a full commit SHA"
  exit 1
fi
echo "All actions are pinned by SHA"
