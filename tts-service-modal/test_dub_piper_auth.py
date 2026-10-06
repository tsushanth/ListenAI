"""Auth/validation helpers of the dedicated CPU Piper dubbing function. Run: python3 -m pytest tts-service-modal/test_dub_piper_auth.py"""
import pytest

import dub_piper_core as core


def test_bearer_ok_only_with_exact_secret():
    assert core.bearer_ok("Bearer s3cret-value", "s3cret-value")
    assert not core.bearer_ok("Bearer wrong", "s3cret-value")
    assert not core.bearer_ok("s3cret-value", "s3cret-value")       # no scheme
    assert not core.bearer_ok("bearer s3cret-value", "s3cret-value")  # scheme is case-sensitive like the other endpoints
    assert not core.bearer_ok("", "s3cret-value")
    assert not core.bearer_ok(None, "s3cret-value")


def test_fail_closed_when_secret_is_missing_or_empty():
    assert not core.bearer_ok("Bearer ", "")
    assert not core.bearer_ok("Bearer x", None)
    assert not core.bearer_ok("Bearer ", None)


def test_validate_accepts_the_readaloud_synthesize_contract():
    r = core.validate_request({"text": "Hola.", "voice_id": "es-pilot-m", "language": "es", "speed": 1.2, "model": "kokoro"})
    assert r == {"text": "Hola.", "voice_id": "es-pilot-m", "speed": 1.2}


def test_validate_defaults_and_limits():
    assert core.validate_request({"text": "Hola.", "voice_id": "es-pilot-f"})["speed"] == 1.0
    for bad in [
        {"voice_id": "es-pilot-f"}, {"text": "", "voice_id": "es-pilot-f"}, {"text": "  ", "voice_id": "es-pilot-f"},
        {"text": "x" * (core.MAX_TEXT_CHARS + 1), "voice_id": "es-pilot-f"},
        {"text": "hi", "voice_id": "af_heart"}, {"text": "hi", "voice_id": "../etc"}, {"text": "hi"},
        {"text": "hi", "voice_id": "es-pilot-f", "speed": 0}, {"text": "hi", "voice_id": "es-pilot-f", "speed": 5},
        {"text": "hi", "voice_id": "es-pilot-f", "speed": "fast"}, "nope", None,
    ]:
        with pytest.raises(core.BadRequest):
            core.validate_request(bad)


def test_wav_encoding_is_24k_mono_pcm16():
    import numpy as np
    wav = core.encode_wav(np.array([0.0, 0.5, -0.5, 2.0], dtype=np.float32), 24000)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    import struct
    ch, sr, bits = struct.unpack("<H I", wav[22:28])[0], struct.unpack("<I", wav[24:28])[0], struct.unpack("<H", wav[34:36])[0]
    assert (ch, sr, bits) == (1, 24000, 16)
    pcm = np.frombuffer(wav[44:], dtype="<i2")
    assert pcm.tolist() == [0, 16383, -16383, 32767]  # clipped
