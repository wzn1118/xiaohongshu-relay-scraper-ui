#!/bin/bash
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export XHS_CODEX_BUILT_IN_EDITION=1
exec "$ROOT/Start-App.command" "$@"
