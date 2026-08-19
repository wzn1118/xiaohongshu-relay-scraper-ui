#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: scripts/package-github-release-macos.sh [options]

Create the clean macOS source archive used by the GitHub Release workflow.

Options:
  --output-path PATH   Archive destination. Defaults to deliverables/xiaohongshu-relay-scraper-ui-one-click-macos.zip.
  --source-ref REF     Git ref to archive. Defaults to HEAD.
  --archive-root NAME  Top-level directory inside the ZIP. Defaults to xiaohongshu-relay-scraper-ui.
  -h, --help           Show this help text.
EOF
}

output_path='deliverables/xiaohongshu-relay-scraper-ui-one-click-macos.zip'
source_ref='HEAD'
archive_root='xiaohongshu-relay-scraper-ui'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-path)
      shift
      [ "$#" -gt 0 ] || { echo '--output-path requires a value' >&2; exit 2; }
      output_path=$1
      ;;
    --source-ref)
      shift
      [ "$#" -gt 0 ] || { echo '--source-ref requires a value' >&2; exit 2; }
      source_ref=$1
      ;;
    --archive-root)
      shift
      [ "$#" -gt 0 ] || { echo '--archive-root requires a value' >&2; exit 2; }
      archive_root=$1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$archive_root" ] || { echo '--archive-root must not be empty' >&2; exit 2; }
case "$archive_root" in
  */*|.|..)
    echo '--archive-root must be a single directory name' >&2
    exit 2
    ;;
esac

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$output_path" in
  /*) resolved_output_path=$output_path ;;
  *) resolved_output_path="$repository_root/$output_path" ;;
esac

git -C "$repository_root" rev-parse --verify "$source_ref^{commit}" >/dev/null
commit=$(git -C "$repository_root" rev-parse "$source_ref^{commit}")
mkdir -p "$(dirname -- "$resolved_output_path")"
rm -f "$resolved_output_path" "$resolved_output_path.sha256"

staging_root=$(mktemp -d "${TMPDIR:-/tmp}/xhs-macos-release.XXXXXX")
cleanup() {
  rm -rf "$staging_root"
}
trap cleanup EXIT HUP INT TERM

staged_project="$staging_root/$archive_root"
mkdir -p "$staged_project"
git -C "$repository_root" archive --format=tar "$source_ref" | tar -xf - -C "$staged_project"

assert_required_file() {
  if [ ! -f "$staged_project/$1" ]; then
    echo "Release archive is missing required entry: $1" >&2
    exit 1
  fi
}

for required_file in \
  README.md \
  ONE_CLICK_START.md \
  start-linux-macos.sh \
  scripts/one-click.sh \
  scripts/bootstrap.sh \
  scripts/package-github-release-macos.sh \
  scripts/verify-github-release-macos.sh \
  package.json \
  package-lock.json \
  requirements.txt \
  .env.example \
  server/index.mjs \
  src/main.tsx
do
  assert_required_file "$required_file"
done

# macOS uses ditto for its native ZIP behavior. The fallback keeps local Linux
# and WSL packaging available for release rehearsal.
if command -v ditto >/dev/null 2>&1; then
  ditto -c -k --sequesterRsrc --keepParent "$staged_project" "$resolved_output_path"
elif command -v zip >/dev/null 2>&1; then
  (
    cd "$staging_root"
    zip -q -r "$resolved_output_path" "$archive_root"
  )
else
  echo 'Packaging requires ditto on macOS or zip on another POSIX host.' >&2
  exit 2
fi

entry_names=$(unzip -Z1 "$resolved_output_path")
for required_file in \
  README.md \
  ONE_CLICK_START.md \
  start-linux-macos.sh \
  scripts/one-click.sh \
  scripts/bootstrap.sh \
  scripts/package-github-release-macos.sh \
  scripts/verify-github-release-macos.sh \
  package.json \
  package-lock.json \
  requirements.txt \
  .env.example \
  server/index.mjs \
  src/main.tsx
do
  case "$(printf '%s\n' "$entry_names" | grep -Fxc "$archive_root/$required_file" || true)" in
    1) ;;
    *)
      echo "Release archive is missing required entry: $required_file" >&2
      exit 1
      ;;
  esac
done

if printf '%s\n' "$entry_names" | grep -Eq "^$archive_root/(\.git|node_modules|dist|data|runtime|\.runtime|test-results|playwright-report)(/|$)"; then
  echo 'Release archive contains a forbidden runtime directory.' >&2
  exit 1
fi
if printf '%s\n' "$entry_names" | grep -Eq "^$archive_root/(.*/)?\.env($|\.)"; then
  if printf '%s\n' "$entry_names" | grep -Ev '\.example$' | grep -Eq "^$archive_root/(.*/)?\.env($|\.)"; then
    echo 'Release archive contains a private environment file.' >&2
    exit 1
  fi
fi
if printf '%s\n' "$entry_names" | grep -Eq '\.(sqlite|sqlite3|db|log|pem|pfx|key)$'; then
  echo 'Release archive contains a private or generated file.' >&2
  exit 1
fi

hash=$(shasum -a 256 "$resolved_output_path" | awk '{print $1}')
checksum_path="$resolved_output_path.sha256"
printf '%s  %s\n' "$hash" "$(basename -- "$resolved_output_path")" > "$checksum_path"

printf '{"archive":"%s","checksum":"%s","sha256":"%s","sourceRef":"%s","commit":"%s"}\n' \
  "$resolved_output_path" "$checksum_path" "$hash" "$source_ref" "$commit"
