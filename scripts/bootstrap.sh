#!/usr/bin/env sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SKIP_TESTS=0
if [ "${1:-}" = "--skip-tests" ]; then
  SKIP_TESTS=1
elif [ "$#" -gt 0 ]; then
  printf '%s\n' "Unknown argument: $1" >&2
  exit 2
fi

PYTHON_CODE=$($PYTHON_BIN -c 'import sys; print(sys.version_info.major * 100 + sys.version_info.minor)')
[ "$PYTHON_CODE" -ge 311 ] 2>/dev/null || { echo 'Python 3.11+ is required.' >&2; exit 2; }

npm ci
"$PYTHON_BIN" -m pip install -r requirements.txt
npm run build
if [ "$SKIP_TESTS" -eq 0 ]; then
  npm test
  "$PYTHON_BIN" -m unittest discover -s tests -p 'test_*.py' -v
fi
[ -f .env ] || cp .env.example .env

printf '%s\n' 'Bootstrap completed. Start with: ./start-linux-macos.sh'
