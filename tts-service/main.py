"""
ReadAloud AI - Self-Hosted TTS Service
Multi-model TTS service supporting:
- Coqui XTTS v2: High-quality voice cloning (non-commercial license)
- Kokoro-82M: Fast, lightweight, commercially licensed (Apache 2.0)
- Chatterbox: Voice cloning with reference audio, MIT license (commercial OK)

This service runs on Cloud Run and provides an HTTP API
compatible with the ReadAloud AI backend.
"""

import os
import io
import re
import time
import hashlib
import logging
import tempfile
import shutil
from typing import Optional, List
from pathlib import Path

import torch
import numpy as np
from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
import soundfile as sf
import httpx

# Conditional imports - models loaded on demand
TTS = None  # Coqui TTS
KPipeline = None  # Kokoro
ChatterboxModel = None  # Chatterbox

# ============================================================================
# Configuration
# ============================================================================

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
DEFAULT_MODEL = os.getenv("DEFAULT_TTS_MODEL", "xtts")  # "xtts" or "kokoro"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
API_KEY = os.getenv("TTS_API_KEY", "")  # Optional API key for auth
PORT = int(os.getenv("PORT", "8080"))

# Voice sample directory (for voice cloning)
VOICE_SAMPLES_DIR = os.getenv("VOICE_SAMPLES_DIR", "/app/voice_samples")

# Audio cache directory
AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", "/app/audio_cache")
CACHE_ENABLED = os.getenv("CACHE_ENABLED", "true").lower() == "true"

# Model-specific settings
XTTS_MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"
KOKORO_SAMPLE_RATE = 24000
XTTS_SAMPLE_RATE = 24000
CHATTERBOX_SAMPLE_RATE = 24000

# Cloned voices cache directory (downloaded from Supabase)
CLONED_VOICES_CACHE_DIR = os.getenv("CLONED_VOICES_CACHE_DIR", "/app/cloned_voices_cache")

# Target amplitude for audio normalization (90% of max to avoid clipping)
NORMALIZE_TARGET_AMPLITUDE = 0.9

# ============================================================================
# Logging
# ============================================================================

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("tts-service")

# ============================================================================
# Metrics Tracking
# ============================================================================

class SynthesisMetrics:
    """Track synthesis metrics for monitoring and alerting."""

    def __init__(self):
        self.reset()

    def reset(self):
        """Reset all metrics."""
        self.total_requests = 0
        self.successful_requests = 0
        self.failed_requests = 0
        self.cuda_errors = 0
        self.audio_validation_errors = 0
        self.model_load_errors = 0
        self.download_errors = 0
        self.last_cuda_error_time = None
        self.cuda_error_count_since_restart = 0
        self.service_start_time = time.time()

    def record_success(self, model: str, synthesis_time_ms: int, char_count: int):
        """Record a successful synthesis."""
        self.total_requests += 1
        self.successful_requests += 1
        logger.info(f"METRIC: synthesis_success model={model} time_ms={synthesis_time_ms} chars={char_count}")

    def record_failure(self, model: str, error_type: str, error_message: str):
        """Record a failed synthesis."""
        self.total_requests += 1
        self.failed_requests += 1
        logger.error(f"METRIC: synthesis_failure model={model} error_type={error_type} error={error_message}")

        if error_type == "cuda_error":
            self.cuda_errors += 1
            self.cuda_error_count_since_restart += 1
            self.last_cuda_error_time = time.time()
        elif error_type == "audio_validation":
            self.audio_validation_errors += 1
        elif error_type == "model_load":
            self.model_load_errors += 1
        elif error_type == "download":
            self.download_errors += 1

    def get_stats(self) -> dict:
        """Get current metrics."""
        uptime_seconds = time.time() - self.service_start_time
        return {
            "uptime_seconds": int(uptime_seconds),
            "total_requests": self.total_requests,
            "successful_requests": self.successful_requests,
            "failed_requests": self.failed_requests,
            "success_rate": self.successful_requests / max(1, self.total_requests),
            "cuda_errors": self.cuda_errors,
            "cuda_errors_since_restart": self.cuda_error_count_since_restart,
            "audio_validation_errors": self.audio_validation_errors,
            "model_load_errors": self.model_load_errors,
            "download_errors": self.download_errors,
            "last_cuda_error_time": self.last_cuda_error_time,
        }

    def is_cuda_healthy(self) -> bool:
        """Check if CUDA appears healthy based on recent errors."""
        # If we've had CUDA errors recently, consider it unhealthy
        if self.cuda_error_count_since_restart > 0:
            return False
        return True


# Global metrics instance
metrics = SynthesisMetrics()


# ============================================================================
# Audio Validation
# ============================================================================

def validate_audio_file(file_path: str, min_duration_sec: float = 1.0, max_duration_sec: float = 300.0) -> tuple[bool, str]:
    """
    Validate an audio file before using it for synthesis.

    Checks:
    - File exists and is readable
    - Valid audio format (can be decoded)
    - Sample rate is reasonable (8kHz - 48kHz)
    - Duration is within bounds
    - No NaN/Inf values in audio data

    Returns:
        tuple: (is_valid, message)
    """
    if not os.path.exists(file_path):
        return False, f"File not found: {file_path}"

    file_size = os.path.getsize(file_path)
    if file_size < 1000:  # Less than 1KB is suspicious
        return False, f"File too small ({file_size} bytes), likely corrupted"

    try:
        # Try reading with soundfile (handles WAV, FLAC, OGG)
        info = sf.info(file_path)

        # Check sample rate
        if info.samplerate < 8000 or info.samplerate > 48000:
            return False, f"Invalid sample rate: {info.samplerate}Hz (expected 8000-48000Hz)"

        # Check duration
        if info.duration < min_duration_sec:
            return False, f"Audio too short: {info.duration:.2f}s (minimum {min_duration_sec}s)"

        if info.duration > max_duration_sec:
            return False, f"Audio too long: {info.duration:.2f}s (maximum {max_duration_sec}s)"

        # Check channels (Chatterbox expects mono)
        if info.channels > 2:
            return False, f"Too many channels: {info.channels} (expected 1-2)"

        # Read a small sample to check for corruption
        try:
            audio_data, sr = sf.read(file_path, frames=int(info.samplerate * 1))  # Read 1 second
            if np.any(np.isnan(audio_data)) or np.any(np.isinf(audio_data)):
                return False, "Audio contains NaN or Inf values"
        except Exception as e:
            return False, f"Failed to read audio data: {e}"

        logger.info(f"Audio validation passed: {file_path} - {info.samplerate}Hz, {info.channels}ch, {info.duration:.2f}s")
        return True, f"Valid: {info.duration:.2f}s, {info.samplerate}Hz, {info.channels}ch"

    except Exception as e:
        # soundfile failed, try with librosa as fallback
        try:
            import librosa
            audio, sr = librosa.load(file_path, sr=None, mono=True, duration=10)  # Load up to 10s
            duration = len(audio) / sr

            if duration < min_duration_sec:
                return False, f"Audio too short: {duration:.2f}s (minimum {min_duration_sec}s)"

            if np.any(np.isnan(audio)) or np.any(np.isinf(audio)):
                return False, "Audio contains NaN or Inf values"

            logger.info(f"Audio validation passed (via librosa): {file_path} - {sr}Hz, {duration:.2f}s")
            return True, f"Valid (librosa): {duration:.2f}s, {sr}Hz"

        except Exception as e2:
            return False, f"Cannot read audio file: {e} / {e2}"


def check_cuda_health() -> tuple[bool, str]:
    """Check if CUDA is healthy and can be used."""
    if not torch.cuda.is_available():
        return True, "CUDA not available (using CPU)"

    try:
        # Try a simple CUDA operation
        test_tensor = torch.zeros(10, device='cuda')
        result = test_tensor.sum().item()
        del test_tensor
        torch.cuda.empty_cache()
        return True, "CUDA healthy"
    except Exception as e:
        error_str = str(e)
        logger.error(f"CUDA health check failed: {error_str}")
        return False, f"CUDA unhealthy: {error_str}"

# ============================================================================
# FastAPI App
# ============================================================================

app = FastAPI(
    title="ReadAloud AI TTS Service",
    description="Self-hosted TTS with voice cloning (Kokoro, Chatterbox, XTTS)",
    version="2.0.0"
)

# ============================================================================
# TTS Model Loading
# ============================================================================

# Model instances (loaded on demand)
xtts_model = None
kokoro_pipeline = None
chatterbox_model = None

