"""
ReadAloud AI - CPU-Only TTS Service (Kokoro ONNX)
Lightweight, cost-effective TTS using ONNX Runtime instead of PyTorch+GPU.
API-compatible with the GPU service for benchmarking.
"""

import os
import io
import re
import time
import hashlib
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import soundfile as sf

# ============================================================================
# Configuration
# ============================================================================

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
PORT = int(os.getenv("PORT", "8080"))
KOKORO_SAMPLE_RATE = 24000

AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", "/app/audio_cache")
CACHE_ENABLED = os.getenv("CACHE_ENABLED", "true").lower() == "true"

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("tts-cpu-service")

# ============================================================================
# Kokoro ONNX Voice Mapping
# ============================================================================

KOKORO_VOICES = {
    "af_heart": "American Female (Heart)",
    "af_bella": "American Female (Bella)",
    "af_nicole": "American Female (Nicole)",
    "af_sarah": "American Female (Sarah)",
    "af_sky": "American Female (Sky)",
    "am_adam": "American Male (Adam)",
    "am_michael": "American Male (Michael)",
    "bf_emma": "British Female (Emma)",
    "bf_isabella": "British Female (Isabella)",
    "bm_george": "British Male (George)",
    "bm_lewis": "British Male (Lewis)",
}

# Map builtin voice IDs to Kokoro voices (same as GPU service)
BUILTIN_VOICES = {
    "default": {"name": "Heart (Default)", "kokoro_voice": "af_heart"},
    "alloy": {"name": "Alloy", "kokoro_voice": "af_bella"},
    "echo": {"name": "Echo", "kokoro_voice": "am_adam"},
    "fable": {"name": "Fable", "kokoro_voice": "bf_emma"},
    "onyx": {"name": "Onyx", "kokoro_voice": "bm_george"},
    "nova": {"name": "Nova", "kokoro_voice": "af_nicole"},
    "shimmer": {"name": "Shimmer", "kokoro_voice": "af_sky"},
    "adam": {"name": "Adam", "kokoro_voice": "am_adam"},
    "michael": {"name": "Michael", "kokoro_voice": "am_michael"},
    "heart": {"name": "Heart", "kokoro_voice": "af_heart"},
    "bella": {"name": "Bella", "kokoro_voice": "af_bella"},
    "nicole": {"name": "Nicole", "kokoro_voice": "af_nicole"},
    "sarah": {"name": "Sarah", "kokoro_voice": "af_sarah"},
    "sky": {"name": "Sky", "kokoro_voice": "af_sky"},
    "emma": {"name": "Emma", "kokoro_voice": "bf_emma"},
    "isabella": {"name": "Isabella", "kokoro_voice": "bf_isabella"},
    "george": {"name": "George", "kokoro_voice": "bm_george"},
    "lewis": {"name": "Lewis", "kokoro_voice": "bm_lewis"},
}

# ============================================================================
# Model Loading
# ============================================================================

kokoro_model = None
kokoro_voices_cache = {}


def load_kokoro():
    """Load Kokoro ONNX model."""
    global kokoro_model
    if kokoro_model is not None:
        return kokoro_model

    logger.info("Loading Kokoro ONNX model...")
    start_time = time.time()

    from kokoro_onnx import Kokoro
    kokoro_model = Kokoro("/app/kokoro-v1.0.onnx", "/app/voices-v1.0.bin")

    load_time = time.time() - start_time
    logger.info(f"Kokoro ONNX model loaded in {load_time:.2f}s")
    return kokoro_model


# ============================================================================
# Text Preprocessing (same as GPU service)
# ============================================================================

def preprocess_text_for_kokoro(text: str) -> str:
    """Preprocess text for Kokoro synthesis."""
    # Normalize paragraph breaks
    text = re.sub(r'\n{2,}', '\n\n', text)
    paragraphs = text.split('\n\n')
    processed = []
    for para in paragraphs:
        para = para.strip()
        if para:
            para = re.sub(r'\s+', ' ', para)
            processed.append(para)
    text = '\n\n'.join(processed)

    # Handle common abbreviations
    text = re.sub(r'(\d+)"', r'\1 inches', text)

    return text.strip()


# ============================================================================
# Cache
# ============================================================================

def get_cache_key(text: str, voice_id: str, language: str, speed: float) -> str:
    content = f"kokoro-onnx|{text}|{voice_id}|{language}|{speed}"
    return hashlib.md5(content.encode()).hexdigest()


def get_cached_audio(cache_key: str) -> Optional[bytes]:
    if not CACHE_ENABLED:
        return None
    cache_path = os.path.join(AUDIO_CACHE_DIR, f"{cache_key}.wav")
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return f.read()
    return None


def save_to_cache(cache_key: str, audio_data: bytes):
    if not CACHE_ENABLED:
        return
    os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(AUDIO_CACHE_DIR, f"{cache_key}.wav")
    with open(cache_path, "wb") as f:
        f.write(audio_data)


# ============================================================================
# Synthesis
# ============================================================================

