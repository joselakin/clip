#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

"$ROOT_DIR/.venv/bin/python" -m pip install --upgrade pip
"$ROOT_DIR/.venv/bin/python" -m pip install yt-dlp pytube
"$ROOT_DIR/.venv/bin/python" -m pip install -r "$ROOT_DIR/face-detection/requirements.txt"

echo "Python test environment ready at $ROOT_DIR/.venv"