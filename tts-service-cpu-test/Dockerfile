# ReadAloud AI TTS - CPU-Only ONNX Version
# Much smaller image, no PyTorch, no CUDA
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal system deps. espeak-ng for misaki g2p phoneme processing.
# ffmpeg for Edge TTS MP3→WAV fallback (used for de/ko, languages
# Kokoro 82M doesn't cover).
RUN apt-get update && apt-get install -y \
    libsndfile1 \
    curl \
    espeak-ng \
    wget \
    ffmpeg \
    cron \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/audio_cache

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Set HuggingFace cache
ENV HF_HOME=/app/.cache/huggingface
RUN mkdir -p /app/.cache/huggingface

# Download ONNX model files from GitHub releases
RUN wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx -O /app/kokoro-v1.0.onnx && \
    wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin -O /app/voices-v1.0.bin

# Test model loading and pre-warm voices
COPY download_model.py .
RUN python download_model.py

COPY main.py .

# Nightly prune of /app/audio_cache: delete WAVs untouched in 7+ days at
# 03:00 UTC. Prevents the cache from filling the container's 7.8 GB rootfs
# and causing ENOSPC on subsequent renders (2026-07-25 incident: cache
# accumulated 16k files over 6 weeks and blocked every render).
RUN echo "0 3 * * * root find /app/audio_cache -maxdepth 1 -type f -name '*.wav' -mtime +7 -delete >> /var/log/audio-cache-prune.log 2>&1" \
    > /etc/cron.d/audio-cache-prune && \
    chmod 644 /etc/cron.d/audio-cache-prune && \
    touch /var/log/audio-cache-prune.log

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8080
ENV CACHE_ENABLED=true
ENV LOG_LEVEL=INFO

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["/entrypoint.sh"]
