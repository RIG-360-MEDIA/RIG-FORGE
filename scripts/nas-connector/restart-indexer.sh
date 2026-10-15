#!/usr/bin/env bash
# Stop the whole-NAS indexer, install nas_indexer.py.new if present, and start
# it again. Pass --rewalk to make it walk the shares immediately (needed after
# changing what is excluded: the walk is what drops excluded files' points).
cd "$HOME/nas-connector" || exit 1
for p in $(pgrep -f "python nas_indexer.py"); do kill "$p"; done
for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "python nas_indexer.py" > /dev/null || break; sleep 1; done
[ -f nas_indexer.py.new ] && mv nas_indexer.py.new nas_indexer.py
if [ "$1" = "--rewalk" ]; then
  .venv/bin/python -c "import sqlite3,os; c=sqlite3.connect(os.path.expanduser('~/nas-indexer/state.db')); c.execute(\"UPDATE meta SET v='0' WHERE k='last_walk'\"); c.commit()"
fi
./run-indexer.sh
sleep 2
pgrep -f "python nas_indexer.py" > /dev/null && echo "indexer running" || echo "indexer NOT running"
