#!/usr/bin/env bash
# Builds the StudyAI command-line tool if it is missing (run from the project root).
set -euo pipefail

if [ ! -f package.json ] || ! grep -q '"name": "studyai"' package.json; then
  echo "Run this from the StudyAI project root (the folder containing package.json)." >&2
  exit 2
fi

if [ ! -f dist-cli/lecture-cli.mjs ]; then
  [ -d node_modules ] || pnpm install --frozen-lockfile
  pnpm cli:build
fi

node dist-cli/lecture-cli.mjs help >/dev/null
echo "StudyAI CLI ready: dist-cli/lecture-cli.mjs"
