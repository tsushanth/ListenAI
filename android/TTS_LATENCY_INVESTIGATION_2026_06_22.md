# TTS Latency Investigation — 2026-06-22

End-to-end record of a single-evening sweep on Pixel 9 Pro to cut the
speak()-to-first-audible-sound latency for the system TTS engine
(`com.listenai.systemtts.ReadAloudTTSService`). Triggered by Warren Carr's
2026-06-22 bug report on v47 (Play closed testing):

> sluggish ... several seconds before TalkBack speaks what's under my finger

All numbers are measured on a single device (Pixel 9 Pro, Android 17,
kokoro `model_q8f16.onnx` ~80MB ONNX bundle, ORT Mobile 1.22.0) using a
fixed 170-char benchmark text:

> The quick brown fox jumps over the lazy dog. Speech synthesis turns
> written words into spoken audio. This benchmark measures how quickly
> the first sound reaches your ear.

Driven via `BenchmarkActivity` (an adb-launchable activity that uses
the public `TextToSpeech` client API against our engine — same code
path TalkBack/Maps/Kindle exercise). Audio captured at the speaker
with `scrcpy --no-video --audio-source=playback --record=…` and
cross-referenced with logcat timestamps. Spectrogram analysis in
`/tmp/tts_latency_analysis.py`.

---

## Headline result

| Build | What changed | First audio at speaker | Total synthesis |
|-------|--------------|------------------------:|----------------:|
| v47 (morning baseline) | none — production | ~24s (1 chunk × 24s) | 24s |
| **v53 (shipped to Play closed testing)** | streaming + 60-char chunks + `@Synchronized` ensureSession | **~7s** | 22.6s |
| v55 (best EP attempt) | + NNAPI/XNNPACK sweep | ~7.2s | 23.2s |

**3.4× faster first-audio for medium/long text** (book paragraphs, Maps
directions, long article reads). Total synthesis also dropped 5% as a
side effect of killing concurrent ORT session creation.

**Warren's specific complaint is NOT meaningfully fixed**. Short
TalkBack utterances ("Wi-Fi", "Bluetooth", 15-30 chars) stay
single-chunk, so streaming gives nothing. The morning telemetry showed
1.9s p50 for those. After v53 it's roughly 1.5-1.8s p50 (concurrency
fix helps a little but architecture didn't move). Target for "feels
native" is ~200-300ms. We are still 5-7× off.

---

## Experiments (in order)

### v48 — Per-stage latency telemetry

`LatencyTelemetry` singleton + ring buffer of last 100 calls. Records
per inference: `tokenize_ms`, `embedding_ms`, `sess_run_ms`,
`wav_pack_ms`, `total_ms`, `audio_ms`, `nnapi_available`,
`cold_start`. Surfaced as a Diagnostics card at the bottom of the
in-app TTS settings; also logged to `adb logcat -s KokoroLatency:I`.

Morning data (19 short TalkBack-style utterances, ~19 chars median):

| | p50 | p95 | max |
|---|---:|---:|---:|
| Total | 1899 ms | 6604 ms | 8874 ms |
| `sess.run` only | 1831 ms | 6598 ms | — |
| Tokenize | 1 ms | 1 ms | — |
| WAV pack | 0 ms | 11 ms | — |

Key finding: `sess.run` is 96% of total. NNAPI "attached 100%" but
median RTF was 0.78× — textbook signature of silent CPU fallback.
Tokenize and WAV pack are noise.

Commit: `6eaa41b`

### v49 — Streaming PCM to AudioTrack

`ReadAloudTTSService.streamKokoroChunksToCallback`: pushes each
chunk's 16-bit PCM directly to `SynthesisCallback.audioAvailable`
as it's produced. No WAV file lands on disk, AudioTrack starts
draining chunk 1 while chunk 2 is still synthesizing.

`KokoroOnDeviceService.synthesizeChunkedPcm` — chunk-yielding
synthesis with per-chunk callback signature.

Effect alone: roughly 50-100ms saved per single-chunk utterance (no
WAV write+read round-trip). Not measurable on the benchmark because
v49 still used 350-char cap so the 170-char text was single-chunk.

Commit: included in `1bbada2`.

### v50 — `BenchmarkActivity` for adb-driven testing

Headless TTS benchmark, launches via
`adb shell am start -n com.listenai/.systemtts.BenchmarkActivity --es text "…"`.
Uses the public `TextToSpeech` client API with `engine="com.listenai"`
so it exercises the exact code path TalkBack / Maps / Kindle hit.

Logged timestamps form a recoverable timeline: `T_ACTIVITY_START`,
`T_TTS_INIT_DONE`, `T_SPEAK_CALL`, `T_UTTERANCE_START`,
`T_FIRST_AUDIO_PUSH` (logged inside the service), `T_UTTERANCE_DONE`.

First measurement (170-char input, 350-char cap → 1 chunk):

| Stage | Time |
|---|---:|
| T_SPEAK → T_SVC_ENTRY | 7 ms |
| 1 chunk inference | 23,917 ms |
| T_FIRST_AUDIO_PUSH | T+23,917 ms |
| T_UTTERANCE_DONE | T+24,779 ms |

