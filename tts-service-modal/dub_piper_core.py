"""Pure helpers for the dedicated CPU Piper dubbing function (dub_piper.py): auth, request validation, WAV encoding."""
import hmac
import io
import struct
from typing import Optional

import numpy as np

import piper_engine

MAX_TEXT_CHARS = 5000
MIN_SPEED, MAX_SPEED = 0.5, 2.0  # same bounds as the readaloud-tts /synthesize contract


class BadRequest(Exception):
    pass


def bearer_ok(authorization: Optional[str], secret: Optional[str]) -> bool:
    """Constant-time `Authorization: Bearer <secret>` check; fails closed when no secret is configured."""
    if not secret or not authorization or not authorization.startswith("Bearer "):
        return False
    token = authorization[len("Bearer "):]
    return bool(token) and hmac.compare_digest(token.encode(), secret.encode())


def validate_request(body) -> dict:
    """Accepts the readaloud-tts /synthesize body ({text, voice_id, language?, speed?, model?}); returns the used fields."""
    if not isinstance(body, dict):
        raise BadRequest("body must be a JSON object")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise BadRequest("text must be a non-empty string")
    if len(text) > MAX_TEXT_CHARS:
        raise BadRequest(f"text too long (max {MAX_TEXT_CHARS} chars)")
    voice_id = body.get("voice_id")
    if not isinstance(voice_id, str) or not piper_engine.is_dub_piper_voice(voice_id):
        raise BadRequest(f"voice_id must be one of: {', '.join(piper_engine.DUB_PIPER_VOICES)}")
    speed = body.get("speed", 1.0)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not (MIN_SPEED <= float(speed) <= MAX_SPEED):
        raise BadRequest(f"speed must be a number in [{MIN_SPEED}, {MAX_SPEED}]")
    return {"text": text, "voice_id": voice_id, "speed": float(speed)}


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    data = pcm.tobytes()
    out = io.BytesIO()
    out.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE")
    out.write(b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    out.write(b"data" + struct.pack("<I", len(data)) + data)
    return out.getvalue()
