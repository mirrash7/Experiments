#!/usr/bin/env bash
# Start the InstantHMR WebSocket server (ws://127.0.0.1:8791). Extra args are passed through, e.g. ./run.sh --model nano --fit 0
cd "$(dirname "$0")"
exec ./.venv/bin/python hmr_server.py "$@"
