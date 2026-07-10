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
    # English (American) — 11 voices
    "af_heart": "American Female (Heart)",
    "af_bella": "American Female (Bella)",
    "af_nicole": "American Female (Nicole)",
    "af_sarah": "American Female (Sarah)",
    "af_sky": "American Female (Sky)",
    "am_adam": "American Male (Adam)",
    "am_michael": "American Male (Michael)",
    # English (British)
    "bf_emma": "British Female (Emma)",
    "bf_isabella": "British Female (Isabella)",
    "bm_george": "British Male (George)",
    "bm_lewis": "British Male (Lewis)",
    # Spanish
    "ef_dora": "Spanish Female (Dora)",
    "em_alex": "Spanish Male (Alex)",
    "em_santa": "Spanish Male (Santa)",
    # French
    "ff_siwis": "French Female (Siwis)",
    # Italian
    "if_sara": "Italian Female (Sara)",
    "im_nicola": "Italian Male (Nicola)",
    # Japanese
    "jf_alpha": "Japanese Female (Alpha)",
    "jf_gongitsune": "Japanese Female (Gongitsune)",
    "jf_nezumi": "Japanese Female (Nezumi)",
    "jf_tebukuro": "Japanese Female (Tebukuro)",
    "jm_kumo": "Japanese Male (Kumo)",
    # Portuguese (Brazilian)
    "pf_dora": "Portuguese Female (Dora)",
    "pm_alex": "Portuguese Male (Alex)",
    "pm_santa": "Portuguese Male (Santa)",
    # Mandarin Chinese
    "zf_xiaobei": "Chinese Female (Xiaobei)",
    "zf_xiaoni": "Chinese Female (Xiaoni)",
    "zf_xiaoxiao": "Chinese Female (Xiaoxiao)",
    "zf_xiaoyi": "Chinese Female (Xiaoyi)",
    "zm_yunjian": "Chinese Male (Yunjian)",
    "zm_yunxi": "Chinese Male (Yunxi)",
    "zm_yunxia": "Chinese Male (Yunxia)",
    "zm_yunyang": "Chinese Male (Yunyang)",
    # Hindi
    "hf_alpha": "Hindi Female (Alpha)",
    "hf_beta": "Hindi Female (Beta)",
    "hm_omega": "Hindi Male (Omega)",
    "hm_psi": "Hindi Male (Psi)",
}

# Map ISO 639-1 language code → (kokoro `lang` arg, default female voice, default male voice).
# Kokoro 82M v1.0 nominally covers ja/zh/ko/hi, BUT empirically espeak's
# G2P for those languages produces garbage phonemes — the voice then
# renders character-name-sounding gibberish ("japanese letter, chinese
# letter…"). So we keep Kokoro for European languages where espeak is
# mature and route CJK + Hindi to Edge TTS instead.
KOKORO_LANG_MAP = {
    "en":    ("en-us",  "af_sarah",     "am_michael"),
    "en-gb": ("en-gb",  "bf_emma",      "bm_george"),
}