def load_xtts():
    """Load XTTS v2 model."""
    global xtts_model
    if xtts_model is not None:
        return xtts_model

    logger.info(f"Loading XTTS model: {XTTS_MODEL_NAME}")
    logger.info(f"Device: {DEVICE}")

    start_time = time.time()

    # PyTorch 2.6+ changed weights_only default to True, breaking TTS model loading.
    # Monkey-patch torch.load to use weights_only=False for TTS compatibility.
    # This is safe since we trust the TTS model checkpoints from HuggingFace.
    import torch
    _original_torch_load = torch.load
    def _patched_torch_load(*args, **kwargs):
        if 'weights_only' not in kwargs:
            kwargs['weights_only'] = False
        return _original_torch_load(*args, **kwargs)
    torch.load = _patched_torch_load

    from TTS.api import TTS
    xtts_model = TTS(XTTS_MODEL_NAME).to(DEVICE)

    # Restore original torch.load
    torch.load = _original_torch_load

    load_time = time.time() - start_time
    logger.info(f"XTTS model loaded in {load_time:.2f}s")

    return xtts_model

def load_kokoro():
    """Load Kokoro-82M model."""
    global kokoro_pipeline
    if kokoro_pipeline is not None:
        return kokoro_pipeline

    logger.info("Loading Kokoro-82M model...")
    start_time = time.time()

    from kokoro import KPipeline
    kokoro_pipeline = KPipeline(lang_code='a')  # 'a' = American English

    load_time = time.time() - start_time
    logger.info(f"Kokoro model loaded in {load_time:.2f}s")

    return kokoro_pipeline

def load_chatterbox():
    """Load Chatterbox model for voice cloning."""
    global chatterbox_model
    if chatterbox_model is not None:
        return chatterbox_model

    logger.info("Loading Chatterbox model...")
    start_time = time.time()

    try:
        from chatterbox.tts import ChatterboxTTS
        chatterbox_model = ChatterboxTTS.from_pretrained(device=DEVICE)
        load_time = time.time() - start_time
        logger.info(f"Chatterbox model loaded in {load_time:.2f}s on {DEVICE}")
    except ImportError as e:
        logger.error(f"Failed to import Chatterbox: {e}. Voice cloning will be unavailable.")
        return None
    except Exception as e:
        logger.error(f"Failed to load Chatterbox model: {e}")
        return None

    return chatterbox_model

def get_model(model_type: str):
    """Get the requested model, loading if necessary."""
    if model_type == "kokoro":
        return load_kokoro()
    elif model_type == "chatterbox":
        return load_chatterbox()
    else:
        return load_xtts()

@app.on_event("startup")
async def startup_event():
    """Initialize default model on startup."""
    # Load default model
    if DEFAULT_MODEL == "kokoro":
        load_kokoro()
    elif DEFAULT_MODEL == "chatterbox":
        load_chatterbox()
    else:
        load_xtts()

    # Create directories
    os.makedirs(VOICE_SAMPLES_DIR, exist_ok=True)
    os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)
    os.makedirs(CLONED_VOICES_CACHE_DIR, exist_ok=True)

# ============================================================================
# Request/Response Models
# ============================================================================

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=10000)
    voice_id: str = Field(default="default")
    language: str = Field(default="en")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    model: str = Field(default="xtts", description="TTS model: 'xtts' or 'kokoro'")

class SynthesizeLongRequest(BaseModel):
    """Request for synthesizing long documents (PDFs, articles, etc.)"""
    text: str = Field(..., min_length=1, max_length=500000)  # ~100 pages
    voice_id: str = Field(default="default")
    language: str = Field(default="en")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    model: str = Field(default="xtts", description="TTS model: 'xtts' or 'kokoro'")
    # Chunk size: 250 for self-hosted (CPU), 2000-3000 for cloud providers
    max_chunk_chars: int = Field(default=250, ge=50, le=5000)  # Characters per chunk

class ChunkInfo(BaseModel):
    """Info about a single chunk"""
    index: int
    text: str
    char_count: int
    status: str  # pending, processing, completed, failed
    audio_size: Optional[int] = None
    synthesis_time_ms: Optional[int] = None

class SynthesizeLongResponse(BaseModel):
    """Response for long document synthesis"""
    job_id: str
    total_chunks: int
    total_chars: int
    estimated_duration_s: int
    chunks: List[ChunkInfo]

class VoiceInfo(BaseModel):
    id: str
    name: str
    language: str
    gender: str
    description: str

class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    gpu_available: bool
    gpu_name: Optional[str] = None

# ============================================================================
# Built-in Voice Presets
# ============================================================================

# XTTS v2 default speaker
XTTS_DEFAULT_SPEAKER = "Ana Florence"

# Kokoro voice IDs (from https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
# Format: af_* = American Female, am_* = American Male, bf_* = British Female, etc.
KOKORO_VOICES = {
    "af_heart": "American Female - Heart (default)",
    "af_bella": "American Female - Bella",
    "af_nicole": "American Female - Nicole",
    "af_sarah": "American Female - Sarah",
    "af_sky": "American Female - Sky",
    "am_adam": "American Male - Adam",
    "am_michael": "American Male - Michael",
    "bf_emma": "British Female - Emma",
    "bf_isabella": "British Female - Isabella",
    "bm_george": "British Male - George",
    "bm_lewis": "British Male - Lewis",
}

# Unified voice presets with mappings for each model
BUILTIN_VOICES = {
    "rachel": {
        "name": "Rachel",
        "description": "Warm & Clear female voice",
        "language": "en",
        "gender": "female",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "af_nicole",
        "sample_file": None
    },
    "adam": {
        "name": "Adam",
        "description": "Professional male narrator",
        "language": "en",
        "gender": "male",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "am_adam",
        "sample_file": None
    },
    # Direct Kokoro voice ID aliases (iOS sends these directly)
    "am_adam": {
        "name": "Adam (Kokoro)",
        "description": "Professional male narrator",
        "language": "en",
        "gender": "male",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "am_adam",
        "sample_file": None
    },
    "af_nicole": {
        "name": "Nicole (Kokoro)",
        "description": "Warm & Clear female voice",
        "language": "en",
        "gender": "female",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "af_nicole",
        "sample_file": None
    },
    "af_bella": {
        "name": "Bella (Kokoro)",
        "description": "Calm & Soothing female voice",
        "language": "en",
        "gender": "female",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "af_bella",
        "sample_file": None
    },
    "am_michael": {
        "name": "Michael (Kokoro)",
        "description": "Storyteller male voice",
        "language": "en",
        "gender": "male",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "am_michael",
        "sample_file": None
    },
    "bf_emma": {
        "name": "Emma (Kokoro)",
        "description": "Elegant British female voice",
        "language": "en",
        "gender": "female",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "bf_emma",
        "sample_file": None
    },
    "bm_george": {
        "name": "George (Kokoro)",
        "description": "Deep British male voice",
        "language": "en",
        "gender": "male",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "bm_george",
        "sample_file": None
    },
    "brian": {
        "name": "Brian",
        "description": "Deep British male voice",
        "language": "en",
        "gender": "male",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "bm_george",
        "sample_file": None
    },
    "bella": {
        "name": "Bella",
        "description": "Calm & Soothing female voice",
        "language": "en",
        "gender": "female",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "af_bella",
        "sample_file": None
    },
    "josh": {
        "name": "Josh",
        "description": "Storyteller male voice",
        "language": "en",
        "gender": "male",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "am_michael",
        "sample_file": None
    },
    "charlotte": {
        "name": "Charlotte",
        "description": "Elegant & Articulate female voice",
        "language": "en",
        "gender": "female",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "bf_emma",
        "sample_file": None
    },
    "default": {
        "name": "Default",
        "description": "Default voice (Adam)",
        "language": "en",
        "gender": "male",
        "xtts_speaker": XTTS_DEFAULT_SPEAKER,
        "kokoro_voice": "am_adam",
        "sample_file": None
    }
}

# ============================================================================
# Text Chunking for Long Documents
# ============================================================================

