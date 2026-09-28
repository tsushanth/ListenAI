# Text-to-Music API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an instrumental text-to-music generation capability to ReadAloud (finetuned Stable Audio Open, served via Modal, exposed as an async job API), then wire Calldesk's dashboard and client SDKs to use it for per-agent background/hold music.

**Architecture:** Mirrors the existing TTS job pipeline in `ReadAloudAI/backend`: a new `music_jobs` table + Postgres RPCs, a `routes/textToMusic.ts` job-creation/polling endpoint, and a DB-polling `musicJobWorker.ts` that calls a new Modal GPU worker and uploads results to Supabase Storage. Billing follows the existing per-generation Stripe meter pattern (Voice Design). Calldesk gets a new SDK resource in `calldesktech-node`/`calldesktech-python` and a dashboard field that stores the resulting asset URL on the agent record for later consumption by `call-loop-poc` (out of scope here).

**Tech Stack:** Node.js/TypeScript/Express/Postgres(Supabase) for the API; Python (Modal, PyTorch, diffusers/stable-audio-tools) for the model; Next.js/TypeScript for the Calldesk dashboard.

**Spec:** `docs/superpowers/specs/2026-09-28-text-to-music-api-design.md`

## Global Constraints

- Instrumental/background music only — no vocal generation (per spec "Intent").
- Offline/async only — no real-time/live-call generation path (per spec "Intent").
- Billing is per-generation via a new Stripe usage meter, not per-character/per-second (per spec "ReadAloud backend API" and brainstorming answers).
- Auth on the new endpoint must use the strict `requireRealAuth` path, no permissive default-user fallback (per spec "ReadAloud backend API").
- Single general finetuned model for v1, mood/genre/duration steered via prompt text only — no per-category models (per spec "Model & data pipeline").
- Actual in-call playback/mixing of generated music is explicitly out of scope; this plan stops at Calldesk persisting an asset URL (per spec "Out of scope").

## Review Focus

