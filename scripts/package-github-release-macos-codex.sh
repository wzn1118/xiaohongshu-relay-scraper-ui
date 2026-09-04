#!/usr/bin/env sh
set -eu

output_path='deliverables/xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos.zip'
source_ref='HEAD'
archive_root='xiaohongshu-relay-scraper-ui-codex-built-in'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-path) shift; [ "$#" -gt 0 ] || { echo '--output-path requires a value' >&2; exit 2; }; output_path=$1 ;;
    --source-ref) shift; [ "$#" -gt 0 ] || { echo '--source-ref requires a value' >&2; exit 2; }; source_ref=$1 ;;
    --archive-root) shift; [ "$#" -gt 0 ] || { echo '--archive-root requires a value' >&2; exit 2; }; archive_root=$1 ;;
    -h|--help)
      echo 'Usage: scripts/package-github-release-macos-codex.sh [--output-path PATH] [--source-ref REF] [--archive-root NAME]'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$output_path" in
  /*) resolved_output_path=$output_path ;;
  *) resolved_output_path="$repository_root/$output_path" ;;
esac

sh "$repository_root/scripts/package-github-release-macos.sh" \
  --output-path "$resolved_output_path" \
  --source-ref "$source_ref" \
  --archive-root "$archive_root" >/dev/null

entry_names=$(unzip -Z1 "$resolved_output_path")
for required_file in \
  Start-Codex-App.command \
  CODEX_BUILT_IN_START.md \
  server/ai-session-store.mjs \
  server/codex-app-server-transport.mjs \
  server/codex-browser-service.mjs \
  server/codex-model-bridge-service.mjs \
  server/codex-runtime-resolver.mjs \
  public/codex/index.html \
  public/codex/app.js \
  public/codex-browser-host.js \
  src/App.tsx
do
  count=$(printf '%s\n' "$entry_names" | grep -Fxc "$archive_root/$required_file" || true)
  [ "$count" -eq 1 ] || { echo "Codex release archive is missing required entry: $required_file" >&2; exit 1; }
done

hash=$(shasum -a 256 "$resolved_output_path" | awk '{print $1}')
printf '{"archive":"%s","checksum":"%s.sha256","sha256":"%s","sourceRef":"%s","edition":"codex-built-in","launchEntry":"Start-Codex-App.command"}\n' \
  "$resolved_output_path" "$resolved_output_path" "$hash" "$source_ref"