def split_into_sentences(text: str) -> List[str]:
    """Split text into sentences using regex."""
    # First, normalize paragraph breaks to ensure they become sentence boundaries
    # Replace multiple newlines (paragraph breaks) with a period + space
    text = re.sub(r'\n\s*\n+', '. ', text)
    # Replace single newlines with space (soft line breaks within paragraphs)
    text = re.sub(r'\n', ' ', text)
    # Clean up multiple spaces
    text = re.sub(r'\s+', ' ', text)

    # Handle common abbreviations to avoid false splits
    text = text.replace("Mr.", "Mr\x00")
    text = text.replace("Mrs.", "Mrs\x00")
    text = text.replace("Dr.", "Dr\x00")
    text = text.replace("Ms.", "Ms\x00")
    text = text.replace("Prof.", "Prof\x00")
    text = text.replace("Jr.", "Jr\x00")
    text = text.replace("Sr.", "Sr\x00")
    text = text.replace("vs.", "vs\x00")
    text = text.replace("etc.", "etc\x00")
    text = text.replace("i.e.", "ie\x00")
    text = text.replace("e.g.", "eg\x00")

    # Split on sentence boundaries
    sentences = re.split(r'(?<=[.!?])\s+', text)

    # Restore abbreviations
    sentences = [s.replace("\x00", ".") for s in sentences]

    # Filter empty sentences and strip whitespace
    return [s.strip() for s in sentences if s.strip()]

def chunk_text(text: str, max_chunk_chars: int = 250) -> List[str]:
    """
    Split long text into chunks suitable for TTS synthesis.

    Strategy:
    1. Split into sentences
    2. Group sentences into chunks up to max_chunk_chars
    3. Never split mid-sentence (better prosody)
    """
    sentences = split_into_sentences(text)
    chunks = []
    current_chunk = ""

    for sentence in sentences:
        # If single sentence is too long, we need to split it
        if len(sentence) > max_chunk_chars:
            # Save current chunk if not empty
            if current_chunk:
                chunks.append(current_chunk.strip())
                current_chunk = ""

            # Split long sentence by clauses (commas, semicolons)
            parts = re.split(r'(?<=[,;:])\s+', sentence)
            for part in parts:
                if len(current_chunk) + len(part) + 1 <= max_chunk_chars:
                    current_chunk += " " + part if current_chunk else part
                else:
                    if current_chunk:
                        chunks.append(current_chunk.strip())
                    current_chunk = part
        elif len(current_chunk) + len(sentence) + 1 <= max_chunk_chars:
            # Add sentence to current chunk
            current_chunk += " " + sentence if current_chunk else sentence
        else:
            # Start new chunk
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = sentence

    # Don't forget the last chunk
    if current_chunk:
        chunks.append(current_chunk.strip())

    return chunks

# ============================================================================
# Caching
# ============================================================================

def get_cache_key(text: str, voice_id: str, language: str, speed: float) -> str:
    """Generate a cache key for the synthesis request."""
    content = f"{text}|{voice_id}|{language}|{speed}"
    return hashlib.md5(content.encode()).hexdigest()

def get_cached_audio(cache_key: str) -> Optional[bytes]:
    """Retrieve cached audio if available."""
    if not CACHE_ENABLED:
        return None

    cache_path = os.path.join(AUDIO_CACHE_DIR, f"{cache_key}.mp3")
    if os.path.exists(cache_path):
        logger.debug(f"Cache hit: {cache_key}")
        with open(cache_path, "rb") as f:
            return f.read()
    return None

def save_to_cache(cache_key: str, audio_data: bytes):
    """Save audio to cache."""
    if not CACHE_ENABLED:
        return

    cache_path = os.path.join(AUDIO_CACHE_DIR, f"{cache_key}.mp3")
    with open(cache_path, "wb") as f:
        f.write(audio_data)
    logger.debug(f"Cached: {cache_key}")