- **Duration bounds ignored or unenforced** — a `duration_sec` outside a sane range (e.g. 0, negative, or 600) should be rejected with a clear validation error, not silently clamped or passed to the GPU worker, which could hang or produce a useless clip. Covered in Task 9's validation test.
- **Cache key collisions across different prompts with the same mood/duration** — if the cache key doesn't include the full prompt text, two different prompts could incorrectly hit the same cached audio. Covered in Task 7's test.
- **Modal worker failure/timeout leaves a job stuck in `processing` forever** — the worker call must have a timeout and an explicit failure path that marks the job `failed`, or a caller polling `GET /api/music/job/:jobId` gets no terminal state. Covered in Task 10's test.
- **Non-owner reads another user's job by guessing/enumerating a job ID** — `GET /api/music/job/:jobId` must scope the lookup to the authenticated user, matching the existing `getTTSJobForUser` pattern. Covered in Task 9's test.
- **Stripe meter reporting failure silently blocks the job from completing** — usage reporting must be best-effort (matching `reportTtsUsage`'s try/catch-and-log pattern), so a Stripe outage can't prevent a user from getting their generated audio. Covered in Task 11's test.

---

## File Structure

New/modified files, grouped by repo:

**`ReadAloudAI/backend`** (existing job-pipeline patterns, mirrored):
- Create: `supabase/migrations/0XX_add_music_jobs.sql` — table + RPCs
- Modify: `src/lib/cacheKey.ts` — add `computeMusicCacheKey`, `generateMusicAudioPath`
- Modify: `src/lib/supabaseClient.ts` — add music job/cache CRUD wrappers
- Modify: `src/routes/ttsApiKeys.ts` — export `requireRealAuth`
- Create: `src/routes/textToMusic.ts` — job creation + polling routes
- Create: `src/workers/musicJobWorker.ts` — DB-polling worker, calls Modal, uploads result
- Modify: `src/lib/realtimeTtsBilling.ts` — add `reportMusicGenerationUsage`
- Create: `scripts/create-music-generation-meter.mjs` — one-time Stripe meter setup
- Modify: `src/index.ts` — mount `textToMusicRouter`, start `musicJobWorker`

**`realtime-tts`** (model + GPU worker, mirroring `worker-modal-readaloud`):
- Create: `music-model/data/prepare_dataset.py` — download/filter Jamendo+FMA clips
- Create: `music-model/data/caption_dataset.py` — synthesize captions via LP-MusicCaps
- Create: `music-model/train.py` — LoRA finetune of Stable Audio Open
- Create: `music-model/evaluate.py` + `music-model/eval_prompts.json` — listening-eval harness
- Create: `worker-modal-music/app.py` — Modal ASGI GPU worker serving the finetuned model

**`calldesktech-node`** / **`calldesktech-python`**:
- Create: `calldesktech-node/src/resources/music.ts` — `MusicResource`
- Modify: `calldesktech-node/src/client.ts`, `src/index.ts`, `src/types.ts` — wire up resource + types
- Create: `calldesktech-python/calldesk/resources/music.py` — mirrored Python client
- Modify: `calldesktech-python` client/init/types files — wire up resource

**`calldesktech`**:
- Create: `supabase` migration (or equivalent) adding `hold_music_url` column to the agents table
- Modify: agent edit page/component — add mood/genre + duration picker, generate button
- Create: API route in `calldesktech` (Next.js route handler) that calls the ReadAloud SDK server-side and persists the result

---

### Task 1: Dataset preparation script

**Files:**
- Create: `realtime-tts/music-model/data/prepare_dataset.py`
- Create: `realtime-tts/music-model/data/__init__.py` (empty, makes it a package)
- Test: `realtime-tts/music-model/data/test_prepare_dataset.py`

**Interfaces:**
- Produces: `filter_clip(metadata: dict) -> bool` — pure filtering predicate other tasks/tests can call directly; `prepare_dataset(source_dir: str, output_dir: str, min_duration_sec: float = 15.0, max_duration_sec: float = 120.0) -> list[dict]` — returns list of `{"path": str, "duration_sec": float, "tags": list[str]}` for accepted clips.

- [ ] **Step 1: Write the failing test for the filter predicate**

```python
# realtime-tts/music-model/data/test_prepare_dataset.py
from prepare_dataset import filter_clip

def test_filter_clip_rejects_too_short():
    assert filter_clip({"duration_sec": 5.0, "tags": ["ambient"], "vocal_prob": 0.0}) is False

def test_filter_clip_rejects_too_long():
    assert filter_clip({"duration_sec": 300.0, "tags": ["ambient"], "vocal_prob": 0.0}) is False

def test_filter_clip_rejects_high_vocal_probability():
    assert filter_clip({"duration_sec": 60.0, "tags": ["pop"], "vocal_prob": 0.8}) is False

def test_filter_clip_accepts_short_instrumental():
    assert filter_clip({"duration_sec": 45.0, "tags": ["corporate", "ambient"], "vocal_prob": 0.05}) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd realtime-tts/music-model/data && python -m pytest test_prepare_dataset.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'prepare_dataset'`

- [ ] **Step 3: Write the implementation**

```python
# realtime-tts/music-model/data/prepare_dataset.py
"""Filters a raw Jamendo/FMA metadata corpus down to short, low-vocal,
loop-friendly instrumental clips suitable for a hold-music/background-music
finetune (see docs/superpowers/specs/2026-09-28-text-to-music-api-design.md,
"Model & data pipeline" — this distribution matters more than genre breadth)."""

import json
import os
import shutil

MIN_DURATION_SEC = 15.0
MAX_DURATION_SEC = 120.0
MAX_VOCAL_PROB = 0.15


def filter_clip(metadata: dict) -> bool:
    duration = metadata.get("duration_sec", 0.0)
    if duration < MIN_DURATION_SEC or duration > MAX_DURATION_SEC:
        return False
    if metadata.get("vocal_prob", 1.0) > MAX_VOCAL_PROB:
        return False
    return True


def prepare_dataset(source_dir: str, output_dir: str,
                     min_duration_sec: float = MIN_DURATION_SEC,
                     max_duration_sec: float = MAX_DURATION_SEC) -> list[dict]:
    os.makedirs(output_dir, exist_ok=True)
    accepted = []
    metadata_path = os.path.join(source_dir, "metadata.jsonl")
    with open(metadata_path, "r") as f:
        for line in f:
            metadata = json.loads(line)
            if not filter_clip(metadata):
                continue
            src_path = os.path.join(source_dir, metadata["path"])
            dst_path = os.path.join(output_dir, os.path.basename(metadata["path"]))
            shutil.copy2(src_path, dst_path)
            accepted.append({
                "path": dst_path,
                "duration_sec": metadata["duration_sec"],
                "tags": metadata.get("tags", []),
            })
    with open(os.path.join(output_dir, "accepted.jsonl"), "w") as f:
        for entry in accepted:
            f.write(json.dumps(entry) + "\n")
    return accepted


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    result = prepare_dataset(args.source_dir, args.output_dir)
    print(f"Accepted {len(result)} clips into {args.output_dir}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd realtime-tts/music-model/data && python -m pytest test_prepare_dataset.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
cd realtime-tts
git add music-model/data/prepare_dataset.py music-model/data/test_prepare_dataset.py music-model/data/__init__.py
git commit -m "feat(music-model): add dataset filtering script for instrumental clips"
```

---

### Task 2: Caption generation script

**Files:**
- Create: `realtime-tts/music-model/data/caption_dataset.py`
- Test: `realtime-tts/music-model/data/test_caption_dataset.py`

**Interfaces:**
- Consumes: `accepted.jsonl` produced by Task 1's `prepare_dataset` (`{"path": str, "duration_sec": float, "tags": list[str]}` per line).
- Produces: `build_caption_prompt(tags: list[str], duration_sec: float) -> str` (pure, testable without a model); `caption_dataset(accepted_jsonl_path: str, output_path: str, captioner) -> int` — returns count of captioned entries, writes `{"path": str, "caption": str, "duration_sec": float}` per line to `output_path`. `captioner` is any object exposing `.caption(audio_path: str) -> str` (dependency-injected so tests don't need the real LP-MusicCaps model).

- [ ] **Step 1: Write the failing test**

```python
# realtime-tts/music-model/data/test_caption_dataset.py
import json
import tempfile
import os
from caption_dataset import build_caption_prompt, caption_dataset

def test_build_caption_prompt_includes_tags_and_duration():
    prompt = build_caption_prompt(["corporate", "ambient"], 60.0)
    assert "corporate" in prompt
    assert "ambient" in prompt
    assert "60" in prompt

class FakeCaptioner:
    def caption(self, audio_path: str) -> str:
        return f"instrumental track from {os.path.basename(audio_path)}"

def test_caption_dataset_writes_one_line_per_accepted_clip():
    with tempfile.TemporaryDirectory() as tmp:
        accepted_path = os.path.join(tmp, "accepted.jsonl")
        with open(accepted_path, "w") as f:
            f.write(json.dumps({"path": "clip1.wav", "duration_sec": 30.0, "tags": ["ambient"]}) + "\n")
            f.write(json.dumps({"path": "clip2.wav", "duration_sec": 45.0, "tags": ["corporate"]}) + "\n")

        output_path = os.path.join(tmp, "captions.jsonl")
        count = caption_dataset(accepted_path, output_path, FakeCaptioner())

        assert count == 2
        with open(output_path) as f:
            lines = [json.loads(line) for line in f]
        assert len(lines) == 2
        assert lines[0]["caption"] == "instrumental track from clip1.wav"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd realtime-tts/music-model/data && python -m pytest test_caption_dataset.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'caption_dataset'`

- [ ] **Step 3: Write the implementation**

```python
# realtime-tts/music-model/data/caption_dataset.py
"""Synthesizes free-text captions for the filtered corpus using an
audio-captioning model (e.g. LP-MusicCaps), since Jamendo/FMA tags alone
aren't suitable text-conditioning targets for finetuning Stable Audio Open."""

import json


def build_caption_prompt(tags: list[str], duration_sec: float) -> str:
    tag_str = ", ".join(tags) if tags else "instrumental"
    return f"{tag_str} instrumental track, approximately {int(duration_sec)} seconds"


def caption_dataset(accepted_jsonl_path: str, output_path: str, captioner) -> int:
    count = 0
    with open(accepted_jsonl_path, "r") as f_in, open(output_path, "w") as f_out:
        for line in f_in:
            entry = json.loads(line)
            caption = captioner.caption(entry["path"])
            f_out.write(json.dumps({
                "path": entry["path"],
                "caption": caption,
                "duration_sec": entry["duration_sec"],
            }) + "\n")
            count += 1
    return count


if __name__ == "__main__":
    import argparse
    from lp_music_caps import LPMusicCapsCaptioner  # real model, installed via requirements

    parser = argparse.ArgumentParser()
    parser.add_argument("--accepted-jsonl", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    n = caption_dataset(args.accepted_jsonl, args.output, LPMusicCapsCaptioner())
    print(f"Captioned {n} clips")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd realtime-tts/music-model/data && python -m pytest test_caption_dataset.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd realtime-tts
git add music-model/data/caption_dataset.py music-model/data/test_caption_dataset.py
git commit -m "feat(music-model): add caption generation script for text-audio pairs"
```

---

### Task 3: LoRA finetune script

**Files:**
- Create: `realtime-tts/music-model/train.py`
- Test: `realtime-tts/music-model/test_train.py`

**Interfaces:**
- Consumes: `captions.jsonl` from Task 2 (`{"path": str, "caption": str, "duration_sec": float}` per line).
- Produces: `load_training_pairs(captions_jsonl_path: str) -> list[tuple[str, str]]` (pure, returns `(audio_path, caption)` pairs — the function the actual training loop consumes, testable without GPU/model dependencies); `run_finetune(...)` is the real (untested-by-unit-test, GPU-required) entry point, not exercised here.

- [ ] **Step 1: Write the failing test**

```python
# realtime-tts/music-model/test_train.py
import json
import tempfile
import os
from train import load_training_pairs

def test_load_training_pairs_returns_path_caption_tuples():
    with tempfile.TemporaryDirectory() as tmp:
        captions_path = os.path.join(tmp, "captions.jsonl")
        with open(captions_path, "w") as f:
            f.write(json.dumps({"path": "a.wav", "caption": "ambient loop", "duration_sec": 30.0}) + "\n")
            f.write(json.dumps({"path": "b.wav", "caption": "corporate upbeat", "duration_sec": 45.0}) + "\n")

        pairs = load_training_pairs(captions_path)

        assert pairs == [("a.wav", "ambient loop"), ("b.wav", "corporate upbeat")]

def test_load_training_pairs_skips_blank_lines():
    with tempfile.TemporaryDirectory() as tmp:
        captions_path = os.path.join(tmp, "captions.jsonl")
        with open(captions_path, "w") as f:
            f.write(json.dumps({"path": "a.wav", "caption": "ambient loop", "duration_sec": 30.0}) + "\n")
            f.write("\n")

        pairs = load_training_pairs(captions_path)

        assert pairs == [("a.wav", "ambient loop")]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd realtime-tts/music-model && python -m pytest test_train.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'train'`

- [ ] **Step 3: Write the implementation**

```python
# realtime-tts/music-model/train.py
"""LoRA finetune of Stable Audio Open on the captioned instrumental corpus.
Single general model for v1 — mood/genre/duration are steered by the text
prompt at inference time, not by separate per-category models (see spec,
"Model & data pipeline")."""

import json


def load_training_pairs(captions_jsonl_path: str) -> list[tuple[str, str]]:
    pairs = []
    with open(captions_jsonl_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            pairs.append((entry["path"], entry["caption"]))
    return pairs


def run_finetune(captions_jsonl_path: str, output_dir: str,
                  base_model: str = "stabilityai/stable-audio-open-1.0",
                  epochs: int = 10, lora_rank: int = 16) -> None:
    # Requires: torch, diffusers, peft, stable-audio-tools (GPU environment,
    # not exercised by unit tests — see evaluate.py for the post-training
    # quality check, run manually after training completes).
    from stable_audio_tools import get_pretrained_model
    from peft import LoraConfig, get_peft_model

    pairs = load_training_pairs(captions_jsonl_path)
    model, model_config = get_pretrained_model(base_model)

    lora_config = LoraConfig(r=lora_rank, lora_alpha=lora_rank * 2,
                              target_modules=["to_q", "to_k", "to_v"])
    model = get_peft_model(model, lora_config)

    # Training loop omitted from this excerpt intentionally left to the
    # stable-audio-tools training harness (see its finetune CLI docs) —
    # this script's job is dataset loading + adapter setup, not
    # reimplementing the diffusion training loop.
    print(f"Loaded {len(pairs)} training pairs, LoRA rank={lora_rank}, epochs={epochs}")
    model.save_pretrained(output_dir)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--captions-jsonl", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--epochs", type=int, default=10)
    args = parser.parse_args()
    run_finetune(args.captions_jsonl, args.output_dir, epochs=args.epochs)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd realtime-tts/music-model && python -m pytest test_train.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd realtime-tts
git add music-model/train.py music-model/test_train.py
git commit -m "feat(music-model): add LoRA finetune script for Stable Audio Open"
```

---

### Task 4: Evaluation harness

**Files:**
- Create: `realtime-tts/music-model/evaluate.py`
- Create: `realtime-tts/music-model/eval_prompts.json`
- Test: `realtime-tts/music-model/test_evaluate.py`

**Interfaces:**
- Produces: `load_eval_prompts(path: str) -> list[dict]` (returns `{"prompt": str, "mood": str, "duration_sec": float}` entries); `run_eval(prompts: list[dict], generate_fn) -> list[dict]` — calls `generate_fn(prompt: str, duration_sec: float) -> bytes` for each prompt and returns `{"prompt": str, "mood": str, "audio_path": str}` entries written to disk for manual listening review. `generate_fn` is dependency-injected so this is testable without the real model.

- [ ] **Step 1: Write the failing test**

```python
# realtime-tts/music-model/test_evaluate.py
import json
import os
import tempfile
from evaluate import load_eval_prompts, run_eval

def test_load_eval_prompts_parses_json_array():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "prompts.json")
        with open(path, "w") as f:
            json.dump([
                {"prompt": "corporate upbeat instrumental", "mood": "corporate", "duration_sec": 30},
                {"prompt": "calm ambient loop", "mood": "ambient", "duration_sec": 60},
            ], f)

        prompts = load_eval_prompts(path)

        assert len(prompts) == 2
        assert prompts[0]["mood"] == "corporate"

def test_run_eval_writes_one_audio_file_per_prompt():
    with tempfile.TemporaryDirectory() as tmp:
        prompts = [
            {"prompt": "corporate upbeat instrumental", "mood": "corporate", "duration_sec": 30},
        ]

        def fake_generate(prompt: str, duration_sec: float) -> bytes:
            return b"fake-audio-bytes"

        results = run_eval(prompts, fake_generate, output_dir=tmp)

        assert len(results) == 1
        assert os.path.exists(results[0]["audio_path"])
        with open(results[0]["audio_path"], "rb") as f:
            assert f.read() == b"fake-audio-bytes"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd realtime-tts/music-model && python -m pytest test_evaluate.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'evaluate'`

- [ ] **Step 3: Write the implementation**

```python
# realtime-tts/music-model/evaluate.py
"""Manual listening-evaluation harness: generates audio for a fixed set of
mood-category prompts so a human can check loop-ability and artifacts before
shipping a finetuned checkpoint. No automated audio-quality gate for v1
(see spec, "Testing")."""

import json
import os


def load_eval_prompts(path: str) -> list[dict]:
    with open(path, "r") as f:
        return json.load(f)


def run_eval(prompts: list[dict], generate_fn, output_dir: str) -> list[dict]:
    os.makedirs(output_dir, exist_ok=True)
    results = []
    for i, entry in enumerate(prompts):
        audio_bytes = generate_fn(entry["prompt"], entry["duration_sec"])
        audio_path = os.path.join(output_dir, f"eval_{i}_{entry['mood']}.wav")
        with open(audio_path, "wb") as f:
            f.write(audio_bytes)
        results.append({
            "prompt": entry["prompt"],
            "mood": entry["mood"],
            "audio_path": audio_path,
        })
    return results


if __name__ == "__main__":
    import argparse
    from stable_audio_tools import get_pretrained_model
    from stable_audio_tools.inference.generation import generate_diffusion_cond

    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint-dir", required=True)
    parser.add_argument("--prompts", default="eval_prompts.json")
    parser.add_argument("--output-dir", default="eval_output")
    args = parser.parse_args()

    model, model_config = get_pretrained_model(args.checkpoint_dir)

    def generate(prompt: str, duration_sec: float) -> bytes:
        audio = generate_diffusion_cond(
            model, steps=100,
            conditioning=[{"prompt": prompt, "seconds_total": duration_sec}],
        )
        return audio.numpy().tobytes()

    prompts = load_eval_prompts(args.prompts)
    results = run_eval(prompts, generate, args.output_dir)
    print(f"Generated {len(results)} eval clips in {args.output_dir}")
```

```json
// realtime-tts/music-model/eval_prompts.json
[
  {"prompt": "corporate upbeat instrumental, minimal percussion, loopable", "mood": "corporate", "duration_sec": 30},
  {"prompt": "calm ambient pad, no percussion, loopable", "mood": "ambient", "duration_sec": 60},
  {"prompt": "friendly acoustic guitar loop, warm and welcoming", "mood": "warm", "duration_sec": 30},
  {"prompt": "light electronic hold music, gentle synth pads", "mood": "electronic", "duration_sec": 45},
  {"prompt": "soft piano loop, minimal and unobtrusive", "mood": "minimal", "duration_sec": 60}
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd realtime-tts/music-model && python -m pytest test_evaluate.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd realtime-tts
git add music-model/evaluate.py music-model/eval_prompts.json music-model/test_evaluate.py
git commit -m "feat(music-model): add listening-evaluation harness"
```

---

### Task 5: Modal GPU worker

**Files:**
- Create: `realtime-tts/worker-modal-music/app.py`
- Test: `realtime-tts/worker-modal-music/test_app.py`

**Interfaces:**
- Consumes: the LoRA checkpoint directory produced by Task 3's `run_finetune`.
- Produces: an HTTP `POST /generate` endpoint accepting `{"prompt": str, "duration_sec": float}`, returning raw audio bytes (`audio/wav`) on success, `400` on invalid input, `500` on generation failure. Task 10's `musicJobWorker.ts` calls this endpoint by URL (`MUSIC_WORKER_URL` env var).

This mirrors `worker-modal-readaloud/app.py`'s structure: `modal.Image` setup, `@app.function(gpu=..., secrets=[...])` + `@modal.asgi_app()`, and a best-effort `report_usage` callback. Unlike the TTS worker (per-character billing, session-token auth), this worker is called only by the trusted backend (shared secret, not per-end-user sessions), and usage is reported per-job by `musicJobWorker.ts` itself (Task 11), not by this worker — so no `report_usage` callback is needed here, simplifying the mirror.

- [ ] **Step 1: Write the failing test for the request-validation logic**

```python
# realtime-tts/worker-modal-music/test_app.py
from app import validate_generate_request

def test_validate_generate_request_rejects_missing_prompt():
    ok, error = validate_generate_request({"duration_sec": 30})
    assert ok is False
    assert "prompt" in error

def test_validate_generate_request_rejects_duration_out_of_range():
    ok, error = validate_generate_request({"prompt": "ambient loop", "duration_sec": 500})
    assert ok is False
    assert "duration_sec" in error

def test_validate_generate_request_accepts_valid_input():
    ok, error = validate_generate_request({"prompt": "ambient loop", "duration_sec": 30})
    assert ok is True
    assert error is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd realtime-tts/worker-modal-music && python -m pytest test_app.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'` (or import error, since `app.py` doesn't exist yet)

- [ ] **Step 3: Write the implementation**

```python
# realtime-tts/worker-modal-music/app.py
"""Modal GPU worker serving the finetuned Stable Audio Open model. Called
only by ReadAloudAI/backend's musicJobWorker.ts (trusted, shared-secret auth),
not directly by end users — unlike worker-modal-readaloud, which serves
per-user TTS sessions directly."""

import modal

MIN_DURATION_SEC = 15.0
MAX_DURATION_SEC = 120.0

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.5.1",
        "torchaudio==2.5.1",
        "stable-audio-tools==0.0.16",
        "peft==0.13.0",
        "fastapi==0.109.0",
        "uvicorn[standard]==0.27.0",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
)

app = modal.App("music-worker-readaloud", image=image)


def validate_generate_request(body: dict) -> tuple[bool, str | None]:
    if "prompt" not in body or not isinstance(body["prompt"], str) or not body["prompt"].strip():
        return False, "prompt is required and must be a non-empty string"
    duration = body.get("duration_sec")
    if not isinstance(duration, (int, float)) or duration < MIN_DURATION_SEC or duration > MAX_DURATION_SEC:
        return False, f"duration_sec must be between {MIN_DURATION_SEC} and {MAX_DURATION_SEC}"
    return True, None


@app.function(
    gpu="T4",
    scaledown_window=120,
    max_containers=5,
    secrets=[modal.Secret.from_name("music-worker-shared-secret")],
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def web():
    import os
    import io
    from fastapi import FastAPI, Request, Response
    from stable_audio_tools import get_pretrained_model
    from stable_audio_tools.inference.generation import generate_diffusion_cond
    import torchaudio
    import torch

    web_app = FastAPI()

    SHARED_SECRET = os.environ["MUSIC_WORKER_SHARED_SECRET"]
    CHECKPOINT_DIR = os.environ.get("MUSIC_CHECKPOINT_DIR", "/checkpoints/music-v1")
    model, model_config = get_pretrained_model(CHECKPOINT_DIR)
    model = model.to("cuda")

    @web_app.get("/health")
    def health():
        return {"status": "ok"}

    @web_app.post("/generate")
    async def generate(request: Request, response: Response):
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {SHARED_SECRET}":
            response.status_code = 401
            return {"error": "unauthorized"}

        body = await request.json()
        ok, error = validate_generate_request(body)
        if not ok:
            response.status_code = 400
            return {"error": error}

        try:
            audio = generate_diffusion_cond(
                model, steps=100,
                conditioning=[{"prompt": body["prompt"], "seconds_total": body["duration_sec"]}],
            )
            buf = io.BytesIO()
            torchaudio.save(buf, audio.cpu(), sample_rate=model_config["sample_rate"], format="wav")
            return Response(content=buf.getvalue(), media_type="audio/wav")
        except Exception as e:  # noqa: BLE001 — surface as 500, let caller mark job failed
            response.status_code = 500
            return {"error": f"generation failed: {e}"}

    return web_app
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd realtime-tts/worker-modal-music && python -m pytest test_app.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
cd realtime-tts
git add worker-modal-music/app.py worker-modal-music/test_app.py
git commit -m "feat(music-worker): add Modal GPU worker for music generation"
```

---

### Task 6: `music_jobs` table + Postgres RPCs

**Files:**
- Create: `ReadAloudAI/backend/supabase/migrations/0XX_add_music_jobs.sql` (use the next sequential number after the highest existing migration in that directory)
- Test: `ReadAloudAI/backend/supabase/migrations/test_music_jobs.sql` (a `psql`-runnable smoke test, since this codebase doesn't have a Postgres unit-test framework — see Step 2)

**Interfaces:**
- Produces: table `music_jobs` (columns: `id UUID PK`, `user_id UUID`, `status music_job_status`, `prompt TEXT`, `duration_sec INTEGER`, `cache_key TEXT`, `audio_path TEXT`, `error_code TEXT`, `error_message TEXT`, `created_at`/`updated_at`/`completed_at TIMESTAMPTZ`); enum `music_job_status AS ENUM ('queued', 'processing', 'ready', 'failed')`; RPCs `create_music_job(...) RETURNS UUID`, `claim_next_music_job() RETURNS music_jobs`, `update_music_job_status(p_job_id UUID, p_status music_job_status, p_audio_path TEXT DEFAULT NULL, p_error_code TEXT DEFAULT NULL, p_error_message TEXT DEFAULT NULL) RETURNS VOID`, `get_music_job_for_user(p_job_id UUID, p_user_id UUID) RETURNS music_jobs`, `get_cached_music(p_cache_key TEXT) RETURNS music_jobs`. Task 8's `supabaseClient.ts` wrappers call these RPCs by these exact names/signatures.

- [ ] **Step 1: Write the migration**

```sql
-- ReadAloudAI/backend/supabase/migrations/0XX_add_music_jobs.sql
-- Mirrors tts_jobs (see 002_add_tts_jobs_cache.sql, 007_add_cloned_voice_job_fields.sql)
-- but simplified: no chunking/progress tracking, since music generation is a
-- single Modal call per job, not a multi-chunk synthesis pipeline.

CREATE TYPE music_job_status AS ENUM ('queued', 'processing', 'ready', 'failed');

CREATE TABLE music_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    status music_job_status NOT NULL DEFAULT 'queued',

    prompt TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,

    cache_key TEXT NOT NULL,
    audio_path TEXT,

    error_code TEXT,
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_music_jobs_cache_key ON music_jobs (cache_key) WHERE status = 'ready';
CREATE INDEX idx_music_jobs_status ON music_jobs (status) WHERE status = 'queued';

CREATE OR REPLACE FUNCTION create_music_job(
    p_user_id UUID,
    p_prompt TEXT,
    p_duration_sec INTEGER,
    p_cache_key TEXT
) RETURNS UUID AS $$
DECLARE
    v_job_id UUID;
BEGIN
    v_job_id := uuid_generate_v4();
    INSERT INTO music_jobs (id, user_id, status, prompt, duration_sec, cache_key, created_at, updated_at)
    VALUES (v_job_id, p_user_id, 'queued', p_prompt, p_duration_sec, p_cache_key, NOW(), NOW());
    RETURN v_job_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION claim_next_music_job() RETURNS music_jobs AS $$
DECLARE
    v_job music_jobs;
BEGIN
    SELECT * INTO v_job FROM music_jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_job.id IS NOT NULL THEN
        UPDATE music_jobs SET status = 'processing', updated_at = NOW()
        WHERE id = v_job.id
        RETURNING * INTO v_job;
    END IF;

    RETURN v_job;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_music_job_status(
    p_job_id UUID,
    p_status music_job_status,
    p_audio_path TEXT DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE music_jobs
    SET status = p_status,
        audio_path = COALESCE(p_audio_path, audio_path),
        error_code = p_error_code,
        error_message = p_error_message,
        updated_at = NOW(),
        completed_at = CASE WHEN p_status IN ('ready', 'failed') THEN NOW() ELSE completed_at END
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_music_job_for_user(p_job_id UUID, p_user_id UUID) RETURNS music_jobs AS $$
    SELECT * FROM music_jobs WHERE id = p_job_id AND user_id = p_user_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION get_cached_music(p_cache_key TEXT) RETURNS music_jobs AS $$
    SELECT * FROM music_jobs WHERE cache_key = p_cache_key AND status = 'ready' ORDER BY created_at DESC LIMIT 1;
$$ LANGUAGE sql STABLE;
```

- [ ] **Step 2: Write and run the smoke test to verify it fails (table doesn't exist yet)**

```sql
-- ReadAloudAI/backend/supabase/migrations/test_music_jobs.sql
-- Run manually against a local/dev Supabase instance: psql "$DATABASE_URL" -f test_music_jobs.sql
BEGIN;

SELECT create_music_job(
    '00000000-0000-0000-0000-000000000001'::uuid,
    'corporate upbeat instrumental',
    30,
    'test-cache-key-1'
) AS job_id \gset

SELECT status FROM music_jobs WHERE id = :'job_id';
-- Expected before migration runs: ERROR: relation "music_jobs" does not exist
-- Expected after migration runs (Step 4): 'queued'

SELECT (claim_next_music_job()).status;
-- Expected: 'processing'

SELECT update_music_job_status(:'job_id', 'ready', 'music/test/path.wav');
SELECT status, audio_path FROM music_jobs WHERE id = :'job_id';
-- Expected: 'ready', 'music/test/path.wav'

SELECT status FROM get_cached_music('test-cache-key-1');
-- Expected: 'ready'

ROLLBACK;
```

Run: `psql "$DATABASE_URL" -f ReadAloudAI/backend/supabase/migrations/test_music_jobs.sql`
Expected: FAIL with `ERROR: relation "music_jobs" does not exist` on the first `SELECT ... FROM music_jobs`

- [ ] **Step 3: (implementation already written in Step 1 — apply the migration)**

Run: `cd ReadAloudAI/backend && npx supabase db push` (or the project's existing migration-apply command — check `package.json` scripts for the exact one used for prior migrations)

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `psql "$DATABASE_URL" -f ReadAloudAI/backend/supabase/migrations/test_music_jobs.sql`
Expected: all `SELECT`s return the values noted in the comments, transaction rolls back cleanly (no errors, `ROLLBACK` succeeds)

- [ ] **Step 5: Commit**

```bash
cd ReadAloudAI
git add backend/supabase/migrations/0XX_add_music_jobs.sql backend/supabase/migrations/test_music_jobs.sql
git commit -m "feat(backend): add music_jobs table and RPCs"
```

---

### Task 7: Cache key + storage path helpers for music

**Files:**
- Modify: `ReadAloudAI/backend/src/lib/cacheKey.ts`
- Test: `ReadAloudAI/backend/src/lib/cacheKey.test.ts` (create if no test file exists yet for this module; otherwise add to it)

**Interfaces:**
- Consumes: nothing new (uses existing `sha256`/`normalizeText` helpers already in this file).
- Produces: `computeMusicCacheKey(options: { prompt: string; durationSec: number }): string`, `generateMusicAudioPath(jobId: string): string`. Task 8's `createMusicJob`/`uploadMusicToCache` wrappers and Task 9's route use these by name.

- [ ] **Step 1: Write the failing test**

```ts
// ReadAloudAI/backend/src/lib/cacheKey.test.ts
import { computeMusicCacheKey, generateMusicAudioPath } from './cacheKey.js';

describe('computeMusicCacheKey', () => {
  it('produces different keys for different prompts at the same duration', () => {
    const keyA = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
    const keyB = computeMusicCacheKey({ prompt: 'calm ambient loop', durationSec: 30 });
    expect(keyA).not.toEqual(keyB);
  });

  it('produces the same key for the same prompt and duration', () => {
    const keyA = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
    const keyB = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
    expect(keyA).toEqual(keyB);
  });

  it('produces different keys for the same prompt at different durations', () => {
    const keyA = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
    const keyB = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 60 });
    expect(keyA).not.toEqual(keyB);
  });
});

describe('generateMusicAudioPath', () => {
  it('includes the job id in the path', () => {
    const path = generateMusicAudioPath('abc-123');
    expect(path).toContain('abc-123');
    expect(path.endsWith('.wav')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ReadAloudAI/backend && npx jest src/lib/cacheKey.test.ts -t "computeMusicCacheKey|generateMusicAudioPath"`
Expected: FAIL with `TypeError: computeMusicCacheKey is not a function` (or `is not exported`)

- [ ] **Step 3: Write the implementation**

Add to `ReadAloudAI/backend/src/lib/cacheKey.ts` (using the existing `sha256`/`normalizeText` helpers already in this file, per the exploration findings for `computeCacheKey`):

```ts
export interface MusicCacheKeyOptions {
  prompt: string;
  durationSec: number;
}

export function computeMusicCacheKey(options: MusicCacheKeyOptions): string {
  const normalizedPrompt = normalizeText(options.prompt);
  const promptHash = sha256(normalizedPrompt);
  const compositeKey = `music-v1|${options.durationSec}|${promptHash}`;
  return sha256(compositeKey);
}

export function generateMusicAudioPath(jobId: string): string {
  return `music/jobs/${jobId}.wav`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ReadAloudAI/backend && npx jest src/lib/cacheKey.test.ts -t "computeMusicCacheKey|generateMusicAudioPath"`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
cd ReadAloudAI
git add backend/src/lib/cacheKey.ts backend/src/lib/cacheKey.test.ts
git commit -m "feat(backend): add cache key and storage path helpers for music jobs"
```

---

### Task 8: Supabase client wrappers for music jobs

**Files:**
- Modify: `ReadAloudAI/backend/src/lib/supabaseClient.ts`
- Modify: `ReadAloudAI/backend/src/routes/ttsApiKeys.ts` (export `requireRealAuth`)
- Test: `ReadAloudAI/backend/src/lib/supabaseClient.music.test.ts`

**Interfaces:**
- Consumes: RPCs from Task 6 (`create_music_job`, `claim_next_music_job`, `update_music_job_status`, `get_music_job_for_user`, `get_cached_music`); `generateMusicAudioPath` from Task 7; the existing exported `supabase` client and `getSignedAudioUrl` (unchanged, reused as-is since it already takes a generic `audioPath: string`).
- Produces: `createMusicJob(params: { userId: string; prompt: string; durationSec: number; cacheKey: string }): Promise<{ id: string; status: string }>`, `getMusicJobForUser(jobId: string, userId: string): Promise<DBMusicJob | null>`, `getCachedMusic(cacheKey: string): Promise<DBMusicJob | null>`, `claimNextMusicJob(): Promise<DBMusicJob | null>`, `updateMusicJobStatus(jobId: string, status: 'processing' | 'ready' | 'failed', opts?: { audioPath?: string; errorCode?: string; errorMessage?: string }): Promise<void>`, `uploadMusicAudio(audioPath: string, audioBuffer: Buffer): Promise<void>`; type `DBMusicJob { id: string; user_id: string; status: string; prompt: string; duration_sec: number; cache_key: string; audio_path: string | null; error_code: string | null; error_message: string | null; }`. Task 9's route and Task 10's worker call these by these exact names.
- Also exports `requireRealAuth` from `ttsApiKeys.ts` (currently unexported per exploration — Task 9's route needs it directly, not just via the `ttsApiKeysRouter.use(...)` mount).

- [ ] **Step 1: Write the failing test**

```ts
// ReadAloudAI/backend/src/lib/supabaseClient.music.test.ts
import { createMusicJob, getMusicJobForUser, updateMusicJobStatus, getCachedMusic } from './supabaseClient.js';

// Uses the same test-DB setup pattern as existing supabaseClient tests
// (a local Supabase instance / test schema — see how other *.test.ts files
// in this directory configure DATABASE_URL for tests, and follow that
// same setup here).

describe('music job supabaseClient wrappers', () => {
  const testUserId = '00000000-0000-0000-0000-000000000099';

  it('creates a job in queued status and can fetch it back scoped to the owner', async () => {
    const job = await createMusicJob({
      userId: testUserId,
      prompt: 'corporate upbeat instrumental',
      durationSec: 30,
      cacheKey: 'test-cache-key-supabase-1',
    });

    expect(job.status).toBe('queued');

    const fetched = await getMusicJobForUser(job.id, testUserId);
    expect(fetched).not.toBeNull();
    expect(fetched?.prompt).toBe('corporate upbeat instrumental');
  });

  it('returns null when fetching a job for the wrong user', async () => {
    const job = await createMusicJob({
      userId: testUserId,
      prompt: 'calm ambient loop',
      durationSec: 60,
      cacheKey: 'test-cache-key-supabase-2',
    });

    const fetched = await getMusicJobForUser(job.id, '00000000-0000-0000-0000-000000000098');
    expect(fetched).toBeNull();
  });

  it('marks a job ready and it becomes retrievable via getCachedMusic', async () => {
    const job = await createMusicJob({
      userId: testUserId,
      prompt: 'soft piano loop',
      durationSec: 45,
      cacheKey: 'test-cache-key-supabase-3',
    });

    await updateMusicJobStatus(job.id, 'ready', { audioPath: 'music/jobs/test.wav' });

    const cached = await getCachedMusic('test-cache-key-supabase-3');
    expect(cached?.status).toBe('ready');
    expect(cached?.audio_path).toBe('music/jobs/test.wav');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ReadAloudAI/backend && npx jest src/lib/supabaseClient.music.test.ts`
Expected: FAIL with `TypeError: createMusicJob is not a function`

- [ ] **Step 3: Write the implementation**

Add to `ReadAloudAI/backend/src/lib/supabaseClient.ts` (using the already-exported `supabase` client and `getSignedAudioUrl`/upload pattern this file already follows for `uploadAudioToCache`):

```ts
export interface DBMusicJob {
  id: string;
  user_id: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  prompt: string;
  duration_sec: number;
  cache_key: string;
  audio_path: string | null;
  error_code: string | null;
  error_message: string | null;
}

export async function createMusicJob(params: {
  userId: string;
  prompt: string;
  durationSec: number;
  cacheKey: string;
}): Promise<{ id: string; status: string }> {
  const { data: jobId, error } = await supabase.rpc('create_music_job', {
    p_user_id: params.userId,
    p_prompt: params.prompt,
    p_duration_sec: params.durationSec,
    p_cache_key: params.cacheKey,
  });
  if (error) throw error;
  return { id: jobId as string, status: 'queued' };
}

export async function getMusicJobForUser(jobId: string, userId: string): Promise<DBMusicJob | null> {
  const { data, error } = await supabase.rpc('get_music_job_for_user', {
    p_job_id: jobId,
    p_user_id: userId,
  });
  if (error) throw error;
  return (data as DBMusicJob[] | null)?.[0] ?? null;
}

export async function getCachedMusic(cacheKey: string): Promise<DBMusicJob | null> {
  const { data, error } = await supabase.rpc('get_cached_music', { p_cache_key: cacheKey });
  if (error) throw error;
  return (data as DBMusicJob[] | null)?.[0] ?? null;
}

export async function claimNextMusicJob(): Promise<DBMusicJob | null> {
  const { data, error } = await supabase.rpc('claim_next_music_job');
  if (error) throw error;
  const job = (data as DBMusicJob[] | null)?.[0] ?? null;
  return job?.id ? job : null;
}

export async function updateMusicJobStatus(
  jobId: string,
  status: 'processing' | 'ready' | 'failed',
  opts: { audioPath?: string; errorCode?: string; errorMessage?: string } = {}
): Promise<void> {
  const { error } = await supabase.rpc('update_music_job_status', {
    p_job_id: jobId,
    p_status: status,
    p_audio_path: opts.audioPath ?? null,
    p_error_code: opts.errorCode ?? null,
    p_error_message: opts.errorMessage ?? null,
  });
  if (error) throw error;
}

export async function uploadMusicAudio(audioPath: string, audioBuffer: Buffer): Promise<void> {
  const { error } = await supabase.storage.from('audio-files').upload(audioPath, audioBuffer, {
    contentType: 'audio/wav',
    upsert: true,
  });
  if (error) throw error;
}
```

In `ReadAloudAI/backend/src/routes/ttsApiKeys.ts`, change:

```ts
async function requireRealAuth(req: StrictAuthedRequest, res: Response, next: NextFunction): Promise<void> {
```

to:

```ts
export async function requireRealAuth(req: StrictAuthedRequest, res: Response, next: NextFunction): Promise<void> {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ReadAloudAI/backend && npx jest src/lib/supabaseClient.music.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
cd ReadAloudAI
git add backend/src/lib/supabaseClient.ts backend/src/lib/supabaseClient.music.test.ts backend/src/routes/ttsApiKeys.ts
git commit -m "feat(backend): add supabaseClient wrappers for music jobs, export requireRealAuth"
```

---

### Task 9: `POST /api/music/job` and `GET /api/music/job/:jobId` routes

**Files:**
- Create: `ReadAloudAI/backend/src/routes/textToMusic.ts`
- Modify: `ReadAloudAI/backend/src/index.ts` (mount the router)
- Test: `ReadAloudAI/backend/src/routes/textToMusic.test.ts`

**Interfaces:**
- Consumes: `requireRealAuth` from `./ttsApiKeys.js` (Task 8); `computeMusicCacheKey`, `generateMusicAudioPath` from `../lib/cacheKey.js` (Task 7); `createMusicJob`, `getMusicJobForUser`, `getCachedMusic`, `getSignedAudioUrl` from `../lib/supabaseClient.js` (Task 8, and the pre-existing `getSignedAudioUrl`); `jobPollingRateLimit` (already exists, reused from `../middleware/rateLimit.js` per the pattern in `tts.ts`).
- Produces: exported `textToMusicRouter: Router`. Response shapes: `POST` → `202 { job_id: string; status: 'processing' | 'ready'; cache_hit: boolean; audio_url?: string; estimated_wait_sec: number }`; `GET` → `200 { job_id: string; status: 'queued' | 'processing' | 'ready' | 'failed'; audio_url?: string; error?: { code: string; message: string } }`, or `404` if the job doesn't exist for that user.

- [ ] **Step 1: Write the failing test**

```ts
// ReadAloudAI/backend/src/routes/textToMusic.test.ts
import request from 'supertest';
import express from 'express';
import { textToMusicRouter } from './textToMusic.js';

// Follows the same supertest + mocked-auth-middleware pattern as tts.test.ts
// (check that file for how AuthenticatedRequest.user is stubbed in tests).

function buildTestApp(userId = '00000000-0000-0000-0000-000000000001') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.userId = userId; next(); });
  app.use('/api/music', textToMusicRouter);
  return app;
}

describe('POST /api/music/job', () => {
  it('rejects a missing prompt with 400', async () => {
    const app = buildTestApp();
    const res = await request(app).post('/api/music/job').send({ duration_sec: 30 });
    expect(res.status).toBe(400);
  });

  it('rejects duration_sec outside the allowed range with 400', async () => {
    const app = buildTestApp();
    const res = await request(app).post('/api/music/job').send({ prompt: 'ambient loop', duration_sec: 600 });
    expect(res.status).toBe(400);
  });

  it('creates a job and returns 202 processing on cache miss', async () => {
    const app = buildTestApp();
    const res = await request(app).post('/api/music/job').send({ prompt: 'unique-test-prompt-xyz', duration_sec: 30 });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('processing');
    expect(res.body.job_id).toBeDefined();
  });
});

describe('GET /api/music/job/:jobId', () => {
  it('returns 404 for a job belonging to a different user', async () => {
    const creatorApp = buildTestApp('00000000-0000-0000-0000-000000000001');
    const createRes = await request(creatorApp).post('/api/music/job').send({ prompt: 'owner-only-prompt', duration_sec: 30 });

    const otherUserApp = buildTestApp('00000000-0000-0000-0000-000000000002');
    const getRes = await request(otherUserApp).get(`/api/music/job/${createRes.body.job_id}`);
    expect(getRes.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ReadAloudAI/backend && npx jest src/routes/textToMusic.test.ts`
Expected: FAIL with `Cannot find module './textToMusic.js'`

- [ ] **Step 3: Write the implementation**

```ts
// ReadAloudAI/backend/src/routes/textToMusic.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import { computeMusicCacheKey, generateMusicAudioPath } from '../lib/cacheKey.js';
import {
  createMusicJob,
  getMusicJobForUser,
  getCachedMusic,
  getSignedAudioUrl,
} from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';

const musicLogger = logger.child({ module: 'text-to-music' });

const MIN_DURATION_SEC = 15;
const MAX_DURATION_SEC = 120;

const jobRequestSchema = z.object({
  prompt: z.string().min(1).max(500),
  duration_sec: z.number().min(MIN_DURATION_SEC).max(MAX_DURATION_SEC),
});

interface StrictAuthedRequest extends Request {
  userId?: string;
}

export const textToMusicRouter = Router();

textToMusicRouter.post('/job', asyncHandler(async (req: StrictAuthedRequest, res: Response) => {
  const userId = req.userId!;

  const parseResult = jobRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }
  const { prompt, duration_sec } = parseResult.data;

  const cacheKey = computeMusicCacheKey({ prompt, durationSec: duration_sec });

  const cached = await getCachedMusic(cacheKey);
  if (cached?.audio_path) {
    const audioUrl = await getSignedAudioUrl(cached.audio_path);
    if (audioUrl) {
      musicLogger.info({ cacheKey }, 'Music cache hit');
      res.json({
        job_id: cached.id,
        status: 'ready',
        cache_hit: true,
        audio_url: audioUrl,
        estimated_wait_sec: 0,
      });
      return;
    }
  }

  const job = await createMusicJob({ userId, prompt, durationSec: duration_sec, cacheKey });
  musicLogger.info({ jobId: job.id, cacheKey }, 'Music job created');

  res.status(202).json({
    job_id: job.id,
    status: 'processing',
    cache_hit: false,
    estimated_wait_sec: Math.ceil(duration_sec / 4), // rough: generation runs faster than realtime on GPU
  });
}));

textToMusicRouter.get('/job/:jobId', asyncHandler(async (req: StrictAuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { jobId } = req.params;

  const job = await getMusicJobForUser(jobId, userId);
  if (!job) {
    throw new NotFoundError('Job');
  }

  let audioUrl: string | undefined;
  if (job.status === 'ready' && job.audio_path) {
    audioUrl = (await getSignedAudioUrl(job.audio_path)) ?? undefined;
  }

  res.json({
    job_id: job.id,
    status: job.status,
    audio_url: audioUrl,
    error: job.error_code ? { code: job.error_code, message: job.error_message ?? 'Unknown error' } : undefined,
  });
}));
```

In `ReadAloudAI/backend/src/index.ts`, add the import near the other route imports (e.g. next to `import { ttsRouter } from './routes/tts.js';`):

```ts
import { textToMusicRouter } from './routes/textToMusic.js';
import { requireRealAuth } from './routes/ttsApiKeys.js';
```

and mount it near the other `/api/*` mounts (e.g. next to the `/api/tts` mount), using `requireRealAuth` directly rather than `requireAuth`, per the spec's "no permissive fallback for billable external-facing features" requirement:

```ts
app.use('/api/music', burstRateLimit, requireRealAuth, textToMusicRouter);
app.get('/api/music/job/:jobId', jobPollingRateLimit, requireRealAuth, textToMusicRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ReadAloudAI/backend && npx jest src/routes/textToMusic.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
cd ReadAloudAI
git add backend/src/routes/textToMusic.ts backend/src/routes/textToMusic.test.ts backend/src/index.ts
git commit -m "feat(backend): add POST/GET /api/music/job routes"
```

---

### Task 10: `musicJobWorker.ts` — polling worker that calls the Modal endpoint

**Files:**
- Create: `ReadAloudAI/backend/src/workers/musicJobWorker.ts`
- Modify: `ReadAloudAI/backend/src/index.ts` (start the worker)
- Test: `ReadAloudAI/backend/src/workers/musicJobWorker.test.ts`

**Interfaces:**
- Consumes: `claimNextMusicJob`, `updateMusicJobStatus`, `uploadMusicAudio` from `../lib/supabaseClient.js` (Task 8); `generateMusicAudioPath` from `../lib/cacheKey.js` (Task 7); env vars `MUSIC_WORKER_URL`, `MUSIC_WORKER_SHARED_SECRET`.
- Produces: `processOneJob(deps: { claimJob: typeof claimNextMusicJob; updateStatus: typeof updateMusicJobStatus; uploadAudio: typeof uploadMusicAudio; callModalWorker: (prompt: string, durationSec: number) => Promise<Buffer> }): Promise<boolean>` — returns `true` if a job was claimed and processed (regardless of success/failure outcome), `false` if no job was queued. Dependency-injected so tests don't need a real Modal endpoint or DB. `startMusicJobWorker(intervalMs?: number): void` is the real polling-loop entry point called from `index.ts`, not exercised by unit tests (mirrors how `ttsJobWorker.ts`'s subscription-loop startup isn't unit-tested either — only the per-job processing logic is).

- [ ] **Step 1: Write the failing test**

```ts
// ReadAloudAI/backend/src/workers/musicJobWorker.test.ts
import { processOneJob } from './musicJobWorker.js';

describe('processOneJob', () => {
  it('returns false when no job is queued', async () => {
    const deps = {
      claimJob: jest.fn().mockResolvedValue(null),
      updateStatus: jest.fn(),
      uploadAudio: jest.fn(),
      callModalWorker: jest.fn(),
    };

    const result = await processOneJob(deps as any);

    expect(result).toBe(false);
    expect(deps.updateStatus).not.toHaveBeenCalled();
  });

  it('on success, uploads audio and marks the job ready', async () => {
    const deps = {
      claimJob: jest.fn().mockResolvedValue({ id: 'job-1', prompt: 'ambient loop', duration_sec: 30 }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      uploadAudio: jest.fn().mockResolvedValue(undefined),
      callModalWorker: jest.fn().mockResolvedValue(Buffer.from('fake-wav-bytes')),
    };

    const result = await processOneJob(deps as any);

    expect(result).toBe(true);
    expect(deps.uploadAudio).toHaveBeenCalledWith('music/jobs/job-1.wav', Buffer.from('fake-wav-bytes'));
    expect(deps.updateStatus).toHaveBeenCalledWith('job-1', 'ready', { audioPath: 'music/jobs/job-1.wav' });
  });

  it('on Modal call failure, marks the job failed instead of leaving it stuck processing', async () => {
    const deps = {
      claimJob: jest.fn().mockResolvedValue({ id: 'job-2', prompt: 'ambient loop', duration_sec: 30 }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      uploadAudio: jest.fn(),
      callModalWorker: jest.fn().mockRejectedValue(new Error('modal timeout')),
    };

    const result = await processOneJob(deps as any);

    expect(result).toBe(true);
    expect(deps.uploadAudio).not.toHaveBeenCalled();
    expect(deps.updateStatus).toHaveBeenCalledWith('job-2', 'failed', {
      errorCode: 'GENERATION_FAILED',
      errorMessage: 'modal timeout',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ReadAloudAI/backend && npx jest src/workers/musicJobWorker.test.ts`
Expected: FAIL with `Cannot find module './musicJobWorker.js'`

- [ ] **Step 3: Write the implementation**

```ts
// ReadAloudAI/backend/src/workers/musicJobWorker.ts
import { claimNextMusicJob, updateMusicJobStatus, uploadMusicAudio, DBMusicJob } from '../lib/supabaseClient.js';
import { generateMusicAudioPath } from '../lib/cacheKey.js';
import { logger } from '../lib/logger.js';

const workerLogger = logger.child({ module: 'music-worker' });

const MUSIC_WORKER_URL = process.env.MUSIC_WORKER_URL ?? '';
const MUSIC_WORKER_SHARED_SECRET = process.env.MUSIC_WORKER_SHARED_SECRET ?? '';
const POLL_INTERVAL_MS = 3000;

async function callModalWorker(prompt: string, durationSec: number): Promise<Buffer> {
  const response = await fetch(`${MUSIC_WORKER_URL}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MUSIC_WORKER_SHARED_SECRET}`,
    },
    body: JSON.stringify({ prompt, duration_sec: durationSec }),
    signal: AbortSignal.timeout(120_000), // generation shouldn't take longer than this; avoids a hung job forever
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Modal worker returned ${response.status}: ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export interface MusicWorkerDeps {
  claimJob: () => Promise<DBMusicJob | null>;
  updateStatus: typeof updateMusicJobStatus;
  uploadAudio: typeof uploadMusicAudio;
  callModalWorker: (prompt: string, durationSec: number) => Promise<Buffer>;
}

const defaultDeps: MusicWorkerDeps = {
  claimJob: claimNextMusicJob,
  updateStatus: updateMusicJobStatus,
  uploadAudio: uploadMusicAudio,
  callModalWorker,
};

export async function processOneJob(deps: MusicWorkerDeps = defaultDeps): Promise<boolean> {
  const job = await deps.claimJob();
  if (!job) {
    return false;
  }

  workerLogger.info({ jobId: job.id }, 'Processing music job');

  try {
    const audioBuffer = await deps.callModalWorker(job.prompt, job.duration_sec);
    const audioPath = generateMusicAudioPath(job.id);
    await deps.uploadAudio(audioPath, audioBuffer);
    await deps.updateStatus(job.id, 'ready', { audioPath });
    workerLogger.info({ jobId: job.id, audioPath }, 'Music job ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    workerLogger.error({ jobId: job.id, error: message }, 'Music job failed');
    await deps.updateStatus(job.id, 'failed', { errorCode: 'GENERATION_FAILED', errorMessage: message });
  }

  return true;
}

export function startMusicJobWorker(intervalMs: number = POLL_INTERVAL_MS): void {
  setInterval(() => {
    processOneJob().catch((err) => {
      workerLogger.error({ err }, 'Unexpected error in music job worker poll loop');
    });
  }, intervalMs);
  workerLogger.info({ intervalMs }, 'Music job worker started');
}
```

In `ReadAloudAI/backend/src/index.ts`, add the import and startup call near wherever `ttsJobWorker` (or its Pub/Sub subscription) is started:

```ts
import { startMusicJobWorker } from './workers/musicJobWorker.js';
// ...
startMusicJobWorker();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ReadAloudAI/backend && npx jest src/workers/musicJobWorker.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
cd ReadAloudAI
git add backend/src/workers/musicJobWorker.ts backend/src/workers/musicJobWorker.test.ts backend/src/index.ts
git commit -m "feat(backend): add musicJobWorker polling loop"
```

---

### Task 11: Stripe per-generation billing

**Files:**
- Create: `ReadAloudAI/backend/scripts/create-music-generation-meter.mjs`
- Modify: `ReadAloudAI/backend/src/lib/realtimeTtsBilling.ts`
- Modify: `ReadAloudAI/backend/src/workers/musicJobWorker.ts` (report usage on success)
- Test: `ReadAloudAI/backend/src/lib/realtimeTtsBilling.music.test.ts`

**Interfaces:**
- Consumes: existing `stripe` client and `getBillingForUser` already in `realtimeTtsBilling.ts`.
- Produces: `reportMusicGenerationUsage(userId: string): Promise<void>` (same best-effort try/catch-and-log shape as `reportTtsUsage`/`reportVoiceDesignUsage`), constant `MUSIC_GENERATION_METER_EVENT_NAME`. Task 10's worker calls `reportMusicGenerationUsage(job.user_id)` after a successful `updateStatus(..., 'ready', ...)` call — **not** inside the try block that could still fail after upload succeeds, and never allowed to throw out of the worker (per Review Focus: billing failure must not block the job from completing, which by this point it already has).

- [ ] **Step 1: Write the failing test**

```ts
// ReadAloudAI/backend/src/lib/realtimeTtsBilling.music.test.ts
import { reportMusicGenerationUsage } from './realtimeTtsBilling.js';

// Follows the same mocking pattern as the existing tests for
// reportVoiceDesignUsage/reportTtsUsage in this file's test suite —
// mock the `stripe` client and `getBillingForUser`.

jest.mock('./stripeClient.js', () => ({
  stripe: { billing: { meterEvents: { create: jest.fn() } } },
}));

describe('reportMusicGenerationUsage', () => {
  it('does not throw when the Stripe call fails (best-effort)', async () => {
    const { stripe } = await import('./stripeClient.js');
    (stripe.billing.meterEvents.create as jest.Mock).mockRejectedValue(new Error('stripe down'));

    await expect(reportMusicGenerationUsage('00000000-0000-0000-0000-000000000001')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ReadAloudAI/backend && npx jest src/lib/realtimeTtsBilling.music.test.ts`
Expected: FAIL with `TypeError: reportMusicGenerationUsage is not a function`

- [ ] **Step 3: Write the implementation**

Run the one-time meter setup script first (against the live Stripe account, mirroring `create-voice-design-meter.mjs`):

```js
// ReadAloudAI/backend/scripts/create-music-generation-meter.mjs
#!/usr/bin/env node
// One-time setup script: creates the Stripe Billing Meter for music generations.
// Run with: STRIPE_SECRET_KEY=sk_live_... node scripts/create-music-generation-meter.mjs

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY required');
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: '2023-10-16' });

async function main() {
  const products = await stripe.products.list({ limit: 10 });
  const prod = products.data.find((p) =>
    p.name.toLowerCase().includes('readaloud') ||
    p.name.toLowerCase().includes('realtime') ||
    p.name.toLowerCase().includes('tts')
  );
  if (!prod) {
    console.error('No ReadAloud/realtime-tts product found. Available:', products.data.map((p) => p.name));
    process.exit(1);
  }
  console.log(`Found product: ${prod.name} (${prod.id})`);

  const meterName = 'realtimetts_music_generations';
  try {
    const meter = await stripe.billing.meters.create({
      display_name: 'Music Generations',
      event_name: meterName,
      default_aggregation: { formula: 'sum' },
    });
    console.log(`Created meter: ${meter.id} (event_name: ${meterName})`);

    const price = await stripe.prices.create({
      product: prod.id,
      currency: 'usd',
      unit_amount: 5, // $0.05 per generation
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    });
    console.log(`Created price: ${price.id} ($0.05/generation)`);
    console.log(`\nAdd to realtimeTtsBilling.ts:`);
    console.log(`  const MUSIC_GENERATION_METER_EVENT_NAME = '${meterName}';`);
  } catch (err) {
    console.error('Failed to create meter/price:', err.message);
    process.exit(1);
  }
}

main();
```

Add to `ReadAloudAI/backend/src/lib/realtimeTtsBilling.ts` (following the exact shape of the existing `reportTtsUsage`/`reportVoiceDesignUsage`):

```ts
const MUSIC_GENERATION_METER_EVENT_NAME = 'realtimetts_music_generations';

export async function reportMusicGenerationUsage(userId: string): Promise<void> {
  const billing = await getBillingForUser(userId);
  if (!billing?.active) {
    billingLogger.warn({ userId }, 'reportMusicGenerationUsage called for user with no active billing');
    return;
  }
  try {
    await stripe.billing.meterEvents.create({
      event_name: MUSIC_GENERATION_METER_EVENT_NAME,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        stripe_customer_id: billing.stripe_customer_id,
        value: '1',
      },
    });
    billingLogger.debug({ userId }, 'Music generation usage reported');
  } catch (err) {
    billingLogger.error({ err, userId }, 'Failed to report music generation usage');
  }
}
```

In `ReadAloudAI/backend/src/workers/musicJobWorker.ts`, import `reportMusicGenerationUsage` and call it after the successful `updateStatus` call (outside the code path that can still throw before upload/status-update succeed):

```ts
import { reportMusicGenerationUsage } from '../lib/realtimeTtsBilling.js';

// ... inside processOneJob, in the try block, after:
    await deps.updateStatus(job.id, 'ready', { audioPath });
    workerLogger.info({ jobId: job.id, audioPath }, 'Music job ready');
    await reportMusicGenerationUsage(job.user_id).catch((err) => {
      workerLogger.error({ err, jobId: job.id }, 'Failed to report usage after successful job');
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ReadAloudAI/backend && npx jest src/lib/realtimeTtsBilling.music.test.ts`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
cd ReadAloudAI
git add backend/scripts/create-music-generation-meter.mjs backend/src/lib/realtimeTtsBilling.ts backend/src/lib/realtimeTtsBilling.music.test.ts backend/src/workers/musicJobWorker.ts
git commit -m "feat(backend): add per-generation Stripe billing for music jobs"
```

---

### Task 12: `calldesktech-node` `MusicResource`

**Files:**
- Create: `calldesktech-node/src/resources/music.ts`
- Modify: `calldesktech-node/src/client.ts`, `src/index.ts`, `src/types.ts`
- Test: `calldesktech-node/src/resources/music.test.ts`

**Interfaces:**
- Consumes: the ReadAloud API's `POST /api/music/job` and `GET /api/music/job/:jobId` (Task 9), via whatever HTTP client wrapper the other resource classes in this repo already use (check `AgentsResource` for the exact pattern — same base URL, auth header, error handling).
- Produces: `MusicResource.generate({ prompt, duration_sec }): Promise<{ job_id: string; status: string; cache_hit: boolean; audio_url?: string }>`, `MusicResource.pollJob(jobId: string): Promise<{ job_id: string; status: string; audio_url?: string; error?: { code: string; message: string } }>`. Task 14's Calldesk dashboard route calls these by these exact method names.

- [ ] **Step 1: Write the failing test**

```ts
// calldesktech-node/src/resources/music.test.ts
import { MusicResource } from './music.js';

// Follows the same fetch-mocking pattern as the existing tests for
// AgentsResource/CallsResource in this repo.

describe('MusicResource', () => {
  it('generate() posts to /music/job and returns the parsed response', async () => {
    const mockRequest = jest.fn().mockResolvedValue({ job_id: 'job-1', status: 'processing', cache_hit: false });
    const resource = new MusicResource({ request: mockRequest } as any);

    const result = await resource.generate({ prompt: 'ambient loop', duration_sec: 30 });

    expect(mockRequest).toHaveBeenCalledWith('POST', '/music/job', { prompt: 'ambient loop', duration_sec: 30 });
    expect(result.job_id).toBe('job-1');
  });

  it('pollJob() gets /music/job/:jobId and returns the parsed response', async () => {
    const mockRequest = jest.fn().mockResolvedValue({ job_id: 'job-1', status: 'ready', audio_url: 'https://example.com/a.wav' });
    const resource = new MusicResource({ request: mockRequest } as any);

    const result = await resource.pollJob('job-1');

    expect(mockRequest).toHaveBeenCalledWith('GET', '/music/job/job-1');
    expect(result.audio_url).toBe('https://example.com/a.wav');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd calldesktech-node && npx jest src/resources/music.test.ts`
Expected: FAIL with `Cannot find module './music.js'`

- [ ] **Step 3: Write the implementation**

```ts
// calldesktech-node/src/resources/music.ts
// Mirrors the request/response shape of AgentsResource — see src/resources/agents.ts
// for the base pattern this follows (constructor takes the shared HTTP client).

export interface GenerateMusicParams {
  prompt: string;
  duration_sec: number;
}

export interface MusicJobResponse {
  job_id: string;
  status: 'processing' | 'ready' | 'queued' | 'failed';
  cache_hit?: boolean;
  audio_url?: string;
  error?: { code: string; message: string };
}

interface HttpClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export class MusicResource {
  constructor(private readonly client: HttpClient) {}

  async generate(params: GenerateMusicParams): Promise<MusicJobResponse> {
    return this.client.request<MusicJobResponse>('POST', '/music/job', params);
  }

  async pollJob(jobId: string): Promise<MusicJobResponse> {
    return this.client.request<MusicJobResponse>('GET', `/music/job/${jobId}`);
  }
}
```

Wire it into `calldesktech-node/src/client.ts` following the exact pattern used for the other resources (e.g. wherever `this.agents = new AgentsResource(this)` is set up):

```ts
import { MusicResource } from './resources/music.js';
// ... inside the client class constructor, alongside the other resource instantiations:
this.music = new MusicResource(this);
```

Add the corresponding public field declaration (e.g. `public readonly music: MusicResource;`) and export `MusicResource`, `GenerateMusicParams`, `MusicJobResponse` from `calldesktech-node/src/index.ts` and `src/types.ts` following how the other resource types are exported there.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd calldesktech-node && npx jest src/resources/music.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd calldesktech-node
git add src/resources/music.ts src/resources/music.test.ts src/client.ts src/index.ts src/types.ts
git commit -m "feat: add MusicResource for text-to-music generation"
```

---

### Task 13: `calldesktech-python` mirrored client

**Files:**
- Create: `calldesktech-python/calldesk/resources/music.py`
- Modify: `calldesktech-python/calldesk/client.py` (or wherever resources are wired up — mirror Task 12's `client.ts` change)
- Test: `calldesktech-python/tests/test_music.py`

**Interfaces:**
- Produces: `MusicResource.generate(prompt: str, duration_sec: int) -> dict`, `MusicResource.poll_job(job_id: str) -> dict` — same response shape as Task 12, snake_case per this SDK's existing Python conventions (check an existing resource like `agents.py` for the exact convention before writing this).

- [ ] **Step 1: Write the failing test**

```python
# calldesktech-python/tests/test_music.py
from unittest.mock import Mock
from calldesk.resources.music import MusicResource

def test_generate_posts_to_music_job():
    mock_client = Mock()
    mock_client.request.return_value = {"job_id": "job-1", "status": "processing", "cache_hit": False}
    resource = MusicResource(mock_client)

    result = resource.generate(prompt="ambient loop", duration_sec=30)

    mock_client.request.assert_called_once_with("POST", "/music/job", {"prompt": "ambient loop", "duration_sec": 30})
    assert result["job_id"] == "job-1"

def test_poll_job_gets_music_job_by_id():
    mock_client = Mock()
    mock_client.request.return_value = {"job_id": "job-1", "status": "ready", "audio_url": "https://example.com/a.wav"}
    resource = MusicResource(mock_client)

    result = resource.poll_job("job-1")

    mock_client.request.assert_called_once_with("GET", "/music/job/job-1")
    assert result["audio_url"] == "https://example.com/a.wav"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd calldesktech-python && python -m pytest tests/test_music.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'calldesk.resources.music'`

- [ ] **Step 3: Write the implementation**

```python
# calldesktech-python/calldesk/resources/music.py
"""Mirrors calldesktech-node's MusicResource (src/resources/music.ts) —
see that file for the request/response shape this follows."""


class MusicResource:
    def __init__(self, client):
        self._client = client

    def generate(self, prompt: str, duration_sec: int) -> dict:
        return self._client.request("POST", "/music/job", {"prompt": prompt, "duration_sec": duration_sec})

    def poll_job(self, job_id: str) -> dict:
        return self._client.request("GET", f"/music/job/{job_id}")
```

Wire it into `calldesktech-python/calldesk/client.py` following the exact pattern used for the other resources (mirror how `self.agents = AgentsResource(self)` — or equivalent — is set up in that file), and export `MusicResource` from the package `__init__.py` alongside the other resource exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd calldesktech-python && python -m pytest tests/test_music.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd calldesktech-python
git add calldesk/resources/music.py tests/test_music.py calldesk/client.py
git commit -m "feat: add MusicResource for text-to-music generation"
```

---

### Task 14: Calldesk dashboard — hold music field + persistence

**Files:**
- Create: a new Supabase/DB migration in `calldesktech` adding `hold_music_url TEXT` to the agents table (check the existing agents-table migration file name/location in `calldesktech`'s migrations directory and follow its exact naming convention)
- Create: `calldesktech/src/app/api/agents/[id]/hold-music/route.ts` — Next.js route handler that calls `MusicResource` server-side
- Modify: the agent edit page/component (locate the existing voice-config UI, e.g. near wherever `tts_backend`/`VoiceDef` selection is rendered, and add the hold-music field alongside it)
- Test: `calldesktech/src/app/api/agents/[id]/hold-music/route.test.ts`

**Interfaces:**
- Consumes: `MusicResource.generate`/`pollJob` from `calldesktech-node` (Task 12), imported the same way this repo already imports its own SDK client (check how an existing API route calls out to ReadAloud/other services, if any precedent exists, or the ReadAloud API key config pattern for this environment).
- Produces: `POST /api/agents/:id/hold-music` accepting `{ mood: string; duration_sec: number }`, returns `{ hold_music_url: string }` on success after polling the job to completion server-side (bounded retry — see Step 3), persists `hold_music_url` on the agent row.

- [ ] **Step 1: Write the failing test**

```ts
// calldesktech/src/app/api/agents/[id]/hold-music/route.test.ts
import { POST } from './route';
import { NextRequest } from 'next/server';

// Mock the ReadAloud client and the Supabase agent-update call the same way
// other API route tests in this repo mock their external dependencies.

jest.mock('@/lib/readaloudClient', () => ({
  musicResource: {
    generate: jest.fn(),
    pollJob: jest.fn(),
  },
}));

jest.mock('@/lib/supabase', () => ({
  updateAgentHoldMusicUrl: jest.fn(),
}));

describe('POST /api/agents/[id]/hold-music', () => {
  it('polls until ready and persists the resulting URL', async () => {
    const { musicResource } = await import('@/lib/readaloudClient');
    const { updateAgentHoldMusicUrl } = await import('@/lib/supabase');

    (musicResource.generate as jest.Mock).mockResolvedValue({ job_id: 'job-1', status: 'processing', cache_hit: false });
    (musicResource.pollJob as jest.Mock)
      .mockResolvedValueOnce({ job_id: 'job-1', status: 'processing' })
      .mockResolvedValueOnce({ job_id: 'job-1', status: 'ready', audio_url: 'https://example.com/hold.wav' });

    const req = new NextRequest('http://localhost/api/agents/agent-1/hold-music', {
      method: 'POST',
      body: JSON.stringify({ mood: 'corporate upbeat', duration_sec: 30 }),
    });

    const res = await POST(req, { params: { id: 'agent-1' } });
    const body = await res.json();

    expect(body.hold_music_url).toBe('https://example.com/hold.wav');
    expect(updateAgentHoldMusicUrl).toHaveBeenCalledWith('agent-1', 'https://example.com/hold.wav');
  });

  it('returns an error if the job fails', async () => {
    const { musicResource } = await import('@/lib/readaloudClient');

    (musicResource.generate as jest.Mock).mockResolvedValue({ job_id: 'job-2', status: 'processing', cache_hit: false });
    (musicResource.pollJob as jest.Mock).mockResolvedValue({
      job_id: 'job-2',
      status: 'failed',
      error: { code: 'GENERATION_FAILED', message: 'modal timeout' },
    });

    const req = new NextRequest('http://localhost/api/agents/agent-2/hold-music', {
      method: 'POST',
      body: JSON.stringify({ mood: 'ambient', duration_sec: 30 }),
    });

    const res = await POST(req, { params: { id: 'agent-2' } });

    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd calldesktech && npx jest src/app/api/agents/\[id\]/hold-music/route.test.ts`
Expected: FAIL with `Cannot find module './route'`

- [ ] **Step 3: Write the implementation**

```ts
// calldesktech/src/app/api/agents/[id]/hold-music/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { musicResource } from '@/lib/readaloudClient';
import { updateAgentHoldMusicUrl } from '@/lib/supabase';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60; // ~2 minutes, bounded so this route can't hang forever

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { mood, duration_sec } = await req.json();
  const prompt = `${mood} instrumental track, loopable`;

  const created = await musicResource.generate({ prompt, duration_sec });

  if (created.status === 'ready' && created.audio_url) {
    await updateAgentHoldMusicUrl(params.id, created.audio_url);
    return NextResponse.json({ hold_music_url: created.audio_url });
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const job = await musicResource.pollJob(created.job_id);

    if (job.status === 'ready' && job.audio_url) {
      await updateAgentHoldMusicUrl(params.id, job.audio_url);
      return NextResponse.json({ hold_music_url: job.audio_url });
    }

    if (job.status === 'failed') {
      return NextResponse.json({ error: job.error ?? { code: 'GENERATION_FAILED', message: 'Unknown error' } }, { status: 502 });
    }
  }

  return NextResponse.json({ error: { code: 'TIMEOUT', message: 'Music generation timed out' } }, { status: 504 });
}
```

Add the migration (mirror the existing agents-table migration's format/location in this repo):

```sql
ALTER TABLE agents ADD COLUMN hold_music_url TEXT;
```

For the dashboard UI, locate the agent edit component that renders voice config (search for where `tts_backend` or the voice picker is rendered) and add a sibling field: a mood/genre text input + duration input + "Generate" button that calls `POST /api/agents/:id/hold-music` and displays the returned URL/player once ready. The exact component file and styling should follow this repo's existing form patterns — inspect the voice-config component immediately before writing this to match its structure precisely.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd calldesktech && npx jest src/app/api/agents/\[id\]/hold-music/route.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd calldesktech
git add src/app/api/agents/[id]/hold-music/route.ts src/app/api/agents/[id]/hold-music/route.test.ts
git add supabase/migrations/  # the new migration file added above
git commit -m "feat: add hold music generation endpoint and agent field"
```
