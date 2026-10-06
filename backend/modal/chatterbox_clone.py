"""Chatterbox Multilingual V3 zero-shot voice cloning on Modal (scale-to-zero, L4).

Serves the consent-gated cloning flow in backend/src/lib/voiceCloning/ (client: serviceClient.ts).
MIT-licensed model + code (Resemble AI Chatterbox); output carries the built-in Perth watermark.
Derived from the S5 harness (internal-docs/cost-lab/gtm/voice-cloning/harness/clone_eval.py, cfg cb_mtl3).

NOT DEPLOYED to production by this change. Deploy deliberately:
    modal secret create readaloud-chatterbox-clone-secret CLONE_SERVICE_SECRET=<random>
    modal deploy backend/modal/chatterbox_clone.py
Dev/ephemeral deploys override names so nothing touches prod resources:
    RA_CLONE_APP_NAME=ra-clone-dev RA_CLONE_VOLUME=ra-clone-dev-vol RA_CLONE_SECRET_NAME=ra-clone-dev-secret modal deploy ...

Endpoints (all need `Authorization: Bearer $CLONE_SERVICE_SECRET`):
    GET    /health
    POST   /analyze                 multipart audio            -> reference-quality metrics
    POST   /similarity              multipart a, b             -> ECAPA cosine (the embedding the threshold was calibrated on)
    POST   /voices                  multipart voice_id, language, reference -> stores the reference, returns reference_sec
    POST   /voices/{id}/synthesize  json {text, language, speed} -> audio/wav (Perth-watermarked)
    POST   /voices/{id}/disable     marks unusable, keeps evidence
    DELETE /voices/{id}             removes reference audio and every derived artefact

Storage: /vol/voices/<voice_id>/{ref.wav, meta.json, DISABLED?}. Nothing else is cached per voice
(conditionals are recomputed per request), so deleting the directory removes reference audio, embeddings and
cached prompts. Customer reference audio is never used for training.

Cost (REPORT.md, measured on L4): ~$0.0126 per generated minute, RTF ~0.94, cold start 60-180 s.
"""
import hmac
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

import modal

APP_NAME = os.environ.get("RA_CLONE_APP_NAME", "readaloud-chatterbox-clone")
VOLUME_NAME = os.environ.get("RA_CLONE_VOLUME", "ra-voice-clones")
SECRET_NAME = os.environ.get("RA_CLONE_SECRET_NAME", "readaloud-chatterbox-clone-secret")
# Pinned so the image is reproducible; the harness's cb_mtl3 run used the then-current git HEAD (commit unknown).
CHATTERBOX_REF = os.environ.get("RA_CLONE_CHATTERBOX_REF", "5de7a54aa4e5e2baadb0182dde554908b48b85c2")
AST_MODEL = "MIT/ast-finetuned-audioset-10-10-0.4593"  # BSD-3-Clause; AudioSet music/speech classifier
MODEL_ID = "chatterbox-mtl-v3"
ECAPA_REPO = "speechbrain/spkrec-ecapa-voxceleb"
V = "/vol"
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_TEXT_CHARS = 5000
CHUNK_CHARS = 300
LANGS = {"ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

app = modal.App(APP_NAME)
vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
secret = modal.Secret.from_name(SECRET_NAME)


def _speechbrain_hf_compat():
    """speechbrain 1.0.2 vs current huggingface_hub: (1) it passes hf_hub_download(use_auth_token=...), removed upstream;
    (2) it expects a requests.HTTPError("404 Client Error") for a missing optional file (custom.py) and gets
    RemoteEntryNotFoundError instead. Shim both here rather than pinning huggingface_hub (chatterbox/gradio need a
    recent one). The embedding weights are unchanged, so scores match the harness's ECAPA numbers."""
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


def _bake_weights():
    """Runs at image build so a cold start does not download weights."""
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    from speechbrain.inference.speaker import EncoderClassifier
    from transformers import ASTFeatureExtractor, ASTForAudioClassification

    ChatterboxMultilingualTTS.from_pretrained(device="cpu", t3_model="v3")
    _speechbrain_hf_compat()
    EncoderClassifier.from_hparams(ECAPA_REPO, savedir="/models/ecapa", run_opts={"device": "cpu"})
    ASTFeatureExtractor.from_pretrained(AST_MODEL)
    ASTForAudioClassification.from_pretrained(AST_MODEL)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(f"chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@{CHATTERBOX_REF}", "huggingface_hub", "soundfile")
    .pip_install("speechbrain==1.0.2", "fastapi[standard]", "python-multipart", "librosa")
    .env({"HF_HOME": "/root/hf", "HF_HUB_DISABLE_XET": "1", "TOKENIZERS_PARALLELISM": "false"})
    .run_function(_bake_weights)
)


