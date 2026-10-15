#!/usr/bin/env bash
# Starts the whole-NAS content indexer (nas_indexer.py) if it is not running.
# Crontab on TRIJYA-3: @reboot + every 5 minutes. Low priority (nice 10): it
# yields the CPU to the connector, Ollama and everything else on the box.
cd "$HOME/nas-connector" || exit 1
if pgrep -f "python nas_indexer.py" > /dev/null; then exit 0; fi
# Tesseract (for OCR of scanned PDFs) lives in ~/ocr, installed without sudo.
export PATH="$HOME/ocr/bin:$PATH"
setsid nice -n 10 .venv/bin/python nas_indexer.py >> "$HOME/nas-indexer/indexer.log" 2>&1 < /dev/null &
