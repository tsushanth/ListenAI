#!/usr/bin/env python3
"""
Download and cache all TTS models during Docker build.
This ensures models are baked into the image for fast cold starts.
"""

import os
import sys

# Set up HuggingFace cache directory
os.environ.setdefault('HF_HOME', '/app/.cache/huggingface')
os.environ.setdefault('HUGGINGFACE_HUB_CACHE', '/app/.cache/huggingface/hub')

def download_kokoro():
    """Download and cache Kokoro-82M model and all voice packs."""
    print("=" * 50)
    print("Downloading Kokoro-82M model and voices...")
    print("=" * 50)

    from kokoro import KPipeline

    # Initialize pipeline (downloads main model)
    print("Loading Kokoro pipeline...")
    pipeline = KPipeline(lang_code='a')  # 'a' = American English
    print("✓ Kokoro pipeline loaded")

    # List of voices to pre-download
    # These are the voices we support in our service
    voices = [
        'af_heart',    # Default female
        'af_bella',    # Female alternative
        'af_nicole',   # Female (Rachel mapping)
        'af_sarah',    # Female
        'af_sky',      # Female
        'am_adam',     # Male (Adam mapping)
        'am_michael',  # Male (default male)
        'bf_emma',     # British female
        'bf_isabella', # British female
        'bm_george',   # British male
        'bm_lewis',    # British male
    ]

    # Run synthesis for each voice to trigger download
    for voice in voices:
        print(f"Pre-downloading voice: {voice}...", end=" ")
        try:
            # Run a short synthesis to trigger voice file download
            for gs, ps, audio in pipeline('Test.', voice=voice):
                pass  # Just need to trigger the download
            print(f"✓")
        except Exception as e:
            print(f"⚠ failed: {e}")

    print("=" * 50)
    print("✓ Kokoro fully cached")
    print("=" * 50)

def download_chatterbox():
    """Download and cache Chatterbox model for voice cloning."""
    print("=" * 50)
    print("Downloading Chatterbox model for voice cloning...")
    print("=" * 50)

    try:
        from chatterbox.tts import ChatterboxTTS

        # Initialize Chatterbox - this downloads the model
        print("Loading Chatterbox model...")
        model = ChatterboxTTS.from_pretrained(device="cpu")  # Use CPU for download
        print("✓ Chatterbox model cached successfully")

        # Clean up to free memory
        del model

    except Exception as e:
        print(f"⚠ Chatterbox download failed (will download on first use): {e}")

    print("=" * 50)
    print("✓ Chatterbox setup complete")
    print("=" * 50)

def download_xtts():
    """Download and cache XTTS v2 model for voice cloning."""
    print("=" * 50)
    print("Downloading XTTS v2 model for voice cloning...")
    print("=" * 50)

    try:
        from TTS.api import TTS

        # Initialize XTTS - this downloads the model
        print("Loading XTTS v2 model...")
        model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cpu")
        print("✓ XTTS v2 model cached successfully")

        # Clean up to free memory
        del model

    except Exception as e:
        print(f"⚠ XTTS download failed (will download on first use): {e}")

    print("=" * 50)
    print("✓ XTTS setup complete")
    print("=" * 50)

if __name__ == "__main__":
    try:
        download_kokoro()
        download_chatterbox()
        download_xtts()
        print("\n✓ All models downloaded successfully!")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        sys.exit(1)
