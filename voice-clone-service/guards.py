"""Abuse and cost guards: per-IP rate limits, the global daily breaker + kill switch, cost telemetry, bounded work queue.
No audio and no text is ever stored or logged here."""
import json
import os
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone


class RateLimited(Exception):
    pass


class QueueFull(Exception):
    pass


class BreakerOpen(Exception):
    def __init__(self, reason: str, retry_after: int):
        super().__init__(reason)
        self.reason, self.retry_after = reason, retry_after


class SlidingWindow:
    """Per-key sliding-window counter (in-process: one machine, so exact enough for a token-protected service)."""

    def __init__(self, limit: int, window_sec: float = 60.0, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window_sec, clock
        self.hits = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = self.clock()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            if len(self.hits) > 5000:  # bound memory against key churn
                for k in [k for k, v in self.hits.items() if not v][:1000]:
                    del self.hits[k]
            return True

    def peek_count(self, key: str) -> int:
        now = self.clock()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            return len(q)


def utc_day(now: float | None = None) -> str:
    return datetime.fromtimestamp(now if now is not None else time.time(), timezone.utc).strftime("%Y-%m-%d")


def seconds_until_utc_midnight(now: float | None = None) -> int:
    t = now if now is not None else time.time()
    return int(86400 - (t % 86400)) + 1


class Telemetry:
    """Daily counters persisted as JSON on the data volume (survives scale-to-zero). Also holds per-voice character
    counts for the per-voice daily cap."""

    def __init__(self, directory: str, clock=time.time):
        self.dir = os.path.join(directory, "telemetry")
        os.makedirs(self.dir, exist_ok=True)
        self.clock, self.lock = clock, threading.Lock()

    def _path(self, day: str) -> str:
        return os.path.join(self.dir, f"{day}.json")

    def _load(self, day: str) -> dict:
        try:
            with open(self._path(day)) as f:
                return json.load(f)
        except (FileNotFoundError, ValueError):
            return {"day": day, "jobs": 0, "failed": 0, "gen_seconds": 0.0, "cpu_seconds": 0.0, "audio_seconds": 0.0,
                    "chars": 0, "voices_created": 0, "rejected": {}, "voice_chars": {}}

    def _save(self, d: dict) -> None:
        tmp = self._path(d["day"]) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(d, f)
        os.replace(tmp, self._path(d["day"]))

    def today(self) -> dict:
        with self.lock:
            return self._load(utc_day(self.clock()))

    def record(self, *, ok: bool, gen_s: float = 0.0, cpu_s: float = 0.0, audio_s: float = 0.0, chars: int = 0,
               voice_id: str | None = None, created: bool = False) -> None:
        with self.lock:
            d = self._load(utc_day(self.clock()))
            d["jobs"] += 1 if not created else 0
            d["voices_created"] += 1 if created else 0
            d["failed"] += 0 if ok else 1
            d["gen_seconds"] = round(d["gen_seconds"] + gen_s, 3)
            d["cpu_seconds"] = round(d["cpu_seconds"] + cpu_s, 3)
            d["audio_seconds"] = round(d["audio_seconds"] + audio_s, 3)
            d["chars"] += chars
            if voice_id and chars:
                d["voice_chars"][voice_id] = d["voice_chars"].get(voice_id, 0) + chars
            self._save(d)

    def add_compute(self, seconds: float) -> None:
        """Analysis/similarity calls: real CPU seconds that count toward the daily budget but are not synthesis jobs."""
        with self.lock:
            d = self._load(utc_day(self.clock()))
            d["gen_seconds"] = round(d["gen_seconds"] + seconds, 3)
            self._save(d)

    def reject(self, reason: str) -> None:
        with self.lock:
            d = self._load(utc_day(self.clock()))
            d["rejected"][reason] = d["rejected"].get(reason, 0) + 1
            self._save(d)

    def voice_chars_today(self, voice_id: str) -> int:
        return int(self.today().get("voice_chars", {}).get(voice_id, 0))

    def recent(self, days: int = 7) -> list:
        out = []
        for i in range(days):
            day = utc_day(self.clock() - i * 86400)
            if os.path.exists(self._path(day)):
                with self.lock:
                    d = self._load(day)
                d.pop("voice_chars", None)
                out.append(d)
        return out


class Breaker:
    """Global circuit breaker: operator kill switch (env flag or DATA_DIR/KILL file) and a daily generation-seconds budget."""

    def __init__(self, telemetry: Telemetry, daily_gen_seconds: float, data_dir: str, env_disabled: bool = False, clock=time.time):
        self.t, self.budget, self.kill_file = telemetry, daily_gen_seconds, os.path.join(data_dir, "KILL")
        self.env_disabled, self.clock = env_disabled, clock

    def check(self) -> None:
        if self.env_disabled or os.path.exists(self.kill_file):
            raise BreakerOpen("kill_switch", 300)
        if self.t.today()["gen_seconds"] >= self.budget:
            raise BreakerOpen("daily_budget", seconds_until_utc_midnight(self.clock()))

    def status(self) -> dict:
        used = self.t.today()["gen_seconds"]
        return {"kill_switch": self.env_disabled or os.path.exists(self.kill_file), "daily_budget_s": self.budget,
                "used_today_s": used, "open": self.env_disabled or os.path.exists(self.kill_file) or used >= self.budget}


class WorkQueue:
    """Bounded admission: at most `max_concurrent` running plus `max_queue` waiting; everything beyond is refused (429) so a
    burst cannot pile up unbounded CPU work or memory. `slot()` must wrap the whole unit of work."""

    def __init__(self, max_concurrent: int, max_queue: int):
        self.capacity = max_concurrent + max_queue
        self.infer = threading.Semaphore(max_concurrent)
        self.lock = threading.Lock()
        self.admitted = 0

    def admit(self) -> None:
        with self.lock:
            if self.admitted >= self.capacity:
                raise QueueFull()
            self.admitted += 1

    def leave(self) -> None:
        with self.lock:
            self.admitted -= 1

    def position(self) -> int:
        with self.lock:
            return self.admitted
