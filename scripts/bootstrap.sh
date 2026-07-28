#!/usr/bin/env sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

npm ci
"$PYTHON_BIN" -m pip install -r requirements.txt
npm run build
npm test
"$PYTHON_BIN" -m unittest discover -s tests -p 'test_*.py' -v
[ -f .env ] || cp .env.example .env

printf '%s\n' 'Bootstrap completed. Start with: sh scripts/start.sh'
