#!/usr/bin/env sh
set -eu

output_path='deliverables/xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos-arm64.zip'
source_ref='HEAD'
archive_root='xiaohongshu-relay-scraper-ui-codex-built-in-macos-arm64'
architecture='arm64'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-path) shift; [ "$#" -gt 0 ] || { echo '--output-path requires a value' >&2; exit 2; }; output_path=$1 ;;
    --source-ref) shift; [ "$#" -gt 0 ] || { echo '--source-ref requires a value' >&2; exit 2; }; source_ref=$1 ;;
    --archive-root) shift; [ "$#" -gt 0 ] || { echo '--archive-root requires a value' >&2; exit 2; }; archive_root=$1 ;;
    --architecture) shift; [ "$#" -gt 0 ] || { echo '--architecture requires a value' >&2; exit 2; }; architecture=$1 ;;
    -h|--help)
      echo 'Usage: scripts/package-github-release-macos-codex.sh [--output-path PATH] [--source-ref REF] [--archive-root NAME]'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$architecture" in arm64|x64) ;; *) echo '--architecture must be arm64 or x64' >&2; exit 2 ;; esac

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$output_path" in
  /*) resolved_output_path=$output_path ;;
  *) resolved_output_path="$repository_root/$output_path" ;;
esac

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/xhs-codex-package.XXXXXX")
cleanup() { rm -rf "$temporary_root"; }
trap cleanup EXIT HUP INT TERM
base_archive="$temporary_root/base.zip"
sh "$repository_root/scripts/package-github-release-macos.sh" \
  --output-path "$base_archive" \
  --source-ref "$source_ref" \
  --archive-root "$archive_root" >/dev/null
mkdir -p "$temporary_root/stage"
unzip -q "$base_archive" -d "$temporary_root/stage"
node "$repository_root/scripts/codex-runtime-artifact.mjs" --mode stage --source-root "$repository_root" --stage-root "$temporary_root/stage/$archive_root" --platform darwin --architecture "$architecture" >/dev/null
rm -f "$resolved_output_path" "$resolved_output_path.sha256"
if command -v ditto >/dev/null 2>&1; then
  ditto -c -k --sequesterRsrc --keepParent "$temporary_root/stage/$archive_root" "$resolved_output_path"
else
  (cd "$temporary_root/stage" && zip -q -r "$resolved_output_path" "$archive_root")
fi

entry_names=$(unzip -Z1 "$resolved_output_path")
for required_file in \
  Start-Codex-App.command \
  CODEX_BUILT_IN_START.md \
  server/ai-session-store.mjs \
  server/codex-app-server-transport.mjs \
  server/codex-browser-service.mjs \
  server/codex-model-bridge-service.mjs \
  server/codex-runtime-resolver.mjs \
  scripts/codex-runtime-artifact.mjs \
  public/codex/index.html \
  public/codex/app.js \
  public/codex-browser-host.js \
  src/App.tsx \
  runtime/codex/codex-runtime-manifest.json \
  "runtime/codex/darwin-$architecture/bin/codex"
do
  count=$(printf '%s\n' "$entry_names" | grep -Fxc "$archive_root/$required_file" || true)
  [ "$count" -eq 1 ] || { echo "Codex release archive is missing required entry: $required_file" >&2; exit 1; }
done

hash=$(shasum -a 256 "$resolved_output_path" | awk '{print $1}')
printf '%s  %s\n' "$hash" "$(basename -- "$resolved_output_path")" > "$resolved_output_path.sha256"
node "$repository_root/scripts/codex-runtime-artifact.mjs" --mode verify --project-root "$temporary_root/stage/$archive_root" --platform darwin --architecture "$architecture" >/dev/null
printf '{"archive":"%s","checksum":"%s.sha256","sha256":"%s","sourceRef":"%s","edition":"codex-built-in","platform":"darwin","architecture":"%s","runtimeManifest":"runtime/codex/codex-runtime-manifest.json","launchEntry":"Start-Codex-App.command"}\n' \
  "$(basename -- "$resolved_output_path")" "$(basename -- "$resolved_output_path")" "$hash" "$source_ref" "$architecture"
