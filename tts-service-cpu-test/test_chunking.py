"""No text may be lost between the request and the audio. Run:
python3 -m pytest tts-service-cpu-test/test_chunking.py   (needs numpy; the web framework and the model are stubbed)

Set KOKORO_MODEL_DIR to a folder holding kokoro-v1.0.onnx and voices-v1.0.bin to also run the real-model test."""
import asyncio
import importlib.util
import logging
import os
import re
import sys
import types

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import failure_reporter  # noqa: E402


class _HTTPError(Exception):
    def __init__(self, status_code=500, detail=""):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


def _load_main():
    class _App:
        def __init__(self, *a, **k): pass
        def __getattr__(self, n): return lambda *a, **k: (lambda f: f)

    class _BaseModel:
        def __init__(self, **k): self.__dict__.update(k)

    stubs = {
        "fastapi": types.SimpleNamespace(FastAPI=_App, HTTPException=_HTTPError, BackgroundTasks=object),
        "fastapi.responses": types.SimpleNamespace(StreamingResponse=object),
        "pydantic": types.SimpleNamespace(BaseModel=_BaseModel, Field=lambda *a, **k: None),
        "soundfile": types.SimpleNamespace(write=lambda *a, **k: None),
    }
    saved = {k: sys.modules.get(k) for k in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location("cpu_main_chunking", os.path.join(HERE, "main.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.CACHE_ENABLED = False
        return mod
    finally:
        for k, v in saved.items():
            if v is None: sys.modules.pop(k, None)
            else: sys.modules[k] = v


m = _load_main()

# One comma piece far over the limit, FOLLOWED by more pieces: the shape that used to reach the model oversize.
EARLY_LONG_PIECE = ("the quick brown fox walks past the quiet river and then keeps on walking " * 9).strip() + \
    ", and that is the end of the long sentence. A short closing sentence follows it."


def letters(s):
    return re.sub(r"\s+", "", s)


class FakeModel:
    """Behaves like the real library at its limit: a run of 510+ phonemes raises IndexError."""

    def __init__(self, phonemes_per_char=1, fail_on=None):
        self.ratio, self.fail_on, self.spoken = phonemes_per_char, fail_on, []
        self.tokenizer = types.SimpleNamespace(phonemize=lambda text, lang: "a" * (len(text) * self.ratio) if re.search(r"\w", text) else "")

    def create(self, text, voice, speed, lang):
        if self.fail_on and self.fail_on in text:
            raise ValueError("model blew up on " + text)
        if len(text) * self.ratio >= 510:
            raise IndexError("index 510 is out of bounds for axis 0 with size 510")
        self.spoken.append(text)
        return np.ones(len(text), dtype=np.float32), 24000


@pytest.fixture
def fake(monkeypatch):
    def install(**k):
        model = FakeModel(**k)
        monkeypatch.setattr(m, "load_kokoro", lambda: model)
        return model
    return install


@pytest.mark.parametrize("language,limit", [("en", 400), ("es", 300), ("ja", 25)])
@pytest.mark.parametrize("text", [
    EARLY_LONG_PIECE,
    "x" * 1500,
    ("y" * 900) + ", tail, " + ("z" * 700) + ", end.",
    "short. " + "word " * 300 + ", then more, " + "q" * 450 + ". done.",
])
def test_every_chunk_fits_and_no_text_is_lost(language, limit, text):
    chunks = m.chunk_for_kokoro(text, language)
    assert max(len(c) for c in chunks) <= limit
    assert letters("".join(chunks)) == letters(text)


def test_long_early_piece_is_spoken_in_full(fake):
    model = fake()
    m.synthesize_with_kokoro_onnx(EARLY_LONG_PIECE, "af_heart", 1.0, "en")
    assert letters("".join(model.spoken)) == letters(EARLY_LONG_PIECE)


@pytest.mark.parametrize("text", ["1234567 " * 49, "9" * 390, "1234567 " * 200])
def test_text_that_expands_past_the_phoneme_limit_is_split_not_dropped(fake, text):
    model = fake(phonemes_per_char=4)
    m.synthesize_with_kokoro_onnx(text, "af_heart", 1.0, "en")
    assert letters("".join(model.spoken)) == letters(text)
    assert all(len(t) * 4 < m.MAX_PHONEMES for t in model.spoken)


def test_one_failing_part_fails_the_whole_request_and_leaks_no_text(fake, caplog):
    fake(fail_on="SECRETWORD")
    text = ("fine words here. " * 40) + "SECRETWORD again. " + ("more fine words. " * 40)
    with pytest.raises(m.ChunkSynthesisError) as err:
        m.synthesize_with_kokoro_onnx(text, "af_heart", 1.0, "en")
    assert "SECRETWORD" not in str(err.value)
    assert "SECRETWORD" not in caplog.text


def test_unpronounceable_part_is_not_an_error(fake):
    model = fake()
    audio, rate = m.synthesize_with_kokoro_onnx("hello there. " + "*** " * 200 + ". bye.", "af_heart", 1.0, "en")
    assert rate == 24000 and len(audio) > 0 and any("hello" in t for t in model.spoken)


def test_nothing_pronounceable_raises(fake):
    fake()
    with pytest.raises(RuntimeError):
        m.synthesize_with_kokoro_onnx("*** !!!", "af_heart", 1.0, "en")


@pytest.mark.parametrize("handler", ["synthesize", "synthesize_long"])
def test_endpoint_answers_500_and_reports_without_text(fake, monkeypatch, handler):
    fake(fail_on="SECRETWORD")
    sent = []
    monkeypatch.setattr(m.failure_reporter, "report", lambda flow, code, ctx: sent.append((flow, code, ctx)))
    request = types.SimpleNamespace(text="SECRETWORD here.", voice_id="af_heart", language="en", speed=1.0, model="kokoro")
    args = (request, None) if handler == "synthesize" else (request,)
    with pytest.raises(_HTTPError) as err:
        asyncio.run(getattr(m, handler)(*args))
    assert err.value.status_code == 500 and "SECRETWORD" not in err.value.detail
    assert sent and sent[0][0] == "tts_worker" and sent[0][1] == "TTS_WORKER_CHUNK_FAILED"
    assert "SECRETWORD" not in repr(sent)


@pytest.mark.parametrize("handler", ["synthesize", "synthesize_long"])
def test_an_error_message_that_quotes_the_text_never_reaches_the_log(fake, monkeypatch, caplog, handler):
    fake()
    monkeypatch.setattr(m.failure_reporter, "report", lambda *a: None)

    request = types.SimpleNamespace(text="SECRETWORD here.", voice_id="af_heart", language="en", speed=1.0, model="kokoro")

    def write_fails(*a, **k):
        raise ValueError("cannot encode: " + request.text)

    monkeypatch.setattr(m, "sf", types.SimpleNamespace(write=write_fails))
    args = (request, None) if handler == "synthesize" else (request,)
    with pytest.raises(_HTTPError):
        asyncio.run(getattr(m, handler)(*args))
    assert "ValueError" in caplog.text and "write_fails" in caplog.text  # still says what broke and where
    assert "SECRETWORD" not in caplog.text


def test_engine_logger_is_held_at_warning_even_when_debug_is_asked_for(monkeypatch):
    def kokoro(*a, **k):
        return object()

    engine_log = logging.getLogger("kokoro_onnx")

    class _Module(types.ModuleType):
        def __getattr__(self, name):  # the real library sets its logger from LOG_LEVEL when imported
            engine_log.setLevel(logging.DEBUG)
            if name == "Kokoro":
                return kokoro
            raise AttributeError(name)

    monkeypatch.setitem(sys.modules, "kokoro_onnx", _Module("kokoro_onnx"))
    monkeypatch.setattr(m, "kokoro_model", None)
    m.load_kokoro()
    assert engine_log.getEffectiveLevel() >= logging.WARNING  # at DEBUG it prints the phonemes of the text


def test_reporter_is_off_without_a_key(monkeypatch):
    monkeypatch.delenv("FAILURE_REPORTER_KEY", raising=False)
    assert failure_reporter.report("tts_worker", "X", {}, send=lambda p: pytest.fail("sent")) is None


def test_reporter_sends_a_stable_class_when_keyed(monkeypatch):
    monkeypatch.setenv("FAILURE_REPORTER_KEY", "test-key")
    monkeypatch.setattr(failure_reporter, "_window", [0.0, 0])
    got = []
    failure_reporter.report("tts_worker", "TTS_WORKER_CHUNK_FAILED", {"chars": 12}, send=got.append).join(2)
    assert got[0]["message"] == "TTS_WORKER_CHUNK_FAILED" and got[0]["context"] == {"chars": "12"} and got[0]["stack"] == ""


def test_reporter_is_rate_limited(monkeypatch):
    monkeypatch.setenv("FAILURE_REPORTER_KEY", "test-key")
    monkeypatch.setattr(failure_reporter, "_window", [0.0, 0])
    threads = [failure_reporter.report("f", "C", {}, send=lambda p: None) for _ in range(25)]
    assert sum(t is not None for t in threads) == failure_reporter.MAX_PER_MINUTE


def test_image_contains_every_local_module():
    docker = open(os.path.join(HERE, "Dockerfile")).read()
    copied = " ".join(line for line in docker.splitlines() if line.startswith("COPY "))
    source = open(os.path.join(HERE, "main.py")).read()
    local = {n for n in re.findall(r"^(?:import|from) (\w+)", source, re.M) if os.path.exists(os.path.join(HERE, n + ".py"))}
    assert local and all(f"{n}.py" in copied for n in local | {"main"})


@pytest.mark.skipif(not os.getenv("KOKORO_MODEL_DIR"), reason="real model not available")
def test_real_model_speaks_the_whole_text(monkeypatch):
    from kokoro_onnx import EspeakConfig, Kokoro
    d = os.environ["KOKORO_MODEL_DIR"]
    config = None
    if os.getenv("ESPEAK_DATA_DIR"):
        import espeakng_loader
        config = EspeakConfig(lib_path=espeakng_loader.get_library_path(), data_path=os.environ["ESPEAK_DATA_DIR"])
    model = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"), espeak_config=config)
    monkeypatch.setattr(m, "load_kokoro", lambda: model)
    for text in [EARLY_LONG_PIECE, "1234567 " * 49, "QWxhZGRpbjpvcGVuc2VzYW1l" * 30]:
        audio, rate = m.synthesize_with_kokoro_onnx(text, "af_heart", 1.0, "en")
        seconds = len(audio) / rate
        print(f"chars={len(text)} audio_s={seconds:.1f}")
        assert seconds >= len(text) / 25  # speech runs at roughly 12-18 characters a second
