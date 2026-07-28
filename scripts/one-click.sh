#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

NO_BROWSER=0
CHECK_ONLY=0
PORT_OVERRIDE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-browser) NO_BROWSER=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --port)
      shift
      [ "$#" -gt 0 ] || { echo '--port requires a value' >&2; exit 2; }
      PORT_OVERRIDE=$1
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

load_env() {
  if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
  if [ -n "$PORT_OVERRIDE" ]; then PORT=$PORT_OVERRIDE; export PORT; fi
  PYTHON_BIN=${PYTHON_BIN:-python3}
  export PYTHON_BIN
}

load_env
HOST=${HOST:-127.0.0.1}
PORT=${PORT:-4317}
case "$HOST" in 0.0.0.0|::) BROWSER_HOST=127.0.0.1 ;; *) BROWSER_HOST=$HOST ;; esac
URL="http://$BROWSER_HOST:$PORT"

app_healthy() {
  "$PYTHON_BIN" - "$URL/api/health" <<'PY' >/dev/null 2>&1
import json
import sys
from urllib.request import urlopen

with urlopen(sys.argv[1], timeout=2) as response:
    payload = json.load(response)
if payload.get("ok") is not True or payload.get("service") != "xiaohongshu-relay-scraper":
    raise SystemExit(1)
PY
}

connect_relay() {
  "$PYTHON_BIN" - "$URL" <<'PY'
import json
import sys
from urllib.request import Request, urlopen

origin = sys.argv[1]
with urlopen(f"{origin}/api/relay/config", timeout=10) as response:
    config = json.load(response)
if config.get("autoConnect") is False:
    print("Relay auto-connect is disabled by configuration")
    raise SystemExit(0)
payload = json.dumps({
    "port": config.get("port", 18792),
    "profile": config.get("profile", "chrome"),
}).encode()
request = Request(
    f"{origin}/api/relay/connect",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urlopen(request, timeout=35) as response:
    status = json.load(response)
tabs = status.get("tabs", 0)
ready = status.get("ready") is True or (status.get("running") and status.get("cdpReady") and tabs > 0)
print(f"Relay code startup: ready={ready} port={status.get('port')} tabs={tabs}")
raise SystemExit(0 if ready else 1)
PY
}

open_app() {
  [ "$NO_BROWSER" -eq 1 ] && return 0
  if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
  else printf '%s\n' "Open $URL in a browser."
  fi
}

if command -v "$PYTHON_BIN" >/dev/null 2>&1 && app_healthy; then
  printf '%s\n' "Application is already running at $URL"
  if [ "$CHECK_ONLY" -eq 0 ]; then connect_relay || true; open_app; fi
  exit 0
fi

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf 0); fi
PYTHON_CODE=0
PYTHON_VERSION=0.0
if command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_CODE=$("$PYTHON_BIN" -c 'import sys; print(sys.version_info.major * 100 + sys.version_info.minor)' 2>/dev/null || printf 0)
  PYTHON_VERSION=$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || printf 0.0)
fi
PREREQUISITES_READY=0
if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null && [ "$PYTHON_CODE" -ge 311 ] 2>/dev/null && command -v npm >/dev/null 2>&1 && command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PREREQUISITES_READY=1
fi

PYTHON_DEPS=0
if command -v "$PYTHON_BIN" >/dev/null 2>&1 && "$PYTHON_BIN" -c 'import docx, openpyxl, playwright, pypdf' >/dev/null 2>&1; then
  PYTHON_DEPS=1
fi
BOOTSTRAP_REQUIRED=1
if [ -d node_modules ] && [ -f dist/index.html ] && [ "$PYTHON_DEPS" -eq 1 ]; then BOOTSTRAP_REQUIRED=0; fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf '{"ready":%s,"bootstrapRequired":%s,"nodeMajor":%s,"pythonVersion":"%s","python":"%s","url":"%s"}\n' \
    "$([ "$PREREQUISITES_READY" -eq 1 ] && printf true || printf false)" \
    "$([ "$BOOTSTRAP_REQUIRED" -eq 1 ] && printf true || printf false)" \
    "$NODE_MAJOR" "$PYTHON_VERSION" "$PYTHON_BIN" "$URL"
  [ "$PREREQUISITES_READY" -eq 1 ] || exit 2
  exit 0
fi

[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || { echo 'Node.js 22 or newer is required.' >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; exit 2; }
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo 'Python 3.11 or newer is required.' >&2; exit 2; }
[ "$PYTHON_CODE" -ge 311 ] 2>/dev/null || { echo 'Python 3.11 or newer is required.' >&2; exit 2; }

if [ "$BOOTSTRAP_REQUIRED" -eq 1 ]; then
  printf '%s\n' 'First run detected. Installing dependencies and building the application...'
  sh scripts/bootstrap.sh --skip-tests
fi

[ -f .env ] || cp .env.example .env
load_env
HOST=${HOST:-127.0.0.1}
PORT=${PORT:-4317}
case "$HOST" in 0.0.0.0|::) BROWSER_HOST=127.0.0.1 ;; *) BROWSER_HOST=$HOST ;; esac
URL="http://$BROWSER_HOST:$PORT"

if app_healthy; then
  printf '%s\n' "Application is already running at $URL"
  open_app
  exit 0
fi

if "$PYTHON_BIN" - "$BROWSER_HOST" "$PORT" <<'PY' >/dev/null 2>&1
import socket
import sys

with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=1):
    pass
PY
then
  echo "Port $PORT is occupied by another service. Change PORT in .env and try again." >&2
  exit 2
fi

printf '%s\n' "Starting application at $URL"
npm start &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

READY=0
ATTEMPT=0
while [ "$ATTEMPT" -lt 120 ]; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    wait "$SERVER_PID" || true
    echo 'Application process exited before becoming healthy.' >&2
    exit 1
  fi
  if app_healthy; then READY=1; break; fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.5
done
[ "$READY" -eq 1 ] || { echo "Application did not become healthy within 60 seconds: $URL" >&2; exit 1; }

printf '%s\n' "Application is ready: $URL"
connect_relay || true
open_app
set +e
wait "$SERVER_PID"
EXIT_CODE=$?
set -e
exit "$EXIT_CODE"
