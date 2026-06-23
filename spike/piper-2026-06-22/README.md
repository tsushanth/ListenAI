# Piper TTS spike — 2026-06-22

Mac-side scripts for the Piper investigation documented in
`android/TTS_LATENCY_INVESTIGATION_2026_06_22.md`.

## Setup

```bash
brew install espeak-ng
python3 -m venv venv && source venv/bin/activate
pip install onnxruntime numpy scipy

# Download Piper voice (~60MB) — NOT in git
curl -L -o en_US-amy-low.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx
curl -L -o en_US-amy-low.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx.json
```

The scripts assume model + config live in this directory (the rendering
script uses `/tmp/piper_spike/` — adjust if running from here).

## Scripts

- `run_piper.py` — single-shot Mac inference, prints timing + saves WAV.
  Used to validate the architecture before committing to integration.
- `gen_short_ids.py` — phonemize an arbitrary short string and emit a
  JSON of phoneme IDs ready to paste into a benchmark `--es ids` extra.
- `render_cache.py` — bulk-render `talkback_labels.txt` into raw PCM
  files + manifest. Output goes to APK assets at
  `android/app/src/main/assets/talkback_cache/`. **Regenerate from
  here**, don't hand-edit the asset dir.
- `talkback_labels.txt` — one label per line, the corpus the cache
  ships with. Append-and-rerender to grow.

## Why this lives here

The build doesn't depend on these — the produced PCM is checked into
`assets/`. But the scripts ARE the source of truth for the cache:
anyone changing labels or trying a different voice needs to re-run
`render_cache.py`, so they should be reproducible from the repo, not
ephemeral in /tmp.
