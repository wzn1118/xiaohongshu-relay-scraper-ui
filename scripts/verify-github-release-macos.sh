#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: scripts/verify-github-release-macos.sh --archive-path PATH [options]

Extract a macOS GitHub Release archive into a fresh directory, launch it through
the Finder-facing Start-App.command entry, then verify the live UI.

Options:
  --port PORT                Local verification port. Defaults to 65432.
  --browser-smoke            Open the running UI in Playwright Chromium.
  --screenshot-path PATH     Save the browser-smoke screenshot at PATH.
  --launch-entry FILE        Launcher inside the ZIP. Defaults to Start-App.command.
  --require-codex-built-in   Verify the bundled Codex provider and UI entry.
  --expected-architecture A  Required runtime architecture: arm64 or x64.
  --evidence-path PATH       Write redacted JSON acceptance evidence.
EOF
}

archive_path=''
port=65432
browser_smoke=0
screenshot_path=''
launch_entry='Start-App.command'
require_codex_built_in=0
expected_architecture=''
evidence_path=''

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
    --launch-entry)
      shift
      [ "$#" -gt 0 ] || { echo '--launch-entry requires a value' >&2; exit 2; }
      launch_entry=$1
      ;;
    --require-codex-built-in)
      require_codex_built_in=1
      ;;
    --expected-architecture)
      shift
      [ "$#" -gt 0 ] || { echo '--expected-architecture requires a value' >&2; exit 2; }
      expected_architecture=$1
      ;;
    --evidence-path)
      shift
      [ "$#" -gt 0 ] || { echo '--evidence-path requires a value' >&2; exit 2; }
      evidence_path=$1
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
[ -n "$launch_entry" ] || { echo '--launch-entry must not be empty' >&2; exit 2; }
case "$launch_entry" in */*|..|.) echo '--launch-entry must be a root-level file name' >&2; exit 2 ;; esac
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
launcher_log="$temporary_root/launcher.log"
launcher_pid=''
temporary_env_path=''

cleanup() {
  if [ -n "$launcher_pid" ] && kill -0 "$launcher_pid" >/dev/null 2>&1; then
    kill "$launcher_pid" >/dev/null 2>&1 || true
    wait "$launcher_pid" >/dev/null 2>&1 || true
  fi
  [ -z "$temporary_env_path" ] || rm -f "$temporary_env_path"
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
[ -x "$project_root/$launch_entry" ] || {
  echo "The extracted Finder launcher is missing or is not executable: $launch_entry" >&2
  exit 1
}
if [ "$require_codex_built_in" -eq 1 ]; then
  [ -f "$project_root/CODEX_BUILT_IN_START.md" ] || { echo 'The Codex edition marker is missing.' >&2; exit 1; }
  [ "$launch_entry" = 'Start-Codex-App.command' ] || { echo 'The Codex edition must use Start-Codex-App.command.' >&2; exit 1; }
  case "$expected_architecture" in arm64|x64) ;; *) echo 'Codex verification requires --expected-architecture arm64 or x64.' >&2; exit 2 ;; esac
  host_architecture=$(uname -m)
  case "$host_architecture" in arm64|aarch64) host_architecture=arm64 ;; x86_64|amd64) host_architecture=x64 ;; esac
  [ "$(uname -s)" = Darwin ] || { echo 'A built-in macOS Codex package must be verified on macOS.' >&2; exit 1; }
  [ "$host_architecture" = "$expected_architecture" ] || { echo "Runner architecture $host_architecture does not match package architecture $expected_architecture." >&2; exit 1; }
  runtime_evidence=$(node "$project_root/scripts/codex-runtime-artifact.mjs" --mode verify --project-root "$project_root" --platform darwin --architecture "$expected_architecture")
fi

temporary_env_path="$project_root/.env"
printf 'HOST=127.0.0.1\nPORT=%s\nXHS_MCP_ENABLED=false\nXHS_MCP_PORT=%s\n' "$port" "$((port + 1))" > "$temporary_env_path"

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

export HOST=127.0.0.1
export PORT="$port"
export PYTHON_BIN="$python_bin"
export XHS_MCP_ENABLED=false
export XHS_SERVER_DATA_DIR="$runtime_root/jobs"
export XHS_PROFILE_DATA_DIR="$runtime_root/profiles"
export XHS_BROWSER_DATA_DIR="$runtime_root/browser"
export XHS_COPILOT_WORKSPACE_ROOT="$project_root"
export CODEX_HOME="$runtime_root/codex-home"
export XHS_CODEX_SQLITE_HOME="$runtime_root/codex-sqlite"
export NPM_CONFIG_CACHE="$runtime_root/npm-cache"

(
  cd "$project_root"
  exec "./$launch_entry" --no-browser --port "$port"
) >"$launcher_log" 2>&1 &
launcher_pid=$!
health_url="http://127.0.0.1:$port/api/health"
healthy=false
attempt=0
while [ "$attempt" -lt 180 ]; do
  if ! kill -0 "$launcher_pid" >/dev/null 2>&1; then
    echo 'The extracted Start-App.command launcher exited before the application became healthy.' >&2
    [ -f "$launcher_log" ] && { echo '--- Finder launcher output ---' >&2; tail -n 120 "$launcher_log" >&2; }
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
  echo "Start-App.command did not produce a healthy application: $health_url" >&2
  [ -f "$launcher_log" ] && { echo '--- Finder launcher output ---' >&2; tail -n 120 "$launcher_log" >&2; }
  exit 1
fi

grep -Fq 'First run detected. Installing dependencies and building the application...' "$launcher_log" || {
  echo 'Start-App.command did not exercise the clean first-run bootstrap path.' >&2
  tail -n 120 "$launcher_log" >&2
  exit 1
}

launcher_ready=false
attempt=0
while [ "$attempt" -lt 60 ]; do
  if grep -Fq "Application is ready: http://127.0.0.1:$port" "$launcher_log"; then
    launcher_ready=true
    break
  fi
  if ! kill -0 "$launcher_pid" >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.5
done
if [ "$launcher_ready" != true ]; then
  echo 'Start-App.command did not report that the application was ready.' >&2
  tail -n 120 "$launcher_log" >&2
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
    node --input-type=module - "$health_url" "$screenshot_path" "$require_codex_built_in" <<'JS'
import { chromium } from '@playwright/test';

const healthUrl = new URL(process.argv[2]);
const origin = healthUrl.origin;
const screenshotPath = process.argv[3];
const requireCodexBuiltIn = process.argv[4] === '1';
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
  let codexProvider = null;
  if (requireCodexBuiltIn) {
    const providersResponse = await page.request.get(`${origin}/api/ai/providers`);
    if (!providersResponse.ok()) throw new Error(`AI providers returned HTTP ${providersResponse.status()}.`);
    const providers = await providersResponse.json();
    codexProvider = providers.find((item) => item?.id === 'codex');
    if (!codexProvider || codexProvider.label !== '内置 Codex Runtime' || codexProvider.wireApi !== 'responses' || codexProvider.bundled !== true) {
      throw new Error('The built-in Codex provider contract is missing or invalid.');
    }
    const codexLaunch = page.locator('button.codex-browser-launch');
    await codexLaunch.waitFor({ state: 'visible', timeout: 30_000 });
    let codexStatus = null;
    for (let attempt = 0; attempt < 180; attempt += 1) {
    const codexStatusResponse = await page.request.get(`${origin}/api/codex-browser/status`);
      if (!codexStatusResponse.ok()) throw new Error(`Codex status returned HTTP ${codexStatusResponse.status()}.`);
      codexStatus = await codexStatusResponse.json();
      if (codexStatus.ready === true && codexStatus.presentation === 'bundled' && codexStatus.backend?.initialized === true) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (codexStatus.ready !== true || codexStatus.presentation !== 'bundled' || codexStatus.backend?.initialized !== true) {
      throw new Error('The bundled Codex app-server or browser presentation is not ready.');
    }
    const threadListResponse = await page.request.post(`${origin}/api/codex-browser/request`, {
      data: { method: 'thread/list', params: { limit: 3, useStateDbOnly: true } },
    });
    if (!threadListResponse.ok()) throw new Error(`Codex thread/list smoke returned HTTP ${threadListResponse.status()}.`);
    const codexResponse = await page.goto(`${origin}/codex/`, { waitUntil: 'networkidle', timeout: 60_000 });
    if (!codexResponse?.ok()) throw new Error(`Codex page returned HTTP ${codexResponse?.status() || 'unknown'}.`);
    await page.locator('html[data-codex-ready="true"]').waitFor({ state: 'attached', timeout: 30_000 });
    const codexControls = await page.locator('button, textarea').count();
    if (codexControls < 3) throw new Error(`Codex page has too few interactive controls: ${codexControls}.`);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  process.stdout.write(JSON.stringify({
    ok: true,
    origin,
    title: await page.title(),
    textLength,
    interactiveCount,
    codexBuiltIn: requireCodexBuiltIn,
    codexProvider: codexProvider?.id || null,
    screenshot: screenshotPath.split('/').at(-1),
  }));
} finally {
  await browser.close();
}
JS
  )
  printf '%s\n' "$browser_smoke_result"
fi

runtime_evidence=${runtime_evidence:-null}
archive_name=${resolved_archive_path##*/}
screenshot_name=${screenshot_path##*/}
evidence_json=$(node --input-type=module - "$archive_name" "$launch_entry" "${expected_architecture:-unknown}" "$require_codex_built_in" "$runtime_evidence" "$browser_smoke_result" "$screenshot_name" <<'JS'
const [archive, launchEntry, architecture, codexFlag, runtimeJson, browserJson, screenshot] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  archive,
  platform: 'darwin',
  architecture,
  launchEntry,
  launcherExecutable: true,
  launcherFirstRun: true,
  healthPath: '/api/health',
  service: 'xiaohongshu-relay-scraper',
  ok: true,
  cleanBootstrap: true,
  codexBuiltIn: codexFlag === '1',
  runtime: JSON.parse(runtimeJson),
  codexStatusPath: codexFlag === '1' ? '/api/codex-browser/status' : null,
  codexPage: codexFlag === '1' ? '/codex/' : null,
  browserSmoke: JSON.parse(browserJson),
  screenshot: screenshot || null,
}));
JS
)
printf '%s\n' "$evidence_json"
if [ -n "$evidence_path" ]; then
  case "$evidence_path" in /*) ;; *) evidence_path="$(pwd)/$evidence_path" ;; esac
  mkdir -p "$(dirname -- "$evidence_path")"
  printf '%s\n' "$evidence_json" > "$evidence_path"
fi
