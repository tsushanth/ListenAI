#!/usr/bin/env python3
"""Pre-render a list of common TalkBack labels with Piper en_US-amy-low
and write them as raw 16-bit LE PCM files into a directory ready to be
copied into the Android app's assets dir.

Produces:
  manifest.json      — {sha16_of_normalized_text: {text, samples, ms, file}}
  <sha16>.pcm        — raw 16-bit little-endian mono PCM @ sample_rate
                       (sample rate is in manifest; matches Piper voice)

Normalization rule (must match the Android side exactly):
  text.trim().toLowerCase()  -> SHA-256 -> first 16 hex chars
"""
import hashlib, json, os, subprocess, sys, time
import numpy as np
import onnxruntime as ort

MODEL = "/tmp/piper_spike/en_US-amy-low.onnx"
CONFIG = "/tmp/piper_spike/en_US-amy-low.onnx.json"
LABELS = sys.argv[1] if len(sys.argv) > 1 else "/tmp/piper_spike/talkback_labels.txt"
OUT_DIR = sys.argv[2] if len(sys.argv) > 2 else "/tmp/piper_spike/cache"

os.makedirs(OUT_DIR, exist_ok=True)

with open(CONFIG) as f:
    cfg = json.load(f)
pid_map = cfg["phoneme_id_map"]
inf = cfg["inference"]
sr = cfg["audio"]["sample_rate"]
scales = np.array([inf["noise_scale"], inf["length_scale"], inf["noise_w"]], dtype=np.float32)

print(f"loading model…")
sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])

with open(LABELS) as f:
    labels = [line.strip() for line in f if line.strip()]
print(f"rendering {len(labels)} labels at {sr}Hz")

manifest = {}
total_bytes = 0
total_ms = 0
t0 = time.time()
for i, text in enumerate(labels):
    norm = text.strip().lower()
    h = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]
    fn = f"{h}.pcm"
    # Phonemize via espeak-ng (Piper voice config says en-us)
    ipa = subprocess.check_output(
        ["espeak-ng", "-v", "en-us", "-x", "--ipa", "-q", text], text=True
    ).strip().replace("\n", " ")
    ids = [pid_map["^"][0]]
    for ch in ipa:
        if ch in pid_map:
            ids.append(pid_map[ch][0])
            ids.append(pid_map["_"][0])
    ids.append(pid_map["$"][0])
    x = np.array([ids], dtype=np.int64)
    xlen = np.array([len(ids)], dtype=np.int64)
    t_start = time.time()
    audio = sess.run(None, {"input": x, "input_lengths": xlen, "scales": scales})[0].squeeze()
    inf_ms = int((time.time() - t_start) * 1000)
    # Float32 [-1,1] → int16 LE PCM
    pcm = (audio * 32767).clip(-32768, 32767).astype(np.int16)
    pcm_bytes = pcm.tobytes()
    with open(os.path.join(OUT_DIR, fn), "wb") as f:
        f.write(pcm_bytes)
    audio_ms = int(len(pcm) * 1000 / sr)
    total_bytes += len(pcm_bytes)
    total_ms += audio_ms
    manifest[h] = {
        "text": text,
        "norm": norm,
        "samples": len(pcm),
        "ms": audio_ms,
        "bytes": len(pcm_bytes),
        "file": fn,
        "inf_ms": inf_ms,
    }
    print(f"  [{i+1:>3}/{len(labels)}] {text:<30s} → {fn} ({len(pcm_bytes):>6}B, {audio_ms:>4}ms audio, {inf_ms:>4}ms synth)")

# Manifest tracks the format too so the Android side can read PCM correctly
with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
    json.dump({
        "sample_rate": sr,
        "channels": 1,
        "bits_per_sample": 16,
        "voice": "en_US-amy-low",
        "labels": manifest,
    }, f, indent=2)

elapsed = time.time() - t0
print()
print(f"done: {len(labels)} labels in {elapsed:.1f}s")
print(f"  total audio:  {total_ms/1000:.1f}s")
print(f"  total bytes:  {total_bytes/1024/1024:.2f} MB")
print(f"  manifest:     {OUT_DIR}/manifest.json")