# ============================================================================
# API Endpoints
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint with metrics and CUDA health status."""
    gpu_name = None
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)

    models_loaded = []
    if xtts_model is not None:
        models_loaded.append("xtts")
    if kokoro_pipeline is not None:
        models_loaded.append("kokoro")
    if chatterbox_model is not None:
        models_loaded.append("chatterbox")

    # Check CUDA health
    cuda_healthy, cuda_status = check_cuda_health()

    # Get metrics
    stats = metrics.get_stats()

    # Check if Chatterbox module is importable (critical for voice cloning)
    chatterbox_importable = False
    try:
        from chatterbox.tts import ChatterboxTTS
        chatterbox_importable = True
    except ImportError:
        pass

    # Determine overall status
    if not cuda_healthy:
        status = "degraded"
    elif models_loaded:
        status = "ok"
    else:
        status = "loading"

    return {
        "status": status,
        "default_model": DEFAULT_MODEL,
        "models_loaded": models_loaded,
        "models_available": ["xtts", "kokoro", "chatterbox"],
        "device": DEVICE,
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": gpu_name,
        "voice_cloning_available": chatterbox_model is not None,
        "voice_cloning_module_installed": chatterbox_importable,
        "cuda_healthy": cuda_healthy,
        "cuda_status": cuda_status,
        "metrics": stats
    }


@app.get("/capabilities")
async def get_capabilities():
    """
    Report which capabilities are available on this service instance.

    This endpoint is used for:
    1. Pre-deployment validation (smoke tests)
    2. Canary deployment health checks
    3. Client feature detection

    Returns detailed information about what features are available.
    """
    # Check module availability
    chatterbox_importable = False
    chatterbox_import_error = None
    try:
        from chatterbox.tts import ChatterboxTTS
        chatterbox_importable = True
    except ImportError as e:
        chatterbox_import_error = str(e)

    xtts_importable = False
    xtts_import_error = None
    try:
        from TTS.api import TTS as XTTS_TTS
        xtts_importable = True
    except ImportError as e:
        xtts_import_error = str(e)

    kokoro_importable = False
    kokoro_import_error = None
    try:
        from kokoro import KPipeline
        kokoro_importable = True
    except ImportError as e:
        kokoro_import_error = str(e)

    # Check CUDA
    cuda_available = torch.cuda.is_available()
    cuda_device_name = torch.cuda.get_device_name(0) if cuda_available else None

    # Model load status
    models_loaded = {
        "kokoro": kokoro_pipeline is not None,
        "xtts": xtts_model is not None,
        "chatterbox": chatterbox_model is not None,
    }

    return {
        "service_version": "2.0.0",
        "capabilities": {
            "standard_tts": {
                "available": kokoro_importable,
                "models": ["kokoro"] if kokoro_importable else [],
                "error": kokoro_import_error,
            },
            "voice_cloning": {
                "available": chatterbox_importable or xtts_importable,
                "models": [
                    m for m, available in [
                        ("chatterbox", chatterbox_importable),
                        ("xtts", xtts_importable)
                    ] if available
                ],
                "chatterbox_error": chatterbox_import_error,
                "xtts_error": xtts_import_error,
            },
        },
        "hardware": {
            "device": DEVICE,
            "cuda_available": cuda_available,
            "gpu_name": cuda_device_name,
        },
        "models_loaded": models_loaded,
        "ready_for_voice_cloning": chatterbox_importable and (chatterbox_model is not None or cuda_available),
    }


@app.get("/metrics")
async def get_metrics():
    """Get detailed synthesis metrics for monitoring."""
    stats = metrics.get_stats()
    cuda_healthy, cuda_status = check_cuda_health()

    return {
        "cuda_healthy": cuda_healthy,
        "cuda_status": cuda_status,
        "needs_restart": not cuda_healthy or stats["cuda_errors_since_restart"] > 0,
        **stats
    }

@app.get("/voices")
async def list_voices():
    """List available voices."""
    voices = []
    for voice_id, info in BUILTIN_VOICES.items():
        voices.append(VoiceInfo(
            id=voice_id,
            name=info["name"],
            language=info["language"],
            gender=info["gender"],
            description=info["description"]
        ))
    return {"voices": voices}

def synthesize_with_xtts(text: str, voice_info: dict, language: str, speed: float) -> tuple:
    """Synthesize using XTTS v2 model."""
    model = load_xtts()
    speaker = voice_info.get("xtts_speaker", XTTS_DEFAULT_SPEAKER)
    speaker_wav = None

    # Check if there's a custom sample file for this voice
    if voice_info.get("sample_file"):
        sample_path = os.path.join(VOICE_SAMPLES_DIR, voice_info["sample_file"])
        if os.path.exists(sample_path):
            speaker_wav = sample_path
            logger.info(f"Using custom voice sample: {sample_path}")

    # Synthesize audio using XTTS v2
    if speaker_wav:
        wav = model.tts(
            text=text,
            speaker_wav=speaker_wav,
            language=language,
            speed=speed
        )
    else:
        wav = model.tts(
            text=text,
            speaker=speaker,
            language=language,
            speed=speed
        )

    wav_array = np.array(wav)
    sample_rate = model.synthesizer.output_sample_rate if hasattr(model, 'synthesizer') else XTTS_SAMPLE_RATE

    return wav_array, sample_rate


XTTS_MAX_CHUNK_CHARS = 500  # Maximum chars per chunk for XTTS


def synthesize_with_xtts_cloned(
    text: str,
    reference_audio_path: str,
    language: str = "en",
    speed: float = 1.0
) -> tuple:
    """
    Synthesize speech using XTTS v2 with voice cloning from a reference audio file.

    XTTS v2 natively supports voice cloning via the speaker_wav parameter.
    This provides an alternative to Chatterbox with different voice characteristics.

    For long texts, this function automatically chunks the text and concatenates
    the audio segments.

    Args:
        text: Text to synthesize
        reference_audio_path: Path to the reference audio file for voice cloning
        language: Language code (default: "en")
        speed: Speech speed multiplier (0.5-2.0)

    Returns:
        tuple: (wav_array, sample_rate)
    """
    # Validate the reference audio file
    is_valid, validation_msg = validate_audio_file(reference_audio_path, min_duration_sec=1.0)
    if not is_valid:
        metrics.record_failure("xtts", "audio_validation", validation_msg)
        logger.error(f"Audio validation failed for XTTS: {reference_audio_path}: {validation_msg}")
        raise HTTPException(
            status_code=400,
            detail=f"Reference audio file is invalid: {validation_msg}. Please re-record your voice clone."
        )

    # Check if we need to chunk the text
    if len(text) > XTTS_MAX_CHUNK_CHARS:
        logger.info(f"Text too long ({len(text)} chars), chunking for XTTS synthesis")
        return synthesize_with_xtts_cloned_chunked(
            text=text,
            reference_audio_path=reference_audio_path,
            language=language,
            speed=speed
        )

    # Load XTTS model
    model = load_xtts()
    if model is None:
        metrics.record_failure("xtts", "model_load", "XTTS model not available")
        raise HTTPException(status_code=503, detail="XTTS model not available")

    logger.info(f"XTTS cloned synthesis: text_len={len(text)}, ref_audio={reference_audio_path}, lang={language}")

    start_time = time.time()

    try:
        # Clear CUDA cache before synthesis
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        # Generate audio with XTTS using the reference audio for voice cloning
        wav = model.tts(
            text=text,
            speaker_wav=reference_audio_path,
            language=language,
            speed=speed
        )

        wav_array = np.array(wav)
        sample_rate = model.synthesizer.output_sample_rate if hasattr(model, 'synthesizer') else XTTS_SAMPLE_RATE

        synthesis_time = time.time() - start_time
        logger.info(f"XTTS cloned synthesis complete in {synthesis_time:.2f}s")

        # Record success metric
        metrics.record_success("xtts", int(synthesis_time * 1000), len(text))

        return wav_array, sample_rate

    except RuntimeError as e:
        error_str = str(e)
        synthesis_time = time.time() - start_time

        # Check for CUDA errors
        if "CUDA" in error_str or "device-side assert" in error_str:
            metrics.record_failure("xtts", "cuda_error", error_str)
            logger.critical(f"CUDA ERROR in XTTS cloned synthesis: {error_str}")

            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()
            except Exception as recovery_error:
                logger.error(f"Failed to recover from CUDA error: {recovery_error}")

            raise HTTPException(
                status_code=503,
                detail="GPU synthesis failed with CUDA error. The service may need restart."
            )

        metrics.record_failure("xtts", "runtime_error", error_str)
        logger.error(f"XTTS cloned synthesis RuntimeError: {error_str}")
        raise HTTPException(status_code=500, detail=f"XTTS voice cloning synthesis failed: {error_str}")

    except Exception as e:
        error_str = str(e)
        metrics.record_failure("xtts", "unknown_error", error_str)
        logger.error(f"XTTS cloned synthesis failed: {error_str}")
        raise HTTPException(status_code=500, detail=f"XTTS voice cloning synthesis failed: {error_str}")


def synthesize_with_xtts_cloned_chunked(
    text: str,
    reference_audio_path: str,
    language: str = "en",
    speed: float = 1.0
) -> tuple:
    """
    Synthesize long text with XTTS by chunking and concatenating audio.

    Args:
        text: Long text to synthesize
        reference_audio_path: Path to the reference audio file
        language: Language code
        speed: Speech speed multiplier

    Returns:
        tuple: (wav_array, sample_rate)
    """
    global xtts_model

    # Load model first
    model = load_xtts()
    if model is None:
        metrics.record_failure("xtts", "model_load", "XTTS model not available")
        raise HTTPException(status_code=503, detail="XTTS model not available")

    # Chunk the text
    chunks = chunk_text(text, max_chunk_chars=XTTS_MAX_CHUNK_CHARS)
    total_chunks = len(chunks)

    logger.info(f"XTTS chunked synthesis: {total_chunks} chunks, total {len(text)} chars")

    start_time = time.time()
    audio_segments = []

    # Small pause between chunks (0.3 seconds of silence)
    pause_samples = int(0.3 * XTTS_SAMPLE_RATE)
    silence = np.zeros(pause_samples, dtype=np.float32)

    try:
        for i, chunk in enumerate(chunks):
            chunk_start = time.time()

            # Clear CUDA cache before each chunk
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            logger.info(f"XTTS synthesizing chunk {i+1}/{total_chunks}: {len(chunk)} chars")

            # Generate audio for this chunk
            wav = model.tts(
                text=chunk,
                speaker_wav=reference_audio_path,
                language=language,
                speed=speed
            )

            wav_array = np.array(wav)
            audio_segments.append(wav_array)

            # Add pause between chunks (except after last chunk)
            if i < total_chunks - 1:
                audio_segments.append(silence)

            chunk_time = time.time() - chunk_start
            logger.info(f"XTTS chunk {i+1}/{total_chunks} completed in {chunk_time:.2f}s")

        # Concatenate all audio segments
        final_audio = np.concatenate(audio_segments)
        sample_rate = model.synthesizer.output_sample_rate if hasattr(model, 'synthesizer') else XTTS_SAMPLE_RATE

        synthesis_time = time.time() - start_time
        logger.info(f"XTTS chunked synthesis complete: {total_chunks} chunks in {synthesis_time:.2f}s")

        # Record success metric
        metrics.record_success("xtts", int(synthesis_time * 1000), len(text))

        return final_audio, sample_rate

    except RuntimeError as e:
        error_str = str(e)
        synthesis_time = time.time() - start_time

        # Check for CUDA errors
        if "CUDA" in error_str or "device-side assert" in error_str:
            metrics.record_failure("xtts", "cuda_error", error_str)
            logger.critical(f"CUDA ERROR in XTTS chunked synthesis: {error_str}")

            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()
                xtts_model = None
            except Exception as recovery_error:
                logger.error(f"Failed to recover from CUDA error: {recovery_error}")

            raise HTTPException(
                status_code=503,
                detail="GPU synthesis failed with CUDA error. The service may need restart."
            )

        metrics.record_failure("xtts", "runtime_error", error_str)
        logger.error(f"XTTS chunked synthesis RuntimeError: {error_str}")
        raise HTTPException(status_code=500, detail=f"XTTS voice cloning synthesis failed: {error_str}")

    except Exception as e:
        error_str = str(e)
        metrics.record_failure("xtts", "unknown_error", error_str)
        logger.error(f"XTTS chunked synthesis failed: {error_str}")
        raise HTTPException(status_code=500, detail=f"XTTS voice cloning synthesis failed: {error_str}")


def preprocess_text_for_kokoro(text: str) -> str:
    """
    Preprocess text for Kokoro synthesis.

    Kokoro's KPipeline splits text internally, but it may not handle
    paragraph breaks (multiple newlines) well. This function normalizes
    the text to ensure proper synthesis of multi-paragraph content.
    """
    # Replace multiple newlines with period + space (paragraph break -> sentence boundary)
    # This ensures paragraphs are treated as separate sentences
    text = re.sub(r'\n\s*\n+', '. ', text)

    # Replace single newlines with space (soft line breaks)
    text = re.sub(r'\n', ' ', text)

    # Clean up any resulting double periods or extra spaces
    text = re.sub(r'\.+', '.', text)
    text = re.sub(r'\s+', ' ', text)

    # Fix common TTS pronunciation issues with Kokoro:
    #
    # CRITICAL: Kokoro's G2P interprets standalone "in" as the abbreviation for "inches".
    # We need to protect "in" when it's a preposition/adverb, not a measurement.
    # Strategy: Only keep "in" as-is when preceded by a number (actual measurement).
    # For all other cases, we slightly modify to prevent abbreviation expansion.
    #
    # Cases where "in" should be "inches": "6 in", "12 in tall", "5.5 in"
    # Cases where "in" should be "in": "in the", "in a", "checked in", "in 2025"

    # Replace standalone "in" with "inn" phonetically when NOT preceded by a digit
    # This tricks the G2P into not treating it as an abbreviation
    # The word "inn" sounds identical to "in" but won't be expanded to "inches"
    text = re.sub(r'(?<![0-9])\bin\b', 'inn', text)

    # Now restore actual inch measurements - number followed by "inn" back to "in"
    # This handles edge cases like "6 inn" -> "6 in" (should be inches)
    text = re.sub(r'(\d)\s*inn\b', r'\1 inches', text)

    # Other common abbreviation fixes:
    # 1. Expand "vs" to "versus" to avoid misreading
    text = re.sub(r'\bvs\.?\b', 'versus', text)
    # 2. Expand "w/" to "with"
    text = re.sub(r'\bw/', 'with ', text)
    # 3. Expand "w/o" to "without"
    text = re.sub(r'\bw/o\b', 'without', text)
    # 4. Expand "approx" to "approximately"
    text = re.sub(r'\bapprox\.?\b', 'approximately', text, flags=re.IGNORECASE)
    # 5. Expand "govt" to "government"
    text = re.sub(r'\bgovt\.?\b', 'government', text, flags=re.IGNORECASE)
    # 6. Expand "dept" to "department"
    text = re.sub(r'\bdept\.?\b', 'department', text, flags=re.IGNORECASE)

    # Clean up extra spaces from substitutions
    text = re.sub(r'\s+', ' ', text)

    # Ensure text ends with proper punctuation for prosody
    text = text.strip()
    if text and text[-1] not in '.!?':
        text += '.'

    return text


def synthesize_with_kokoro(text: str, voice_info: dict, speed: float) -> tuple:
    """Synthesize using Kokoro-82M model."""
    pipeline = load_kokoro()
    voice = voice_info.get("kokoro_voice", "am_adam")  # Default to Adam (male) voice

    # Log warning if falling back to default voice
    if voice == "am_adam" and "kokoro_voice" not in voice_info:
        logger.warning(f"No kokoro_voice in voice_info, falling back to am_adam. voice_info: {voice_info}")

    # Preprocess text to handle paragraph breaks properly
    processed_text = preprocess_text_for_kokoro(text)
    logger.info(f"Kokoro synthesis with voice: {voice}, voice_info: {voice_info}, original len: {len(text)}, processed len: {len(processed_text)}")

    # Kokoro returns a generator of (graphemes, phonemes, audio) tuples
    # For single text, we get one result
    all_audio = []
    for _gs, _ps, audio in pipeline(processed_text, voice=voice, speed=speed):
        all_audio.append(audio)

    # Concatenate if multiple segments
    if len(all_audio) > 1:
        wav_array = np.concatenate(all_audio)
    else:
        wav_array = all_audio[0] if all_audio else np.array([])

    return wav_array, KOKORO_SAMPLE_RATE

@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest, background_tasks: BackgroundTasks):
    """
    Synthesize text to speech.

    Supports multiple models:
    - xtts: High-quality, supports voice cloning (slower on CPU)
    - kokoro: Fast, lightweight, commercially licensed (Apache 2.0)

    Returns audio/wav stream.
    """
    model_type = request.model.lower()
    if model_type not in ["xtts", "kokoro"]:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_type}. Use 'xtts' or 'kokoro'")

    # Check cache first (include model in cache key)
    cache_key = get_cache_key(f"{model_type}|{request.text}", request.voice_id, request.language, request.speed)
    cached = get_cached_audio(cache_key)
    if cached:
        return StreamingResponse(
            io.BytesIO(cached),
            media_type="audio/wav",
            headers={
                "X-Cache": "HIT",
                "X-Voice-ID": request.voice_id,
                "X-Model": model_type,
            }
        )

    logger.info(f"Synthesizing: model={model_type}, voice={request.voice_id}, lang={request.language}, chars={len(request.text)}")

    start_time = time.time()

    try:
        # Get voice configuration
        voice_info = BUILTIN_VOICES.get(request.voice_id)

        # If not found, check if it's a direct Kokoro voice ID (e.g., am_adam, af_bella)
        if voice_info is None:
            if re.match(r'^[ab][fm]_\w+$', request.voice_id) and request.voice_id in KOKORO_VOICES:
                # It's a valid Kokoro voice ID - create voice_info on the fly
                logger.info(f"Using direct Kokoro voice ID: {request.voice_id}")
                voice_info = {
                    "name": KOKORO_VOICES.get(request.voice_id, request.voice_id),
                    "kokoro_voice": request.voice_id,
                    "xtts_speaker": XTTS_DEFAULT_SPEAKER,
                }
            else:
                # Fall back to default
                logger.warning(f"Unknown voice_id '{request.voice_id}', using default")
                voice_info = BUILTIN_VOICES["default"]

        # Synthesize based on model type
        if model_type == "kokoro":
            wav_array, sample_rate = synthesize_with_kokoro(
                request.text, voice_info, request.speed
            )
        else:
            wav_array, sample_rate = synthesize_with_xtts(
                request.text, voice_info, request.language, request.speed
            )

        # Write to buffer
        audio_buffer = io.BytesIO()
        sf.write(audio_buffer, wav_array, sample_rate, format='WAV')
        audio_buffer.seek(0)
        audio_data = audio_buffer.read()

        synthesis_time = time.time() - start_time
        logger.info(f"Synthesis completed in {synthesis_time:.2f}s, size={len(audio_data)} bytes")

        # Cache in background
        background_tasks.add_task(save_to_cache, cache_key, audio_data)

        return StreamingResponse(
            io.BytesIO(audio_data),
            media_type="audio/wav",
            headers={
                "X-Cache": "MISS",
                "X-Voice-ID": request.voice_id,
                "X-Model": model_type,
                "X-Synthesis-Time-Ms": str(int(synthesis_time * 1000)),
                "X-Character-Count": str(len(request.text)),
            }
        )

    except Exception as e:
        logger.error(f"Synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {str(e)}")

@app.post("/synthesize-long")
async def synthesize_long(request: SynthesizeLongRequest):
    """
    Synthesize long text (articles, PDFs) by chunking into sentences.

    Returns a combined audio file with all chunks concatenated.
    This endpoint handles documents up to ~100 pages.

    Supports models: 'xtts' (high quality) or 'kokoro' (fast, Apache licensed)
    """
    model_type = request.model.lower()
    if model_type not in ["xtts", "kokoro"]:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_type}. Use 'xtts' or 'kokoro'")

    # Chunk the text
    chunks = chunk_text(request.text, request.max_chunk_chars)
    total_chunks = len(chunks)
    total_chars = sum(len(c) for c in chunks)

    logger.info(f"Long synthesis ({model_type}): {total_chars} chars -> {total_chunks} chunks")

    # Get voice configuration
    voice_info = BUILTIN_VOICES.get(request.voice_id)

    # If not found, check if it's a direct Kokoro voice ID
    if voice_info is None:
        if re.match(r'^[ab][fm]_\w+$', request.voice_id) and request.voice_id in KOKORO_VOICES:
            logger.info(f"Using direct Kokoro voice ID: {request.voice_id}")
            voice_info = {
                "name": KOKORO_VOICES.get(request.voice_id, request.voice_id),
                "kokoro_voice": request.voice_id,
                "xtts_speaker": XTTS_DEFAULT_SPEAKER,
            }
        else:
            logger.warning(f"Unknown voice_id '{request.voice_id}', using default")
            voice_info = BUILTIN_VOICES["default"]

    start_time = time.time()

    try:
        if model_type == "kokoro":
            # Kokoro fast path: KPipeline handles internal text segmentation,
            # so bypass per-chunk loop to avoid overhead of 160+ tiny chunks.
            # This is ~10-20x faster for long articles.
            cache_key = get_cache_key(f"{model_type}|{request.text}", request.voice_id, request.language, request.speed)
            cached = get_cached_audio(cache_key)

            if cached:
                audio_data = cached
                sample_rate = KOKORO_SAMPLE_RATE
                logger.info(f"Kokoro long synthesis from cache: {total_chars} chars")
            else:
                logger.info(f"Kokoro fast path: synthesizing {total_chars} chars in single pass")
                combined_audio, sample_rate = synthesize_with_kokoro(
                    request.text, voice_info, request.speed
                )

                audio_buffer = io.BytesIO()
                sf.write(audio_buffer, combined_audio, sample_rate, format='WAV')
                audio_buffer.seek(0)
                audio_data = audio_buffer.read()

                save_to_cache(cache_key, audio_data)

            total_synthesis_time = time.time() - start_time
            total_chunks = 1
        else:
            # XTTS: use per-chunk synthesis (XTTS needs smaller text segments)
            all_audio = []
            sample_rate = XTTS_SAMPLE_RATE
            total_synthesis_time = 0

            for i, chunk_text_content in enumerate(chunks):
                chunk_start = time.time()
                logger.info(f"Synthesizing chunk {i+1}/{total_chunks}: {len(chunk_text_content)} chars")

                # Check cache first (include model in cache key)
                cache_key = get_cache_key(f"{model_type}|{chunk_text_content}", request.voice_id, request.language, request.speed)
                cached = get_cached_audio(cache_key)

                if cached:
                    audio_buf = io.BytesIO(cached)
                    cached_audio, cached_sr = sf.read(audio_buf)
                    all_audio.append(cached_audio)
                    sample_rate = cached_sr
                    logger.info(f"Chunk {i+1} from cache")
                else:
                    wav_array, sample_rate = synthesize_with_xtts(
                        chunk_text_content, voice_info, request.language, request.speed
                    )

                    all_audio.append(wav_array)

                    chunk_buffer = io.BytesIO()
                    sf.write(chunk_buffer, wav_array, sample_rate, format='WAV')
                    chunk_buffer.seek(0)
                    save_to_cache(cache_key, chunk_buffer.read())

                chunk_time = time.time() - chunk_start
                total_synthesis_time += chunk_time
                logger.info(f"Chunk {i+1} completed in {chunk_time:.2f}s")

            combined_audio = np.concatenate(all_audio)

            audio_buffer = io.BytesIO()
            sf.write(audio_buffer, combined_audio, sample_rate, format='WAV')
            audio_buffer.seek(0)
            audio_data = audio_buffer.read()

    except Exception as e:
        logger.error(f"Long synthesis failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Synthesis failed: {str(e)}"
        )

    logger.info(f"Long synthesis complete: {total_chunks} chunks, {len(audio_data)} bytes, {total_synthesis_time:.2f}s")

    return StreamingResponse(
        io.BytesIO(audio_data),
        media_type="audio/wav",
        headers={
            "X-Total-Chunks": str(total_chunks),
            "X-Total-Chars": str(total_chars),
            "X-Synthesis-Time-Ms": str(int(total_synthesis_time * 1000)),
            "X-Voice-ID": request.voice_id,
            "X-Model": model_type,
        }
    )

@app.post("/synthesize-stream")
async def synthesize_stream(request: SynthesizeLongRequest):
    """
    Stream audio chunks as they're synthesized (NDJSON format).

    Returns newline-delimited JSON where each line contains:
    - index: chunk index (0-based)
    - total: total number of chunks
    - audio: base64-encoded WAV audio
    - duration_ms: estimated duration of this chunk
    - final: true for the last chunk

    This allows clients to start playback immediately after receiving
    the first chunk, rather than waiting for the entire synthesis.
    """
    import base64
    import json

    model_type = request.model.lower()
    if model_type not in ["xtts", "kokoro"]:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_type}. Use 'xtts' or 'kokoro'")

    # Chunk the text
    chunks = chunk_text(request.text, request.max_chunk_chars)
    total_chunks = len(chunks)
    total_chars = sum(len(c) for c in chunks)

    logger.info(f"Streaming synthesis ({model_type}): {total_chars} chars -> {total_chunks} chunks")

    # Get voice configuration
    voice_info = BUILTIN_VOICES.get(request.voice_id)

    # If not found, check if it's a direct Kokoro voice ID
    if voice_info is None:
        if re.match(r'^[ab][fm]_\w+$', request.voice_id) and request.voice_id in KOKORO_VOICES:
            logger.info(f"Using direct Kokoro voice ID: {request.voice_id}")
            voice_info = {
                "name": KOKORO_VOICES.get(request.voice_id, request.voice_id),
                "kokoro_voice": request.voice_id,
                "xtts_speaker": XTTS_DEFAULT_SPEAKER,
            }
        else:
            logger.warning(f"Unknown voice_id '{request.voice_id}', using default")
            voice_info = BUILTIN_VOICES["default"]

    sample_rate = KOKORO_SAMPLE_RATE if model_type == "kokoro" else XTTS_SAMPLE_RATE

    async def generate_chunks():
        """Generator that yields NDJSON lines as chunks are synthesized."""
        for i, chunk_text_content in enumerate(chunks):
            chunk_start = time.time()
            logger.info(f"Streaming chunk {i+1}/{total_chunks}: {len(chunk_text_content)} chars")

            try:
                # Check cache first
                cache_key = get_cache_key(f"{model_type}|{chunk_text_content}", request.voice_id, request.language, request.speed)
                cached = get_cached_audio(cache_key)

                if cached:
                    audio_data = cached
                    logger.info(f"Chunk {i+1} from cache")
                else:
                    # Synthesize based on model type
                    if model_type == "kokoro":
                        wav_array, sr = synthesize_with_kokoro(
                            chunk_text_content, voice_info, request.speed
                        )
                    else:
                        wav_array, sr = synthesize_with_xtts(
                            chunk_text_content, voice_info, request.language, request.speed
                        )

                    # Convert to WAV bytes
                    audio_buffer = io.BytesIO()
                    sf.write(audio_buffer, wav_array, sr, format='WAV')
                    audio_buffer.seek(0)
                    audio_data = audio_buffer.read()

                    # Cache this chunk
                    save_to_cache(cache_key, audio_data)

                chunk_time = time.time() - chunk_start

                # Estimate duration: WAV is 24kHz mono 16-bit = 48000 bytes/second
                # Header is ~44 bytes, so (size - 44) / 48000 * 1000 = duration_ms
                duration_ms = int((len(audio_data) - 44) / 48000 * 1000)

                # Create NDJSON response
                chunk_response = {
                    "index": i,
                    "total": total_chunks,
                    "audio": base64.b64encode(audio_data).decode('utf-8'),
                    "duration_ms": duration_ms,
                    "synthesis_time_ms": int(chunk_time * 1000),
                    "final": i == total_chunks - 1
                }

                logger.info(f"Chunk {i+1} completed in {chunk_time:.2f}s, duration={duration_ms}ms")

                # Yield as NDJSON line
                yield json.dumps(chunk_response).encode('utf-8') + b'\n'

            except Exception as e:
                logger.error(f"Chunk {i+1} failed: {e}")
                # Yield error as NDJSON
                error_response = {
                    "index": i,
                    "total": total_chunks,
                    "error": str(e),
                    "final": True
                }
                yield json.dumps(error_response).encode('utf-8') + b'\n'
                return

    return StreamingResponse(
        generate_chunks(),
        media_type="application/x-ndjson",
        headers={
            "X-Total-Chunks": str(total_chunks),
            "X-Total-Chars": str(total_chars),
            "X-Voice-ID": request.voice_id,
            "X-Model": model_type,
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        }
    )

@app.post("/chunk-preview")
async def chunk_preview(request: SynthesizeLongRequest):
    """
    Preview how text will be chunked without synthesizing.

    Useful for estimating cost/time before synthesis.
    """
    chunks = chunk_text(request.text, request.max_chunk_chars)

    # Estimate time based on CPU performance (~1.5s per word on CPU)
    total_words = sum(len(c.split()) for c in chunks)
    estimated_time_cpu = total_words * 1.5  # seconds
    estimated_time_gpu = total_words * 0.1  # seconds (10-15x faster)

    chunk_infos = [
        ChunkInfo(
            index=i,
            text=c,
            char_count=len(c),
            status="pending"
        )
        for i, c in enumerate(chunks)
    ]

    return {
        "total_chunks": len(chunks),
        "total_chars": sum(len(c) for c in chunks),
        "total_words": total_words,
        "estimated_time_cpu_s": int(estimated_time_cpu),
        "estimated_time_gpu_s": int(estimated_time_gpu),
        "chunks": chunk_infos
    }

# ============================================================================
# Voice Cloning with Chatterbox
# ============================================================================

# In-memory cache of recently used cloned voices (reference audio paths)
_cloned_voice_cache: dict[str, str] = {}
MAX_CLONED_VOICE_CACHE = 50  # Max number of voice files to keep cached


def normalize_audio_file(file_path: str) -> None:
    """
    Normalize audio file to target amplitude.
    This improves voice cloning quality by ensuring consistent input levels.
    Modifies the file in place.
    """
    try:
        audio, sample_rate = sf.read(file_path)

        # Get max amplitude
        max_amp = np.max(np.abs(audio))

        if max_amp < 0.01:
            logger.warning(f"Audio file {file_path} is nearly silent (max amp: {max_amp:.4f})")
            return

        # Check if normalization is needed (if audio is below 50% of target)
        if max_amp < NORMALIZE_TARGET_AMPLITUDE * 0.5:
            scale = NORMALIZE_TARGET_AMPLITUDE / max_amp
            normalized = audio * scale

            # Clip to prevent any overflow
            normalized = np.clip(normalized, -1.0, 1.0)

            sf.write(file_path, normalized, sample_rate)
            logger.info(f"Normalized audio {file_path}: {max_amp:.3f} -> {NORMALIZE_TARGET_AMPLITUDE:.3f} (scale: {scale:.2f}x)")
        else:
            logger.debug(f"Audio {file_path} already normalized (max amp: {max_amp:.3f})")

    except Exception as e:
        logger.error(f"Failed to normalize audio {file_path}: {e}")
        # Don't raise - continue with unnormalized audio


async def download_voice_file(voice_url: str, voice_id: str) -> str:
    """
    Download a cloned voice reference file from Supabase Storage.
    Caches the file locally for repeated use.
    Returns the local file path.
    """
    cache_path = os.path.join(CLONED_VOICES_CACHE_DIR, f"{voice_id}.wav")

    # Check if already cached
    if os.path.exists(cache_path):
        logger.info(f"Voice file cache hit: {voice_id}")
        return cache_path

    logger.info(f"Downloading voice file for {voice_id} from {voice_url[:50]}...")

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(voice_url)
            response.raise_for_status()

            with open(cache_path, "wb") as f:
                f.write(response.content)

            logger.info(f"Voice file downloaded: {voice_id} ({len(response.content)} bytes)")

            # Normalize audio for better voice cloning quality
            normalize_audio_file(cache_path)

            # Update cache tracking
            _cloned_voice_cache[voice_id] = cache_path

            # Cleanup old cache entries if needed
            if len(_cloned_voice_cache) > MAX_CLONED_VOICE_CACHE:
                oldest_id = next(iter(_cloned_voice_cache))
                oldest_path = _cloned_voice_cache.pop(oldest_id)
                if os.path.exists(oldest_path):
                    os.remove(oldest_path)
                    logger.info(f"Removed old cached voice: {oldest_id}")

            return cache_path

    except Exception as e:
        logger.error(f"Failed to download voice file {voice_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to download voice file: {str(e)}")


# Maximum characters Chatterbox can process in one call
# Longer texts are chunked and results concatenated
CHATTERBOX_MAX_CHUNK_CHARS = 500


def synthesize_with_chatterbox(
    text: str,
    reference_audio_path: str,
    speed: float = 1.0,
    exaggeration: float = 0.5
) -> tuple:
    """
    Synthesize speech using Chatterbox with a cloned voice.

    For long texts, this function automatically chunks the text into smaller
    segments, synthesizes each, and concatenates the audio.

    Args:
        text: Text to synthesize
        reference_audio_path: Path to the reference audio file for voice cloning
        speed: Speech speed multiplier (0.5-2.0)
        exaggeration: Emotion exaggeration (0.0-1.0)

    Returns:
        tuple: (wav_array, sample_rate)
    """
    global chatterbox_model

    # Step 1: Check CUDA health before proceeding
    cuda_healthy, cuda_msg = check_cuda_health()
    if not cuda_healthy:
        metrics.record_failure("chatterbox", "cuda_error", cuda_msg)
        raise HTTPException(
            status_code=503,
            detail=f"GPU is in an unhealthy state. Service needs restart. {cuda_msg}"
        )

    # Step 2: Validate the reference audio file BEFORE passing to model
    is_valid, validation_msg = validate_audio_file(reference_audio_path, min_duration_sec=1.0)
    if not is_valid:
        metrics.record_failure("chatterbox", "audio_validation", validation_msg)
        logger.error(f"Audio validation failed for {reference_audio_path}: {validation_msg}")
        raise HTTPException(
            status_code=400,
            detail=f"Reference audio file is invalid: {validation_msg}. Please re-record your voice clone."
        )

    # Step 3: Check if we need to chunk the text
    if len(text) > CHATTERBOX_MAX_CHUNK_CHARS:
        logger.info(f"Text too long ({len(text)} chars), chunking for Chatterbox synthesis")
        return synthesize_with_chatterbox_chunked(
            text=text,
            reference_audio_path=reference_audio_path,
            speed=speed,
            exaggeration=exaggeration
        )

    # Step 3: Load model
    model = load_chatterbox()
    if model is None:
        metrics.record_failure("chatterbox", "model_load", "Chatterbox model not available")
        raise HTTPException(status_code=503, detail="Chatterbox model not available")

    logger.info(f"Chatterbox synthesis: text_len={len(text)}, ref_audio={reference_audio_path}")

    start_time = time.time()

    try:
        # Clear CUDA cache before synthesis
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        # Generate audio with Chatterbox
        wav = model.generate(
            text=text,
            audio_prompt_path=reference_audio_path,
            exaggeration=exaggeration,
        )

        # Apply speed adjustment if not 1.0
        if speed != 1.0:
            import librosa
            wav_array = wav.cpu().numpy().squeeze()
            wav_array = librosa.effects.time_stretch(wav_array, rate=speed)
        else:
            wav_array = wav.cpu().numpy().squeeze()

        synthesis_time = time.time() - start_time
        logger.info(f"Chatterbox synthesis complete in {synthesis_time:.2f}s")

        # Record success metric
        metrics.record_success("chatterbox", int(synthesis_time * 1000), len(text))

        return wav_array, CHATTERBOX_SAMPLE_RATE

    except RuntimeError as e:
        error_str = str(e)
        synthesis_time = time.time() - start_time

        # Check for CUDA errors specifically
        if "CUDA" in error_str or "device-side assert" in error_str:
            metrics.record_failure("chatterbox", "cuda_error", error_str)
            logger.critical(f"CUDA ERROR in Chatterbox synthesis: {error_str}")

            # Try to recover CUDA state
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()
                # Mark the model for reload on next request
                chatterbox_model = None
                logger.info("Cleared Chatterbox model for reload")
            except Exception as recovery_error:
                logger.error(f"Failed to recover from CUDA error: {recovery_error}")

            raise HTTPException(
                status_code=503,
                detail="GPU synthesis failed with CUDA error. The service may need restart. Please try again or contact support."
            )

        # Other runtime errors
        metrics.record_failure("chatterbox", "runtime_error", error_str)
        logger.error(f"Chatterbox synthesis RuntimeError: {error_str}")
        raise HTTPException(status_code=500, detail=f"Voice cloning synthesis failed: {error_str}")

    except Exception as e:
        error_str = str(e)
        metrics.record_failure("chatterbox", "unknown_error", error_str)
        logger.error(f"Chatterbox synthesis failed: {error_str}")
        raise HTTPException(status_code=500, detail=f"Voice cloning synthesis failed: {error_str}")


def synthesize_with_chatterbox_chunked(
    text: str,
    reference_audio_path: str,
    speed: float = 1.0,
    exaggeration: float = 0.5
) -> tuple:
    """
    Synthesize long text by chunking and concatenating audio.

    This function:
    1. Splits text into chunks that Chatterbox can handle
    2. Synthesizes each chunk
    3. Concatenates the audio with small pauses between chunks
    4. Returns the combined audio

    Args:
        text: Long text to synthesize
        reference_audio_path: Path to the reference audio file
        speed: Speech speed multiplier
        exaggeration: Emotion exaggeration level

    Returns:
        tuple: (wav_array, sample_rate)
    """
    global chatterbox_model

    # Load model first
    model = load_chatterbox()
    if model is None:
        metrics.record_failure("chatterbox", "model_load", "Chatterbox model not available")
        raise HTTPException(status_code=503, detail="Chatterbox model not available")

    # Chunk the text
    chunks = chunk_text(text, max_chunk_chars=CHATTERBOX_MAX_CHUNK_CHARS)
    total_chunks = len(chunks)

    logger.info(f"Chatterbox chunked synthesis: {total_chunks} chunks, total {len(text)} chars")

    start_time = time.time()
    audio_segments = []

    # Small pause between chunks (0.3 seconds of silence)
    pause_samples = int(0.3 * CHATTERBOX_SAMPLE_RATE)
    silence = np.zeros(pause_samples, dtype=np.float32)

    try:
        for i, chunk in enumerate(chunks):
            chunk_start = time.time()

            # Clear CUDA cache before each chunk
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            logger.info(f"Synthesizing chunk {i+1}/{total_chunks}: {len(chunk)} chars")

            # Generate audio for this chunk
            wav = model.generate(
                text=chunk,
                audio_prompt_path=reference_audio_path,
                exaggeration=exaggeration,
            )

            wav_array = wav.cpu().numpy().squeeze()

            # Apply speed adjustment if needed
            if speed != 1.0:
                import librosa
                wav_array = librosa.effects.time_stretch(wav_array, rate=speed)

            audio_segments.append(wav_array)

            # Add pause between chunks (except after last chunk)
            if i < total_chunks - 1:
                audio_segments.append(silence)

            chunk_time = time.time() - chunk_start
            logger.info(f"Chunk {i+1}/{total_chunks} completed in {chunk_time:.2f}s")

        # Concatenate all audio segments
        final_audio = np.concatenate(audio_segments)

        synthesis_time = time.time() - start_time
        logger.info(f"Chatterbox chunked synthesis complete: {total_chunks} chunks in {synthesis_time:.2f}s")

        # Record success metric
        metrics.record_success("chatterbox", int(synthesis_time * 1000), len(text))

        return final_audio, CHATTERBOX_SAMPLE_RATE

    except RuntimeError as e:
        error_str = str(e)
        synthesis_time = time.time() - start_time

        # Check for CUDA errors
        if "CUDA" in error_str or "device-side assert" in error_str:
            metrics.record_failure("chatterbox", "cuda_error", error_str)
            logger.critical(f"CUDA ERROR in Chatterbox chunked synthesis: {error_str}")

            # Try to recover
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()
                chatterbox_model = None
            except Exception as recovery_error:
                logger.error(f"Failed to recover from CUDA error: {recovery_error}")

            raise HTTPException(
                status_code=503,
                detail="GPU synthesis failed with CUDA error. The service may need restart."
            )

        metrics.record_failure("chatterbox", "runtime_error", error_str)
        logger.error(f"Chatterbox chunked synthesis RuntimeError: {error_str}")
        raise HTTPException(status_code=500, detail=f"Voice cloning synthesis failed: {error_str}")

    except Exception as e:
        error_str = str(e)
        metrics.record_failure("chatterbox", "unknown_error", error_str)
        logger.error(f"Chatterbox chunked synthesis failed: {error_str}")
        raise HTTPException(status_code=500, detail=f"Voice cloning synthesis failed: {error_str}")


class SynthesizeWithClonedVoiceRequest(BaseModel):
    """Request for synthesizing with a cloned voice."""
    text: str = Field(..., min_length=1, max_length=500000)  # Support long articles (~100 pages)
    voice_url: str = Field(..., description="URL to the reference audio file (from Supabase Storage)")
    voice_id: str = Field(..., description="Unique ID for caching the voice file")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    exaggeration: float = Field(default=0.5, ge=0.0, le=1.0, description="Emotion exaggeration level (Chatterbox only)")
    model: str = Field(default="chatterbox", description="Voice cloning model: 'chatterbox' (default) or 'xtts'")


@app.post("/synthesize-cloned")
async def synthesize_with_cloned_voice(request: SynthesizeWithClonedVoiceRequest, background_tasks: BackgroundTasks):
    """
    Synthesize text using a cloned voice.

    Supports two voice cloning models:
    - chatterbox (default): MIT licensed, great for expressive voices
    - xtts: XTTS v2, multilingual support, different voice characteristics

    The reference audio is downloaded from the provided URL (Supabase Storage)
    and cached locally for repeated use.

    Returns audio/wav stream.
    """
    # Validate model selection
    model_type = request.model.lower()
    if model_type not in ["chatterbox", "xtts"]:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown cloning model: {model_type}. Use 'chatterbox' or 'xtts'"
        )

    # Download/retrieve cached voice file
    voice_path = await download_voice_file(request.voice_url, request.voice_id)

    # Check cache (include model and voice_id in cache key)
    cache_key = get_cache_key(f"{model_type}|{request.text}", request.voice_id, "en", request.speed)
    cached = get_cached_audio(cache_key)
    if cached:
        return StreamingResponse(
            io.BytesIO(cached),
            media_type="audio/wav",
            headers={
                "X-Cache": "HIT",
                "X-Voice-ID": request.voice_id,
                "X-Model": model_type,
            }
        )

    logger.info(f"Synthesizing with cloned voice: model={model_type}, voice_id={request.voice_id}, chars={len(request.text)}")

    start_time = time.time()

    # Synthesize with the selected model
    if model_type == "xtts":
        wav_array, sample_rate = synthesize_with_xtts_cloned(
            text=request.text,
            reference_audio_path=voice_path,
            language="en",
            speed=request.speed
        )
    else:
        # Default to Chatterbox
        wav_array, sample_rate = synthesize_with_chatterbox(
            text=request.text,
            reference_audio_path=voice_path,
            speed=request.speed,
            exaggeration=request.exaggeration
        )

    # Write to buffer
    audio_buffer = io.BytesIO()
    sf.write(audio_buffer, wav_array, sample_rate, format='WAV')
    audio_buffer.seek(0)
    audio_data = audio_buffer.read()

    synthesis_time = time.time() - start_time
    logger.info(f"Cloned voice synthesis ({model_type}) completed in {synthesis_time:.2f}s, size={len(audio_data)} bytes")

    # Cache in background
    background_tasks.add_task(save_to_cache, cache_key, audio_data)

    return StreamingResponse(
        io.BytesIO(audio_data),
        media_type="audio/wav",
        headers={
            "X-Cache": "MISS",
            "X-Voice-ID": request.voice_id,
            "X-Model": model_type,
            "X-Synthesis-Time-Ms": str(int(synthesis_time * 1000)),
            "X-Character-Count": str(len(request.text)),
        }
    )


@app.post("/upload-voice")
async def upload_voice_sample(
    voice_id: str = Form(...),
    name: str = Form(...),
    audio_file: UploadFile = File(...)
):
    """
    Upload a voice sample for cloning.

    The audio sample is saved locally and can be used for future synthesis.
    This is primarily for testing - in production, voices are stored in Supabase.
    """
    # Validate file type
    if not audio_file.content_type or not audio_file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="File must be an audio file")

    # Read and save the audio sample
    content = await audio_file.read()
    sample_path = os.path.join(VOICE_SAMPLES_DIR, f"{voice_id}.wav")

    with open(sample_path, "wb") as f:
        f.write(content)

    logger.info(f"Voice sample uploaded: {voice_id} ({len(content)} bytes)")

    return {
        "status": "ok",
        "voice_id": voice_id,
        "name": name,
        "file_size": len(content),
        "local_path": sample_path
    }


@app.post("/preview-cloned-voice")
async def preview_cloned_voice(
    voice_id: str = Form(...),
    voice_url: str = Form(...),
    text: str = Form(default="Hello, this is a preview of your cloned voice. How does it sound?"),
    model: str = Form(default="chatterbox")
):
    """
    Generate a short preview of a cloned voice.

    Used during voice cloning setup to let users hear how their voice sounds.
    Supports both 'chatterbox' (default) and 'xtts' models.
    """
    # Validate model
    model_type = model.lower()
    if model_type not in ["chatterbox", "xtts"]:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown cloning model: {model_type}. Use 'chatterbox' or 'xtts'"
        )

    # Download voice file
    voice_path = await download_voice_file(voice_url, voice_id)

    # Synthesize preview with selected model
    if model_type == "xtts":
        wav_array, sample_rate = synthesize_with_xtts_cloned(
            text=text,
            reference_audio_path=voice_path,
            language="en",
            speed=1.0
        )
    else:
        wav_array, sample_rate = synthesize_with_chatterbox(
            text=text,
            reference_audio_path=voice_path,
            speed=1.0,
            exaggeration=0.5
        )

    # Write to buffer
    audio_buffer = io.BytesIO()
    sf.write(audio_buffer, wav_array, sample_rate, format='WAV')
    audio_buffer.seek(0)

    return StreamingResponse(
        audio_buffer,
        media_type="audio/wav",
        headers={
            "X-Voice-ID": voice_id,
            "X-Model": model_type,
        }
    )


@app.delete("/cached-voice/{voice_id}")
async def delete_cached_voice(voice_id: str):
    """
    Delete a cached voice file.

    Called when a user deletes their cloned voice.
    """
    cache_path = os.path.join(CLONED_VOICES_CACHE_DIR, f"{voice_id}.wav")

    if os.path.exists(cache_path):
        os.remove(cache_path)
        if voice_id in _cloned_voice_cache:
            del _cloned_voice_cache[voice_id]
        logger.info(f"Deleted cached voice: {voice_id}")
        return {"status": "ok", "voice_id": voice_id}

    return {"status": "not_found", "voice_id": voice_id}


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
