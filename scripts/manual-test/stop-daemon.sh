#!/bin/bash
# Stops the isolated daemon started by start-daemon.sh, and nothing else: it
# checks the daemon's home and port before killing it. Never `paseo daemon stop`
# here: without the right home that would stop your real daemon.
#
#   scripts/manual-test/stop-daemon.sh <work-dir>
set -euo pipefail
work=$(cd "${1:?usage: stop-daemon.sh <work-dir>}" && pwd)
home="$work/paseo-home"
status=$(PASEO_HOME="$home" paseo daemon status --home "$home" --json)
pid=$(printf '%s' "$status" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const d = JSON.parse(s);
  if (d.home !== process.argv[1] || d.listen === "127.0.0.1:6767") { console.error("not the test daemon"); process.exit(3); }
  process.stdout.write(d.pid ? String(d.pid) : "");
});' "$home")
if [ -z "$pid" ]; then echo "the test daemon is not running"; exit 0; fi
kill "$pid"
echo "stopped test daemon $pid"
