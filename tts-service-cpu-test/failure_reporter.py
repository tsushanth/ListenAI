"""
Sends worker failures to the central app-failure-reporter, which dedupes and emails them.

Off unless FAILURE_REPORTER_KEY is set (a Fly secret). Fire-and-forget on a daemon thread: reporting never delays or
fails a request. Pass stable class names and counts only. Never pass the text being synthesized or anything from it.
"""

import json
import logging
import os
import threading
import time
import urllib.request

DEFAULT_URL = "https://app-failure-reporter.t-sushanth.workers.dev/v1/report"
MAX_PER_MINUTE = 10

logger = logging.getLogger("tts-cpu-service")
_lock = threading.Lock()
_window = [0.0, 0]  # window start, reports asked for in it


def enabled() -> bool:
    return bool(os.getenv("FAILURE_REPORTER_KEY")) and os.getenv("FAILURE_REPORTER_DISABLED") != "1"


def build_payload(flow: str, code: str, context: dict) -> dict:
    return {
        "kind": "failure",
        "platform": "backend",
        "version": os.getenv("FLY_IMAGE_REF", "unknown"),
        "flow": flow,
        "message": code,
        "stack": "",
        "context": {str(k): str(v)[:80] for k, v in context.items()},
    }


def _post(payload: dict) -> None:
    try:
        request = urllib.request.Request(
            os.getenv("FAILURE_REPORTER_URL", DEFAULT_URL),
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Report-Key": os.getenv("FAILURE_REPORTER_KEY", ""),
                "User-Agent": "tts-worker-failure-reporter",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5):
            pass
    except Exception as e:  # reporting must never cause a failure of its own
        logger.warning(f"failure report not sent ({type(e).__name__})")


def _allow(now: float) -> bool:
    with _lock:
        if now - _window[0] > 60:
            _window[0], _window[1] = now, 0
        _window[1] += 1
        return _window[1] <= MAX_PER_MINUTE


def report(flow: str, code: str, context: dict, send=_post):
    """Returns the sending thread, or None when reporting is off or rate limited."""
    if not enabled() or not _allow(time.time()):
        return None
    thread = threading.Thread(target=send, args=(build_payload(flow, code, context),), daemon=True)
    thread.start()
    return thread
