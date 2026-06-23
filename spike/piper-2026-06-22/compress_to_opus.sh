#!/bin/bash
# Batch-convert raw PCM @ 24kHz mono 16-bit LE into Opus (.opus container).
# Output is the same filename with .opus extension. Manifest gets rewritten
# with format=opus + new file extensions.
#
# Run AFTER render_cache_parallel.py finishes.
#
# Usage: compress_to_opus.sh <pcm_dir> <out_dir> [bitrate_kbps]

set -e
PCM_DIR="${1:-/tmp/piper_spike/cache_full}"
OUT_DIR="${2:-/tmp/piper_spike/cache_full_opus}"
BITRATE="${3:-32}"   # 32 kbps is plenty for clear speech

mkdir -p "$OUT_DIR"

n=0
total=$(ls "$PCM_DIR"/*.pcm 2>/dev/null | wc -l | tr -d ' ')
echo "compressing $total .pcm files at ${BITRATE}kbps Opus, output → $OUT_DIR"
t_start=$(date +%s)

for f in "$PCM_DIR"/*.pcm; do
  name=$(basename "$f" .pcm)
  out="$OUT_DIR/${name}.opus"
  if [ -f "$out" ] && [ -s "$out" ]; then
    n=$((n+1))
    continue
  fi
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f s16le -ar 24000 -ac 1 -i "$f" \
    -c:a libopus -b:a "${BITRATE}k" -application voip -frame_duration 60 \
    "$out"
  n=$((n+1))
  if [ $((n % 200)) -eq 0 ]; then
    elapsed=$(( $(date +%s) - t_start ))
    echo "  $n/$total in ${elapsed}s ($(( n * 100 / total ))%)"
  fi
done

# Patch the manifest to reflect new format + file extensions
python3 - <<EOF
import json, os
src = "$PCM_DIR/manifest.json"
dst = "$OUT_DIR/manifest.json"
with open(src) as f:
    m = json.load(f)
m["format"] = "opus"
m["bitrate_kbps"] = $BITRATE
for h, e in m["labels"].items():
    e["file"] = e["file"].replace(".pcm", ".opus")
    op = os.path.join("$OUT_DIR", e["file"])
    if os.path.exists(op):
        e["bytes"] = os.path.getsize(op)
with open(dst, "w") as f:
    json.dump(m, f, indent=2)
print(f"manifest written to {dst}")

total = sum(e["bytes"] for e in m["labels"].values())
print(f"total opus size: {total/1024/1024:.1f} MB across {len(m['labels'])} files")
EOF

elapsed=$(( $(date +%s) - t_start ))
echo "done in ${elapsed}s"
du -sh "$OUT_DIR"
