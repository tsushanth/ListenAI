"""Environment-driven settings for the voice-clone serving app. Every limit has a safe default; nothing here is a secret
except VC_SERVICE_SECRET (set with `fly secrets set`, never committed)."""
import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v not in (None, "") else default


def _float(name: str, default: float) -> float:
    v = os.environ.get(name)
    return float(v) if v not in (None, "") else default


@dataclass
class Settings:
    secret: str = ""
    data_dir: str = "/data"
    model: str = "turbo"                    # "turbo" | "nano" (English only, MIT)
    langs: frozenset = frozenset({"en"})    # Turbo/Nano are English-only; Multilingual is a separate, off-by-default option
    max_concurrent: int = 1                 # CPU torch uses every core: more than 1 only adds contention
    max_queue: int = 4                      # requests allowed to wait behind the running one; beyond this -> 429
    daily_gen_seconds: float = 3600.0       # GLOBAL breaker: wall seconds of generation per UTC day (~USD 0.4/day on performance-8x)
    max_chars_per_voice_per_day: int = 20000
    max_text_chars: int = 5000
    chunk_chars: int = 300
    max_gen_seconds_per_request: float = 900.0
    min_reference_sec: float = 6.0          # Chatterbox asserts > 5 s; the backend reference gate (>= 8 s) is stricter
    max_reference_sec: float = 120.0
    voice_ttl_days: int = 365               # unused voices (reference audio + conditionals) are deleted after this
    ip_rpm: int = 120
    auth_fail_rpm: int = 10
    job_result_ttl_sec: int = 900
    job_wait_max_sec: float = 55.0
    disabled: bool = False                  # operator kill switch (env); the file DATA_DIR/KILL does the same without a redeploy
    extras: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls, env=os.environ) -> "Settings":
        langs = frozenset(x.strip() for x in env.get("VC_LANGS", "en").split(",") if x.strip())
        return cls(
            secret=env.get("VC_SERVICE_SECRET", ""),
            data_dir=env.get("VC_DATA_DIR", "/data"),
            model=env.get("VC_MODEL", "turbo"),
            langs=langs,
            max_concurrent=_int("VC_MAX_CONCURRENT", 1),
            max_queue=_int("VC_MAX_QUEUE", 4),
            daily_gen_seconds=_float("VC_DAILY_GEN_SECONDS", 3600.0),
            max_chars_per_voice_per_day=_int("VC_MAX_CHARS_PER_VOICE_PER_DAY", 20000),
            max_text_chars=_int("VC_MAX_TEXT_CHARS", 5000),
            chunk_chars=_int("VC_CHUNK_CHARS", 300),
            max_gen_seconds_per_request=_float("VC_MAX_GEN_SECONDS_PER_REQUEST", 900.0),
            voice_ttl_days=_int("VC_VOICE_TTL_DAYS", 365),
            ip_rpm=_int("VC_IP_RPM", 120),
            auth_fail_rpm=_int("VC_AUTH_FAIL_RPM", 10),
            disabled=env.get("VC_DISABLED", "").lower() == "true",
        )
