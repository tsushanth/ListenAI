"""Modal GPU worker serving the finetuned Stable Audio Open model.

VENDORED from the realtime-tts repo (branch feat/text-to-music-api, worker-modal-music/app.py at 2c6f83d) so the
backend image can deploy it per user (backend/src/lib/modalDeployments.ts). Changes from that copy: per-user app and
secret names, the shared checkpoints Volume mounted read-only for per-user deployments, one GPU container per
user, and an X-GPU-Seconds response header with the measured generation time. Keep the two in sync until the
realtime-tts copy is retired.
 Called
only by ReadAloudAI/backend's musicJobWorker.ts (trusted, shared-secret auth),
not directly by end users — unlike worker-modal-readaloud, which serves
per-user TTS sessions directly.

Generation approach verified empirically: an actual LoRA finetune + inference
run was completed end-to-end on Modal against a real Stable Audio Open 1.0
checkpoint (via the ungated mirror `audo/stable-audio-open-1.0`, since the
official Stability AI repo is gated behind a HF license acceptance), producing
a real, audibly non-silent 20-second generated clip. The conditioning shape,
output tensor handling, and package versions below all match what that run
actually used — not guessed from documentation.
"""

import math
import os
import time

import modal

MIN_DURATION_SEC = 15.0
# Stable Audio Open 1.0's model config has sample_size=2097152 at
# sample_rate=44100 -> max ~47.5s per generation (confirmed from the model's
# published model_config.json). 120s was the original plan's assumption and
# is wrong for this model.
MAX_DURATION_SEC = 47.0

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git")
    .pip_install(
        "numpy==1.26.4",
        "soundfile",
        "torch==2.7.1",
        "torchaudio==2.7.1",
        "pytorch-lightning==2.1.0",
        "prefigure",
        "dill",
        "git+https://github.com/Stability-AI/stable-audio-tools.git",
        "fastapi==0.109.0",
        "uvicorn[standard]==0.27.0",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
)
# NOTE: `stable-audio-tools` must be installed from GitHub main, not PyPI —
# the latest PyPI release (0.0.19) at the time of writing does not have the
# `stable_audio_tools.models.lora` module (`load_and_apply_loras`) that this
# worker depends on. GitHub main also requires Python <3.11 and torch 2.7.1,
# hence the version pins above (found by trial against a real install, not
# from documentation).

# Per-user deployments (lib/modalDeployments.ts) set MUSIC_APP_SUFFIX and MUSIC_SECRET_NAME so each user gets their own
# app and their own bearer secret, like convert_job.py / isolate_job.py / sound_effects_worker.py. Without a suffix
# this is the original shared worker (app and secret names unchanged).
#
# The per-user app name is deliberately short: Modal builds the endpoint subdomain as "<workspace>--<app>-<function>"
# and that label cannot exceed 63 characters.
APP_SUFFIX = os.environ.get("MUSIC_APP_SUFFIX", "")
SECRET_NAME = os.environ.get("MUSIC_SECRET_NAME", "music-worker-shared-secret")
PER_USER = bool(APP_SUFFIX)

app = modal.App(("music-readaloud" + APP_SUFFIX) if PER_USER else "music-worker-readaloud", image=image)

# Model weights and the finetuned LoRA live on one shared Volume. A per-user app mounts it read-only (it must never be
# able to alter the shared weights, and must fail at deploy rather than silently create an empty Volume if missing).
_checkpoints = modal.Volume.from_name("music-checkpoints", create_if_missing=not PER_USER)
if PER_USER:
    _checkpoints = _checkpoints.read_only()


def validate_generate_request(body: dict) -> tuple[bool, str | None]:
    if not isinstance(body, dict):
        return False, "request body must be a JSON object"
    if "prompt" not in body or not isinstance(body["prompt"], str) or not body["prompt"].strip():
        return False, "prompt is required and must be a non-empty string"
    duration = body.get("duration_sec")
    if (
        not isinstance(duration, (int, float))
        or isinstance(duration, bool)
        or not math.isfinite(duration)
        or duration < MIN_DURATION_SEC
        or duration > MAX_DURATION_SEC
    ):
        return False, f"duration_sec must be between {MIN_DURATION_SEC} and {MAX_DURATION_SEC}"
    return True, None


