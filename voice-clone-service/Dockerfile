# CPU-only voice-clone serving app (Chatterbox Turbo, MIT; Nano optional via BAKE_MODELS). Weights are baked in, so a cold start is
# process start + model load. Fly rejects images that unpack to more than 8 GiB: build tools are purged in the SAME layer they are
# installed in (a later layer cannot shrink an earlier one), and only the checkpoint files the loader reads are fetched.
FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/models/hf HF_HUB_DISABLE_XET=1 TOKENIZERS_PARALLELISM=false VC_ECAPA_DIR=/models/ecapa
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY requirements.txt .
# The upstream chatterbox repo is archived: pin the commit that was benchmarked (2026-11-06); Perth is pinned in requirements.txt.
ARG CHATTERBOX_REF=5de7a54aa4e5e2baadb0182dde554908b48b85c2
# CPU wheels only (default PyPI torch pulls ~2 GB of CUDA libraries we cannot use here).
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential \
    && pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt \
    && pip install --no-deps "chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@${CHATTERBOX_REF}" \
    && apt-get purge -y --auto-remove git build-essential && rm -rf /var/lib/apt/lists/* /root/.cache

COPY settings.py guards.py audio.py engine.py app.py main.py bake_weights.py ./
ARG BAKE_MODELS=turbo
RUN BAKE_MODELS=${BAKE_MODELS} python bake_weights.py && du -sh /models/* /usr/local/lib/python3.11/site-packages | sort -h | tail -5

# After baking, never touch the network for model files.
ENV HF_HUB_OFFLINE=1
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--timeout-keep-alive", "75"]
