#!/bin/zsh
# Double-click to launch the Site Safety Photobooth.
cd "$(dirname "$0")/photobooth"
exec ../.venv/bin/python photobooth.py "$@"