@app.function(
    gpu="A10G",
    scaledown_window=120,
    # A per-user deployment gets one GPU container, so one user cannot fan out into many on our Modal bill.
    max_containers=1 if PER_USER else 5,
    timeout=180,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    volumes={"/checkpoints": _checkpoints},
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def web():
    import asyncio
    import hmac
    import json
    import os
    import io
    from fastapi import FastAPI, Request, Response
    from stable_audio_tools import create_model_from_config
    from stable_audio_tools.models.utils import load_ckpt_state_dict, copy_state_dict
    from stable_audio_tools.models.lora import load_and_apply_loras
    from stable_audio_tools.inference.generation import generate_diffusion_cond
    import torch
    import torchaudio

    web_app = FastAPI()

    SHARED_SECRET = os.environ["MUSIC_WORKER_SHARED_SECRET"]
    if not SHARED_SECRET:
        raise RuntimeError(
            "MUSIC_WORKER_SHARED_SECRET is empty — refusing to start, since a "
            "bare 'Bearer ' header would otherwise authenticate."
        )

    # Base checkpoint + model config: downloaded once and cached in the
    # Modal Volume by whatever deploy/setup step runs before this worker
    # starts (see music-model/train.py's run_finetune for how these are
    # produced during training — the same model_config.json, with its
    # embedded lora_config, is reused here).
    MODEL_CONFIG_PATH = os.environ.get("MUSIC_MODEL_CONFIG_PATH", "/checkpoints/model_config.json")
    BASE_CKPT_PATH = os.environ.get("MUSIC_BASE_CKPT_PATH", "/checkpoints/model.safetensors")
    LORA_CKPT_PATH = os.environ.get("MUSIC_LORA_CKPT_PATH", "/checkpoints/lora.ckpt")

    with open(MODEL_CONFIG_PATH) as f:
        model_config = json.load(f)

    model = create_model_from_config(model_config)
    copy_state_dict(model, load_ckpt_state_dict(BASE_CKPT_PATH))
    load_and_apply_loras(model, [LORA_CKPT_PATH], model_config["model_type"])
    model = model.to("cuda").eval()

    SAMPLE_RATE = model_config["sample_rate"]
    MAX_SAMPLE_SIZE = model_config["sample_size"]

    @web_app.get("/health")
    def health():
        return {"status": "ok"}

    @web_app.post("/generate")
    async def generate(request: Request, response: Response):
        auth = request.headers.get("Authorization", "")
        if not hmac.compare_digest(auth, f"Bearer {SHARED_SECRET}"):
            response.status_code = 401
            return {"error": "unauthorized"}

        try:
            body = await request.json()
        except Exception:
            response.status_code = 400
            return {"error": "invalid JSON body"}

        ok, error = validate_generate_request(body)
        if not ok:
            response.status_code = 400
            return {"error": error}

        try:
            def _run_generation():
                duration_sec = body["duration_sec"]
                conditioning = [{
                    "prompt": body["prompt"],
                    "seconds_start": 0,
                    "seconds_total": duration_sec,
                }]
                sample_size = min(int(duration_sec * SAMPLE_RATE), MAX_SAMPLE_SIZE)

                with torch.no_grad():
                    audio = generate_diffusion_cond(
                        model,
                        steps=50,
                        conditioning=conditioning,
                        sample_size=sample_size,
                        device="cuda",
                    )

                # audio shape: [batch, channels, samples] — take the first
                # (only) batch item and clamp before saving, matching the
                # shape torchaudio.save expects and avoiding clipping noise.
                audio = audio[0].cpu().clamp(-1, 1)
                buf = io.BytesIO()
                # torchaudio 2.7 requires an explicit backend when writing to
                # a file-like object (BytesIO) rather than a real path —
                # confirmed by an actual deploy failure ("Couldn't find
                # appropriate backend to handle uri <BytesIO> and format
                # wav"), not from documentation.
                torchaudio.save(buf, audio, sample_rate=SAMPLE_RATE, format="wav", backend="soundfile")
                return buf.getvalue()

            started = time.monotonic()
            wav_bytes = await asyncio.to_thread(_run_generation)
            # Wall-clock seconds the GPU spent on this request, so usage can be recorded on measured resource time.
            gpu_seconds = round(time.monotonic() - started, 3)
            return Response(content=wav_bytes, media_type="audio/wav", headers={"X-GPU-Seconds": str(gpu_seconds)})
        except Exception as e:  # noqa: BLE001 — surface as 500, let caller mark job failed
            response.status_code = 500
            return {"error": f"generation failed: {e}"}

    return web_app
