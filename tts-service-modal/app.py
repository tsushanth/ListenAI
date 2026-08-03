"""
ReadAloud AI - Kokoro TTS on Modal (T4 GPU)
Serverless GPU with true scale-to-zero and per-second billing.
"""

import modal

# Define the container image with all dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("espeak-ng", "libsndfile1", "curl", "wget")
    .pip_install(
        "kokoro==0.9.4",
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "transformers==4.44.0",
        "soundfile==0.12.1",
        "numpy>=1.24.0,<2.0.0",
        "fastapi==0.109.0",
        "uvicorn[standard]==0.27.0",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    .run_commands(
        # Pre-download Kokoro model and all voices during image build
        "python3 -c \""
        "from kokoro import KPipeline; "
        "p = KPipeline(lang_code='a'); "
        "voices = ['af_heart','af_bella','af_nicole','af_sarah','af_sky',"
        "'am_adam','am_michael','bf_emma','bf_isabella','bm_george','bm_lewis']; "
        "[next(p('Test.', voice=v)) for v in voices]; "
        "print('All voices cached')"
        "\""
    )
)

app = modal.App("readaloud-tts", image=image)


@app.cls(
    gpu="T4",
    # 30s was too aggressive: torch+CUDA+Kokoro cold start takes ~16-20s
    # (measured via `modal app logs`), so any real-world gap over 30s
    # between requests forced a fresh cold start on every call — which is
    # the common case for TTS (users don't request narration every 30s).
    # 90s comfortably covers the back-to-back chunk requests within one
    # article's synthesis while still scaling down between distinct
    # sessions (typically minutes apart). At T4's $0.000164/s, worst-case
    # idle-keepalive cost is ~$0.0148 per session even if never reused.
    scaledown_window=90,
)
@modal.concurrent(max_inputs=10)
class KokoroTTS:
    @modal.enter()
    def load_model(self):
        """Load model once when container starts."""
        import time
        start = time.time()
        from kokoro import KPipeline
        self.pipeline = KPipeline(lang_code='a')
        self.load_time = time.time() - start
        print(f"Kokoro model loaded in {self.load_time:.2f}s")

    @modal.method()
    def synthesize(self, text: str, voice: str = "af_heart", speed: float = 1.0) -> dict:
        """Synthesize text to speech, return audio bytes + timing."""
        import time
        import io
        import re
        import numpy as np
        import soundfile as sf

        # Preprocess (same as GPU service)
        text = re.sub(r'\n{2,}', '\n\n', text)
        paragraphs = text.split('\n\n')
        processed = []
        for para in paragraphs:
            para = para.strip()
            if para:
                para = re.sub(r'\s+', ' ', para)
                processed.append(para)
        processed_text = '\n\n'.join(processed).strip()
        processed_text = re.sub(r'(\d+)"', r'\1 inches', processed_text)

        start = time.time()

        all_audio = []
        for _gs, _ps, audio in self.pipeline(processed_text, voice=voice, speed=speed):
            all_audio.append(audio)

        if len(all_audio) > 1:
            wav_array = np.concatenate(all_audio)
        else:
            wav_array = all_audio[0] if all_audio else np.array([])

        synthesis_time_ms = int((time.time() - start) * 1000)

        # Encode to WAV
        audio_buffer = io.BytesIO()
        sf.write(audio_buffer, wav_array, 24000, format='WAV')
        audio_buffer.seek(0)
        audio_bytes = audio_buffer.read()

        return {
            "audio": audio_bytes,
            "synthesis_time_ms": synthesis_time_ms,
            "audio_size_bytes": len(audio_bytes),
            "voice": voice,
            "text_length": len(text),
        }