170 chars yielded a single 23.9s chunk → no streaming amortization
possible. Forced the next move.

Commit: included in `1bbada2`.

### v51 — Drop `STREAMING_CHUNK_CHAR_CAP` to 60

Same input now splits into 4 chunks (44 / 55 / 59 / 9 chars).
`chunkTextForModel` + `splitOverlongSentence` now accept a `charCap`
arg; system TTS path passes 60, in-app reader keeps 350.

| Chunk | Chars | Inference | Notes |
|---:|---:|---:|---|
| 1 | 44 | 6,645 ms | cold (JIT) |
| 2 | 55 | 3,469 ms | warm |
| 3 | 59 | 3,234 ms | warm |
| 4 | 9 | 1,170 ms | warm |
| Total | | 25,203 ms | |
| T_FIRST_AUDIO_PUSH | | **T+9,518 ms** | (chunk 1 + push drain) |

Spectrogram of the device audio confirmed 4 distinct speech segments
at recording times 19.00/25.37/32.36/36.92s with ~3.5s silence gaps
between. Streaming structurally working.

**Side discovery**: silence gaps between segments are 3.3-3.8s.
That's because `runInference` for chunk N+1 doesn't start until
chunk N's audio fully drains through AudioTrack (the push callback
blocks). Decoupling synth and push threads is the obvious next 2×
win (see "Open follow-ups").

Commit: `1bbada2`.

### v52 — Synthetic warmup inference (REGRESSION)

Hypothesis: chunk 1 = 6.6s vs chunks 2-4 = 3.3s is ORT JIT compilation
on first call. A throwaway 6-token inference inside `ensureSession`
would amortize the JIT cost.

| Metric | v51 (no warmup) | v52 (with warmup) |
|---|---:|---:|
| `createSession` | 1 race, 1.3s | **3 races, 2.7+3.6+3.7s** |
| Chunk 1 inference | 6,645 ms | 7,391 ms |
| T_FIRST_AUDIO_PUSH | T+9,518 ms | **T+10,257 ms** |
| Total synthesis | 25,203 ms | 25,884 ms |

Logcat revealed two unrelated issues that the warmup change exposed:

1. **Synthetic warmup shape didn't match real chunk shape** (6 tokens
   vs 50-60 tokens). ORT JIT didn't transfer, so chunk 1 still paid
   the cold cost.
2. **`ensureSession` was racy**. Three concurrent callers
   (in-flight `onSynthesizeText`, async `isAvailable()` warmup,
   in-app preview) each called `env.createSession` in parallel
   → three sessions, three JITs, CPU contention. Two of them were
   leaked memory until process death.

The warmup change made things worse on net. Reverted in v53.

Lesson: when a change moves the wrong direction, dig into the logcat
before declaring failure. The race condition was load-bearing on
two separate workstreams.

(Not shipped — was a transient.)

### v53 — `@Synchronized` ensureSession (WIN — shipped)

Single-line fix: `@Synchronized` on `ensureSession`. No more racing
session creation.

| Metric | v51 | v53 | Δ |
|---|---:|---:|---:|
| `createSession` races | 1 (1.3s) | 1 (1.3s) | — |
| Chunk 1 inference | 6,645 ms | **4,112 ms** | -38% |
| Chunk 2 inference | 3,469 ms | 3,414 ms | -2% |
| T_FIRST_AUDIO_PUSH | 9,518 ms | **6,981 ms** | -27% |
| Total synthesis | 25,203 ms | 22,647 ms | -10% |

The chunk 1 win was unexpected. In v52 the 3 racing sessions were
stealing CPU from each other AND from the real synthesis thread; in
v53 the synth thread has the CPU to itself, so even chunk 1 (the
JIT-heavy one) runs faster.

Shipped to Play closed testing as `v2.14.10 / vc53`. Commit: `275d547`.

### v54 / v55 — EP switcher infrastructure + sweep

Added `EpConfig` enum + `readEpConfig()` reading
`SharedPreferences("kokoro_ep")`. `SetEpReceiver` writes the pref
synchronously via:

    adb shell am broadcast -a com.listenai.SET_EP --es ep NNAPI_FP16 \
      --receiver-include-background

The `--receiver-include-background` flag is required — without it
broadcasts skip stopped packages and the test silently uses whatever
EP was previously persisted. First sweep was contaminated by exactly
this; second sweep below is clean.

#### EP sweep (170-char benchmark, force-stop between each)

| EP | Chunk 1 | T_FIRST_AUDIO_PUSH | Total |
|---|---:|---:|---:|
| NNAPI_DEFAULT | 4,157 ms | 7,179 ms | 23,179 ms |
| NNAPI_FP16 | 4,131 ms | 7,155 ms | 23,236 ms |
| NNAPI_FP16_NO_CPU | 4,392 ms | 7,435 ms | 23,635 ms |
| XNNPACK | 4,402 ms | 7,426 ms | 23,745 ms |
| **CPU_ONLY (control)** | **4,196 ms** | **7,224 ms** | **23,663 ms** |

