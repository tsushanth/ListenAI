"""Routing tests for the CPU (kokoro-onnx) service. fastapi/pydantic/soundfile are stubbed so this runs without the
service's dependencies: python3 -m pytest tts-service-cpu-test/test_voice_routing.py"""
import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_main():
    class _Any:
        def __init__(self, *a, **k): pass
        def __call__(self, *a, **k): return lambda f: f
        def __getattr__(self, n): return _Any()
    class _BaseModel:
        def __init__(self, **k): self.__dict__.update(k)
    stubs = {
        "fastapi": types.SimpleNamespace(FastAPI=_Any, HTTPException=Exception, BackgroundTasks=object),
        "fastapi.responses": types.SimpleNamespace(StreamingResponse=object),
        "pydantic": types.SimpleNamespace(BaseModel=_BaseModel, Field=lambda *a, **k: None),
        "soundfile": types.SimpleNamespace(),
    }
    saved = {k: sys.modules.get(k) for k in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location("cpu_main", os.path.join(HERE, "main.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k, v in saved.items():
            if v is None: sys.modules.pop(k, None)
            else: sys.modules[k] = v


m = _load_main()


def test_resolve_voice_accepts_native_non_english_ids():
    for v in ["em_alex", "ef_dora", "ff_siwis", "hm_omega", "if_sara", "pm_santa"]:
        assert m.resolve_voice(v) == v


def test_resolve_voice_unknown_still_falls_back_to_heart():
    assert m.resolve_voice("nonsense") == "af_heart"


def test_explicit_native_voice_routes_to_kokoro_not_edge_even_when_language_is_in_the_edge_map(kokoro_on):
    assert m.route_voice_for_language("em_alex", "es") == ("kokoro", "em_alex")
    assert m.route_voice_for_language("ff_siwis", "fr") == ("kokoro", "ff_siwis")
    assert m.route_voice_for_language("hm_omega", "hi") == ("kokoro", "hm_omega")


def test_explicit_native_voice_wins_over_a_wrong_language_hint(kokoro_on):
    assert m.route_voice_for_language("em_alex", "en-US") == ("kokoro", "em_alex")


def test_edge_tts_is_off_by_default_and_never_serves_paid_traffic():
    import pytest
    assert m.EDGE_TTS_ENABLED is False
    for lang in ["es", "fr", "hi", "de", "ja", "zh", "ko", "it", "pt"]:
        with pytest.raises(m.LanguageNotServed, match="Edge TTS"):
            m.route_voice_for_language("af_heart", lang)
    assert m.route_voice_for_language("af_heart", "en") == ("kokoro", "af_heart")


def test_edge_tts_only_with_the_explicit_unlicensed_dev_flag():
    m.EDGE_TTS_ENABLED = True
    try:
        assert m.route_voice_for_language("af_heart", "es")[0] == "edge"
        assert m.route_voice_for_language("am_adam", "fr") == ("edge", "male")
    finally:
        m.EDGE_TTS_ENABLED = False


def test_flag_default_comes_from_env_ALLOW_UNLICENSED_EDGE_TTS():
    assert m._env_flag("ALLOW_UNLICENSED_EDGE_TTS_UNSET_XYZ") is False
    os.environ["EDGE_TEST_FLAG"] = "1"
    try:
        assert m._env_flag("EDGE_TEST_FLAG") is True
    finally:
        del os.environ["EDGE_TEST_FLAG"]


import pytest


@pytest.fixture
def kokoro_on():
    m.KOKORO_NON_ENGLISH_ENABLED = True
    yield
    m.KOKORO_NON_ENGLISH_ENABLED = False


def test_kokoro_non_english_is_off_by_default_and_refuses_with_a_clear_error():
    assert m.KOKORO_NON_ENGLISH_ENABLED is False
    for v, lang in [("em_alex", "es"), ("ff_siwis", "fr"), ("hm_omega", "hi"), ("if_sara", "it"), ("pf_dora", "pt"), ("jf_alpha", "ja"), ("zm_yunxi", "zh"), ("em_alex", "en-US")]:
        with pytest.raises(m.LanguageNotServed, match="KOKORO_NON_ENGLISH_ENABLED"):
            m.route_voice_for_language(v, lang)


def test_kokoro_synthesis_path_is_gated_too_not_only_routing():
    with pytest.raises(m.LanguageNotServed, match="KOKORO_NON_ENGLISH_ENABLED"):
        m.synthesize_with_kokoro_onnx("hola", "em_alex", 1.0, language="es")


def test_english_kokoro_is_never_gated():
    assert m.route_voice_for_language("af_heart", "en") == ("kokoro", "af_heart")
    assert m.route_voice_for_language("bf_emma", "en-gb")[0] == "kokoro"


def test_onnx_lang_for_native_voice_prefix():
    assert m.onnx_lang_for_voice("em_alex") == "es"
    assert m.onnx_lang_for_voice("ff_siwis") == "fr-fr"
    assert m.onnx_lang_for_voice("hm_omega") == "hi"
    assert m.onnx_lang_for_voice("if_sara") == "it"
    assert m.onnx_lang_for_voice("pf_dora") == "pt-br"
    assert m.onnx_lang_for_voice("am_adam") is None  # English path unchanged
    assert m.onnx_lang_for_voice("bf_emma") is None


def test_latin_script_languages_are_not_chopped_into_25_char_chunks():
    text = "Esta es una frase bastante larga para traducir que no debe partirse en trozos diminutos."
    assert m.chunk_for_kokoro(text, "es") == [text]
    # dense scripts keep the conservative limit
    assert len(m.chunk_for_kokoro("यह एक काफी लंबा वाक्य है जो छोटे टुकड़ों में बांटा जाना चाहिए", "hi")) > 1
