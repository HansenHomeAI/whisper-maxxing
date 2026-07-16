#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "usage: $0 <branch> <sha>" >&2
  exit 2
fi
BRANCH="$1"
SHA="$2"
RUN_JSON="$(gh run list --workflow electron-ci.yml --branch "$BRANCH" --event push --limit 20 \
  --json databaseId,headSha,status,conclusion,url \
  --jq ".[] | select(.headSha == \"$SHA\" and .status == \"completed\" and .conclusion == \"success\")" | head -1)"
if [[ -z "$RUN_JSON" ]]; then
  echo "no successful completed electron-ci.yml push run for $BRANCH at $SHA" >&2
  exit 1
fi
RUN_ID="$(jq -r '.databaseId' <<<"$RUN_JSON")"
RUN_URL="$(jq -r '.url' <<<"$RUN_JSON")"
JOBS="$(gh run view "$RUN_ID" --json jobs)"
for NAME in 'Electron (macos-14)' 'Electron (windows-2022)' 'Swift (macos-14)' 'Dist (macos-14)' 'Dist (windows-2022)'; do
  COUNT="$(jq --arg name "$NAME" '[.jobs[] | select(.name == $name and .conclusion == "success")] | length' <<<"$JOBS")"
  if [[ "$COUNT" -ne 1 ]]; then
    echo "required successful job missing: $NAME" >&2
    exit 1
  fi
done
echo "ELECTRON CI TIP MATRIX PASSED: $RUN_URL"
