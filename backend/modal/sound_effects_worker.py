"""Modal GPU worker serving text-to-sound-effect generation. Sibling to the
text-to-music feature's worker-modal-music/app.py (separate repo,
realtime-tts-text-to-music-api) — called only by ReadAloudAI/backend's
soundEffectJobWorker.ts (trusted, shared-secret auth), not directly by end
users, same as the music worker.

ARCHITECTURE DECISION (shared-worker, not per-user deploy/teardown):
This mirrors Music's pattern (a single, always-on, shared Modal worker
polled by a backend job worker) rather than voiceConvert.ts's per-user
Modal deploy/teardown pattern used for Seed-VC voice conversion. That's a
deliberate deviation from this repo's more common "self-serve GPU" shape —
see the "Sound Effects" section of the top-level report for why: a shared
Stable-Audio-family model with no per-user state/training to isolate is a
much better fit for one pooled GPU pool (scale-to-zero, shared checkpoint)
than for spinning up/tearing down a dedicated Modal app per user.

MODEL DECISION: reuses the SAME base checkpoint as worker-modal-music
(Stable Audio Open 1.0, via the ungated HF mirror `audo/stable-audio-open-1.0`
— the official Stability AI repo is gated behind a license click-through we
never completed, so do not swap in that repo id here or anywhere else in
this file) but DELIBERATELY DOES NOT load worker-modal-music's LoRA
checkpoint. That LoRA is a finetune specifically trained to bias the base
model toward music-style output (per worker-modal-music/app.py's own
docstring: "an actual LoRA finetune + inference run ... producing a real,
audibly non-silent 20-second generated clip" — i.e. the LoRA is what makes
that worker good at music specifically). Stable Audio Open 1.0's own base
checkpoint is a general text-to-audio diffusion model conditioned on free-
text prompts, not a music-only model — loading the music LoRA on top of it
for sound-effect prompts ("glass shattering", "footsteps on gravel") would
bias generations toward musical/tonal output, which is exactly wrong for
this use case. So: same base checkpoint, no LoRA, a sound-effect-oriented
prompt template (see build_conditioning below) instead of the music one.
If a dedicated sound-effect LoRA is ever trained, point SFX_LORA_CKPT_PATH
at it and this worker picks it up unchanged (see load_and_apply_loras call).

DURATION: sound effects are almost always much shorter clips than music —
capped here at MAX_DURATION_SEC = 12.0, well under the ~47.5s hard ceiling
Stable Audio Open 1.0's model config imposes (sample_size=2097152 @
sample_rate=44100 — same constant as worker-modal-music/app.py, this is a
property of the checkpoint, not something either worker can raise). 12s
comfortably covers UI stingers, foley, and one-shot effects; a caller that
wants a longer ambience-style clip should use the music endpoint instead.
MIN_DURATION_SEC = 1.0 (some effects like a click or a single footstep are
sub-2s; the music endpoint's 15s floor makes no sense here).
"""

import math
import os
import time

import modal

MIN_DURATION_SEC = 1.0
# Sound effects are capped well below the ~47.5s ceiling the model itself
# imposes (sample_size=2097152 at sample_rate=44100 in Stable Audio Open
# 1.0's model_config.json — the same hard limit worker-modal-music/app.py
# documents and enforces). Keep in sync with soundEffects.ts's
# MAX_DURATION_SEC in this repo.
MAX_DURATION_SEC = 12.0

