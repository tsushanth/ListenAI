"""GPU multilingual engine: OmniVoice (Apache-2.0) + the same Perth watermark, ECAPA speaker embedding and AST music classifier the
CPU engine uses. Same interface as ChatterboxEngine, so app.py (queue, breaker, retention, consent hooks, HTTP contract) is unchanged.

Per voice, at creation: pick one clean reference window (about 12 s), transcribe it (OmniVoice's bundled ASR), build the clone prompt
ONCE and cache it next to the reference (prompt-omnivoice.pt). Deleting the voice directory removes reference, transcript and prompt.

Language handling (measured by the exploration): untagged OmniVoice can speak the wrong language, and an id it does not know silently
falls back to language-agnostic mode. So every id is resolved against supported_language_ids() and an unknown one is an error, and the
voice's language is overridden by the text's own language only when the detector is confident (>= 0.90) on text of 20+ characters.
Quality tier = 32 steps; the realtime tier (16 steps) is honoured only for languages in rt_langs.
"""
import io
import os
import re
import subprocess
import tempfile
import threading
import time

import numpy as np

from audio import atempo_chain, chunks
from engine import AST_MODEL, ECAPA_DIR, ECAPA_REPO, ChatterboxEngine, speechbrain_hf_compat

OMNI_REPO = "k2-fsa/OmniVoice"
ASR_REPO = "openai/whisper-large-v3-turbo"
# Our ISO 639-1 code -> candidate OmniVoice ids, first one the model supports wins ("Arabic is arb, not ar" per the exploration).
LANG_CANDIDATES = {"ar": ["arb", "ar"], "zh": ["zh", "cmn"], "no": ["no", "nob"], "pt": ["pt"], "fil": ["fil", "tl"]}
DETECT_MIN_PROB = 0.90
DETECT_MIN_CHARS = 20
REF_WINDOW_SEC = 12.0


class LanguageError(ValueError):
    pass


def best_window(y: np.ndarray, sr: int, sec: float = REF_WINDOW_SEC) -> np.ndarray:
    """The `sec`-long stretch of y with the highest speech fraction (frames 10 dB above the 10th-percentile floor); y itself when shorter."""
    n = int(sec * sr)
    if len(y) <= n * 1.15:
        return y
    hop = int(0.010 * sr)
    fr = len(y) // hop
    db = 10 * np.log10((y[: fr * hop].reshape(fr, hop) ** 2).mean(1) + 1e-12)
    speech = (db > np.percentile(db, 10) + 10).astype("float32")
    w = int(sec * 100)
    csum = np.concatenate([[0.0], np.cumsum(speech)])
    scores = csum[w:] - csum[:-w]
    start = int(np.argmax(scores)) * hop
    return y[start:start + n]


def resolve_language(code, supported):
    """Valid OmniVoice language id for `code`, or raise LanguageError (never fall back silently)."""
    if not code or not isinstance(code, str):
        raise LanguageError("language required")
    c = code.strip().lower()
    for cand in LANG_CANDIDATES.get(c, [c]):
        if cand in supported:
            return cand
    raise LanguageError(f"unsupported language {c[:12]}")


def detect_language(text, voice_lang, supported):
    """The language to speak: the voice's own unless the text is confidently another supported language. Never raises."""
    if len(text.strip()) < DETECT_MIN_CHARS:
        return voice_lang
    try:
        from langdetect import DetectorFactory, detect_langs

        DetectorFactory.seed = 0
        top = detect_langs(text)[0]
        code = top.lang.split("-")[0]
        if top.prob >= DETECT_MIN_PROB and code != (voice_lang or "") :
            resolve_language(code, supported)  # only switch to a language the model can actually speak
            return code
    except Exception:  # noqa: BLE001
        pass
    return voice_lang


