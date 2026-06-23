#!/usr/bin/env python3
"""Parallel version of render_cache_kokoro.py. Spawns N worker
processes, each with its own Kokoro session (model load is amortized
once per worker — ~3s startup × N workers vs ~3s × N labels otherwise).

Mac M-series usually has 4 performance + 4 efficiency cores; using
N=6 worker processes typically saturates the perf cores plus utilizes
some efficiency cores without thrashing.

Usage:
  python render_cache_parallel.py [voice] [labels_file] [out_dir] [n_workers]
"""
import hashlib, json, os, sys, time
import numpy as np
from multiprocessing import Pool

MODEL = "/tmp/piper_spike/kokoro-v1.0.fp16.onnx"
VOICES = "/tmp/piper_spike/voices-v1.0.bin"
VOICE = sys.argv[1] if len(sys.argv) > 1 else "af_heart"
LABELS = sys.argv[2] if len(sys.argv) > 2 else "/tmp/aosp_strings/full_labels.txt"
OUT_DIR = sys.argv[3] if len(sys.argv) > 3 else "/tmp/piper_spike/cache_full"
N_WORKERS = int(sys.argv[4]) if len(sys.argv) > 4 else 6

os.makedirs(OUT_DIR, exist_ok=True)

# Module-level — initialized lazily per worker process
_kokoro = None
def get_kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(MODEL, VOICES)
    return _kokoro


def render_one(args):
    idx, text = args
    norm = text.strip().lower()
    h = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]
    fn = f"{h}.pcm"
    out_path = os.path.join(OUT_DIR, fn)
    # Idempotent: skip if already rendered (allows resume after crash)
    if os.path.exists(out_path):
        # Stat for manifest
        sz = os.path.getsize(out_path)
        samples = sz // 2
        return (idx, text, norm, h, fn, samples, sz, 0, True)
    t_start = time.time()
    try:
        kokoro = get_kokoro()
        samples_arr, sample_rate = kokoro.create(text, voice=VOICE, speed=1.0, lang="en-us")
        pcm = (samples_arr * 32767).clip(-32768, 32767).astype(np.int16)
        pcm_bytes = pcm.tobytes()
        with open(out_path, "wb") as f:
            f.write(pcm_bytes)
        inf_ms = int((time.time() - t_start) * 1000)
        return (idx, text, norm, h, fn, len(pcm), len(pcm_bytes), inf_ms, False)
    except Exception as e:
        return (idx, text, norm, h, fn, 0, 0, 0, False, str(e))


def main():
    with open(LABELS) as f:
        labels = [line.strip() for line in f if line.strip()]
    print(f"rendering {len(labels)} labels with {N_WORKERS} workers, voice={VOICE}, out={OUT_DIR}")

    t0 = time.time()
    manifest = {}
    total_bytes = 0
    total_audio_ms = 0
    n_done = 0
    n_skipped = 0
    n_errors = 0
    sample_rate = 24000  # Kokoro v1.0 is always 24kHz

    with Pool(processes=N_WORKERS) as pool:
        # Use imap_unordered so we can show progress as workers complete
        for result in pool.imap_unordered(render_one, enumerate(labels), chunksize=4):
            if len(result) == 10:  # error
                idx, text, norm, h, fn, _, _, _, _, err = result
                print(f"  ERR [{idx}] '{text[:40]}': {err}")
                n_errors += 1
                continue
            idx, text, norm, h, fn, samples, n_bytes, inf_ms, was_cached = result
            audio_ms = int(samples * 1000 / sample_rate)
            total_bytes += n_bytes
            total_audio_ms += audio_ms
            manifest[h] = {
                "text": text,
                "norm": norm,
                "samples": samples,
                "ms": audio_ms,
                "bytes": n_bytes,
                "file": fn,
                "inf_ms": inf_ms,
            }
            n_done += 1
            if was_cached:
                n_skipped += 1
            # Progress every 100
            if n_done % 100 == 0:
                elapsed = time.time() - t0
                rate = n_done / elapsed
                eta = (len(labels) - n_done) / rate if rate > 0 else 0
                print(f"  [{n_done:>5}/{len(labels)}] {rate:>5.1f} labels/s  elapsed {elapsed:>5.0f}s  eta {eta:>5.0f}s")

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump({
            "sample_rate": sample_rate,
            "channels": 1,
            "bits_per_sample": 16,
            "voice": f"kokoro-{VOICE}",
            "labels": manifest,
        }, f, indent=2)

    elapsed = time.time() - t0
    print()
    print(f"done: {n_done} rendered ({n_skipped} cached, {n_errors} errors) in {elapsed:.1f}s ({n_done/elapsed:.1f}/s)")
    print(f"  total audio: {total_audio_ms/1000:.1f}s")
    print(f"  total bytes: {total_bytes/1024/1024:.2f} MB")


if __name__ == "__main__":
    main()
