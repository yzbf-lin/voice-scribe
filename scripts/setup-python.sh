#!/usr/bin/env bash
# Creates the Python runtime that powers VoiceScribe's transcription engine.
#
# Why this script exists:
#   1. `python3 -m venv` run over an EXISTING venv created by a different Python
#      version silently produces a broken hybrid environment (pip installs into one
#      site-packages, python imports from another). So we always start from scratch.
#   2. PyAV must come from a prebuilt wheel. Building it from source needs the FFmpeg
#      development libraries, which most machines do not have.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- pick an interpreter -------------------------------------------------------
# 3.13 is preferred: it is well supported by ctranslate2 / PyAV wheels and is the
# version this project was validated against. Override with PYTHON_BIN=/path/to/python.
PYTHON_BIN="${PYTHON_BIN:-}"

if [ -z "$PYTHON_BIN" ]; then
  for candidate in \
    python3.13 \
    /opt/homebrew/bin/python3.13 \
    /usr/local/bin/python3.13 \
    /usr/bin/python3.13 \
    "$HOME/.pyenv/shims/python3.13" \
    "$HOME/.local/bin/python3.13"; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 13) else 1)'; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "!! 未找到 Python 3.13，退回使用 python3（$(${PYTHON_BIN:-python3} --version 2>&1)）"
  echo "   建议安装：brew install python@3.13"
  PYTHON_BIN="python3"
fi

echo "==> Using $("$PYTHON_BIN" --version 2>&1) ($PYTHON_BIN)"

# --- rebuild the virtual environment ------------------------------------------
echo "==> Removing any existing virtual environment"
rm -rf python/.venv

"$PYTHON_BIN" -m venv python/.venv
python/.venv/bin/pip install --quiet --upgrade pip

# faster-whisper only declares `av>=11`, and VoiceScribe decodes media itself
# (python/worker.py), so the newest PyAV is both compatible and the most likely
# to have a prebuilt wheel for your Python version.
echo "==> Installing faster-whisper + PyAV (prebuilt wheels only)"
if ! python/.venv/bin/pip install --quiet --only-binary=:all: faster-whisper av; then
  echo ""
  echo "!! 拿不到预编译 wheel。两个解决办法："
  echo "   1. 换一个有 wheel 的 Python：brew install python@3.13 && \\"
  echo "        /opt/homebrew/bin/python3.13 -m venv python/.venv && \\"
  echo "        python/.venv/bin/pip install faster-whisper av"
  echo "   2. 或者装好 FFmpeg 让 PyAV 从源码编译："
  echo "        brew install ffmpeg pkg-config"
  echo "      然后重跑：npm run setup:python"
  exit 1
fi

echo "==> Verifying installation"
python/.venv/bin/python - <<'PY'
import sys

import av
import faster_whisper

print(f"    Python {sys.version.split()[0]} / faster-whisper {faster_whisper.__version__} / PyAV {av.__version__}")
PY

echo ""
echo "Done. Start the app with:  npm run dev"
