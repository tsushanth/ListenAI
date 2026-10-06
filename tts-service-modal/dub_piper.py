"""Dedicated CPU-only Modal function for Piper dubbing TTS (no GPU). Default DUB_TTS_BACKEND=modal-cpu talks to this.

Why: Piper is CPU/ONNX work; serving it from the Kokoro GPU container (app.py `web`) pays for an idle T4 (~$0.0015 per
source minute measured) while this function costs about 4 CPU cores x container seconds (~$0.0003 per source minute).
Scale-to-zero (no min_containers), reads the existing Modal volume `house-voices` read-only; piper_engine.DUB_PIPER_VOICES is
the allowlist (es-pilot-f/m, fr-fr-mls-f/m: tier A, CC BY 4.0), nothing else on the volume can be served.

Contract = readaloud-tts POST /synthesize: JSON {text, voice_id, language?, speed?, model?} -> audio/wav (24 kHz mono PCM16).
Speed is Piper's length_scale / speed. GET /health is unauthenticated and returns no voice or model detail.

Auth: shared secret, same pattern as backend/modal/convert_job.py and sound_effects_worker.py: `Authorization: Bearer <secret>`
checked with hmac.compare_digest, fail-closed when the secret is not configured. The secret is read from the Modal secret named by
DUB_PIPER_SECRET_NAME (default "dub-piper"), key DUB_PIPER_SECRET. This repo does NOT create it: the owner provisions it
(`modal secret create dub-piper DUB_PIPER_SECRET=...`) and sets the same value as DUB_PIPER_MODAL_SECRET on the backend.

Deploy (owner, prod):    modal deploy dub_piper.py
Ephemeral measurement:   DUB_PIPER_APP_NAME=ra-dub-piper-dev DUB_PIPER_DEV_INLINE_SECRET=<random throwaway> modal deploy dub_piper.py
  (DEV_INLINE_SECRET attaches an inline, unnamed secret to that throwaway app only; never use it for the prod app.)
"""
import os

import modal

APP_NAME = os.environ.get("DUB_PIPER_APP_NAME", "readaloud-dub-piper")
SECRET_NAME = os.environ.get("DUB_PIPER_SECRET_NAME", "dub-piper")
_DEV_INLINE = os.environ.get("DUB_PIPER_DEV_INLINE_SECRET")  # throwaway apps only

if _DEV_INLINE:
    dub_secret = modal.Secret.from_dict({"DUB_PIPER_SECRET": _DEV_INLINE})
else:
    dub_secret = modal.Secret.from_name(SECRET_NAME, required_keys=["DUB_PIPER_SECRET"])

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("piper-tts==1.8.0", "numpy<2", "scipy", "fastapi==0.109.0")  # same piper pin as realtime-tts worker-piper-fly
    .add_local_python_source("piper_engine", "dub_piper_core")
)
app = modal.App(APP_NAME, image=image)
HOUSE_VOICES = modal.Volume.from_name("house-voices")  # existing volume; mounted read-only

PRELOAD = ("es-pilot-m", "es-pilot-f")  # the Spanish pilot voices are loaded at container start; fr loads on first use


@app.cls(
    cpu=4,
    memory=2048,
    secrets=[dub_secret],
    volumes={"/house-voices": HOUSE_VOICES.read_only()},
    scaledown_window=60,  # idle containers stop after 1 minute: scale to zero between jobs (cold start measured ~9 s)
    timeout=600,
)
@modal.concurrent(max_inputs=3)
class DubPiper:
    @modal.enter()
    def load(self):
        import time
        import piper_engine
        t = time.time()
        self.registry = piper_engine.PiperRegistry("/house-voices", max_loaded=4)
        for v in PRELOAD:
            try:
                self.registry.synth("Prueba de arranque.", v, 1.0)
            except piper_engine.PiperVoiceError as e:  # a missing voice must not stop the container
                print("preload skipped:", v, e)
        print(f"DubPiper ready in {time.time() - t:.1f}s")

    @modal.asgi_app()
    def web(self):
        import time
        import os as _os
        from fastapi import FastAPI, HTTPException, Request
        from fastapi.concurrency import run_in_threadpool
        from fastapi.responses import Response
        import dub_piper_core as core
        import piper_engine

        api = FastAPI(title="ReadAloud dubbing Piper (CPU)")

        @api.get("/health")
        async def health():
            return {"status": "ok"}

        @api.post("/synthesize")
        async def synthesize(request: Request):
            if not core.bearer_ok(request.headers.get("authorization"), _os.environ.get("DUB_PIPER_SECRET")):
                raise HTTPException(status_code=401, detail="unauthorized")
            try:
                req = core.validate_request(await request.json())
            except (ValueError, core.BadRequest) as e:
                raise HTTPException(status_code=400, detail=str(e))
            start = time.time()
            try:
                audio = await run_in_threadpool(self.registry.synth, req["text"], req["voice_id"], req["speed"])
            except piper_engine.PiperVoiceError as e:
                raise HTTPException(status_code=404, detail=str(e))
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=500, detail=f"synthesis failed: {e}")
            return Response(
                content=core.encode_wav(audio, piper_engine.OUT_SR),
                media_type="audio/wav",
                headers={
                    "X-Engine": "piper-cpu",
                    "X-Voice-ID": req["voice_id"],
                    "X-Synthesis-Time-Ms": str(int((time.time() - start) * 1000)),
                    "Cache-Control": "no-store",
                },
            )

        return api