image = (
    modal.Image.debian_slim(python_version="3.10")
    # libsndfile1 is the system library the `soundfile` Python package wraps -
    # without it, torchaudio has NO I/O backend at all and torchaudio.save()
    # fails with "Couldn't find appropriate backend" for any target (BytesIO
    # OR a real file path - confirmed both live against a real deployed
    # worker; this was never a BytesIO-vs-file issue, the backend was simply
    # never installed).
    .apt_install("git", "libsndfile1")
    .pip_install(
        "numpy==1.26.4",
        "torch==2.7.1",
        "torchaudio==2.7.1",
        "pytorch-lightning==2.1.0",
        "prefigure",
        "dill",
        "soundfile==0.12.1",
        "git+https://github.com/Stability-AI/stable-audio-tools.git",
        "fastapi==0.109.0",
        "uvicorn[standard]==0.27.0",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
)
# Same versions/pins as worker-modal-music/app.py, and for the same reason:
# `stable-audio-tools` must come from GitHub main, not PyPI (0.0.19 on PyPI
# lacks stable_audio_tools.models.lora.load_and_apply_loras), which in turn
# requires Python <3.11 and torch 2.7.1.

# Per-user deployments (lib/modalDeployments.ts) set SOUND_EFFECTS_APP_SUFFIX and SOUND_EFFECTS_SECRET_NAME so each
# user gets their own app and their own bearer secret, exactly like convert_job.py / isolate_job.py. Without a
# suffix this is the original shared worker (app and secret names unchanged).
#
# The per-user app name is deliberately short: Modal builds the endpoint's subdomain as
# "<workspace>--<app>-<function>" and that label cannot exceed 63 characters.
APP_SUFFIX = os.environ.get("SOUND_EFFECTS_APP_SUFFIX", "")
SECRET_NAME = os.environ.get("SOUND_EFFECTS_SECRET_NAME", "sound-effects-worker-shared-secret")
PER_USER = bool(APP_SUFFIX)

app = modal.App(("sfx-readaloud" + APP_SUFFIX) if PER_USER else "sound-effects-worker-readaloud", image=image)

# Model weights live on one shared Volume. A per-user app mounts it read-only (it must never be able to alter the
# shared weights, and must fail at deploy rather than silently create an empty Volume if it is missing).
_checkpoints = modal.Volume.from_name("sound-effects-checkpoints", create_if_missing=not PER_USER)
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


# Sound-effect-oriented conditioning template. Stable Audio Open 1.0 is
# prompt-conditioned via free text (no separate "mode" input), so the only
# lever we have to bias it away from music-style output (without the music
# LoRA loaded, see module docstring) is the prompt text itself. Prefixing
# with "sound effect of" nudges the diffusion model toward foley/SFX-style
# training examples in its base dataset rather than musical/tonal ones.
def build_conditioning(prompt: str, duration_sec: float) -> list[dict]:
    return [{
        "prompt": f"sound effect of {prompt.strip()}",
        "seconds_start": 0,
        "seconds_total": duration_sec,
    }]


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
    import tempfile
    from fastapi import FastAPI, Request, Response
    from stable_audio_tools import create_model_from_config
    from stable_audio_tools.models.utils import load_ckpt_state_dict, copy_state_dict
    from stable_audio_tools.inference.generation import generate_diffusion_cond
    import torch
    import torchaudio

    web_app = FastAPI()

    SHARED_SECRET = os.environ["SOUND_EFFECTS_WORKER_SHARED_SECRET"]
    if not SHARED_SECRET:
        raise RuntimeError(
            "SOUND_EFFECTS_WORKER_SHARED_SECRET is empty — refusing to start, since a "
            "bare 'Bearer ' header would otherwise authenticate."
        )

    # Base checkpoint + model config: same checkpoint family as
    # worker-modal-music, downloaded/cached onto this worker's OWN Modal
    # Volume (sound-effects-checkpoints, separate from music-checkpoints —
    # this worker never loads a LoRA on top, see module docstring, but keeps
    # its own volume so a future dedicated SFX LoRA checkpoint can be dropped
    # in without touching the music worker's volume).
    MODEL_CONFIG_PATH = os.environ.get("SOUND_EFFECTS_MODEL_CONFIG_PATH", "/checkpoints/model_config.json")
    BASE_CKPT_PATH = os.environ.get("SOUND_EFFECTS_BASE_CKPT_PATH", "/checkpoints/model.safetensors")
    # Optional: only used if a dedicated sound-effect LoRA is trained later.
    # Absent by default — this worker runs the BASE checkpoint unmodified.
    SFX_LORA_CKPT_PATH = os.environ.get("SOUND_EFFECTS_LORA_CKPT_PATH", "")

    with open(MODEL_CONFIG_PATH) as f:
        model_config = json.load(f)

    model = create_model_from_config(model_config)
    copy_state_dict(model, load_ckpt_state_dict(BASE_CKPT_PATH))
    if SFX_LORA_CKPT_PATH:
        # Uses stable-audio-tools' own built-in LoRA support (the model
        # config's training.lora_config), the same mechanism
        # worker-modal-music/app.py uses — NOT the `peft` library, which
        # does not apply to this model's architecture.
        from stable_audio_tools.models.lora import load_and_apply_loras
        load_and_apply_loras(model, [SFX_LORA_CKPT_PATH], model_config["model_type"])
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
                conditioning = build_conditioning(body["prompt"], duration_sec)
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
                # torchaudio 2.x can't dispatch a backend for an in-memory
                # BytesIO target ("Couldn't find appropriate backend to
                # handle uri <_io.BytesIO ...> and format wav") - confirmed
                # live against a real deployed worker. A real file path with
                # a .wav extension lets it infer the backend the normal way.
                with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
                    torchaudio.save(tmp.name, audio, sample_rate=SAMPLE_RATE, format="wav")
                    tmp.seek(0)
                    return tmp.read()

            started = time.monotonic()
            wav_bytes = await asyncio.to_thread(_run_generation)
            # Wall-clock seconds the GPU spent on this request. The backend records it per job so usage can be
            # billed on measured resource time and reconciled against Modal's own bill.
            gpu_seconds = round(time.monotonic() - started, 3)
            return Response(content=wav_bytes, media_type="audio/wav", headers={"X-GPU-Seconds": str(gpu_seconds)})
        except Exception as e:  # noqa: BLE001 — surface as 500, let caller mark job failed
            response.status_code = 500
            return {"error": f"generation failed: {e}"}

    return web_app
