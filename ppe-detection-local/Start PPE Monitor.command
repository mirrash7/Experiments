#!/bin/zsh
# Double-click to launch the PPE compliance monitor.
cd "$(dirname "$0")"
exec .venv/bin/python ppe_monitor.py "$@"
