#!/usr/bin/env python3
"""Generate a phoneme_ids.json for a SHORT (TalkBack-style) input."""
import json, subprocess, sys

TEXT = sys.argv[1] if len(sys.argv) > 1 else "Wi-Fi. Bluetooth. Settings. Display."
CONFIG = "/tmp/piper_spike/en_US-amy-low.onnx.json"
OUT = "/tmp/piper_spike/phoneme_ids_short.json"

ipa = subprocess.check_output(
    ["espeak-ng", "-v", "en-us", "-x", "--ipa", "-q", TEXT], text=True
).strip().replace("\n", " ")

with open(CONFIG) as f:
    cfg = json.load(f)
pid_map = cfg["phoneme_id_map"]
inf = cfg["inference"]

ids = [pid_map["^"][0]]
for ch in ipa:
    if ch in pid_map:
        ids.append(pid_map[ch][0])
        ids.append(pid_map["_"][0])
ids.append(pid_map["$"][0])

with open(OUT, "w") as f:
    json.dump({
        "text": TEXT,
        "ipa": ipa,
        "ids": ids,
        "scales": [inf["noise_scale"], inf["length_scale"], inf["noise_w"]],
        "sample_rate": cfg["audio"]["sample_rate"],
    }, f)

print(f"text  ({len(TEXT)} chars): {TEXT}")
print(f"ipa   ({len(ipa)} chars): {ipa}")
print(f"ids   ({len(ids)}): {ids}")
print(f"wrote {OUT}")
