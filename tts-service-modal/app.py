"""
ReadAloud AI - Kokoro TTS on Modal (T4 GPU)
Serverless GPU with true scale-to-zero and per-second billing.
"""

import os

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
    .pip_install(
        # Non-English Kokoro (es/fr/hi/it/pt) phonemises through espeak-ng via misaki.espeak.
        "phonemizer-fork==3.3.2",
        "espeakng-loader==0.2.4",
    )
    .run_commands(
        # Pre-download the non-English voices (one KPipeline per lang_code) so first use is not a cold HF fetch.
        "python3 -c \""
        "from kokoro import KPipeline; "
        "m = {'e': ['ef_dora','em_alex','em_santa'], 'f': ['ff_siwis'], 'h': ['hf_alpha','hf_beta','hm_omega','hm_psi'], "
        "'i': ['if_sara','im_nicola'], 'p': ['pf_dora','pm_alex','pm_santa']}; "
        "[next(KPipeline(lang_code=lc)('Prueba.', voice=v)) for lc, vs in m.items() for v in vs]; "
        "print('Non-English voices cached')"
        "\""
    )
    .pip_install(
        # Piper (CPU, ONNX) for the dubbing voices; same pin as realtime-tts worker-piper-fly.
        "piper-tts==1.8.0",
        "scipy",
    )
    .add_local_python_source("kokoro_langs", "piper_engine")
)

# Dubbing voices (es-pilot-f/m, fr-fr-mls-f/m; tier A, CC BY 4.0) live on this Modal volume as <id>/model.onnx + owner.json.
# piper_engine.DUB_PIPER_VOICES is the allowlist: nothing else on the volume can be served from here.
HOUSE_VOICES = modal.Volume.from_name("house-voices")

# Context for humans/AIs: `modal dict get infra-context <app-name>` (who calls this app, evidence, spend). Keep tags in sync.
TAGS = {"status": "low-use", "owner": "backend-api-tts", "context": "modal-dict-infra-context", "verified": "2026-10-01"}
# Name override is for ephemeral verification runs ONLY (e.g. READALOUD_TTS_APP_NAME=ra-dub-verify-tts modal serve ...)
# so a test deploy can never replace the production app of the same name.
APP_NAME = os.environ.get("READALOUD_TTS_APP_NAME", "readaloud-tts")
app = modal.App(APP_NAME, image=image, tags=TAGS)


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
        import kokoro_langs as kl
        # One KPipeline per Kokoro lang_code; English is loaded eagerly, others on first use.
        self.pipelines = kl.PipelineCache(lambda lc: KPipeline(lang_code=lc))
        self.pipeline = self.pipelines.get('a')
        self.load_time = time.time() - start
        print(f"Kokoro model loaded in {self.load_time:.2f}s")

    @modal.method()
    def synthesize(self, text: str, voice: str = "af_heart", speed: float = 1.0, language: str = "en") -> dict:
        """Synthesize text to speech, return audio bytes + timing."""
        import time
        import io
        import re
        import numpy as np
        import soundfile as sf
        import kokoro_langs as kl

        voice, lang_code = kl.plan(voice, language, kl.is_direct_kokoro_voice(voice))  # raises NonEnglishDisabled unless KOKORO_NON_ENGLISH_ENABLED=1
        pipeline = self.pipelines.get(lang_code)

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
        if kl.is_english(lang_code):
            processed_text = re.sub(r'(\d+)"', r'\1 inches', processed_text)
        else:
            processed_text = kl.preprocess_non_english(processed_text)

        start = time.time()

        all_audio = []
        for _gs, _ps, audio in pipeline(processed_text, voice=voice, speed=speed):
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
    # Piper dubbing voices run on CPU inside this container (onnxruntime, 2 threads each); with Modal's default
    # fractional CPU reservation they synthesize ~5x slower than the catalog's cpu_rtf (measured), so reserve cores.
    cpu=4,
    scaledown_window=90,  # see KokoroTTS class above for rationale
    # allow_concurrent_inputs is deprecated in favor of @modal.concurrent,
    # but the docs don't show a confirmed stacking order with @modal.asgi_app()
    # — kept as-is here since it's proven working rather than guessing at
    # decorator order on a function with a hard budget cap watching it.
    allow_concurrent_inputs=10,
    image=image,
    volumes={"/house-voices": HOUSE_VOICES.read_only()},
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
    import kokoro_langs as kl
    pipelines = kl.PipelineCache(lambda lc: KPipeline(lang_code=lc))
    pipelines.get('a')  # English eagerly (cold start); other languages build on first request

    import piper_engine
    piper_registry = piper_engine.PiperRegistry("/house-voices")

    def piper_wav(text: str, voice_id: str, speed: float) -> bytes:
        """WAV (24 kHz PCM16 mono) of an allowlisted Piper dubbing voice; speed = Piper length_scale control."""
        audio = piper_registry.synth(text, voice_id, speed)
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        buf = io.BytesIO()
        sf.write(buf, pcm, piper_engine.OUT_SR, format='WAV', subtype='PCM_16')
        return buf.getvalue()

    async def piper_response(request):
        from fastapi.concurrency import run_in_threadpool
        start = time.time()
        try:
            data = await run_in_threadpool(piper_wav, request.text, request.voice_id, request.speed)
        except piper_engine.PiperVoiceError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
        return StreamingResponse(
            io.BytesIO(data),
            media_type="audio/wav",
            headers={
                "X-Cache": "MISS",
                "X-Engine": "piper",
                "X-Voice-ID": request.voice_id,
                "X-Model": "piper-modal",
                "X-Synthesis-Time-Ms": str(int((time.time() - start) * 1000)),
                "X-Character-Count": str(len(request.text)),
            },
        )

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
        if kl.is_direct_kokoro_voice(voice_id):
            return voice_id
        return "af_heart"

    def pick(voice_id: str, language: str):
        """(voice, lang_code, pipeline). A native Kokoro voice id decides the lang_code; for generic/English aliases the
        request language decides (non-English text is never read with an English voice)."""
        direct = kl.is_direct_kokoro_voice(voice_id)
        try:
            voice, lang_code = kl.plan(voice_id if direct else resolve_voice(voice_id), language, direct)
        except kl.NonEnglishDisabled as e:
            # Owner voice-provenance gate: Kokoro non-English is OFF unless KOKORO_NON_ENGLISH_ENABLED=1.
            raise HTTPException(status_code=403, detail=str(e))
        return voice, lang_code, pipelines.get(lang_code)

    def preprocess(text: str, lang_code: str = 'a') -> str:
        if not kl.is_english(lang_code):
            return kl.preprocess_non_english(text)
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
        if piper_engine.is_dub_piper_voice(request.voice_id):
            return await piper_response(request)
        voice, lang_code, pipeline = pick(request.voice_id, request.language)
        processed_text = preprocess(request.text, lang_code)
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
                    "X-Voice-ID": voice,
                    "X-Lang-Code": lang_code,
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
        if piper_engine.is_dub_piper_voice(request.voice_id):
            return await piper_response(request)
        voice, lang_code, pipeline = pick(request.voice_id, request.language)
        processed_text = preprocess(request.text, lang_code)
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
                    "X-Voice-ID": voice,
                    "X-Lang-Code": lang_code,
                    "X-Model": "kokoro-modal-t4",
                    "X-Synthesis-Time-Ms": str(int(synthesis_time * 1000)),
                    "X-Character-Count": str(len(request.text)),
                    "X-Device": "cuda-t4",
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return web_app
