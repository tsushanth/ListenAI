# ReadAloud AI TTS Service - Multi-Model CPU Version
# Supports: XTTS v2 (high quality) and Kokoro-82M (fast, Apache licensed)
# For Cloud Run deployment (no GPU)

FROM python:3.11-slim

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
# espeak-ng is required for Kokoro phoneme processing
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    git \
    curl \
    espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Create directories for voice samples and cache
RUN mkdir -p /app/voice_samples /app/audio_cache

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies (CPU-only PyTorch)
# Must install torch ecosystem from CPU index first, then TTS
# Pin torch 2.5.x (2.6+ has weights_only=True by default which breaks TTS loading)
# Pin transformers before TTS to avoid compatibility issues
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir transformers==4.42.4 && \
    pip install --no-cache-dir -r requirements.txt

# Accept Coqui TOS for XTTS model
ENV COQUI_TOS_AGREED=1

# Set HuggingFace cache directory to persist in image
ENV HF_HOME=/app/.cache/huggingface
ENV HUGGINGFACE_HUB_CACHE=/app/.cache/huggingface/hub
RUN mkdir -p /app/.cache/huggingface/hub

# Copy model download script
COPY download_models.py .

# Pre-download all models and voices (baked into image for fast cold starts)
# This downloads XTTS v2 (~1.8GB) and Kokoro-82M with all voice packs (~500MB)
RUN python download_models.py

# Copy application code
COPY main.py .

# Environment variables
ENV PORT=8080
ENV DEFAULT_TTS_MODEL=kokoro
ENV VOICE_SAMPLES_DIR=/app/voice_samples
ENV AUDIO_CACHE_DIR=/app/audio_cache
ENV CACHE_ENABLED=true
ENV LOG_LEVEL=INFO

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the service
CMD ["python", "main.py"]
