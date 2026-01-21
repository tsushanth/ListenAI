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

# ============================================================================
# Logging
# ============================================================================

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("tts-service")

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

    from TTS.api import TTS
    xtts_model = TTS(XTTS_MODEL_NAME).to(DEVICE)

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
    """Health check endpoint."""
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

    return {
        "status": "ok" if models_loaded else "loading",
        "default_model": DEFAULT_MODEL,
        "models_loaded": models_loaded,
        "models_available": ["xtts", "kokoro", "chatterbox"],
        "device": DEVICE,
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": gpu_name,
        "voice_cloning_available": chatterbox_model is not None
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

    # Synthesize each chunk and collect audio
    all_audio = []
    sample_rate = KOKORO_SAMPLE_RATE if model_type == "kokoro" else XTTS_SAMPLE_RATE
    total_synthesis_time = 0

    for i, chunk_text_content in enumerate(chunks):
        chunk_start = time.time()
        logger.info(f"Synthesizing chunk {i+1}/{total_chunks}: {len(chunk_text_content)} chars")

        try:
            # Check cache first (include model in cache key)
            cache_key = get_cache_key(f"{model_type}|{chunk_text_content}", request.voice_id, request.language, request.speed)
            cached = get_cached_audio(cache_key)

            if cached:
                # Load cached audio
                audio_buffer = io.BytesIO(cached)
                cached_audio, cached_sr = sf.read(audio_buffer)
                all_audio.append(cached_audio)
                sample_rate = cached_sr
                logger.info(f"Chunk {i+1} from cache")
            else:
                # Synthesize based on model type
                if model_type == "kokoro":
                    wav_array, sample_rate = synthesize_with_kokoro(
                        chunk_text_content, voice_info, request.speed
                    )
                else:
                    wav_array, sample_rate = synthesize_with_xtts(
                        chunk_text_content, voice_info, request.language, request.speed
                    )

                all_audio.append(wav_array)

                # Cache this chunk
                chunk_buffer = io.BytesIO()
                sf.write(chunk_buffer, wav_array, sample_rate, format='WAV')
                chunk_buffer.seek(0)
                save_to_cache(cache_key, chunk_buffer.read())

            chunk_time = time.time() - chunk_start
            total_synthesis_time += chunk_time
            logger.info(f"Chunk {i+1} completed in {chunk_time:.2f}s")

        except Exception as e:
            logger.error(f"Chunk {i+1} failed: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Synthesis failed at chunk {i+1}/{total_chunks}: {str(e)}"
            )

    # Concatenate all audio chunks
    combined_audio = np.concatenate(all_audio)

    # Write to buffer
    audio_buffer = io.BytesIO()
    sf.write(audio_buffer, combined_audio, sample_rate, format='WAV')
    audio_buffer.seek(0)
    audio_data = audio_buffer.read()

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


def synthesize_with_chatterbox(
    text: str,
    reference_audio_path: str,
    speed: float = 1.0,
    exaggeration: float = 0.5
) -> tuple:
    """
    Synthesize speech using Chatterbox with a cloned voice.

    Args:
        text: Text to synthesize
        reference_audio_path: Path to the reference audio file for voice cloning
        speed: Speech speed multiplier (0.5-2.0)
        exaggeration: Emotion exaggeration (0.0-1.0)

    Returns:
        tuple: (wav_array, sample_rate)
    """
    model = load_chatterbox()
    if model is None:
        raise HTTPException(status_code=503, detail="Chatterbox model not available")

    logger.info(f"Chatterbox synthesis: text_len={len(text)}, ref_audio={reference_audio_path}")

    start_time = time.time()

    try:
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

        return wav_array, CHATTERBOX_SAMPLE_RATE

    except Exception as e:
        logger.error(f"Chatterbox synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"Voice cloning synthesis failed: {str(e)}")


class SynthesizeWithClonedVoiceRequest(BaseModel):
    """Request for synthesizing with a cloned voice."""
    text: str = Field(..., min_length=1, max_length=10000)
    voice_url: str = Field(..., description="URL to the reference audio file (from Supabase Storage)")
    voice_id: str = Field(..., description="Unique ID for caching the voice file")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    exaggeration: float = Field(default=0.5, ge=0.0, le=1.0, description="Emotion exaggeration level")


@app.post("/synthesize-cloned")
async def synthesize_with_cloned_voice(request: SynthesizeWithClonedVoiceRequest, background_tasks: BackgroundTasks):
    """
    Synthesize text using a cloned voice.

    Uses Chatterbox TTS with a reference audio file for voice cloning.
    The reference audio is downloaded from the provided URL (Supabase Storage)
    and cached locally for repeated use.

    Returns audio/wav stream.
    """
    # Download/retrieve cached voice file
    voice_path = await download_voice_file(request.voice_url, request.voice_id)

    # Check cache (include voice_id in cache key for cloned voices)
    cache_key = get_cache_key(f"chatterbox|{request.text}", request.voice_id, "en", request.speed)
    cached = get_cached_audio(cache_key)
    if cached:
        return StreamingResponse(
            io.BytesIO(cached),
            media_type="audio/wav",
            headers={
                "X-Cache": "HIT",
                "X-Voice-ID": request.voice_id,
                "X-Model": "chatterbox",
            }
        )

    logger.info(f"Synthesizing with cloned voice: voice_id={request.voice_id}, chars={len(request.text)}")

    start_time = time.time()

    # Synthesize with Chatterbox
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
    logger.info(f"Cloned voice synthesis completed in {synthesis_time:.2f}s, size={len(audio_data)} bytes")

    # Cache in background
    background_tasks.add_task(save_to_cache, cache_key, audio_data)

    return StreamingResponse(
        io.BytesIO(audio_data),
        media_type="audio/wav",
        headers={
            "X-Cache": "MISS",
            "X-Voice-ID": request.voice_id,
            "X-Model": "chatterbox",
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
    text: str = Form(default="Hello, this is a preview of your cloned voice. How does it sound?")
):
    """
    Generate a short preview of a cloned voice.

    Used during voice cloning setup to let users hear how their voice sounds.
    """
    # Download voice file
    voice_path = await download_voice_file(voice_url, voice_id)

    # Synthesize preview
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
            "X-Model": "chatterbox",
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