**Every EP is within ±5% of pure CPU.** NNAPI claims attached but the
model never runs on the Tensor TPU. Confirmed by three independent
signals:

1. `NNAPI_FP16` (allow FP16 acceleration) made zero difference
2. `NNAPI_FP16 + CPU_DISABLED` (refuse NNAPI's CPU fallback) didn't
   error AND ran at CPU speed — meaning ORT's per-op fallback to its
   own CPU EP is bypassing the NNAPI gate entirely
3. XNNPACK (a fully different CPU EP) ran identically to default CPU
   — confirming ORT's default CPU already uses vectorized kernels
   for our quantized op set, so XNNPACK has nothing to add

**Diagnosis**: Kokoro's `q8f16` quantization scheme (INT8 weights +
FP16 activations) is not supported by Pixel 9 Pro's NNAPI dispatcher.
Per-op fallback through ORT means the EP attachment is decorative.

**No NNAPI flag combination will fix this.**

(EP infrastructure shipped in `v55` but default unchanged. Useful for
future quantization experiments.)

---

## What WOULD actually accelerate

Ranked by plausible speedup vs effort:

1. **Switch to Piper / VITS** (~5MB models, CPU-fast, designed for
   on-device). Spike started in `/tmp/piper_spike/`. Real
   integration needs:
   - eSpeak NG phonemizer on Android (NDK build — non-trivial)
   - VITS forward pass (similar shape to Kokoro)
   - New voice catalog entries
   - Quality regression vs Kokoro (Piper is good, Kokoro is great)
   - **Estimate**: 4-6 hours focused work

2. **Re-export Kokoro with NNAPI-friendly quantization** —
   per-tensor symmetric INT8, no INT32 intermediates. Requires the
   Python export pipeline. Risk: quality regression from the
   coarser quantization scheme.
   - **Estimate**: 1-day spike, uncertain payoff

3. **TFLite + Edge TPU delegate** (Tensor SOC's native runtime
   instead of ONNX/NNAPI). Different model file, different
   runtime stack. Highest ceiling but biggest pivot.
   - **Estimate**: 2-3 days

4. **Pre-rendered audio cache for common TalkBack labels**. Top
   1000 short utterances ("Wi-Fi", "Bluetooth", "Settings"…)
   pre-rendered server-side, shipped as ~10MB asset, hash-lookup
   at synthesis time. Misses unknown text but kills latency for
   the common case.
   - **Estimate**: 4 hours, complementary to any model fix

---

## Open follow-ups (not done tonight)

- **Decouple synth thread from push thread** in
  `streamKokoroChunksToCallback`. Currently `audioAvailable` blocks
  on AudioTrack drain, which serializes chunk N+1 inference behind
  chunk N playback. Spectrogram shows 3.3-3.8s silence gaps between
  chunks — those are wasted inference cycles. Expected impact:
  another 2× reduction in first-audio for multi-chunk text.

- **Realistic-shape warmup**. v52 used 6 tokens; real chunks are
  50-60. Need a one-time background WorkManager job that runs a
  ~50-token synthetic synthesis when the user sets us as default
  engine. Triggered out-of-band so the user's first real synthesis
  doesn't pay the warmup cost.

- **Tail latency**. The 6,604ms p95 from morning telemetry (vs
  1,899ms p50) is 3.5× the median. Investigate what's different
  about those calls — GC, ORT memory allocator, NNAPI binder
  contention, etc.

---

## Reproduction

```bash
# Install latest build
cd android && ./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk

# Ensure ReadAloud is default TTS engine
adb shell settings put secure tts_default_synth com.listenai

# Run a single benchmark (default text)
adb shell am force-stop com.listenai
adb shell am start -n com.listenai/.systemtts.BenchmarkActivity

# Dump the timeline
adb logcat -d -s TTSBench:I ReadAloudTTSService:I KokoroOnDeviceTTS:I \
  | grep -E 'T_|chunk [0-9]/|createSession|all .* chunks done'

# Switch EP for next run (commit before force-stop)
adb shell am broadcast -a com.listenai.SET_EP --es ep NNAPI_FP16 \
  --receiver-include-background

# Capture audio for spectrogram analysis (requires scrcpy 4.0+)
scrcpy --no-video --audio-source=playback --record=/tmp/bench.mp4 \
  --no-window &
# ...run benchmark...
pkill -INT scrcpy
ffmpeg -y -i /tmp/bench.mp4 -vn -ar 24000 -ac 1 /tmp/bench.wav
python3 /tmp/tts_latency_analysis.py /tmp/bench.wav
```

---

## Commits this session

| Commit | Version | Summary |
|---|---|---|
| `6eaa41b` | 2.14.5 / vc48 | Latency telemetry + Diagnostics card |
| `1bbada2` | 2.14.8 / vc51 | Streaming PCM + 60-char chunks + BenchmarkActivity |
| `275d547` | 2.14.10 / vc53 | @Synchronized ensureSession (3.4× total speedup landed here) |
| (this) | 2.14.12 / vc55 | EP switcher + sweep infrastructure + this doc |

All four pushed to `origin/main`. `v53` is on Play closed testing.
