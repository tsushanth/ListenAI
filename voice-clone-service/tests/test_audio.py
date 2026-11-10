import numpy as np
import pytest

from audio import AudioError, atempo_chain, basic_metrics, chunks, decode
from conftest import wav_bytes


def test_chunks_split_on_sentences_and_respect_limit():
    text = "One short sentence. " * 40
    out = chunks(text, 100)
    assert all(len(c) <= 100 for c in out) and len(out) > 5
    assert " ".join(out).replace("  ", " ").startswith("One short sentence.")


def test_chunks_hard_splits_runon_at_space():
    out = chunks("word " * 200, 100)
    assert all(len(c) <= 100 for c in out)
    assert all(not c.startswith(" ") for c in out)


def test_chunks_empty():
    assert chunks("   ") == []


def test_atempo_chain_limits():
    assert atempo_chain(1.5) == "atempo=1.5000"
    assert atempo_chain(3.0).count("atempo") == 2
    assert atempo_chain(0.4).count("atempo") == 2


def test_basic_metrics_detects_clipping_and_silence():
    sr = 16000
    y = np.zeros(sr * 3, dtype="float32")
    assert basic_metrics(y, sr)["speech_sec"] == 0.0
    loud = np.ones(sr, dtype="float32")
    assert basic_metrics(loud, sr)["clipping_ratio"] > 0.99


def test_basic_metrics_snr_on_tone_with_pauses():
    sr = 16000
    t = np.arange(sr * 4) / sr
    y = 0.3 * np.sin(2 * np.pi * 200 * t).astype("float32")
    y[sr:2 * sr] = 0.001 * np.random.RandomState(0).randn(sr)
    y[3 * sr:] = 0.001 * np.random.RandomState(1).randn(sr)
    m = basic_metrics(y, sr)
    assert m["snr_db"] > 25 and m["speech_sec"] > 1.5


def test_decode_roundtrip_and_rejects_garbage():
    y = decode(wav_bytes(2.0, 16000), 24000)
    assert abs(len(y) - 48000) < 200
    with pytest.raises(AudioError):
        decode(b"not audio at all" * 100, 16000)
