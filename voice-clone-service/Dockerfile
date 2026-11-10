# CPU-only voice-clone serving app (Chatterbox Turbo/Nano, MIT). Weights are baked in so a cold start is just process start + model load.
FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/models/hf HF_HUB_DISABLE_XET=1 TOKENIZERS_PARALLELISM=false VC_ECAPA_DIR=/models/ecapa
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# CPU wheels only (the default PyPI torch pulls ~2 GB of CUDA libraries we cannot use here).
RUN pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install -r requirements.txt
# The upstream repo is archived: pin the commit that was benchmarked (2026-11-06) and Perth (pinned in requirements.txt).
ARG CHATTERBOX_REF=5de7a54aa4e5e2baadb0182dde554908b48b85c2
RUN pip install --no-deps "chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@${CHATTERBOX_REF}"

COPY settings.py guards.py audio.py engine.py app.py main.py bake_weights.py ./
RUN python bake_weights.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--timeout-keep-alive", "75"]
