"""Pure-function tests for engine_omnivoice (no torch, no GPU): window pick, language id resolution and the detector fallback."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine_omnivoice import LanguageError, best_window, detect_language, resolve_language  # noqa: E402

SUPPORTED = {"en", "de", "fr", "es", "pt", "it", "ja", "pl", "ru", "ko", "arb", "zh"}


def test_best_window_keeps_short_audio():
    y = np.random.default_rng(0).standard_normal(16000 * 10).astype("float32") * 0.1
    assert best_window(y, 16000) is y


def test_best_window_picks_the_speech_stretch():
    sr = 16000
    rng = np.random.default_rng(1)
    quiet = (rng.standard_normal(sr * 20) * 0.001).astype("float32")
    loud = (rng.standard_normal(sr * 12) * 0.2).astype("float32")
    y = np.concatenate([quiet, loud, quiet])
    w = best_window(y, sr, 12.0)
    assert len(w) == 12 * sr
    assert float(np.abs(w).mean()) > 0.1  # the loud stretch, not the quiet padding


def test_resolve_language_known_unknown_and_arabic_alias():
    assert resolve_language("de", SUPPORTED) == "de"
    assert resolve_language("DE", SUPPORTED) == "de"
    assert resolve_language("ar", SUPPORTED) == "arb"  # Arabic is arb in the model's table
    with pytest.raises(LanguageError):
        resolve_language("xx", SUPPORTED)
    with pytest.raises(LanguageError):
        resolve_language("", SUPPORTED)
    with pytest.raises(LanguageError):
        resolve_language(None, SUPPORTED)


def test_detect_language_short_text_keeps_voice_language():
    assert detect_language("Hallo", "en", SUPPORTED) == "en"


def test_detect_language_switches_only_when_confident():
    pytest.importorskip("langdetect")
    assert detect_language("Das ist ein vollständiger deutscher Satz über das Wetter heute.", "en", SUPPORTED) == "de"
    assert detect_language("This is a complete English sentence about the weather today.", "en", SUPPORTED) == "en"
    # a language the model cannot speak is never switched to
    assert detect_language("Это полностью русское предложение о погоде сегодня.", "en", {"en", "de"}) == "en"
