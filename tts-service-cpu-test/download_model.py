#!/usr/bin/env python3
"""Download Kokoro ONNX model and voices during Docker build."""

import os
os.environ.setdefault('HF_HOME', '/app/.cache/huggingface')

def download():
    print("Downloading Kokoro ONNX model and voices...")
    from kokoro_onnx import Kokoro
    model = Kokoro("/app/kokoro-v1.0.onnx", "/app/voices-v1.0.bin")
    print("Model loaded, testing synthesis...")

    # Quick test to verify it works
    samples, sr = model.create("Test.", voice="af_heart", speed=1.0, lang="en-us")
    print(f"Test synthesis OK: {len(samples)} samples at {sr}Hz")

    # Pre-warm all voices
    voices = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky',
              'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis']
    for voice in voices:
        try:
            samples, sr = model.create("Test.", voice=voice, speed=1.0, lang="en-us")
            print(f"  Voice {voice}: OK")
        except Exception as e:
            print(f"  Voice {voice}: FAILED - {e}")

    print("Done!")

if __name__ == "__main__":
    download()
