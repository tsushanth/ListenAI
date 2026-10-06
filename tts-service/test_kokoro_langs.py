"""Unit tests for kokoro_langs (pure logic, no torch/kokoro needed). Run: python3 -m pytest tts-service/test_kokoro_langs.py"""
import pytest

import kokoro_langs as kl


def test_voice_prefix_selects_lang_code():
    assert kl.lang_code_for("em_alex", "en") == "e"
    assert kl.lang_code_for("ff_siwis", None) == "f"
    assert kl.lang_code_for("hm_omega", "hi") == "h"
    assert kl.lang_code_for("am_adam", "en") == "a"
    assert kl.lang_code_for("bf_emma", "en-GB") == "b"


def test_voice_prefix_wins_over_a_wrong_language_hint():
    # The backend used to send language 'en-US' with every voice; the voice is the truth.
    assert kl.lang_code_for("em_alex", "en-US") == "e"


def test_language_used_when_voice_is_not_a_native_id():
    assert kl.lang_code_for("default", "es") == "e"
    assert kl.lang_code_for("rachel", "fr-FR") == "f"
    assert kl.lang_code_for("default", "pt-BR") == "p"
    assert kl.lang_code_for("default", "hi_IN") == "h"


def test_unknown_language_falls_back_to_american_english():
    assert kl.lang_code_for("default", "de") == "a"
    assert kl.lang_code_for("default", "") == "a"
    assert kl.lang_code_for("default", None) == "a"


def test_is_direct_kokoro_voice_accepts_all_languages_only_if_known():
    for v in ["af_heart", "am_adam", "bm_george", "em_alex", "ef_dora", "ff_siwis", "hf_alpha", "hm_psi", "if_sara", "pm_santa"]:
        assert kl.is_direct_kokoro_voice(v), v
    for v in ["xx_foo", "em_nobody", "default", "", "em_", "../etc"]:
        assert not kl.is_direct_kokoro_voice(v), v


def test_every_catalogued_voice_has_a_valid_lang_prefix():
    for v in kl.KOKORO_VOICES:
        assert v[0] in kl.LANG_CODES and v[1] in "fm" and v[2] == "_"


def test_pipeline_cache_builds_one_pipeline_per_lang_code():
    built = []
    cache = kl.PipelineCache(lambda lc: built.append(lc) or object())
    a1 = cache.get("a")
    a2 = cache.get("a")
    e = cache.get("e")
    assert a1 is a2 and a1 is not e
    assert built == ["a", "e"]
    assert cache.loaded() == ["a", "e"]


def test_is_english():
    assert kl.is_english("a") and kl.is_english("b") and not kl.is_english("e")


def test_non_english_preprocessing_does_not_apply_english_rules():
    # 'in' is a real Italian word: the English 'in' -> 'inn' rule must not run on it.
    assert kl.preprocess_non_english("Vivo in Italia") == "Vivo in Italia."
    assert kl.preprocess_non_english("Los gatos están aquí").startswith("Los gatos están aquí")
    assert "vs" in kl.preprocess_non_english("A vs B")


def test_non_english_preprocessing_keeps_native_sentence_final_punctuation():
    assert kl.preprocess_non_english("यह एक परीक्षण है।").endswith("।")
    assert kl.preprocess_non_english("¿Dónde estás?").endswith("?")
    assert kl.preprocess_non_english("Bonjour tout le monde").endswith(".")


def test_non_english_preprocessing_collapses_whitespace_and_newlines():
    assert kl.preprocess_non_english("Hola\n\n  mundo \n adiós") == "Hola. mundo adiós."


def test_default_voice_per_lang_code():
    assert kl.default_voice("e") == "em_alex"
    assert kl.default_voice("f") == "ff_siwis"
    assert kl.default_voice("a") == "af_heart"
    assert kl.default_voice("zz") == "af_heart"


def test_plan_explicit_native_voice_decides_everything():
    assert kl.plan("em_alex", "en-US", True, True) == ("em_alex", "e")
    assert kl.plan("ff_siwis", None, True, True) == ("ff_siwis", "f")
    assert kl.plan("bf_emma", "en", True) == ("bf_emma", "b")


def test_plan_generic_voice_with_non_english_language_gets_that_language_default_voice():
    # e.g. voice 'default' (-> af_heart) + language es: never read Spanish with an English voice
    assert kl.plan("af_heart", "es", False, True) == ("em_alex", "e")
    assert kl.plan("am_adam", "fr-FR", False, True) == ("ff_siwis", "f")
    assert kl.plan("af_heart", "hi", False, True) == ("hm_omega", "h")


def test_plan_english_aliases_keep_their_accent():
    assert kl.plan("bf_emma", "en", False) == ("bf_emma", "b")
    assert kl.plan("am_adam", "en-US", False) == ("am_adam", "a")
    assert kl.plan("am_adam", None, False) == ("am_adam", "a")


def test_plan_unknown_language_is_english_passthrough():
    assert kl.plan("af_heart", "de", False) == ("af_heart", "a")


def test_plan_explicit_flag_false_for_native_voice_still_matches_language():
    assert kl.plan("em_alex", "es", False, True) == ("em_alex", "e")


# ---- owner voice-provenance gate: Kokoro non-English synthesis is OFF unless KOKORO_NON_ENGLISH_ENABLED=1
def test_gate_is_off_by_default_and_flag_values():
    assert kl.non_english_enabled({}) is False
    assert kl.non_english_enabled({"KOKORO_NON_ENGLISH_ENABLED": "0"}) is False
    assert kl.non_english_enabled({"KOKORO_NON_ENGLISH_ENABLED": "1"}) is True
    assert kl.non_english_enabled({"KOKORO_NON_ENGLISH_ENABLED": " true "}) is True


@pytest.mark.parametrize("voice,lang,explicit", [
    ("em_alex", "es", True), ("ff_siwis", "fr", True), ("hm_omega", "hi", True), ("if_sara", "it", True),
    ("pf_dora", "pt-BR", True), ("af_heart", "es", False), ("am_adam", "fr", False), ("em_alex", "en-US", True),
])
def test_non_english_kokoro_is_refused_by_default_with_a_clear_error(voice, lang, explicit):
    with pytest.raises(kl.NonEnglishDisabled, match="KOKORO_NON_ENGLISH_ENABLED"):
        kl.plan(voice, lang, explicit, False)


def test_default_reads_the_environment(monkeypatch):
    monkeypatch.delenv("KOKORO_NON_ENGLISH_ENABLED", raising=False)
    with pytest.raises(kl.NonEnglishDisabled):
        kl.plan("em_alex", "es", True)
    monkeypatch.setenv("KOKORO_NON_ENGLISH_ENABLED", "1")
    assert kl.plan("em_alex", "es", True) == ("em_alex", "e")


def test_english_is_never_gated():
    assert kl.plan("af_heart", "en", False, False) == ("af_heart", "a")
    assert kl.plan("bf_emma", "en-GB", True, False) == ("bf_emma", "b")
    assert kl.plan("am_adam", "de", False, False) == ("am_adam", "a")  # unknown language stays the English passthrough
