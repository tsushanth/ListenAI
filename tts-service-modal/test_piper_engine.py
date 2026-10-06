"""Unit tests for piper_engine (no piper/onnx needed: a fake voice stands in). Run: python3 -m pytest tts-service-modal/test_piper_engine.py"""
import json
import numpy as np
import pytest

import piper_engine as pe


class FakeCfg:
    length_scale = 1.0
    sample_rate = 22050
    num_speakers = 2


class FakeVoice:
    """phonemize -> one 'phoneme list' per sentence; audio length = 0.1 s per phoneme * length_scale."""
    def __init__(self, num_speakers=2):
        self.config = FakeCfg(); self.config.num_speakers = num_speakers
        self.calls = []

    def phonemize(self, text):
        return [list(s.strip()) for s in text.replace("!", ".").replace("?", ".").split(".") if s.strip()]

    def phonemes_to_ids(self, ph):
        return [ord(c) for c in ph]

    def phoneme_ids_to_audio(self, ids, cfg):
        self.calls.append((len(ids), cfg.length_scale, cfg.speaker_id))
        n = int(len(ids) * 0.1 * cfg.length_scale * self.config.sample_rate)
        return np.full(n, 0.25, dtype=np.float32)


def make_registry(tmp_path, ids=("es-pilot-f",), speaker=1):
    for vid in ids:
        d = tmp_path / vid
        d.mkdir()
        (d / "model.onnx").write_bytes(b"x")
        (d / "owner.json").write_text(json.dumps({"public": True, "speaker_id": speaker}))
    voices = {}

    def loader(model_path, speaker_id):
        v = FakeVoice()
        voices[model_path] = (v, speaker_id)
        return pe.PiperEngine(v, speaker_id=speaker_id, synth_config_cls=lambda **k: type("C", (), k)())
    return pe.PiperRegistry(str(tmp_path), loader), voices


def test_allowlist_only_clean_tier_a_dubbing_voices():
    assert set(pe.DUB_PIPER_VOICES) == {"es-pilot-f", "es-pilot-m", "fr-fr-mls-f", "fr-fr-mls-m"}
    assert pe.is_dub_piper_voice("fr-fr-mls-m")
    for v in ["en-gb-vctk-p232", "en-us-lessac", "../x", "af_heart", "", "es-es-carlfm-xlow"]:
        assert not pe.is_dub_piper_voice(v)


def test_synth_returns_24k_float_audio_and_resamples_from_native(tmp_path):
    reg, _ = make_registry(tmp_path)
    audio = reg.synth("hola mundo.", "es-pilot-f", 1.0)
    assert audio.dtype == np.float32
    # 10 phonemes * 0.1 s = 1.0 s at 22.05k native -> 24k
    assert abs(len(audio) / 24000 - 1.0) < 0.01


def test_speed_divides_length_scale_like_the_prod_worker(tmp_path):
    reg, voices = make_registry(tmp_path)
    reg.synth("abcdefghij.", "es-pilot-f", 1.0)
    reg.synth("abcdefghij.", "es-pilot-f", 2.0)
    v, _ = next(iter(voices.values()))
    assert v.calls[0][1] == pytest.approx(1.0) and v.calls[1][1] == pytest.approx(0.5)


def test_speaker_id_is_pinned_from_owner_json(tmp_path):
    reg, voices = make_registry(tmp_path, speaker=1)
    reg.synth("hola.", "es-pilot-f", 1.0)
    v, spk = next(iter(voices.values()))
    assert spk == 1 and v.calls[0][2] == 1


def test_each_sentence_is_peak_normalised_and_concatenated(tmp_path):
    reg, _ = make_registry(tmp_path)
    audio = reg.synth("ab. cdef.", "es-pilot-f", 1.0)
    assert abs(float(np.max(np.abs(audio))) - 1.0) < 0.1
    assert abs(len(audio) / 24000 - 0.6) < 0.01


def test_non_allowlisted_voice_is_refused_even_if_present_on_disk(tmp_path):
    reg, _ = make_registry(tmp_path, ids=("es-pilot-f", "en-gb-vctk-p232"))
    with pytest.raises(pe.PiperVoiceError):
        reg.synth("hi.", "en-gb-vctk-p232", 1.0)


def test_missing_voice_dir_is_a_clear_error(tmp_path):
    reg, _ = make_registry(tmp_path, ids=("es-pilot-f",))
    with pytest.raises(pe.PiperVoiceError, match="not found"):
        reg.synth("hola.", "fr-fr-mls-f", 1.0)


def test_engines_are_cached_and_lru_bounded(tmp_path):
    reg, voices = make_registry(tmp_path, ids=("es-pilot-f", "es-pilot-m", "fr-fr-mls-f"))
    reg.max_loaded = 2
    reg.synth("a.", "es-pilot-f", 1.0); reg.synth("a.", "es-pilot-f", 1.0)
    assert len(voices) == 1
    reg.synth("a.", "es-pilot-m", 1.0); reg.synth("a.", "fr-fr-mls-f", 1.0)
    assert reg.loaded() == ["es-pilot-m", "fr-fr-mls-f"]


def test_empty_text_yields_empty_audio(tmp_path):
    reg, _ = make_registry(tmp_path)
    assert len(reg.synth("   ", "es-pilot-f", 1.0)) == 0


def test_speed_is_validated(tmp_path):
    reg, _ = make_registry(tmp_path)
    with pytest.raises(ValueError):
        reg.synth("hola.", "es-pilot-f", 0)
