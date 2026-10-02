# Measured Modal cost per job (2026-10-02)

Source of the numbers behind `AUDIO_JOB_PRICING` in `backend/src/lib/realtimeTtsBilling.ts`.
Rates: Modal published per-second prices (https://modal.com/pricing, read 2026-10-02): A10 $0.000306/s,
L4 $0.000222/s, T4 $0.000164/s. CPU ($0.0000131/core-s) and memory ($0.00000222/GiB-s) are NOT added below
(a few percent at most for these GPU-bound jobs). Modal's `billing report` for all benchmark apps combined
was $0.25 by the end of the runs (it lags), well inside the $5 cap.

Method: the repo's own Modal functions, unmodified except where noted, run as throwaway `modal run` /
`modal deploy` copies (apps `*-bench`, all stopped afterwards, benchmark volumes and secrets deleted).
Inputs: macOS `say` speech, 30.6 s / 61.3 s / 306.3 s, 24 kHz mono. `gpu_seconds` is the field the repo's own
job.json records (wall time of the GPU subprocess).

| Service | GPU | Warm | Cold | Notes |
|---|---|---|---|---|
| STT (worker-stt-prod, large-v3-turbo) | L4 | 306 s mp3 in 4.2-4.4 s, called from inside Modal = 0.86 s per audio-min = **$0.00019/min = $0.0114/h** | 14.9 s first request | From a laptop the same call took 22 s (upload-bound); that number is NOT the GPU cost |
| Dub = STT + translation + TTS | L4 + API + T4 | **~$0.0071/min**: STT 0.0002 (measured) + translation ~0.0066 (**ESTIMATE**: Sonnet list price $3/$15 per M tokens, ~440 in / ~350 out tokens per minute, `claude-sonnet-4-6` per `routes/dub.ts`) + TTS 0.0003 (measured Kokoro: 534 chars -> 32.5 s audio in 0.73 s on T4 = $0.00022 per 1k chars) | STT cold + 120 s tail = $0.031; TTS worker cold not measured | Non-Latin target languages can double the translation tokens |
| Voice isolation (demucs htdemucs, `isolate_job.py`) | A10G | 61 s clip: 8.1 GPU-s = **$0.0025/job**; 306 s clip: 13.5 GPU-s. Fit: ~6.8 s fixed (subprocess import + model load) + 1.3 s per audio-min | 61 s clip: 11.2 GPU-s, 27 s wall incl. container start; ~20 s boot + 60 s idle tail = **~$0.025/job** | |
| Voice conversion (seed-vc, `convert_job.py`, 30 diffusion steps) | A10G | 30.6 s src: 16.3 GPU-s; 61.3 s src: 29.3 GPU-s = **28.7 GPU-s per audio-min = $0.0088/min** | 30.6 s: 44 GPU-s (weights download), 59 s wall; 61.3 s: 69 GPU-s, 104 s wall; with 60 s tail **$0.035 (30 s) to $0.048 (61 s)** | |
| Sound effects (Stable Audio Open, 50 steps, 12 s) | A10G | 6.3-7.6 s wall per clip (client-side, includes a 4 MB download) = **~$0.0019-0.0023/clip** | ~56 s container boot + model load + first clip; with the 120 s scaledown tail **~$0.054/clip** | App `sound-effects-worker-readaloud` is NOT deployed on Modal right now, so the feature cannot serve |

## Margin check (price / warm cost)

| Service | Price | Warm cost | Ratio | ElevenLabs list (indicative) |
|---|---|---|---|---|
| STT | $0.11/h | $0.0114/h | 9.6x | $0.22/h |
| Dub | $0.15/min | ~$0.0071/min | ~21x | $0.33-0.50/min |
| Isolation | $0.05/min | $0.0025/min (61 s job) | 20x | $0.12/min |
| Conversion | $0.10/min | $0.0088/min | 11x | $0.12/min |
| Sound effects | $0.09/min ($0.0015/s) | $0.0095/generated min | 9x | $0.12/min |

All clear the 2.5x-warm floor and sit under ElevenLabs, so per-minute prices were left alone.

## Cold start and idle: who pays

Nobody bills for container boot, model load or the idle scaledown tail. We pay it. For per-user deployed apps
(isolation, conversion) and the SFX / STT workers, traffic is currently near zero, so almost every job is
cold-isolated and costs 3-30x its warm cost. That is why the minimum charge changed (dub 10 s -> 30 s,
isolation 10 s -> 45 s, conversion 30 s -> 45 s): each now brings in >= 1.5x the cold-isolated cost.
Assumption: Modal's default `scaledown_window` is 60 s for the apps that do not set one (isolate, convert);
the STT and SFX workers set 120 s explicitly. I did not measure the tail separately (ephemeral `modal run` apps
stop at the end of the run), so tails are computed, not observed.

Sound effects cannot be fixed by a minimum charge: a cold-isolated 12 s clip costs ~$0.054 against $0.018 of
revenue; breaking even would need ~$0.27/min, above ElevenLabs. It is profitable only while a worker stays warm
(or with a shorter `scaledown_window`; 30 s would cut the cold clip to ~$0.026, still a loss). Recommendation:
do not expose SFX publicly until there is steady traffic or the worker is deployed with `min_containers=0` and a
short scaledown AND a price/minimum that covers ~$0.03 per cold clip.

## Bug found while measuring

`run_isolation` / `run_conversion` read `/jobs/<id>/job.json` without `jobs.reload()`. On a fresh GPU container
the first benchmark run raised `FileNotFoundError`, the job stayed `queued` forever (never billed, never failed)
and the GPU container sat idle for ~15 minutes until killed. Fixed in this branch by calling `jobs.reload()`
first in both functions (applies on the next per-user deploy).
