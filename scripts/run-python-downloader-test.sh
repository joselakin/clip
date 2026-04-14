#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -x .venv/bin/python ]]; then
  echo "Python venv belum siap. Jalankan: npm run py:test:setup"
  exit 1
fi

.venv/bin/python scripts/test-python-downloaders.py "$@"
