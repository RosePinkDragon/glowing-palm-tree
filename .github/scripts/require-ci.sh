#!/usr/bin/env bash
set -euo pipefail

echo "$NEEDS" | jq -r 'to_entries[] | "\(.key): \(.value.result)"'
bad=$(echo "$NEEDS" | jq -r 'to_entries[] | select(.value.result != "success" and .value.result != "skipped") | .key')
if [[ -n "$bad" ]]; then echo "Not passing: $bad" >&2; exit 1; fi
result() { echo "$NEEDS" | jq -r --arg job "$1" '.[$job].result'; }
[[ "$(result changes)" == success ]] || { echo "Change detection did not succeed." >&2; exit 1; }
require() { [[ "$(result "$2")" == success ]] || { echo "$2 was needed ($1 changed) but its result is $(result "$2")." >&2; exit 1; }; }
require "every event" source-security
[[ "$APP" == true || "$SCRIPTS" == true ]] && require "app or scripts" quality
[[ "$APP" == true ]] && require app export
[[ "$BROWSER" == true ]] && require browser build && require browser suites
[[ "$DB" == true ]] && require db postgis-rls
[[ "$FUNCTIONS" == true ]] && require functions dispatcher
echo "All needed jobs passed."
