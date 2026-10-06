"""Piper TTS engine for the dubbing voices, used by tts-service-modal/app.py.

Mirrors realtime-tts's worker-piper-fly/server.py (PiperEngine.sentences/synth): phonemize per sentence, synthesize
each sentence with length_scale = voice.length_scale / speed and the owner.json-pinned speaker_id, peak-normalise each
sentence, resample the native 22.05 kHz to 24 kHz with scipy resample_poly. Speed is therefore Piper's length_scale
control (duration ~ 1/speed), the same knob the prod worker exposes as `speed`.

Only the allowlisted clean-provenance voices below can be served here (owner rule 2026-10-06: tier A only; no Kokoro
Spanish, nothing Lessac-derived). The ONNX models live on the Modal volume `house-voices` (<id>/model.onnx + owner.json).
Attribution (CC BY 4.0) for each voice is in its owner.json and voices/catalog.json of the realtime-tts repo.
"""
import json
import os
import re
from collections import OrderedDict
from fractions import Fraction
from typing import Callable, List, Optional

import numpy as np

# Tier-A, CC BY 4.0, scratch/clean-base lineage (realtime-tts voices/catalog.json). es-pilot is a PILOT model.
DUB_PIPER_VOICES = ("es-pilot-f", "es-pilot-m", "fr-fr-mls-f", "fr-fr-mls-m")
OUT_SR = 24000
_ID_RE = re.compile(r"^[a-z0-9-]+$")


class PiperVoiceError(Exception):
    pass


def is_dub_piper_voice(voice_id: str) -> bool:
    return bool(voice_id) and bool(_ID_RE.match(voice_id)) and voice_id in DUB_PIPER_VOICES


class PiperEngine:
    def __init__(self, voice, speaker_id: Optional[int] = None, synth_config_cls=None):
        self.voice = voice
        self.speaker_id = speaker_id
        if synth_config_cls is None:
            from piper import SynthesisConfig as synth_config_cls  # piper-tts 1.8.0
        self._cfg_cls = synth_config_cls
        self.native_sr = int(voice.config.sample_rate)
        if speaker_id is not None:
            n = int(getattr(voice.config, "num_speakers", 1) or 1)
            if not 0 <= speaker_id < n:
                raise PiperVoiceError(f"speaker_id {speaker_id} out of range for a {n}-speaker model")

    def sentences(self, text: str) -> List[List[int]]:
        return [self.voice.phonemes_to_ids(p) for p in self.voice.phonemize(text) if p]

    def synth_ids(self, ids: List[int], speed: float) -> np.ndarray:
        cfg = self._cfg_cls(length_scale=self.voice.config.length_scale / max(speed, 0.1), speaker_id=self.speaker_id)
        audio = np.asarray(self.voice.phoneme_ids_to_audio(ids, cfg), dtype=np.float32)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        return audio / peak if peak > 1e-8 else np.zeros_like(audio)


def _resample(audio: np.ndarray, native_sr: int) -> np.ndarray:
    ratio = Fraction(OUT_SR, native_sr).limit_denominator(1000)
    if ratio.numerator == ratio.denominator:
        return audio
    from scipy.signal import resample_poly
    return resample_poly(audio, ratio.numerator, ratio.denominator).astype(np.float32)


class PiperRegistry:
    def __init__(self, voices_dir: str, loader: Optional[Callable] = None, max_loaded: int = 4):
        self.voices_dir = voices_dir
        self._loader = loader or self._default_loader
        self.max_loaded = max_loaded
        self._engines: "OrderedDict[str, PiperEngine]" = OrderedDict()

    @staticmethod
    def _default_loader(model_path: str, speaker_id: Optional[int]) -> PiperEngine:
        import onnxruntime
        from piper import PiperVoice
        voice = PiperVoice.load(model_path)
        so = onnxruntime.SessionOptions()
        so.intra_op_num_threads = int(os.environ.get("ORT_INTRA_THREADS", "2"))
        so.inter_op_num_threads = 1
        voice.session = onnxruntime.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
        return PiperEngine(voice, speaker_id=speaker_id)

    def loaded(self) -> List[str]:
        return sorted(self._engines)

    def get(self, voice_id: str) -> PiperEngine:
        if not is_dub_piper_voice(voice_id):
            raise PiperVoiceError(f"voice {voice_id!r} is not an allowlisted dubbing voice")
        if voice_id in self._engines:
            self._engines.move_to_end(voice_id)
            return self._engines[voice_id]
        d = os.path.join(self.voices_dir, voice_id)
        model = os.path.join(d, "model.onnx")
        if not os.path.exists(model):
            raise PiperVoiceError(f"voice {voice_id!r} not found on this worker")
        speaker = None
        try:
            meta = json.load(open(os.path.join(d, "owner.json")))
            speaker = meta.get("speaker_id") if isinstance(meta, dict) else None
        except (OSError, ValueError):
            pass
        eng = self._loader(model, speaker)
        self._engines[voice_id] = eng
        while len(self._engines) > self.max_loaded:
            self._engines.popitem(last=False)
        return eng

    def synth(self, text: str, voice_id: str, speed: float = 1.0) -> np.ndarray:
        """float32 mono 24 kHz audio in [-1, 1] (empty for blank text)."""
        if not (speed > 0):
            raise ValueError("speed must be > 0")
        eng = self.get(voice_id)
        parts = [_resample(eng.synth_ids(ids, speed), eng.native_sr) for ids in eng.sentences(text)]
        return np.concatenate(parts).astype(np.float32) if parts else np.zeros(0, dtype=np.float32)