# FastAPI web endpoint for HTTP access (same API as Cloud Run service)
@app.function(
    gpu="T4",
    scaledown_window=90,  # see KokoroTTS class above for rationale
    # allow_concurrent_inputs is deprecated in favor of @modal.concurrent,
    # but the docs don't show a confirmed stacking order with @modal.asgi_app()
    # — kept as-is here since it's proven working rather than guessing at
    # decorator order on a function with a hard budget cap watching it.
    allow_concurrent_inputs=10,
    image=image,
)
@modal.asgi_app()
def web():
    """FastAPI web endpoint matching the Cloud Run API."""
    import io
    import re
    import time
    import numpy as np
    import soundfile as sf
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel, Field

    web_app = FastAPI(title="ReadAloud TTS (Modal T4)")

    # Load model globally for this container
    from kokoro import KPipeline
    pipeline = KPipeline(lang_code='a')

    KOKORO_VOICES = {
        "af_heart": "American Female (Heart)", "af_bella": "American Female (Bella)",
        "af_nicole": "American Female (Nicole)", "af_sarah": "American Female (Sarah)",
        "af_sky": "American Female (Sky)", "am_adam": "American Male (Adam)",
        "am_michael": "American Male (Michael)", "bf_emma": "British Female (Emma)",
        "bf_isabella": "British Female (Isabella)", "bm_george": "British Male (George)",
        "bm_lewis": "British Male (Lewis)",
    }

    BUILTIN_VOICES = {
        "default": "af_heart", "alloy": "af_bella", "echo": "am_adam",
        "fable": "bf_emma", "onyx": "bm_george", "nova": "af_nicole",
        "shimmer": "af_sky", "adam": "am_adam", "michael": "am_michael",
        "heart": "af_heart", "bella": "af_bella", "nicole": "af_nicole",
        "sarah": "af_sarah", "sky": "af_sky", "emma": "bf_emma",
        "isabella": "bf_isabella", "george": "bm_george", "lewis": "bm_lewis",
    }

    def resolve_voice(voice_id: str) -> str:
        if voice_id in BUILTIN_VOICES:
            return BUILTIN_VOICES[voice_id]
        if re.match(r'^[ab][fm]_\w+$', voice_id) and voice_id in KOKORO_VOICES:
            return voice_id
        return "af_heart"

    def preprocess(text: str) -> str:
        text = re.sub(r'\n{2,}', '\n\n', text)
        paragraphs = text.split('\n\n')
        processed = [re.sub(r'\s+', ' ', p.strip()) for p in paragraphs if p.strip()]
        text = '\n\n'.join(processed)
        text = re.sub(r'(\d+)"', r'\1 inches', text)
        return text.strip()

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

    @web_app.get("/health")
    async def health():
        return {"status": "healthy", "model": "kokoro", "device": "cuda", "platform": "modal-t4"}

    @web_app.get("/voices")
    async def list_voices():
        return {"voices": KOKORO_VOICES}

    @web_app.post("/synthesize")
    async def synthesize(request: SynthesizeRequest):
        voice = resolve_voice(request.voice_id)
        processed_text = preprocess(request.text)
        start = time.time()

        try:
            all_audio = []
            for _gs, _ps, audio in pipeline(processed_text, voice=voice, speed=request.speed):
                all_audio.append(audio)

            wav_array = np.concatenate(all_audio) if len(all_audio) > 1 else (all_audio[0] if all_audio else np.array([]))
            synthesis_time = time.time() - start

            audio_buffer = io.BytesIO()
            sf.write(audio_buffer, wav_array, 24000, format='WAV')
            audio_buffer.seek(0)
            audio_data = audio_buffer.read()

            return StreamingResponse(
                io.BytesIO(audio_data),
                media_type="audio/wav",
                headers={
                    "X-Cache": "MISS",
                    "X-Voice-ID": request.voice_id,
                    "X-Model": "kokoro-modal-t4",
                    "X-Synthesis-Time-Ms": str(int(synthesis_time * 1000)),
                    "X-Character-Count": str(len(request.text)),
                    "X-Device": "cuda-t4",
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @web_app.post("/synthesize-long")
    async def synthesize_long(request: SynthesizeLongRequest):
        voice = resolve_voice(request.voice_id)
        processed_text = preprocess(request.text)
        start = time.time()

        try:
            all_audio = []
            for _gs, _ps, audio in pipeline(processed_text, voice=voice, speed=request.speed):
                all_audio.append(audio)

            wav_array = np.concatenate(all_audio) if len(all_audio) > 1 else (all_audio[0] if all_audio else np.array([]))
            synthesis_time = time.time() - start

            audio_buffer = io.BytesIO()
            sf.write(audio_buffer, wav_array, 24000, format='WAV')
            audio_buffer.seek(0)
            audio_data = audio_buffer.read()

            return StreamingResponse(
                io.BytesIO(audio_data),
                media_type="audio/wav",
                headers={
                    "X-Cache": "MISS",
                    "X-Model": "kokoro-modal-t4",
                    "X-Synthesis-Time-Ms": str(int(synthesis_time * 1000)),
                    "X-Character-Count": str(len(request.text)),
                    "X-Device": "cuda-t4",
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return web_app
