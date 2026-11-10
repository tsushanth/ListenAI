"""Real CPU engine: Chatterbox Turbo/Nano (MIT) + ECAPA speaker embedding + AST music classifier. torch is imported lazily so
the rest of the service (and its unit tests) never needs it. Output carries Chatterbox's built-in Perth watermark.

Conditioning (the ~15-20 s per-request cost measured on CPU) is computed ONCE per voice and cached next to the reference on the
data volume (conds-<model>.pt); deleting the voice directory removes it together with the reference audio.
"""
import io
import os
import subprocess
import tempfile
import threading
import time

import numpy as np

from audio import atempo_chain, basic_metrics, chunks

ECAPA_REPO = "speechbrain/spkrec-ecapa-voxceleb"
AST_MODEL = "MIT/ast-finetuned-audioset-10-10-0.4593"  # BSD-3-Clause AudioSet classifier
ECAPA_DIR = os.environ.get("VC_ECAPA_DIR", "/models/ecapa")
REF_SR = 24000  # stored reference rate = S3Gen sample rate (conditioning resamples from it; storing 16 kHz would cap bandwidth at 8 kHz)


def speechbrain_hf_compat():
    """speechbrain 1.0.2 vs current huggingface_hub: it passes hf_hub_download(use_auth_token=...) (removed upstream) and expects a
    requests.HTTPError for a missing optional file. Same shim as backend/modal/chatterbox_clone.py; weights unchanged."""
    import huggingface_hub

    if getattr(huggingface_hub.hf_hub_download, "_ra_compat", False):
        return
    orig = huggingface_hub.hf_hub_download

    def compat(*args, use_auth_token=None, **kwargs):
        if use_auth_token is not None:
            kwargs.setdefault("token", use_auth_token)
        try:
            return orig(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            if type(e).__name__ in ("RemoteEntryNotFoundError", "EntryNotFoundError"):
                import requests

                raise requests.exceptions.HTTPError("404 Client Error: entry not found") from e
            raise

    compat._ra_compat = True
    huggingface_hub.hf_hub_download = compat


class ChatterboxEngine:
    sample_rate = 24000

    def __init__(self, model: str = "turbo"):
        if model not in ("turbo", "nano"):
            raise ValueError("VC_MODEL must be 'turbo' or 'nano'")
        self.model = model
        self.model_id = f"chatterbox-{model}-cpu"
        self.lock = threading.Lock()  # chatterbox.generate and the shared .conds attribute are not thread-safe
        self._conds_cache: dict = {}

    def load(self):
        import torch
        import transformers
        from chatterbox.tts_turbo import ChatterboxTurboTTS, Conditionals
        from speechbrain.inference.speaker import EncoderClassifier
        from transformers import ASTFeatureExtractor, ASTForAudioClassification

        t0 = time.time()
        torch.set_num_threads(os.cpu_count() or 1)
        self.torch, self.Conditionals = torch, Conditionals
        self.tts = ChatterboxTurboTTS.from_pretrained(device="cpu", nano=(self.model == "nano"))
        speechbrain_hf_compat()
        self.ecapa = EncoderClassifier.from_hparams(ECAPA_REPO, savedir=ECAPA_DIR, run_opts={"device": "cpu"})
        self.ast_fe = ASTFeatureExtractor.from_pretrained(AST_MODEL)
        self.ast = ASTForAudioClassification.from_pretrained(AST_MODEL).eval()
        self.music_idx = [i for i, l in self.ast.config.id2label.items() if l == "Music"][0]
        self.load_s = round(time.time() - t0, 1)
        transformers.logging.set_verbosity_error()
        return self

    # ---- speaker embedding / reference analysis -------------------------------------------------
    def _embed(self, y16):
        torch = self.torch
        with torch.inference_mode():
            e = self.ecapa.encode_batch(torch.from_numpy(y16).unsqueeze(0)).squeeze()
        return torch.nn.functional.normalize(e, dim=0)

    def similarity(self, a16, b16) -> float:
        with self.lock:
            return round(float(self.torch.dot(self._embed(a16), self._embed(b16))), 4)

    def analyze(self, y16) -> dict:
        torch, sr, n = self.torch, 16000, len(y16)
        m = basic_metrics(y16, sr)
        floor_db = m.pop("floor_db")
        with self.lock:
            win, step, embs = 3 * sr, int(1.5 * sr), []
            for s in range(0, max(1, n - win + 1), step):
                seg = y16[s:s + win]
                if len(seg) < win:
                    break
                seg_db = 10 * np.log10((seg[: len(seg) // 160 * 160].reshape(-1, 160) ** 2).mean(1) + 1e-12)
                if (seg_db > floor_db + 10).mean() < 0.5:
                    continue
                embs.append(self._embed(seg))
            min_sim = None
            if len(embs) >= 2:
                cen = torch.nn.functional.normalize(torch.stack(embs).mean(0), dim=0)
                min_sim = float(min(float(torch.dot(e, cen)) for e in embs))
            music, w10 = 0.0, 10 * sr
            for s in (range(0, max(1, n - w10 + 1), w10) if n > w10 else [0]):
                inp = self.ast_fe(y16[s:s + w10], sampling_rate=sr, return_tensors="pt")
                with torch.inference_mode():
                    p = torch.sigmoid(self.ast(**inp).logits)[0, self.music_idx]
                music = max(music, float(p))
        m["min_window_similarity"] = None if min_sim is None else round(min_sim, 4)
        m["music_prob"] = round(music, 4)
        return m

    # ---- conditioning cache ---------------------------------------------------------------------
    def conds_path(self, vdir: str) -> str:
        return os.path.join(vdir, f"conds-{self.model}.pt")

    def prepare_voice(self, vdir: str) -> float:
        """Compute and cache the conditionals for vdir/ref.wav. Returns seconds spent. Raises AssertionError/ValueError on a bad clip."""
        t0 = time.time()
        with self.lock:
            self.tts.prepare_conditionals(os.path.join(vdir, "ref.wav"))
            self.tts.conds.save(self.conds_path(vdir))
            self._conds_cache[vdir] = self.tts.conds
            while len(self._conds_cache) > 4:
                self._conds_cache.pop(next(iter(self._conds_cache)))
        return time.time() - t0

    def forget_voice(self, vdir: str) -> None:
        self._conds_cache.pop(vdir, None)

    def _conds_for(self, vdir: str):
        c = self._conds_cache.get(vdir)
        if c is None:
            path = self.conds_path(vdir)
            if os.path.exists(path):
                c = self.Conditionals.load(path, map_location="cpu").to("cpu")
            else:  # voice created before conditioning was cached (or file lost): rebuild once
                self.tts.prepare_conditionals(os.path.join(vdir, "ref.wav"))
                self.tts.conds.save(path)
                c = self.tts.conds
            self._conds_cache[vdir] = c
            while len(self._conds_cache) > 4:
                self._conds_cache.pop(next(iter(self._conds_cache)))
        return c

    # ---- synthesis ------------------------------------------------------------------------------
    def synthesize(self, vdir: str, text: str, speed: float, chunk_chars: int, deadline_s: float) -> dict:
        import soundfile as sf

        sr, t0, cpu0 = self.tts.sr, time.time(), time.process_time()
        parts = []
        with self.lock:
            self.tts.conds = self._conds_for(vdir)
            for c in chunks(text, chunk_chars):
                if time.time() - t0 > deadline_s:
                    raise TimeoutError("generation deadline exceeded")
                wav = self.tts.generate(c)  # Perth applied inside generate()
                parts.append(wav.squeeze().detach().cpu().numpy().astype("float32"))
                parts.append(np.zeros(int(0.12 * sr), dtype="float32"))
            y = np.concatenate(parts[:-1]) if parts else np.zeros(1, dtype="float32")
            if abs(speed - 1.0) > 1e-3:
                # Time-stretching damages a watermark, so stretch first and watermark the final audio (REPORT.md: AudioSeal failed at 0.9x).
                with tempfile.TemporaryDirectory() as d:
                    sf.write(f"{d}/a.wav", y, sr)
                    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", f"{d}/a.wav", "-filter:a", atempo_chain(speed), f"{d}/b.wav"], check=True, timeout=120)
                    y, _ = sf.read(f"{d}/b.wav", dtype="float32")
                y = np.asarray(self.tts.watermarker.apply_watermark(y, sample_rate=sr), dtype="float32")
            score = float(self.tts.watermarker.get_watermark(y, sample_rate=sr))
        buf = io.BytesIO()
        sf.write(buf, y, sr, format="WAV", subtype="PCM_16")  # 44-byte header, 16-bit mono (the backend worker's duration math relies on it)
        return {"wav": buf.getvalue(), "sample_rate": sr, "watermark_score": score, "audio_s": len(y) / sr,
                "gen_s": time.time() - t0, "cpu_s": time.process_time() - cpu0}
