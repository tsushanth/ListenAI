"""Modal deployment of the multilingual voice-clone serving app (GPU, scale to zero). Same HTTP contract as the Fly CPU app, so the backend
treats it as another serving app (VOICE_CLONE_ML_SERVICE_URL / VOICE_CLONE_ML_SERVICE_SECRET). Engine: engine_omnivoice.py.

Deploy from a clean checkout:   modal deploy voice-clone-service/modal_app.py
Secret `readaloud-clone-ml` (never in git): VC_SERVICE_SECRET, VC_ENGINE=omnivoice, VC_LANGS, VC_DATA_DIR=/data, optional VC_* limits.
State: Modal Volume `readaloud-clone-ml-voices` at /data (reference audio, transcript prompt, meta per voice). Deleting a voice removes its
directory. Kill switch: `modal app stop readaloud-clone-ml`, or VC_DISABLED=true in the secret, or a file /data/KILL.
"""
import os
import threading
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
APP_NAME = "readaloud-clone-ml"
VOLUME_NAME = "readaloud-clone-ml-voices"
PERTH_PIN = "ff1c8ac55a976971245cdd53c18d6131ca00d993"  # same commit as the CPU service

app = modal.App(APP_NAME)
voices = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


def _bake():
    """Weights are baked into the image: a cold start is container start + model load, no download."""
    from huggingface_hub import snapshot_download

    snapshot_download("k2-fsa/OmniVoice")
    snapshot_download("openai/whisper-large-v3-turbo", allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model"])
    snapshot_download("MIT/ast-finetuned-audioset-10-10-0.4593")
    import sys

    sys.path.insert(0, "/app")
    from engine import speechbrain_hf_compat
    from speechbrain.inference.speaker import EncoderClassifier

    speechbrain_hf_compat()
    EncoderClassifier.from_hparams("speechbrain/spkrec-ecapa-voxceleb", savedir="/models/ecapa", run_opts={"device": "cpu"})


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1", "build-essential")
    .pip_install("torch==2.8.0", "torchaudio==2.8.0")
    .pip_install("omnivoice", "soundfile", "fastapi", "uvicorn[standard]", "python-multipart", "librosa", "speechbrain==1.0.2",
                 "transformers", "langdetect", "numpy", "pyloudnorm", "huggingface_hub")
    .pip_install(f"resemble-perth @ git+https://github.com/resemble-ai/Perth.git@{PERTH_PIN}")
    .env({"HF_HOME": "/models/hf", "VC_ECAPA_DIR": "/models/ecapa", "TOKENIZERS_PARALLELISM": "false"})
    .add_local_dir(HERE, "/app", copy=True, ignore=["tests", "__pycache__", "*.pyc", "Dockerfile", "fly.toml", "scripts", ".dockerignore", "*.md"])
    .run_function(_bake)
)


@app.function(
    image=image,
    gpu=["L4", "A10G"],
    secrets=[modal.Secret.from_name("readaloud-clone-ml")],
    volumes={"/data": voices},
    min_containers=0,
    max_containers=1,          # voices live on one volume: one container keeps writes and the per-voice caches consistent
    scaledown_window=180,
    timeout=3600,
)
@modal.concurrent(max_inputs=16)  # the app's own queue (1 running + VC_MAX_QUEUE waiting) bounds the GPU work
@modal.asgi_app()
def web():
    import sys

    sys.path.insert(0, "/app")
    os.chdir("/app")
    import main  # builds the engine (loads weights in a thread) and the FastAPI app; requests wait on engine.ready

    def _commit_loop():
        while True:
            time.sleep(15)
            try:
                voices.commit()
            except Exception as e:  # noqa: BLE001
                print(f'{{"event":"volume_commit_failed","error":"{type(e).__name__}"}}', flush=True)

    threading.Thread(target=_commit_loop, daemon=True).start()
    return main.app
