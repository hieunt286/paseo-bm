#!/bin/bash
# Starts an ISOLATED Paseo daemon for a manual test: its own home, its own port,
# its own paseo-bm data folder. Your real daemon (~/.paseo, port 6767) is not
# touched and keeps running.
#
#   scripts/manual-test/start-daemon.sh <work-dir> [port]   (port defaults to 6899)
#
# Writes <work-dir>/env.sh; `source` it in every shell you test from.
set -euo pipefail
work=${1:?usage: start-daemon.sh <work-dir> [port]}
port=${2:-6899}
if [ "$port" = "6767" ]; then echo "refusing port 6767: that is your real daemon" >&2; exit 2; fi
mkdir -p "$work"
work=$(cd "$work" && pwd)
home="$work/paseo-home"
mkdir -p "$home" "$work/bm-home"
if [ ! -f "$home/config.json" ]; then
  printf '{\n  "version": 1,\n  "daemon": { "listen": "127.0.0.1:%s", "relay": { "enabled": false } },\n  "pluginsEnabled": true\n}\n' "$port" > "$home/config.json"
fi
cat > "$work/env.sh" <<ENV
# source this file: every paseo command and test script then talks to the isolated daemon
export PASEO_HOME="$home"
export PASEO_BM_HOME="$work/bm-home"
export BM_TEST_WS="ws://127.0.0.1:$port/ws"
export BM_TEST_WORK="$work"
ENV
# PASEO_HOME reaches the daemon, so the `paseo` CLI the plugin runs inside it
# targets this daemon too; PASEO_BM_HOME keeps your ~/.paseo-bm out of the test.
env PASEO_HOME="$home" PASEO_BM_HOME="$work/bm-home" paseo start --home "$home" --timeout 120 --json
echo "started. now run: source \"$work/env.sh\""