def synthesize_with_kokoro_onnx(text: str, voice_id: str, speed: float) -> tuple:
    """Synthesize using Kokoro ONNX model."""
    model = load_kokoro()

    processed_text = preprocess_text_for_kokoro(text)
    logger.info(f"ONNX synthesis: voice={voice_id}, original_len={len(text)}, processed_len={len(processed_text)}")

    samples, sample_rate = model.create(
        processed_text, voice=voice_id, speed=speed, lang="en-us"
    )

    return samples, sample_rate


# ============================================================================
# FastAPI App
# ============================================================================

app = FastAPI(title="ReadAloud TTS CPU (ONNX)", version="1.0.0")


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=50000)
    voice_id: str = Field(default="default")
    language: str = Field(default="en")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    model: str = Field(default="kokoro")


class SynthesizeLongRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500000)
    voice_id: str = Field(default="default")
    language: str = Field(default="en")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    model: str = Field(default="kokoro")
    max_chunk_chars: int = Field(default=2000)


@app.on_event("startup")
async def startup_event():
    """Pre-load model on startup for faster first request."""
    logger.info("Pre-loading Kokoro ONNX model...")
    load_kokoro()
    logger.info("Model ready.")


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "model": "kokoro-onnx",
        "device": "cpu",
        "model_loaded": kokoro_model is not None,
    }


@app.get("/voices")
async def list_voices():
    return {"voices": KOKORO_VOICES}


def resolve_voice(voice_id: str) -> str:
    """Resolve a voice_id to a Kokoro voice name."""
    # Check builtin mapping
    voice_info = BUILTIN_VOICES.get(voice_id)
    if voice_info:
        return voice_info["kokoro_voice"]

    # Check if it's a direct Kokoro voice ID
    if re.match(r'^[ab][fm]_\w+$', voice_id) and voice_id in KOKORO_VOICES:
        return voice_id

    # Default fallback
    logger.warning(f"Unknown voice_id '{voice_id}', using af_heart")
    return "af_heart"


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest, background_tasks: BackgroundTasks):
    """Synthesize text to speech using Kokoro ONNX (CPU)."""
    voice = resolve_voice(request.voice_id)

    # Check cache
    cache_key = get_cache_key(f"kokoro|{request.text}", request.voice_id, request.language, request.speed)
    cached = get_cached_audio(cache_key)
    if cached:
        return StreamingResponse(
            io.BytesIO(cached),
            media_type="audio/wav",
            headers={"X-Cache": "HIT", "X-Voice-ID": request.voice_id, "X-Model": "kokoro-onnx"}
        )

    start_time = time.time()

    try:
        wav_array, sample_rate = synthesize_with_kokoro_onnx(request.text, voice, request.speed)

        audio_buffer = io.BytesIO()
        sf.write(audio_buffer, wav_array, sample_rate, format='WAV')
        audio_buffer.seek(0)
        audio_data = audio_buffer.read()

        synthesis_time = time.time() - start_time
        logger.info(f"Synthesis completed in {synthesis_time:.2f}s, size={len(audio_data)} bytes")

        background_tasks.add_task(save_to_cache, cache_key, audio_data)

        return StreamingResponse(
            io.BytesIO(audio_data),
            media_type="audio/wav",
            headers={
                "X-Cache": "MISS",
                "X-Voice-ID": request.voice_id,
                "X-Model": "kokoro-onnx",
                "X-Synthesis-Time-Ms": str(int(synthesis_time * 1000)),
                "X-Character-Count": str(len(request.text)),
                "X-Device": "cpu",
            }
        )
    except Exception as e:
        logger.error(f"Synthesis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {str(e)}")


@app.post("/synthesize-long")
async def synthesize_long(request: SynthesizeLongRequest):
    """Synthesize long text using Kokoro ONNX (CPU)."""
    voice = resolve_voice(request.voice_id)

    cache_key = get_cache_key(f"kokoro|{request.text}", request.voice_id, request.language, request.speed)
    cached = get_cached_audio(cache_key)

    start_time = time.time()

    if cached:
        audio_data = cached
        logger.info(f"Long synthesis from cache: {len(request.text)} chars")
    else:
        logger.info(f"Long synthesis: {len(request.text)} chars")
        wav_array, sample_rate = synthesize_with_kokoro_onnx(request.text, voice, request.speed)

        audio_buffer = io.BytesIO()
        sf.write(audio_buffer, wav_array, sample_rate, format='WAV')
        audio_buffer.seek(0)
        audio_data = audio_buffer.read()
        save_to_cache(cache_key, audio_data)

    total_time = time.time() - start_time

    return StreamingResponse(
        io.BytesIO(audio_data),
        media_type="audio/wav",
        headers={
            "X-Cache": "HIT" if cached else "MISS",
            "X-Voice-ID": request.voice_id,
            "X-Model": "kokoro-onnx",
            "X-Synthesis-Time-Ms": str(int(total_time * 1000)),
            "X-Character-Count": str(len(request.text)),
            "X-Device": "cpu",
        }
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
