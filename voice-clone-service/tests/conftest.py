import io
import os
import sys
import threading
import time

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient  # noqa: E402

from app import create_app  # noqa: E402
from settings import Settings  # noqa: E402

SECRET = "test-secret-not-real"
AUTH = {"Authorization": f"Bearer {SECRET}"}
VID = "11111111-2222-3333-4444-555555555555"
VID2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class FakeEngine:
    """Same interface as ChatterboxEngine, no torch. synth_delay lets tests hold the inference slot."""
    sample_rate = 24000
    model_id = "fake-cpu"
    load_s = 0.0

    def __init__(self, synth_delay=0.0, fail_prepare=False):
        self.synth_delay, self.fail_prepare = synth_delay, fail_prepare
        self.calls, self.forgotten = [], []
        self.gate = None  # optional threading.Event the synth waits on

    def analyze(self, y):
        return {"duration_sec": len(y) / 16000, "speech_sec": 5.0, "snr_db": 30.0, "clipping_ratio": 0.0, "min_window_similarity": 0.9, "music_prob": 0.0}

    def similarity(self, a, b):
        return 0.8

    def prepare_voice(self, vdir):
        if self.fail_prepare:
            raise AssertionError("Audio prompt must be longer than 5 seconds!")
        open(os.path.join(vdir, "conds-fake.pt"), "w").write("c")
        return 0.01

    def forget_voice(self, vdir):
        self.forgotten.append(vdir)

    def synthesize(self, vdir, text, speed, chunk_chars, deadline_s):
        self.calls.append(text)
        if self.gate is not None:
            self.gate.wait(10)
        if self.synth_delay:
            time.sleep(self.synth_delay)
        buf = io.BytesIO()
        sf.write(buf, np.zeros(24000, dtype="float32"), 24000, format="WAV", subtype="PCM_16")
        return {"wav": buf.getvalue(), "sample_rate": 24000, "watermark_score": 0.9, "audio_s": 1.0, "gen_s": 0.5 + self.synth_delay, "cpu_s": 0.4}


def wav_bytes(seconds=10.0, sr=16000, freq=220.0):
    t = np.arange(int(seconds * sr)) / sr
    y = (0.3 * np.sin(2 * np.pi * freq * t)).astype("float32")
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@pytest.fixture
def make(tmp_path):
    def _make(engine=None, **kw):
        s = Settings(secret=SECRET, data_dir=str(tmp_path), **kw)
        eng = engine or FakeEngine()
        app = create_app(eng, s)
        return TestClient(app), eng, s, app
    return _make


def create_voice(client, vid=VID, seconds=10.0, language="en", **extra):
    return client.post("/voices", headers=AUTH, data={"voice_id": vid, "language": language, **extra},
                       files={"reference": ("ref.wav", wav_bytes(seconds), "audio/wav")})
