#!/bin/sh
# The shared Astro dev server for everyone working in this worktree (concurrent `astro build`s
# overwrite each other's dist/ and caches, so look at pages through this server instead).
#
#   tools/dev-server.sh          # make sure it is running on http://127.0.0.1:4321, start it if not
#   tools/dev-server.sh log      # show the end of its log
#
# Pages hot-reload on save. Screenshots: node tools/screenshot.mjs --url http://127.0.0.1:4321 /learn/ticks/
PORT=${PORT:-4321}
LOG=/tmp/sccharts-astro-dev-$PORT.log
SITE=$(cd "$(dirname "$0")/.." && pwd)
if [ "$1" = log ]; then tail -n 60 "$LOG"; exit 0; fi
up() { curl -s -o /dev/null -m 5 "http://127.0.0.1:$PORT/" ; }
if up; then echo "dev server running: http://127.0.0.1:$PORT/"; exit 0; fi
exec 9>"/tmp/sccharts-astro-dev-$PORT.lock"
if flock -n 9; then
  cd "$SITE" && setsid nohup node node_modules/astro/bin/astro.mjs dev --port "$PORT" --host 127.0.0.1 > "$LOG" 2>&1 < /dev/null &
fi
i=0; while [ $i -lt 90 ]; do up && { echo "dev server running: http://127.0.0.1:$PORT/"; exit 0; }; sleep 1; i=$((i+1)); done
echo "dev server did not come up; see $LOG"; tail -n 30 "$LOG"; exit 1