# Languages routed to Edge TTS (Microsoft's free service, same as live
# radio). CJK + Hindi need Edge because Kokoro's espeak G2P produces
# garbage phonemes there. de isn't in Kokoro at all. es/fr/it/pt are
# nominally in Kokoro but its voices sound like English speakers
# reading Spanish/French/Italian/Portuguese with a heavy accent — the
# radio's Edge TTS voices match what listeners hear on the live stream,
# so use the same here for consistency and authenticity.
EDGE_TTS_LANG_MAP = {
    "ja": {"female": "ja-JP-NanamiNeural",  "male": "ja-JP-KeitaNeural"},
    "zh": {"female": "zh-CN-XiaoxiaoNeural", "male": "zh-CN-YunxiNeural"},
    "ko": {"female": "ko-KR-SunHiNeural",   "male": "ko-KR-InJoonNeural"},
    "hi": {"female": "hi-IN-SwaraNeural",   "male": "hi-IN-MadhurNeural"},
    "de": {"female": "de-DE-KatjaNeural",   "male": "de-DE-ConradNeural"},
    "es": {"female": "es-MX-DaliaNeural",   "male": "es-MX-JorgeNeural"},
    "fr": {"female": "fr-FR-DeniseNeural",  "male": "fr-FR-HenriNeural"},
    "it": {"female": "it-IT-ElsaNeural",    "male": "it-IT-DiegoNeural"},
    "pt": {"female": "pt-BR-FranciscaNeural", "male": "pt-BR-AntonioNeural"},
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

def kokoro_lang_for(language: str) -> str:
    """Map ISO 639-1 language code → kokoro-onnx `lang` arg.
    Defaults to en-us for unknown languages (preserves existing behavior
    for callers that don't pass a language)."""
    if not language:
        return "en-us"
    entry = KOKORO_LANG_MAP.get(language.lower())
    return entry[0] if entry else "en-us"


def chunk_for_kokoro(text: str, language: str, max_chars: int = 25) -> list:
    """Split text into chunks small enough to stay under Kokoro's 510
    phoneme limit. CJK / Hindi / dense scripts produce ~10-15 phonemes
    per char — empirically 37 chars of Japanese already bust the 510
    cap. So we chunk aggressively (25 chars) and *always* sentence-split
    for non-English even on short text. English bypasses chunking.

    Splits in priority order: sentence-end (。！？.!?) → comma (、,) →
    hard char split when no punctuation is available."""
    import re
    lang = (language or "en").lower()
    if lang == "en":
        return [text]

    sentences = re.split(r"(?<=[。！？\.!?])\s*", text)
    sentences = [s.strip() for s in sentences if s.strip()]
    if not sentences:
        sentences = [text]

    chunks: list = []
    for s in sentences:
        if len(s) <= max_chars:
            chunks.append(s)
            continue
        # Sentence still too long — split on commas
        pieces = re.split(r"(?<=[、,])\s*", s)
        buf = ""
        for p in pieces:
            if not buf:
                buf = p
            elif len(buf) + len(p) <= max_chars:
                buf += p
            else:
                chunks.append(buf)
                buf = p
        # Comma-split piece can still exceed max_chars (no commas). Hard split.
        if buf:
            while len(buf) > max_chars:
                chunks.append(buf[:max_chars])
                buf = buf[max_chars:]
            if buf:
                chunks.append(buf)
    return chunks


def synthesize_with_kokoro_onnx(text: str, voice_id: str, speed: float, language: str = "en") -> tuple:
    """Synthesize using Kokoro ONNX model.
    Routes language → Kokoro's expected `lang` arg so non-English text
    (ja/es/fr/it/ja/pt/zh/hi) is rendered with the correct phonemes
    instead of falling back to English (which spells out CJK chars by
    Unicode block name — what caused the JP gibberish).
    Auto-chunks non-English text by sentence so individual model.create
    calls stay under Kokoro's 510 phoneme hard limit; chunks are
    concatenated with brief silence between them."""
    import numpy as np

    model = load_kokoro()
    processed_text = preprocess_text_for_kokoro(text)
    kokoro_lang = kokoro_lang_for(language)

    chunks = chunk_for_kokoro(processed_text, language)
    logger.info(
        f"ONNX synthesis: voice={voice_id}, lang={kokoro_lang} (from {language!r}), "
        f"input_chars={len(processed_text)}, chunks={len(chunks)}"
    )

    if len(chunks) == 1:
        samples, sample_rate = model.create(
            chunks[0], voice=voice_id, speed=speed, lang=kokoro_lang
        )
        return samples, sample_rate

    # Multi-chunk path (non-English long text)
    all_samples: list = []
    sample_rate = KOKORO_SAMPLE_RATE
    for i, chunk in enumerate(chunks):
        try:
            seg_samples, sample_rate = model.create(
                chunk, voice=voice_id, speed=speed, lang=kokoro_lang
            )
            all_samples.append(seg_samples)
            # ~150ms silence between sub-segments so concatenated audio
            # sounds like natural pauses, not abrupt cuts.
            if i < len(chunks) - 1:
                silence = np.zeros(int(sample_rate * 0.15), dtype=seg_samples.dtype)
                all_samples.append(silence)
        except Exception as e:
            logger.warning(f"Chunk {i+1}/{len(chunks)} failed ({e}); skipping. text={chunk!r}")

    if not all_samples:
        raise RuntimeError("All chunks failed synthesis")

    combined = np.concatenate(all_samples)
    return combined, sample_rate


async def synthesize_with_edge_tts(text: str, language: str, speaker: str = "female", speed: float = 1.0) -> tuple:
    """Fallback for languages Kokoro 82M doesn't include (de, ko).
    Uses Microsoft's free Edge TTS endpoint via the edge-tts library —
    same path audexa-radio's orchestrator uses for non-EN live radio
    languages, so the dependency is already battle-tested in production.
    Returns (samples, sample_rate) like the Kokoro path so callers can
    treat both uniformly."""
    import edge_tts
    import numpy as np
    import soundfile as sf

    voices = EDGE_TTS_LANG_MAP.get(language.lower())
    if not voices:
        raise ValueError(f"No Edge TTS voice configured for language {language!r}")
    voice = voices["male"] if speaker == "male" else voices["female"]

    # Edge TTS speed param is a percentage delta string, e.g. "+15%" / "-10%".
    rate_pct = int(round((speed - 1.0) * 100))
    rate_str = f"{'+' if rate_pct >= 0 else ''}{rate_pct}%"

    logger.info(f"Edge TTS synthesis: voice={voice}, rate={rate_str}, len={len(text)}")
    communicate = edge_tts.Communicate(text, voice, rate=rate_str)

    audio_bytes = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_bytes.extend(chunk["data"])

    # edge-tts returns MP3; decode via soundfile (uses libsndfile which handles MP3 via libsndfile 1.1+)
    # Fall back to ffmpeg subprocess if soundfile can't read MP3 in this build.
    try:
        with io.BytesIO(bytes(audio_bytes)) as buf:
            samples, sample_rate = sf.read(buf, dtype='float32')
    except Exception as sf_err:
        logger.info(f"soundfile MP3 decode failed ({sf_err}); falling back to ffmpeg")
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as mp3f:
            mp3f.write(bytes(audio_bytes))
            mp3_path = mp3f.name
        wav_path = mp3_path.replace('.mp3', '.wav')
        subprocess.run(['ffmpeg', '-y', '-i', mp3_path, '-ar', '24000', '-ac', '1', wav_path],
                       check=True, capture_output=True)
        samples, sample_rate = sf.read(wav_path, dtype='float32')
        os.unlink(mp3_path); os.unlink(wav_path)

    # Ensure mono
    if hasattr(samples, 'ndim') and samples.ndim > 1:
        samples = samples.mean(axis=1)
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


def route_voice_for_language(voice_id: str, language: str) -> tuple:
    """Decide which engine + voice to use for a given (voice_id, language) pair.
    Returns (engine, kokoro_voice_or_speaker) where engine is 'kokoro' or 'edge'.

    Logic:
      1. If the language is in EDGE_TTS_LANG_MAP (de, ko), route to Edge TTS;
         use the caller's speaker hint (male/female) inferred from voice_id.
      2. Else if voice_id starts with a Kokoro language prefix (af_, jf_, em_, …)
         AND matches the language family, trust the caller's pick.
      3. Else look up the default voice for the language in KOKORO_LANG_MAP.
      4. Else fall back to the resolved English voice (preserves legacy behavior).
    """
    lang = (language or "en").lower()
    # Edge TTS path
    if lang in EDGE_TTS_LANG_MAP:
        # Best-effort: anything from `am_*`/`bm_*`/`jm_*`/etc. → male voice, else female.
        speaker = "male" if voice_id and voice_id[1:2] == "m" else "female"
        return ("edge", speaker)

    # Kokoro path
    if lang in KOKORO_LANG_MAP:
        kokoro_lang_arg, default_female, default_male = KOKORO_LANG_MAP[lang]
        # Match voice family by first letter (a=american, b=british, e=spanish, f=french,
        # i=italian, j=japanese, p=portuguese, z=mandarin, h=hindi). Each lang has only
        # voices starting with its own family letter, so if the caller picks 'af_sarah'
        # but lang=ja, we must remap to 'jf_alpha'.
        family_letter = lang[0] if lang != "en" else "a"  # en→american prefix 'a'
        if voice_id in KOKORO_VOICES and voice_id.startswith(family_letter):
            return ("kokoro", voice_id)
        # Pick default by gender hint from caller's voice_id
        is_male = voice_id and voice_id[1:2] == "m"
        return ("kokoro", default_male if is_male else default_female)

    # Unknown language — fall back to English with whatever voice was requested
    return ("kokoro", resolve_voice(voice_id))


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest, background_tasks: BackgroundTasks):
    """Synthesize text to speech using Kokoro ONNX (CPU) or Edge TTS fallback."""
    engine, picked = route_voice_for_language(resolve_voice(request.voice_id), request.language)

    # Check cache (cache key includes engine + language so EN/JP don't collide)
    cache_key = get_cache_key(f"{engine}|{request.text}", picked, request.language, request.speed)
    cached = get_cached_audio(cache_key)
    if cached:
        return StreamingResponse(
            io.BytesIO(cached),
            media_type="audio/wav",
            headers={"X-Cache": "HIT", "X-Voice-ID": request.voice_id, "X-Engine": engine}
        )

    start_time = time.time()

    try:
        if engine == "edge":
            wav_array, sample_rate = await synthesize_with_edge_tts(request.text, request.language, speaker=picked, speed=request.speed)
        else:
            wav_array, sample_rate = synthesize_with_kokoro_onnx(request.text, picked, request.speed, language=request.language)

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
                "X-Engine": engine,
                "X-Language": request.language,
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
    """Synthesize long text using Kokoro ONNX (CPU) or Edge TTS fallback."""
    engine, picked = route_voice_for_language(resolve_voice(request.voice_id), request.language)

    cache_key = get_cache_key(f"{engine}|{request.text}", picked, request.language, request.speed)
    cached = get_cached_audio(cache_key)

    start_time = time.time()

    if cached:
        audio_data = cached
        logger.info(f"Long synthesis from cache: {len(request.text)} chars")
    else:
        logger.info(f"Long synthesis: {len(request.text)} chars, engine={engine}")
        if engine == "edge":
            wav_array, sample_rate = await synthesize_with_edge_tts(request.text, request.language, speaker=picked, speed=request.speed)
        else:
            wav_array, sample_rate = synthesize_with_kokoro_onnx(request.text, picked, request.speed, language=request.language)

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
            "X-Engine": engine,
            "X-Language": request.language,
            "X-Synthesis-Time-Ms": str(int(total_time * 1000)),
            "X-Character-Count": str(len(request.text)),
            "X-Device": "cpu",
        }
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
