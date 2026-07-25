#!/bin/sh
# Container entrypoint: start cron in the background (for the nightly
# audio_cache prune at 03:00 UTC), then exec the TTS service in the
# foreground so it stays PID 1 and container lifecycle tracks it.
set -e
cron
exec python main.py