@app.cls(
    image=image, gpu="L4", volumes={V: vol}, secrets=[secret],
    scaledown_window=int(os.environ.get("RA_CLONE_SCALEDOWN_SEC", "120")),  # scale to zero after 2 idle minutes
    min_containers=0, max_containers=2, timeout=1800,
)
@modal.concurrent(max_inputs=4)
class CloneService:
    @modal.enter()
    def load(self):
        import numpy as np
        import perth
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        from speechbrain.inference.speaker import EncoderClassifier
        from transformers import ASTFeatureExtractor, ASTForAudioClassification

        t0 = time.time()
        self.np, self.torch = np, torch
        self.tts = ChatterboxMultilingualTTS.from_pretrained(device="cuda", t3_model="v3")
        _speechbrain_hf_compat()
        self.ecapa = EncoderClassifier.from_hparams(ECAPA_REPO, savedir="/models/ecapa", run_opts={"device": "cuda"})
        self.ast_fe = ASTFeatureExtractor.from_pretrained(AST_MODEL)
        self.ast = ASTForAudioClassification.from_pretrained(AST_MODEL).to("cuda").eval()
        self.music_idx = [i for i, l in self.ast.config.id2label.items() if l == "Music"][0]
        self.wm = perth.PerthImplicitWatermarker()
        self.gpu_lock = threading.Lock()  # chatterbox.generate is not thread-safe
        self.load_s = round(time.time() - t0, 1)

    # ------------------------------------------------------------------ audio helpers
    def _decode16k(self, data: bytes):
        """Any container/codec ffmpeg understands -> float32 mono 16 kHz."""
        if len(data) > MAX_UPLOAD_BYTES:
            raise ValueError("file too large")
        with tempfile.NamedTemporaryFile(suffix=".bin") as f:
            f.write(data)
            f.flush()
            p = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", f.name, "-t", "600", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                capture_output=True, timeout=60,
            )
        if p.returncode != 0 or len(p.stdout) < 3200:
            raise ValueError("could not decode audio")
        return self.np.frombuffer(p.stdout, dtype="<f4").copy()

    def _embed(self, y):
        t = self.torch.from_numpy(y).unsqueeze(0).to("cuda")
        with self.torch.no_grad():
            e = self.ecapa.encode_batch(t).squeeze()
        return self.torch.nn.functional.normalize(e, dim=0)

    def _metrics(self, y):
        np = self.np
        sr = 16000
        n = len(y)
        dur = n / sr
        fl, hop = int(0.025 * sr), int(0.010 * sr)
        n_fr = max(1, 1 + (n - fl) // hop)
        idx = np.arange(fl)[None, :] + hop * np.arange(n_fr)[:, None]
        fr = y[np.minimum(idx, n - 1)]
        power = (fr ** 2).mean(1) + 1e-12
        db = 10 * np.log10(power)
        floor_db = float(np.percentile(db, 10))
        speech = (db > floor_db + 10) & (db > -55)
        speech_sec = float(speech.sum() * 0.01)
        if speech.any() and (~speech).sum() >= 5:
            ps = float(power[speech].mean())
            pn = float(power[db <= np.percentile(db, 20)].mean())
            snr = float(min(60.0, 10 * np.log10(ps / pn)))
        elif speech.any():
            snr = 60.0  # no quiet frames at all: cannot estimate a floor; treat as clean (heuristic)
        else:
            snr = 0.0
        clipping = float((np.abs(y) >= 0.999).mean())

        # single-speaker heuristic: 3 s windows, min cosine to the clip centroid
        min_sim = None
        win, step = 3 * sr, int(1.5 * sr)
        embs = []
        for s in range(0, max(1, n - win + 1), step):
            seg = y[s:s + win]
            if len(seg) < win:
                break
            seg_db = 10 * np.log10((seg[: len(seg) // 160 * 160].reshape(-1, 160) ** 2).mean(1) + 1e-12)
            if (seg_db > floor_db + 10).mean() < 0.5:
                continue
            embs.append(self._embed(seg))
        if len(embs) >= 2:
            cen = self.torch.nn.functional.normalize(self.torch.stack(embs).mean(0), dim=0)
            min_sim = float(min(float(self.torch.dot(e, cen)) for e in embs))

        # music: AudioSet 'Music' probability, max over 10 s windows (sigmoid, multi-label)
        music = 0.0
        w10 = 10 * sr
        for s in range(0, max(1, n - w10 + 1), w10) if n > w10 else [0]:
            seg = y[s:s + w10]
            inp = self.ast_fe(seg, sampling_rate=sr, return_tensors="pt").to("cuda")
            with self.torch.no_grad():
                p = self.torch.sigmoid(self.ast(**inp).logits)[0, self.music_idx]
            music = max(music, float(p))
        return dict(duration_sec=round(dur, 2), speech_sec=round(speech_sec, 2), snr_db=round(snr, 1),
                    clipping_ratio=round(clipping, 5), min_window_similarity=None if min_sim is None else round(min_sim, 4),
                    music_prob=round(music, 4))

    # ------------------------------------------------------------------ voice storage
    @staticmethod
    def _vdir(voice_id: str) -> str:
        if not UUID_RE.match(voice_id):
            raise ValueError("invalid voice id")
        return f"{V}/voices/{voice_id}"

    # ------------------------------------------------------------------ synthesis
    @staticmethod
    def _chunks(text: str):
        sentences = re.split(r"(?<=[.!?。！？])\s+", text.strip())
        out, cur = [], ""
        for s in sentences:
            while len(s) > CHUNK_CHARS:  # hard-split run-on sentences at a space
                cut = s.rfind(" ", 0, CHUNK_CHARS)
                cut = cut if cut > 50 else CHUNK_CHARS
                out.append(s[:cut].strip())
                s = s[cut:].strip()
            if cur and len(cur) + 1 + len(s) > CHUNK_CHARS:
                out.append(cur)
                cur = s
            else:
                cur = f"{cur} {s}".strip()
        if cur:
            out.append(cur)
        return [c for c in out if c]

    def _synthesize(self, ref_path: str, text: str, lang: str, speed: float):
        import soundfile as sf

        np, sr = self.np, self.tts.sr
        parts = []
        with self.gpu_lock:
            for c in self._chunks(text):
                wav = self.tts.generate(c, language_id=lang, audio_prompt_path=ref_path)  # Perth applied inside generate()
                parts.append(wav.squeeze().cpu().numpy().astype("float32"))
                parts.append(np.zeros(int(0.12 * sr), dtype="float32"))
        y = np.concatenate(parts[:-1]) if parts else np.zeros(1, dtype="float32")
        if abs(speed - 1.0) > 1e-3:
            # Time-stretching damages a watermark (REPORT.md: AudioSeal fails at 0.9x; Perth untested), so stretch
            # first and watermark the final audio.
            with tempfile.TemporaryDirectory() as d:
                sf.write(f"{d}/a.wav", y, sr)
                chain, s = [], speed
                while s > 2.0:
                    chain.append("atempo=2.0"); s /= 2.0
                while s < 0.5:
                    chain.append("atempo=0.5"); s /= 0.5
                chain.append(f"atempo={s:.4f}")
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", f"{d}/a.wav", "-filter:a", ",".join(chain), f"{d}/b.wav"], check=True, timeout=120)
                y, _ = sf.read(f"{d}/b.wav", dtype="float32")
            y = np.asarray(self.wm.apply_watermark(y, watermark=None, sample_rate=sr), dtype="float32")
        score = float(self.wm.get_watermark(y, sample_rate=sr))
        buf = io.BytesIO()
        sf.write(buf, y, sr, format="WAV", subtype="PCM_16")  # 44-byte header, 16-bit mono (the worker's duration math relies on it)
        return buf.getvalue(), sr, score

    # ------------------------------------------------------------------ HTTP
    @modal.asgi_app()
    def web(self):
        from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile

        api = FastAPI(title="readaloud-chatterbox-clone", docs_url=None, redoc_url=None, openapi_url=None)
        expected = os.environ["CLONE_SERVICE_SECRET"]

        def auth(request: Request):
            got = request.headers.get("authorization", "")
            if not hmac.compare_digest(got.encode(), f"Bearer {expected}".encode()):
                raise HTTPException(401, "unauthorized")

        async def read(f: UploadFile) -> bytes:
            data = await f.read(MAX_UPLOAD_BYTES + 1)
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "file too large")
            return data

        @api.get("/health")
        def health(_=Depends(auth)):
            return {"ok": True, "model": MODEL_ID, "load_s": self.load_s, "chatterbox_ref": CHATTERBOX_REF}

        @api.post("/analyze")
        async def analyze(audio: UploadFile = File(...), _=Depends(auth)):
            try:
                return self._metrics(self._decode16k(await read(audio)))
            except ValueError as e:
                raise HTTPException(422, str(e))

        @api.post("/similarity")
        async def similarity(a: UploadFile = File(...), b: UploadFile = File(...), _=Depends(auth)):
            try:
                ea, eb = self._embed(self._decode16k(await read(a))), self._embed(self._decode16k(await read(b)))
            except ValueError as e:
                raise HTTPException(422, str(e))
            return {"similarity": round(float(self.torch.dot(ea, eb)), 4), "model": "speechbrain/spkrec-ecapa-voxceleb"}

        @api.post("/voices")
        async def create_voice(voice_id: str = Form(...), language: str = Form(...), reference: UploadFile = File(...), _=Depends(auth)):
            import soundfile as sf

            if language not in LANGS:
                raise HTTPException(400, "unsupported language")
            try:
                d = self._vdir(voice_id)
                y = self._decode16k(await read(reference))
            except ValueError as e:
                raise HTTPException(422, str(e))
            os.makedirs(d, exist_ok=False)  # voice ids are server-generated UUIDs; refuse overwrite
            sf.write(f"{d}/ref.wav", y[: 16000 * 120], 16000)
            json.dump({"language": language, "created": time.time(), "model": MODEL_ID}, open(f"{d}/meta.json", "w"))
            vol.commit()
            return {"voice_id": voice_id, "reference_sec": round(min(len(y), 16000 * 120) / 16000, 2)}

        @api.post("/voices/{voice_id}/synthesize")
        async def synthesize(voice_id: str, request: Request, _=Depends(auth)):
            body = await request.json()
            text = str(body.get("text", "")).strip()
            lang = str(body.get("language", "en"))
            speed = float(body.get("speed", 1.0))
            if not text or len(text) > MAX_TEXT_CHARS or lang not in LANGS or not (0.5 <= speed <= 3.0):
                raise HTTPException(400, "invalid request")
            try:
                d = self._vdir(voice_id)
            except ValueError:
                raise HTTPException(404, "voice not found")
            vol.reload()
            if not os.path.exists(f"{d}/ref.wav"):
                raise HTTPException(404, "voice not found")
            if os.path.exists(f"{d}/DISABLED"):
                raise HTTPException(403, "voice disabled")
            wav, sr, score = self._synthesize(f"{d}/ref.wav", text, lang, speed)
            return Response(wav, media_type="audio/wav", headers={
                "X-Watermark-Scheme": "perth", "X-Watermark-Score": f"{score:.4f}", "X-Sample-Rate": str(sr), "X-Model-Id": MODEL_ID,
            })

        @api.post("/voices/{voice_id}/disable")
        def disable(voice_id: str, _=Depends(auth)):
            try:
                d = self._vdir(voice_id)
            except ValueError:
                raise HTTPException(404, "voice not found")
            vol.reload()
            if not os.path.isdir(d):
                raise HTTPException(404, "voice not found")
            open(f"{d}/DISABLED", "w").write(str(time.time()))
            vol.commit()
            return {"ok": True}

        @api.delete("/voices/{voice_id}")
        def delete(voice_id: str, _=Depends(auth)):
            try:
                d = self._vdir(voice_id)
            except ValueError:
                raise HTTPException(404, "voice not found")
            vol.reload()
            if not os.path.isdir(d):
                raise HTTPException(404, "voice not found")
            shutil.rmtree(d)
            vol.commit()
            return {"deleted": True}

        return api