class OmniVoiceEngine(ChatterboxEngine):
    sample_rate = 24000

    def __init__(self, steps: int = 32, rt_langs: str = "de,en,it,ja,ko,pl,ru"):
        # deliberately not ChatterboxEngine.__init__ (it validates the CPU model name); same attributes
        self.model = "omnivoice"
        self.model_id = "omnivoice-0.6b-gpu"
        self.lock = threading.Lock()
        self._conds_cache = {}
        self.ready = threading.Event()
        self.load_error = None
        self.steps = int(steps)
        self.rt_steps = 16
        self.rt_langs = frozenset(x.strip() for x in rt_langs.split(",") if x.strip())

    def load(self):
        import torch
        import transformers
        import perth
        from omnivoice import OmniVoice
        import omnivoice.models.omnivoice as om
        from speechbrain.inference.speaker import EncoderClassifier
        from transformers import ASTFeatureExtractor, ASTForAudioClassification

        t0 = time.time()
        self.torch, self.om = torch, om
        self.tts = OmniVoice.from_pretrained(OMNI_REPO, device_map="cuda:0", dtype=torch.float16, load_asr=True)
        self.supported = set(self.tts.supported_language_ids())
        self.wm = perth.PerthImplicitWatermarker()
        speechbrain_hf_compat()
        self.ecapa = EncoderClassifier.from_hparams(ECAPA_REPO, savedir=ECAPA_DIR, run_opts={"device": "cpu"})  # CPU: 3-10 s clips, keeps VRAM for the model
        self.ast_fe = ASTFeatureExtractor.from_pretrained(AST_MODEL)
        self.ast = ASTForAudioClassification.from_pretrained(AST_MODEL).eval()
        self.music_idx = [i for i, l in self.ast.config.id2label.items() if l == "Music"][0]
        self.load_s = round(time.time() - t0, 1)
        transformers.logging.set_verbosity_error()
        return self

    # analyze() and similarity() are inherited unchanged (ECAPA + AST on CPU).

    def prompt_path(self, vdir: str) -> str:
        return os.path.join(vdir, "prompt-omnivoice.pt")

    def prepare_voice(self, vdir: str, language=None) -> float:
        """Pick one clean ~12 s window, transcribe it, build the clone prompt once and cache it. Raises ValueError/AssertionError on a bad clip."""
        import soundfile as sf

        t0 = time.time()
        if language is not None:
            resolve_language(language, self.supported)  # fail at creation, not at the first synthesis
        ref = os.path.join(vdir, "ref.wav")
        y, sr = sf.read(ref, dtype="float32")
        y = best_window(y if y.ndim == 1 else y.mean(1), sr)
        win = os.path.join(vdir, "ref-window.wav")
        sf.write(win, y, sr, subtype="PCM_16")
        with self.lock:
            prompt = self.tts.create_voice_clone_prompt(ref_audio=win)  # ref_text=None: transcribed once here
            prompt.save(self.prompt_path(vdir))
            self._conds_cache[vdir] = prompt
            while len(self._conds_cache) > 8:
                self._conds_cache.pop(next(iter(self._conds_cache)))
            self.torch.cuda.empty_cache()
        return time.time() - t0

    def _prompt_for(self, vdir: str):
        p = self._conds_cache.get(vdir)
        if p is None:
            path = self.prompt_path(vdir)
            if os.path.exists(path):
                p = self.om.VoiceClonePrompt.load(path, map_location="cuda:0")
            else:  # voice created before the prompt was cached (or file lost): rebuild once
                self.prepare_voice(vdir)
                return self._conds_cache[vdir]
            self._conds_cache[vdir] = p
            while len(self._conds_cache) > 8:
                self._conds_cache.pop(next(iter(self._conds_cache)))
        return p

    def synthesize(self, vdir: str, text: str, speed: float, chunk_chars: int, deadline_s: float, language=None, tier=None) -> dict:
        import soundfile as sf

        sr, t0, cpu0 = self.sample_rate, time.time(), time.process_time()
        lang_code = detect_language(text, language, self.supported) if language else language
        lid = resolve_language(lang_code, self.supported)
        steps = self.rt_steps if (tier == "realtime" and (lang_code or "") in self.rt_langs) else self.steps
        gc = self.om.OmniVoiceGenerationConfig(num_step=steps)
        parts = []
        with self.lock:
            prompt = self._prompt_for(vdir)
            for c in chunks(text, chunk_chars):
                if time.time() - t0 > deadline_s:
                    raise TimeoutError("generation deadline exceeded")
                a = self.tts.generate(text=c, language=lid, voice_clone_prompt=prompt, generation_config=gc)[0]
                a = a.detach().cpu().numpy() if hasattr(a, "detach") else np.asarray(a)
                parts.append(np.asarray(a, dtype="float32").reshape(-1))
                parts.append(np.zeros(int(0.12 * sr), dtype="float32"))
            y = np.concatenate(parts[:-1]) if parts else np.zeros(1, dtype="float32")
            if abs(speed - 1.0) > 1e-3:  # stretch first, watermark the final audio
                with tempfile.TemporaryDirectory() as d:
                    sf.write(f"{d}/a.wav", y, sr)
                    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", f"{d}/a.wav", "-filter:a", atempo_chain(speed), f"{d}/b.wav"], check=True, timeout=120)
                    y, _ = sf.read(f"{d}/b.wav", dtype="float32")
            y = np.asarray(self.wm.apply_watermark(y, sample_rate=sr), dtype="float32")
            score = float(self.wm.get_watermark(y, sample_rate=sr))
        buf = io.BytesIO()
        sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
        return {"wav": buf.getvalue(), "sample_rate": sr, "watermark_score": score, "audio_s": len(y) / sr,
                "gen_s": time.time() - t0, "cpu_s": time.process_time() - cpu0, "steps": steps, "language": lid}
