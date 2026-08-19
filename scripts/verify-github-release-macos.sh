#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: scripts/verify-github-release-macos.sh --archive-path PATH [options]

Extract a macOS GitHub Release archive into a fresh directory, perform its
first-run dependency installation and build, then verify its live health API.

Options:
  --port PORT                Local verification port. Defaults to 65432.
  --browser-smoke            Open the running UI in Playwright Chromium.
  --screenshot-path PATH     Save the browser-smoke screenshot at PATH.
EOF
}

archive_path=''
port=65432
browser_smoke=0
screenshot_path=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive-path)
      shift
      [ "$#" -gt 0 ] || { echo '--archive-path requires a value' >&2; exit 2; }
      archive_path=$1
      ;;
    --port)
      shift
      [ "$#" -gt 0 ] || { echo '--port requires a value' >&2; exit 2; }
      port=$1
      ;;
    --browser-smoke)
      browser_smoke=1
      ;;
    --screenshot-path)
      shift
      [ "$#" -gt 0 ] || { echo '--screenshot-path requires a value' >&2; exit 2; }
      screenshot_path=$1
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

[ -n "$archive_path" ] || { echo '--archive-path is required' >&2; usage >&2; exit 2; }
case "$port" in
  *[!0-9]*|'') echo '--port must be an integer' >&2; exit 2 ;;
esac

case "$archive_path" in
  /*) resolved_archive_path=$archive_path ;;
  *) resolved_archive_path="$(pwd)/$archive_path" ;;
esac
[ -f "$resolved_archive_path" ] || { echo "Archive was not found: $resolved_archive_path" >&2; exit 2; }

python_bin=${PYTHON_BIN:-python3}
command -v "$python_bin" >/dev/null 2>&1 || { echo 'Python 3.11 or newer is required.' >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo 'Node.js is required.' >&2; exit 2; }

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/xhs-macos-release-verify.XXXXXX")
extract_root="$temporary_root/extract"
runtime_root="$temporary_root/runtime"
stdout_log="$temporary_root/server.out.log"
stderr_log="$temporary_root/server.err.log"
server_pid=''

cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$extract_root" "$runtime_root"
unzip -q "$resolved_archive_path" -d "$extract_root"

project_root=''
for candidate in "$extract_root"/*; do
  if [ -d "$candidate" ] && [ -f "$candidate/package.json" ]; then
    project_root=$candidate
    break
  fi
done
[ -n "$project_root" ] || { echo 'The release archive does not contain a project root with package.json.' >&2; exit 1; }

check_output=$(cd "$project_root" && sh scripts/one-click.sh --check-only --no-browser --port "$port")
printf '%s\n' "$check_output"
printf '%s' "$check_output" | "$python_bin" -c '
import json
import sys

payload = json.load(sys.stdin)
if payload.get("ready") is not True:
    raise SystemExit("One-click prerequisite check did not report ready=true.")
if payload.get("bootstrapRequired") is not True:
    raise SystemExit("A clean source release must require first-run bootstrap.")
'

(
  cd "$project_root"
  npm ci --no-audit --no-fund
  "$python_bin" -m pip install --disable-pip-version-check -r requirements.txt
  npm run build
)

export HOST=127.0.0.1
export PORT="$port"
export PYTHON_BIN="$python_bin"
export XHS_MCP_ENABLED=false
export XHS_SERVER_DATA_DIR="$runtime_root/jobs"
export XHS_PROFILE_DATA_DIR="$runtime_root/profiles"
export XHS_BROWSER_DATA_DIR="$runtime_root/browser"
export XHS_COPILOT_WORKSPACE_ROOT="$project_root"

(
  cd "$project_root"
  exec node server/index.mjs
) >"$stdout_log" 2>"$stderr_log" &
server_pid=$!
health_url="http://127.0.0.1:$port/api/health"
healthy=false
attempt=0
while [ "$attempt" -lt 180 ]; do
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    echo 'Extracted release server exited before becoming healthy.' >&2
    [ -f "$stdout_log" ] && { echo '--- release smoke stdout ---' >&2; tail -n 80 "$stdout_log" >&2; }
    [ -f "$stderr_log" ] && { echo '--- release smoke stderr ---' >&2; tail -n 80 "$stderr_log" >&2; }
    exit 1
  fi
  if "$python_bin" - "$health_url" <<'PY' >/dev/null 2>&1
import json
import sys
from urllib.request import urlopen

with urlopen(sys.argv[1], timeout=2) as response:
    payload = json.load(response)
if payload.get('ok') is not True or payload.get('service') != 'xiaohongshu-relay-scraper':
    raise SystemExit(1)
PY
  then
    healthy=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.5
done

if [ "$healthy" != true ]; then
  echo "Extracted release did not become healthy: $health_url" >&2
  [ -f "$stdout_log" ] && { echo '--- release smoke stdout ---' >&2; tail -n 80 "$stdout_log" >&2; }
  [ -f "$stderr_log" ] && { echo '--- release smoke stderr ---' >&2; tail -n 80 "$stderr_log" >&2; }
  exit 1
fi

browser_smoke_result='null'
if [ "$browser_smoke" -eq 1 ]; then
  if [ -z "$screenshot_path" ]; then
    screenshot_path="$temporary_root/macos-open-smoke.png"
  else
    case "$screenshot_path" in
      /*) ;;
      *) screenshot_path="$(pwd)/$screenshot_path" ;;
    esac
  fi
  mkdir -p "$(dirname -- "$screenshot_path")"
  browser_smoke_result=$(
    cd "$project_root"
    node --input-type=module - "$health_url" "$screenshot_path" <<'JS'
import { chromium } from '@playwright/test';

const healthUrl = new URL(process.argv[2]);
const origin = healthUrl.origin;
const screenshotPath = process.argv[3];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error?.message || error)));
try {
  const response = await page.goto(origin, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!response?.ok()) throw new Error(`Application returned HTTP ${response?.status() || 'unknown'}.`);
  const root = page.locator('#root');
  await root.waitFor({ state: 'visible', timeout: 30_000 });
  const textLength = (await root.innerText()).trim().length;
  const interactiveCount = await root.locator('button, a, input, textarea, select').count();
  if (textLength < 50) throw new Error(`Application root rendered too little visible text: ${textLength}.`);
  if (interactiveCount < 1) throw new Error('Application root has no interactive controls.');
  if (pageErrors.length) throw new Error(`Application raised page errors: ${pageErrors.join(' | ')}`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  process.stdout.write(JSON.stringify({
    ok: true,
    origin,
    title: await page.title(),
    textLength,
    interactiveCount,
    screenshotPath,
  }));
} finally {
  await browser.close();
}
JS
  )
  printf '%s\n' "$browser_smoke_result"
fi

printf '{"archive":"%s","projectRoot":"%s","healthUrl":"%s","service":"xiaohongshu-relay-scraper","ok":true,"cleanBootstrap":true,"browserSmoke":%s}\n' \
  "$resolved_archive_path" "$project_root" "$health_url" "$browser_smoke_result"
