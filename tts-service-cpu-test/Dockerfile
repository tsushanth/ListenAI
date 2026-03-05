# ReadAloud AI TTS - CPU-Only ONNX Version
# Much smaller image, no PyTorch, no CUDA
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive

# Minimal system deps - espeak-ng needed for misaki g2p phoneme processing
RUN apt-get update && apt-get install -y \
    libsndfile1 \
    curl \
    espeak-ng \
    wget \
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

ENV PORT=8080
ENV CACHE_ENABLED=true
ENV LOG_LEVEL=INFO

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["python", "main.py"]
