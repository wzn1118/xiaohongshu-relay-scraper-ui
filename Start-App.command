#!/bin/bash
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT" || exit 1

# Finder launches .command files with a terminal attached. Keep failures visible
# there, while CI and scripted callers retain the original exit status.
if [ -t 0 ]; then
  /bin/sh "$ROOT/start-linux-macos.sh" "$@"
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '\nStartup failed with exit code %s. Press Return to close.\n' "$status" >&2
    IFS= read -r _
  fi
  exit "$status"
fi

exec /bin/sh "$ROOT/start-linux-macos.sh" "$@"
