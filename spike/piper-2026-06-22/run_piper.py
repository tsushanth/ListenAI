#!/usr/bin/env python3
"""Mac-side validation: load Piper en_US-amy-low, run inference, save WAV.

Mirrors what Android-side PiperOnDeviceService would do, minus the
phonemizer (we shell out to espeak-ng here; on Android we'd need
eSpeak NG via NDK or a Java port).
"""
import json, subprocess, sys, time
import numpy as np
import onnxruntime as ort
from scipy.io import wavfile

MODEL = "/tmp/piper_spike/en_US-amy-low.onnx"
CONFIG = "/tmp/piper_spike/en_US-amy-low.onnx.json"
TEXT = sys.argv[1] if len(sys.argv) > 1 else \
    "The quick brown fox jumps over the lazy dog. " \
    "Speech synthesis turns written words into spoken audio. " \
    "This benchmark measures how quickly the first sound reaches your ear."

# 1. Phonemize via espeak-ng (Piper voice config says voice=en-us)
t0 = time.time()
ipa = subprocess.check_output(
    ["espeak-ng", "-v", "en-us", "-x", "--ipa", "-q", TEXT],
    text=True,
).strip()
ipa = ipa.replace("\n", " ")
t_phon = time.time() - t0
print(f"phonemize: {t_phon*1000:.1f}ms")
print(f"  text  ({len(TEXT)} chars): {TEXT[:80]}…")
print(f"  IPA   ({len(ipa)} chars): {ipa[:80]}…")

# 2. Look up phoneme IDs in the model config
with open(CONFIG) as f:
    cfg = json.load(f)
pid_map = cfg["phoneme_id_map"]      # IPA char → [id]
sr = cfg["audio"]["sample_rate"]      # 16000

# Piper convention: BOS (^=1), then for each phoneme insert phoneme_id then pad (0),
# end with EOS ($=2).
ids = [pid_map["^"][0]]
for ch in ipa:
    if ch in pid_map:
        ids.append(pid_map[ch][0])
        ids.append(pid_map["_"][0])  # pad between every phoneme
    else:
        # Unknown IPA char — skip silently (Piper does the same)
        pass
ids.append(pid_map["$"][0])
print(f"  ids   ({len(ids)}): {ids[:20]}… → {ids[-5:]}")

# 3. Build inputs
x = np.array([ids], dtype=np.int64)
x_lengths = np.array([len(ids)], dtype=np.int64)
inf = cfg["inference"]
scales = np.array([inf["noise_scale"], inf["length_scale"], inf["noise_w"]], dtype=np.float32)

# 4. Run inference (CPU EP on Mac — same execution provider Android would use
# once we've ruled out NNAPI on the q8f16 Kokoro path; Piper here is fp32 so
# CPU is the apples-to-apples comparison anyway).
sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
print(f"providers: {sess.get_providers()}")

# Warm one tiny run to amortize JIT then time the real one.
print("warmup…")
sess.run(None, {"input": np.array([[1, 0, 14, 0, 2]], dtype=np.int64),
                "input_lengths": np.array([5], dtype=np.int64),
                "scales": scales})

print("real run…")
t0 = time.time()
outputs = sess.run(None, {"input": x, "input_lengths": x_lengths, "scales": scales})
t_inf = time.time() - t0
audio = outputs[0].squeeze()   # shape was [1, 1, 1, samples]
audio_seconds = len(audio) / sr
print(f"inference: {t_inf*1000:.1f}ms")
print(f"audio: {len(audio)} samples = {audio_seconds:.2f}s @ {sr}Hz")
print(f"real-time factor: {t_inf/audio_seconds:.3f}× (>1 = slower than realtime)")

# 5. Save WAV for sanity-check listening
audio_i16 = (audio * 32767).clip(-32768, 32767).astype(np.int16)
out_path = "/tmp/piper_spike/output.wav"
wavfile.write(out_path, sr, audio_i16)
print(f"wav: {out_path}")

# 6. Dump the full phoneme ID list so the Android benchmark can replay
# this exact inference without an espeak-ng dependency.
import json as _json
with open("/tmp/piper_spike/phoneme_ids.json", "w") as f:
    _json.dump({
        "text": TEXT,
        "ids": ids,
        "scales": scales.tolist(),
        "sample_rate": sr,
    }, f)
print(f"ids dumped to /tmp/piper_spike/phoneme_ids.json")
