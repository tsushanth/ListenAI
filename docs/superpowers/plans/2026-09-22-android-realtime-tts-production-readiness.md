# Android realtime-tts Production-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Android app's realtime-tts migration (proven in a one-off test build) production-safe: Piper voices move to shared object storage so the worker can autoscale, the worker actually autoscales under load, the app's API key moves server-side behind a backend-proxy, and every built-in voice gets a real Piper mapping instead of one hardcoded voice.

**Architecture:** Four sequenced pieces across two repos. `realtime-tts/worker-piper-fly` gets a storage backend swap (local disk → Tigris, S3-compatible) with an in-process LRU cache, then a Fly autoscaling config on top of that once every machine is stateless. `ReadAloudAI/backend` gets new routes that hold a dedicated realtime-tts API key server-side and forward authorize calls. `ReadAloudAI/android` gets a real voice-mapping table replacing today's single-hardcoded-voice shim.

**Tech Stack:** Python/FastAPI (worker-piper-fly), boto3 (Tigris client — S3-compatible), Node/Express/TypeScript (ReadAloudAI backend), Kotlin (Android app), Fly.io (deploy target for both Python services), pytest / Node's built-in test runner / JUnit (respectively).

**Spec:** `docs/superpowers/specs/2026-09-22-android-realtime-tts-production-readiness-design.md`

## Global Constraints

- Never commit secrets (Tigris credentials, the dedicated realtime-tts API key, `ADMIN_SECRET`) to source — all via `fly secrets set` / environment, matching every existing secret in both repos.
- `worker-piper-fly`'s existing `/tts` WebSocket and `/v1/tts/stream` HTTP contracts do not change — this plan changes where voice *files* come from, never the client-facing protocol.
- Every new Python file follows `worker-piper-fly`'s existing style: plain functions/classes, no new framework, tests via `pytest` in `worker-piper-fly/tests/`.
- Every new Express route follows the existing pattern in `ReadAloudAI/backend/src/routes/`: a `Router()` export, mounted in `backend/src/index.ts` with explicit middleware, not inline in `index.ts`.
- `min_machines_running = 1` on the Piper worker is never removed (Section 2 of the spec — this guarantees no request ever pays a cold-start penalty).
- Real voices only: no test/synthetic voice data invented for verification — use the existing published catalog and existing test infrastructure (`eval/`, `worker-piper-fly/tests/`) patterns already in the repo.

---

## Piece 1: Voice storage migration (realtime-tts / worker-piper-fly)

### Task 1: Tigris client wrapper with LRU disk cache

**Files:**
- Create: `worker-piper-fly/voice_storage.py`
- Test: `worker-piper-fly/tests/test_voice_storage.py`

**Interfaces:**
- Consumes: nothing (this is the foundation module)
- Produces: `VoiceStorage` class with `get(vid: str) -> str | None` (returns local cache directory path containing `model.onnx`/`model.onnx.json`/`owner.json`, or `None` if the voice doesn't exist in the bucket), `put(vid: str, files: dict[str, bytes]) -> None`, `delete(vid: str) -> bool` (returns whether it existed), `list_ids() -> list[str]`. Constructor: `VoiceStorage(bucket: str, endpoint_url: str, cache_dir: str, max_cache_entries: int)`.

- [ ] **Step 1: Write the failing test for `put` then `get` round-trip**

```python
# worker-piper-fly/tests/test_voice_storage.py
import os
import shutil
import tempfile
import pytest
from moto import mock_aws
import boto3
from voice_storage import VoiceStorage

BUCKET = "test-piper-voices"

@pytest.fixture
def storage():
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
        cache_dir = tempfile.mkdtemp()
        try:
            yield VoiceStorage(
                bucket=BUCKET,
                endpoint_url=None,  # moto intercepts real boto3 calls, no real endpoint needed
                cache_dir=cache_dir,
                max_cache_entries=3,
            )
        finally:
            shutil.rmtree(cache_dir, ignore_errors=True)


def test_put_then_get_round_trip(storage):
    files = {
        "model.onnx": b"fake-onnx-bytes",
        "model.onnx.json": b'{"espeak": {"voice": "en"}}',
        "owner.json": b'{"public": true}',
    }
    storage.put("test-voice-1", files)

    local_dir = storage.get("test-voice-1")
    assert local_dir is not None
    assert open(os.path.join(local_dir, "model.onnx"), "rb").read() == b"fake-onnx-bytes"
    assert open(os.path.join(local_dir, "owner.json"), "rb").read() == b'{"public": true}'


def test_get_missing_voice_returns_none(storage):
    assert storage.get("does-not-exist") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker-piper-fly && pip install moto boto3 pytest && python -m pytest tests/test_voice_storage.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'voice_storage'`

- [ ] **Step 3: Write minimal implementation**

```python
# worker-piper-fly/voice_storage.py
"""Tigris-backed voice storage with a local LRU disk cache. Tigris (Fly's S3-compatible
object storage) is the source of truth for every published voice - built-in catalog
voices and customer/cloned voices alike, no distinction at this layer (see
2026-09-22-android-realtime-tts-production-readiness-design.md, "Piece 1"). Each machine
keeps a bounded local cache of recently-used voices' raw files so a warm machine doesn't
re-fetch from Tigris on every request; a machine that's never seen a voice fetches it on
first use."""
import os
import shutil
from collections import OrderedDict
from threading import Lock

import boto3

VOICE_FILES = ("model.onnx", "model.onnx.json", "owner.json")


class VoiceStorage:
    def __init__(self, bucket: str, endpoint_url: str | None, cache_dir: str, max_cache_entries: int):
        self.bucket = bucket
        self.cache_dir = cache_dir
        self.max_cache_entries = max_cache_entries
        self._client = boto3.client("s3", endpoint_url=endpoint_url)
        self._lru: "OrderedDict[str, str]" = OrderedDict()  # vid -> local dir path
        self._lock = Lock()
        os.makedirs(cache_dir, exist_ok=True)

    def get(self, vid: str) -> str | None:
        with self._lock:
            cached = self._lru.get(vid)
            if cached is not None and os.path.isdir(cached):
                self._lru.move_to_end(vid)
                return cached

        local_dir = os.path.join(self.cache_dir, vid)
        tmp_dir = local_dir + ".tmp"
        shutil.rmtree(tmp_dir, ignore_errors=True)
        os.makedirs(tmp_dir, exist_ok=True)
        fetched_any = False
        for fname in VOICE_FILES:
            key = f"{vid}/{fname}"
            dest = os.path.join(tmp_dir, fname)
            try:
                self._client.download_file(self.bucket, key, dest)
                fetched_any = True
            except self._client.exceptions.ClientError as e:
                if fname == "model.onnx":
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    return None  # the model itself is required; missing = voice doesn't exist
                # model.onnx.json/owner.json are expected to always exist alongside model.onnx
                # for any voice this class wrote via put(); a missing one here is a real error,
                # not a "voice doesn't exist" case, so re-raise.
                raise RuntimeError(f"voice {vid!r} missing required file {fname!r} in storage") from e
        if not fetched_any:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return None

        shutil.rmtree(local_dir, ignore_errors=True)
        os.rename(tmp_dir, local_dir)

        with self._lock:
            self._lru[vid] = local_dir
            self._lru.move_to_end(vid)
            while len(self._lru) > self.max_cache_entries:
                _, evicted_dir = self._lru.popitem(last=False)
                shutil.rmtree(evicted_dir, ignore_errors=True)
        return local_dir

    def put(self, vid: str, files: dict[str, bytes]) -> None:
        for fname, data in files.items():
            self._client.put_object(Bucket=self.bucket, Key=f"{vid}/{fname}", Body=data)
        with self._lock:
            cached = self._lru.pop(vid, None)
        if cached:
            shutil.rmtree(cached, ignore_errors=True)  # force a re-fetch of the new version

    def delete(self, vid: str) -> bool:
        existed = False
        for fname in VOICE_FILES:
            key = f"{vid}/{fname}"
            try:
                self._client.head_object(Bucket=self.bucket, Key=key)
                existed = True
            except self._client.exceptions.ClientError:
                continue
            self._client.delete_object(Bucket=self.bucket, Key=key)
        with self._lock:
            cached = self._lru.pop(vid, None)
        if cached:
            shutil.rmtree(cached, ignore_errors=True)
        return existed

    def list_ids(self) -> list[str]:
        seen = set()
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Delimiter="/"):
            for prefix in page.get("CommonPrefixes", []):
                seen.add(prefix["Prefix"].rstrip("/"))
        return sorted(seen)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker-piper-fly && python -m pytest tests/test_voice_storage.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for LRU eviction**

```python
# append to worker-piper-fly/tests/test_voice_storage.py
def test_lru_evicts_oldest_when_over_capacity(storage):
    # storage fixture has max_cache_entries=3
    files = {"model.onnx": b"x", "model.onnx.json": b"{}", "owner.json": b'{"public": true}'}
    for vid in ["v1", "v2", "v3", "v4"]:
        storage.put(vid, files)
        storage.get(vid)  # populate cache

    with storage._lock:
        cached_ids = set(storage._lru.keys())
    assert cached_ids == {"v2", "v3", "v4"}  # v1 evicted, it was fetched first
    assert not os.path.exists(os.path.join(storage.cache_dir, "v1"))


def test_put_invalidates_stale_cache_entry(storage):
    files_v1 = {"model.onnx": b"version-1", "model.onnx.json": b"{}", "owner.json": b'{"public": true}'}
    storage.put("versioned", files_v1)
    local_dir = storage.get("versioned")
    assert open(os.path.join(local_dir, "model.onnx"), "rb").read() == b"version-1"

    files_v2 = {"model.onnx": b"version-2", "model.onnx.json": b"{}", "owner.json": b'{"public": true}'}
    storage.put("versioned", files_v2)
    local_dir = storage.get("versioned")
    assert open(os.path.join(local_dir, "model.onnx"), "rb").read() == b"version-2"
```

- [ ] **Step 6: Run to verify it fails, then confirm implementation already handles it**

Run: `cd worker-piper-fly && python -m pytest tests/test_voice_storage.py -v`
Expected: all 4 tests PASS (the `put` invalidation and eviction logic were already written in Step 3 — this step is confirming that code with tests, not writing new code)

- [ ] **Step 7: Commit**

```bash
cd worker-piper-fly
git add voice_storage.py tests/test_voice_storage.py
git commit -m "worker-piper-fly: add Tigris-backed VoiceStorage with LRU disk cache"
```

### Task 2: Wire VoiceStorage into `get_engine` and the admin endpoints

**Files:**
- Modify: `worker-piper-fly/server.py:52-54` (env vars), `:156-209` (`get_engine`), `:230-296` (admin endpoints)
- Test: `worker-piper-fly/tests/test_engine_inprocess.py` (existing file — extend it)

**Interfaces:**
- Consumes: `VoiceStorage` from Task 1 (`voice_storage.py`)
- Produces: `get_engine(voice, key_id, uid=None)` keeps its existing signature and return type (`PiperEngine`) — callers (`/tts` WebSocket handler, `/v1/tts/stream`) need zero changes.

- [ ] **Step 1: Write the failing test — `get_engine` loads a custom voice via `VoiceStorage`, not local `VOICES_DIR`**

```python
# append to worker-piper-fly/tests/test_engine_inprocess.py
def test_get_engine_loads_custom_voice_from_storage(tmp_path, monkeypatch):
    from moto import mock_aws
    import boto3
    import server as server_module

    with mock_aws():
        bucket = "test-bucket"
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=bucket)

        from voice_storage import VoiceStorage
        storage = VoiceStorage(bucket=bucket, endpoint_url=None, cache_dir=str(tmp_path / "cache"), max_cache_entries=8)

        # Use a real small onnx from the existing test fixtures directory if one exists;
        # otherwise this test only needs get_engine to reach PiperEngine construction,
        # so reuse whatever fixture model.onnx test_engine_inprocess.py already loads
        # for its other tests (see its own MODEL_PATH fixture/setup above in this file).
        with open(server_module.MODEL_PATH, "rb") as f:
            onnx_bytes = f.read()
        with open(server_module.MODEL_PATH + ".json", "rb") as f:
            onnx_json_bytes = f.read()

        storage.put("storage-test-voice", {
            "model.onnx": onnx_bytes,
            "model.onnx.json": onnx_json_bytes,
            "owner.json": b'{"public": true}',
        })

        monkeypatch.setattr(server_module, "voice_storage", storage)
        server_module._voices.clear()

        eng = server_module.get_engine("custom:storage-test-voice", key_id=None)
        assert eng is not None

        # A second call for the same voice must hit the in-memory _voices cache, not storage again
        eng2 = server_module.get_engine("custom:storage-test-voice", key_id=None)
        assert eng is eng2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker-piper-fly && python -m pytest tests/test_engine_inprocess.py::test_get_engine_loads_custom_voice_from_storage -v`
Expected: FAIL — `server` module has no attribute `voice_storage`, or `get_engine` still reads from `VOICES_DIR` and raises `VoiceError("unknown voice")`

- [ ] **Step 3: Add storage config and module-level `voice_storage` instance**

In `worker-piper-fly/server.py`, near the existing `VOICES_DIR = os.environ.get(...)` line (around line 54):

```python
VOICES_DIR = os.environ.get("VOICES_DIR", "/voices")  # local cache dir, was previously the source of truth
TIGRIS_BUCKET = os.environ.get("TIGRIS_BUCKET")
TIGRIS_ENDPOINT_URL = os.environ.get("TIGRIS_ENDPOINT_URL")  # e.g. https://fly.storage.tigris.dev
MAX_CACHED_VOICE_FILES = int(os.environ.get("MAX_CACHED_VOICE_FILES", "200"))
```

Near the top-level `engine = PiperEngine(...)` line (around line 141), after it:

```python
from voice_storage import VoiceStorage

voice_storage: "VoiceStorage | None" = None
if TIGRIS_BUCKET:
    voice_storage = VoiceStorage(
        bucket=TIGRIS_BUCKET,
        endpoint_url=TIGRIS_ENDPOINT_URL,
        cache_dir=VOICES_DIR,
        max_cache_entries=MAX_CACHED_VOICE_FILES,
    )
```

- [ ] **Step 4: Replace `get_engine`'s local-disk lookup with a `voice_storage.get()` call**

Replace lines 172-175 of `worker-piper-fly/server.py` (currently: `d = os.path.join(VOICES_DIR, vid)` / `model = os.path.join(d, "model.onnx")` / `if not os.path.isfile(model): raise VoiceError(...)`) with:

```python
    if voice_storage is None:
        raise VoiceError("voice storage not configured")
    d = voice_storage.get(vid)
    if d is None:
        raise VoiceError("unknown voice")
    model = os.path.join(d, "model.onnx")
```

The rest of `get_engine` (owner.json parsing, the `_voices` in-memory LRU of *loaded engines* — a different, smaller cache than `VoiceStorage`'s file cache — speaker_id handling, `PiperEngine` construction) is unchanged; it already reads `owner.json` from `d`, which now comes from `voice_storage.get()` instead of a raw `VOICES_DIR` join.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd worker-piper-fly && python -m pytest tests/test_engine_inprocess.py::test_get_engine_loads_custom_voice_from_storage -v`
Expected: PASS

- [ ] **Step 6: Write the failing test — admin PUT writes to storage, not local disk directly**

```python
# append to worker-piper-fly/tests/test_engine_inprocess.py (or a new tests/test_admin_voices.py
# if this file doesn't already have FastAPI TestClient infrastructure - check the top of
# test_engine_inprocess.py for an existing `client = TestClient(app)` fixture and reuse it)
def test_admin_put_voice_writes_to_storage(monkeypatch):
    from moto import mock_aws
    import boto3
    import io
    import tarfile
    import server as server_module

    with mock_aws():
        bucket = "test-bucket"
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=bucket)
        from voice_storage import VoiceStorage
        storage = VoiceStorage(bucket=bucket, endpoint_url=None, cache_dir="/tmp/admin-put-test-cache", max_cache_entries=8)
        monkeypatch.setattr(server_module, "voice_storage", storage)
        monkeypatch.setattr(server_module, "VOICES_ADMIN_TOKEN", "test-admin-token")

        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for name, data in [
                ("model.onnx", b"fake-model-bytes"),
                ("model.onnx.json", b"{}"),
                ("owner.json", b'{"public": true}'),
            ]:
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))

        response = server_module.client.put(
            "/admin/voices/admin-test-voice",
            content=buf.getvalue(),
            headers={"Authorization": "Bearer test-admin-token"},
        )
        assert response.status_code == 200
        assert storage.get("admin-test-voice") is not None
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd worker-piper-fly && python -m pytest tests/test_engine_inprocess.py::test_admin_put_voice_writes_to_storage -v`
Expected: FAIL — voice still written to local `VOICES_DIR` path via `os.rename`, `storage.get()` returns `None`

- [ ] **Step 8: Replace `admin_put_voice`'s local `os.rename` with `voice_storage.put()`**

Replace lines 269-276 of `worker-piper-fly/server.py` (currently: build `dest`/`old` local paths, `os.rename(out, dest)`, `shutil.rmtree(old, ...)`, `_evict(vid)`) with:

```python
        if voice_storage is None:
            raise HTTPException(status_code=503, detail="voice storage not configured")
        files = {}
        for fname in VOICE_FILES:
            with open(os.path.join(out, fname), "rb") as f:
                files[fname] = f.read()
        voice_storage.put(vid, files)
        _evict(vid)
        return {"voice": f"custom:{vid}", "bytes": size}
```

(`out` still comes from the existing tar-extraction-to-tempdir logic above this block, unchanged — only the final "commit the extracted files somewhere durable" step changes from a local rename to a `voice_storage.put()` call.)

- [ ] **Step 9: Update `admin_delete_voice` and `admin_list_voices` similarly**

Replace `worker-piper-fly/server.py:282-288` (`admin_delete_voice`) body with:

```python
    _admin(request, vid)
    existed = voice_storage.delete(vid) if voice_storage else False
    _evict(vid)
    return {"deleted": existed}
```

Replace `worker-piper-fly/server.py:291-295` (`admin_list_voices`) body with:

```python
    _admin(request)
    ids = voice_storage.list_ids() if voice_storage else []
    return {"voices": ids, "loaded": list(_voices.keys())}
```

- [ ] **Step 10: Run full existing test suite to check for regressions**

Run: `cd worker-piper-fly && python -m pytest tests/ -v`
Expected: all tests PASS, including the new storage-backed tests and every pre-existing test (`test_capacity.py`, `test_audiofmt.py`, etc. from earlier work this session)

- [ ] **Step 11: Commit**

```bash
cd worker-piper-fly
git add server.py tests/test_engine_inprocess.py
git commit -m "worker-piper-fly: load/publish/delete voices via Tigris-backed VoiceStorage"
```

### Task 3: Update `publish_voice.py` and provision Tigris

**Files:**
- Modify: `voices/publish_voice.py` (no code change needed — it already PUTs a tar to `/admin/voices/<vid>`, which Task 2 already redirected server-side; this task is about *provisioning*, not code)
- Modify: `worker-piper-fly/fly.toml`
- Create: `worker-piper-fly/TIGRIS_SETUP.md`

**Interfaces:**
- Consumes: `TIGRIS_BUCKET`, `TIGRIS_ENDPOINT_URL` env vars (Task 2)
- Produces: a real Tigris bucket + credentials, documented for whoever deploys this

- [ ] **Step 1: Provision the Tigris bucket via `fly storage create`**

Run: `cd worker-piper-fly && fly storage create --name piper-voices-prod` (interactive; follow the prompts, choose a region matching `primary_region` in `fly.toml`, currently `sjc`)

This prints an access key id, secret access key, and endpoint URL — do not commit these anywhere; they go directly into the next step.

- [ ] **Step 2: Set the Tigris credentials and config as Fly secrets**

```bash
fly secrets set \
  TIGRIS_BUCKET=piper-voices-prod \
  TIGRIS_ENDPOINT_URL=https://fly.storage.tigris.dev \
  AWS_ACCESS_KEY_ID=<from step 1 output> \
  AWS_SECRET_ACCESS_KEY=<from step 1 output> \
  -a piper-tts-sjc
```

(`boto3` reads `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from the environment automatically — no code needed for credential wiring beyond what Task 2 already wrote.)

- [ ] **Step 3: Add `boto3` to the worker's dependencies**

Check `worker-piper-fly/requirements.txt` for an existing `boto3` line; if absent, add `boto3==1.35.36` (or whatever current pinned version this repo's other `boto3` usage in `training-data/` already uses — match it for consistency) and rebuild.

- [ ] **Step 4: Write `TIGRIS_SETUP.md` documenting the one-time setup**

```markdown
# Tigris voice storage setup

One-time setup for a fresh environment (already done for `piper-tts-sjc` production —
see Task 3 of the production-readiness plan for the exact commands run).

1. `fly storage create --name <bucket-name>` from `worker-piper-fly/` — creates a Tigris
   bucket and prints access credentials once. Save them immediately; Tigris does not show
   the secret key again.
2. `fly secrets set TIGRIS_BUCKET=<bucket-name> TIGRIS_ENDPOINT_URL=https://fly.storage.tigris.dev AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... -a <app-name>`
3. Redeploy (`fly deploy`) so the new secrets take effect.
4. Migrate existing voices: for every voice currently in the old local `VOICES_DIR` on a
   running machine, `fly ssh console -a <app-name>`, then for each voice directory run a
   script that reads the three files and PUTs them through `/admin/voices/<vid>` (the
   admin endpoint now writes to Tigris per Task 2) - or, more simply, re-run
   `voices/publish_voice.py --tier A` (and any other already-published tiers) from a
   machine with the Modal `house-voices` volume access, since that script already re-pulls
   from the canonical Modal volume and re-PUTs - this naturally backfills Tigris with
   every currently-published voice without needing a local-to-Tigris copy script at all.
```

- [ ] **Step 5: Backfill existing published voices into Tigris**

Run: `cd voices && PIPER_ADMIN_URL=https://piper-tts-sjc.fly.dev VOICES_ADMIN_TOKEN=<token from ~/.config/voice-pipeline/piper_admin_token> python3 publish_voice.py --tier A,B --allow-tier-b --republish`

This re-publishes every already-known voice through the now-Tigris-backed admin endpoint, which backfills the bucket without needing a separate migration script. Verify: `curl -H "Authorization: Bearer <token>" https://piper-tts-sjc.fly.dev/admin/voices` and confirm the voice count matches `voices/catalog.json`'s published (non-tier-C, tier-B-with-`--allow-tier-b`-caveat-per-spec) entries.

- [ ] **Step 6: Commit the fly.toml and doc changes**

```bash
git add worker-piper-fly/fly.toml worker-piper-fly/TIGRIS_SETUP.md worker-piper-fly/requirements.txt
git commit -m "worker-piper-fly: document and provision Tigris voice storage"
```

---

## Piece 2: Autoscaling group (realtime-tts / worker-piper-fly)

### Task 4: Configure Fly autoscaling on top of the now-stateless worker

**Files:**
- Modify: `worker-piper-fly/fly.toml`
- Create: `worker-piper-fly/LOAD_TEST.md`
- Create: `worker-piper-fly/tests/load_test.py`

**Interfaces:**
- Consumes: nothing new (this piece is pure infra config + a verification script, not application code)
- Produces: a `max_machines_running` ceiling above the existing `min_machines_running = 1`, and a documented, runnable load test proving machines actually scale

- [ ] **Step 1: Add `max_machines_running` and confirm concurrency thresholds in `fly.toml`**

In `worker-piper-fly/fly.toml`'s `[http_service]` section, alongside the existing `min_machines_running = 1`:

```toml
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1
  max_machines_running = 4  # start conservative; raise once Task 5's load test confirms headroom
  [http_service.concurrency]
    type = "requests"
    soft_limit = 3   # below MAX_CONNECTIONS (per-machine app-level cap) so Fly starts a new
                      # machine before the app-level "at capacity" rejection ever fires
    hard_limit = 4
```

Set `soft_limit`/`hard_limit` below whatever `MAX_CONNECTIONS` is currently configured as on this app (check `fly secrets list -a piper-tts-sjc` for `MAX_CONNECTIONS` — the intent is Fly scales out *before* the application-level capacity rejection ever triggers, not after).

- [ ] **Step 2: Deploy the updated config**

Run: `cd worker-piper-fly && fly deploy -a piper-tts-sjc`
Expected: deploy succeeds, `fly status -a piper-tts-sjc` still shows exactly 1 machine running (no load yet, so no scale-up should have happened)

- [ ] **Step 3: Write a load-test script that drives concurrent WebSocket connections**

```python
# worker-piper-fly/tests/load_test.py
"""Drives N concurrent /tts WebSocket connections against a running worker (local or
deployed) and reports latency + how many machines Fly actually ran during the test.
Not a pytest test (it needs a live server and real wall-clock time) - a standalone
script, run manually per LOAD_TEST.md.

Usage: python3 tests/load_test.py <ws-url> <session-token> --concurrency 10 --requests 30
"""
import argparse
import asyncio
import json
import time

import websockets


async def one_synthesis(ws_url: str, token: str, text: str) -> float:
    start = time.monotonic()
    async with websockets.connect(f"{ws_url}?token={token}") as ws:
        await ws.send(json.dumps({"type": "synthesize", "text": text, "voice": "custom:en-us-john", "speed": 1.0}))
        first_byte_at = None
        async for message in ws:
            if isinstance(message, bytes):
                if first_byte_at is None:
                    first_byte_at = time.monotonic()
            else:
                payload = json.loads(message)
                if payload.get("type") == "done":
                    break
                if payload.get("type") == "error":
                    raise RuntimeError(f"synthesis error: {payload.get('message')}")
    return (first_byte_at or time.monotonic()) - start


async def run_load_test(ws_url: str, token: str, concurrency: int, total_requests: int):
    sem = asyncio.Semaphore(concurrency)
    latencies = []
    errors = []

    async def bounded_request(i: int):
        async with sem:
            try:
                latencies.append(await one_synthesis(ws_url, token, f"Load test request number {i}."))
            except Exception as e:  # noqa: BLE001 - report every failure, don't let one kill the run
                errors.append(str(e))

    await asyncio.gather(*(bounded_request(i) for i in range(total_requests)))

    print(f"completed: {len(latencies)}/{total_requests}, errors: {len(errors)}")
    if latencies:
        latencies.sort()
        p50 = latencies[len(latencies) // 2]
        p90 = latencies[int(len(latencies) * 0.9)]
        print(f"time-to-first-byte: p50={p50*1000:.0f}ms p90={p90*1000:.0f}ms")
    if errors:
        print("errors:", errors[:5])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("ws_url")
    parser.add_argument("token")
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--requests", type=int, default=30)
    args = parser.parse_args()
    asyncio.run(run_load_test(args.ws_url, args.token, args.concurrency, args.requests))
```

- [ ] **Step 4: Write `LOAD_TEST.md` with the exact run procedure**

```markdown
# Load-testing the autoscaled Piper worker

1. Mint a temporary billing-enabled test key (see `eval/README.md`'s established
   mint/use/revoke pattern) - never use a real customer key for load testing.
2. Authorize once to get a session token + WS URL:
   `curl -s -XPOST https://api.readaloudai.org/tts/authorize -d '{"key":"<test-key>","engine":"piper"}'`
3. In one terminal, watch machine count live: `watch -n2 'fly status -a piper-tts-sjc'`
4. Run the load test above a single machine's known ceiling (8-16 concurrent per the
   existing `performance-2x` measurement) to force a scale-up:
   `python3 tests/load_test.py wss://piper-tts-sjc.fly.dev/tts <token> --concurrency 20 --requests 60`
5. Confirm in the `fly status` terminal that machine count actually increased above 1
   during the run, and dropped back to 1 a few minutes after the run ends (Fly's default
   scale-down cooldown).
6. Confirm zero errors in the load test's own output - "at capacity" errors during a
   scale-up transition are exactly the failure mode this piece exists to prevent.
7. Revoke the temporary test key: `curl -s -XDELETE https://api.readaloudai.org/admin/keys -d '{"id":"<key-id>"}'`
```

- [ ] **Step 5: Actually run the load test against the deployed worker**

Follow `LOAD_TEST.md` exactly. This step has no automated pass/fail — it's a manual verification gate. Record the actual observed machine count and p50/p90 numbers in the commit message for Step 6, not invented numbers.

- [ ] **Step 6: Commit**

```bash
cd worker-piper-fly
git add fly.toml tests/load_test.py LOAD_TEST.md
git commit -m "worker-piper-fly: enable autoscaling, add load-test tooling

Verified: <fill in the actual machine-count-under-load and p50/p90
numbers observed in Step 5 here - do not commit this with placeholder
numbers, this line only gets written after Step 5 actually runs>"
```

---

## Piece 3: Backend-proxy (ReadAloudAI / backend)

### Task 5: Provision the dedicated realtime-tts API key for the app

**Files:** none (infra-only task)

- [ ] **Step 1: Mint the dedicated key via the gateway admin API**

```bash
ADM=$(cat ~/.config/voice-pipeline/gateway_admin_secret)  # or wherever ADMIN_SECRET ends up stored per this session's rotation
curl -s -XPOST https://api.readaloudai.org/admin/keys -H "Authorization: Bearer $ADM" -H "content-type: application/json" -d '{"label":"readaloud-android-app-backend-proxy"}'
```

Save the returned `id` and `key` — the `key` is shown once only.

- [ ] **Step 2: Enable billing on the new key**

```bash
curl -s -XPOST https://api.readaloudai.org/admin/keys/billing -H "Authorization: Bearer $ADM" -H "content-type: application/json" -d '{"id":"<id from step 1>","enabled":true}'
unset ADM
```

- [ ] **Step 3: Store the key as a ReadAloudAI backend secret**

```bash
fly secrets set REALTIME_TTS_API_KEY=<key from step 1> -a listenai-backend
```

### Task 6: Add the `/api/realtime-tts/authorize` route

**Files:**
- Create: `backend/src/routes/realtimeTts.ts`
- Modify: `backend/src/index.ts` (route registration)
- Test: `backend/src/routes/realtimeTts.test.ts`

**Interfaces:**
- Consumes: `REALTIME_TTS_API_KEY` env var (Task 5), existing `requireAuth` middleware (check `backend/src/middleware/` for its exact export name/path — mirror how `ttsRouter` is mounted at `backend/src/index.ts:168`)
- Produces: `realtimeTtsRouter` (Express `Router`), mounted at `/api/realtime-tts`, exposing `POST /api/realtime-tts/authorize`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/routes/realtimeTts.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { realtimeTtsRouter } from './realtimeTts.js';

describe('POST /api/realtime-tts/authorize', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/realtime-tts', realtimeTtsRouter);

  beforeEach(() => {
    vi.stubEnv('REALTIME_TTS_API_KEY', 'test-dedicated-key');
    global.fetch = vi.fn();
  });

  it('forwards to the gateway and returns the token/url, never the raw key', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'session-token-abc', url: 'wss://piper-tts-sjc.fly.dev/tts' }),
    });

    const res = await request(app).post('/api/realtime-tts/authorize').send({ engine: 'piper' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'session-token-abc', url: 'wss://piper-tts-sjc.fly.dev/tts' });
    expect(JSON.stringify(res.body)).not.toContain('test-dedicated-key');

    const [, options] = (global.fetch as any).mock.calls[0];
    const sentBody = JSON.parse(options.body);
    expect(sentBody.key).toBe('test-dedicated-key');
    expect(sentBody.engine).toBe('piper');
  });

  it('returns 502 when the gateway call fails', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"error":"invalid or missing API key"}' });

    const res = await request(app).post('/api/realtime-tts/authorize').send({ engine: 'piper' });

    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/realtimeTts.test.ts`
Expected: FAIL — `Cannot find module './realtimeTts.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/routes/realtimeTts.ts
import { Router } from 'express';

export const realtimeTtsRouter = Router();

const GATEWAY_URL = 'https://api.readaloudai.org';

realtimeTtsRouter.post('/authorize', async (req, res) => {
  const apiKey = process.env.REALTIME_TTS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'realtime-tts not configured' });
    return;
  }
  const engine = typeof req.body?.engine === 'string' ? req.body.engine : 'piper';

  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_URL}/tts/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: apiKey, engine }),
    });
  } catch (e) {
    res.status(502).json({ error: 'realtime-tts gateway unreachable' });
    return;
  }

  if (!upstream.ok) {
    res.status(502).json({ error: 'realtime-tts authorize failed' });
    return;
  }

  const { token, url } = await upstream.json();
  res.status(200).json({ token, url });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/realtimeTts.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Register the route in `backend/src/index.ts`**

Near the existing `import { ttsRouter } from './routes/tts.js';` (line 14) and its mount at line 168, add:

```typescript
import { realtimeTtsRouter } from './routes/realtimeTts.js';
```

and, following the same pattern as line 168 (`app.use('/api/tts', burstRateLimit, requireAuth, ttsRateLimitByTier, ttsRouter);`):

```typescript
app.use('/api/realtime-tts', burstRateLimit, requireAuth, realtimeTtsRouter);
```

(Reuses the existing `burstRateLimit`/`requireAuth` middleware already imported at the top of `index.ts` for `ttsRouter` — this is the per-app-user rate limiting the spec's Section 3 calls for, not new middleware.)

- [ ] **Step 6: Run the full backend test suite to check for regressions**

Run: `cd backend && npx vitest run`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
cd backend
git add src/routes/realtimeTts.ts src/routes/realtimeTts.test.ts src/index.ts
git commit -m "backend: add /api/realtime-tts/authorize proxy, keeps the platform key server-side"
```

---

## Piece 4: Real per-voice mapping (ReadAloudAI / android)

### Task 7: Build the voice-mapping table and wire it into `RealtimeTTSService`

**Files:**
- Create: `android/app/src/main/java/com/listenai/service/tts/PiperVoiceMapping.kt`
- Modify: `android/app/src/main/java/com/listenai/service/tts/RealtimeTTSService.kt` (replace `DEFAULT_VOICE_ID` usage)
- Test: create `android/app/src/test/java/com/listenai/service/tts/PiperVoiceMappingTest.kt` (this is the app's first JVM unit test directory for this package — per today's exploration, none existed before)

**Interfaces:**
- Consumes: `VoicePreset` (existing model, has `id`, `name`, locale/gender fields — read `android/app/src/main/java/com/listenai/data/models/VoicePreset.kt` to confirm exact field names before writing the mapping function's input type)
- Produces: `object PiperVoiceMapping { fun resolve(voice: VoicePreset): String }` returning a `"custom:<id>"` string, callable from `RealtimeTTSService`

- [ ] **Step 1: Read `VoicePreset.kt` to get exact field names**

Run: `cat android/app/src/main/java/com/listenai/data/models/VoicePreset.kt`

(This step has no code output — it's a required read before Step 2, since the mapping table's input type must match real fields, not guessed ones. Confirm the exact property names for locale/language and gender before proceeding — do not assume `voice.locale`/`voice.gender` exist under those exact names without checking.)

- [ ] **Step 2: Write the failing test using the confirmed field names**

```kotlin
// android/app/src/test/java/com/listenai/service/tts/PiperVoiceMappingTest.kt
package com.listenai.service.tts

import com.listenai.data.models.VoicePreset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PiperVoiceMappingTest {

    @Test
    fun `every built-in voice has a real, non-fallback mapping entry`() {
        for (voice in VoicePreset.builtInVoices) {
            val resolved = PiperVoiceMapping.resolve(voice)
            assertTrue("voice ${voice.id} resolved to blank", resolved.isNotBlank())
            assertTrue("voice ${voice.id} resolved to $resolved, expected custom: prefix", resolved.startsWith("custom:"))
            assertTrue(
                "voice ${voice.id} silently fell back to the default - add a real mapping entry",
                PiperVoiceMapping.MAPPING_FOR_TEST.containsKey(voice.id)
            )
        }
    }

    @Test
    fun `unmapped voice falls back to the documented default, not a crash`() {
        val unknownVoice = VoicePreset.builtInVoices.first().copy(id = "totally-unmapped-voice-id")
        val resolved = PiperVoiceMapping.resolve(unknownVoice)
        assertEquals(PiperVoiceMapping.FALLBACK_VOICE_ID, resolved)
    }
}
```

(`VoicePreset` is confirmed a Kotlin `data class` at `VoicePreset.kt:105`, so `.copy(id = ...)` is valid.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd android && ./gradlew testReaderDebugUnitTest --tests "*.PiperVoiceMappingTest*"`
Expected: FAIL — `PiperVoiceMapping` doesn't exist

- [ ] **Step 4: Write the mapping table**

`VoicePreset.builtInVoices` (confirmed by reading `VoicePreset.kt:367-378`) has exactly 10 entries, all English (US/British/Australian), each with a real `id` and `gender`: `bella`(F), `adam`(M), `brian`(M), `charlotte`(F), `josh`(M), `matilda`(F), `bill`(M), `elli`(F), `dorothy`(F), `rachel`(F). Cross-referenced against `realtime-tts`'s `voices/catalog.json` English entries (tier A and B — Piece 1's Task 3 backfill makes both tiers live in the registry, so both are safe to reference here) to pick a locale/gender-appropriate match for each, avoiding duplicate assignments:

```kotlin
// android/app/src/main/java/com/listenai/service/tts/PiperVoiceMapping.kt
package com.listenai.service.tts

import com.listenai.data.models.VoicePreset

/**
 * Maps the app's 10 built-in voices (VoicePreset.builtInVoices) to a real, published
 * Piper voice on the realtime-tts platform. Every entry was chosen for locale/gender
 * closeness to the Kokoro voice it replaces, cross-referenced against realtime-tts's
 * voices/catalog.json (see 2026-09-22-android-realtime-tts-production-readiness-design.md,
 * Piece 4, "revised 2026-09-22" note on switching the default engine to Piper).
 * This is a deliberate, reviewed table, not an algorithm - a new VoicePreset needs a new
 * entry added explicitly, not silent reliance on FALLBACK_VOICE_ID.
 */
object PiperVoiceMapping {
    const val FALLBACK_VOICE_ID = "custom:en-us-john"

    private val MAPPING: Map<String, String> = mapOf(
        // Female voices
        "bella" to "custom:en-us-kristin",        // US female, tier A - default voice, safest match
        "charlotte" to "custom:en-us-libritts_r-f383",  // US female, tier A - distinct elegant tone
        "elli" to "custom:en-us-ljspeech",        // US female, tier A - classic clear/calm reference voice
        "matilda" to "custom:en-nz-vctk-p335",    // NZ female, tier B - no Australian female exists in the
                                                    // catalog; New Zealand is the closest Anglophone-Pacific
                                                    // accent available, noted as an approximation
        "dorothy" to "custom:en-ca-vctk-p312",    // Canadian (Hamilton) female, tier B - warm alternate accent
        "rachel" to "custom:en-gb-vctk-p229",     // English (Southern England) female, tier B - clear/neutral,
                                                    // distinct from the US voices already assigned above

        // Male voices
        "adam" to "custom:en-us-john",            // US male, tier A - same voice used as this project's
                                                    // general-purpose default throughout (eval/, benchmarks/)
        "josh" to "custom:en-us-norman",          // US male, tier A - distinct from adam
        "bill" to "custom:en-us-libritts_r-m492", // US male, tier A - distinct authoritative tone
        "brian" to "custom:en-gb-vctk-p232",      // English (Southern England) male, tier B - no tier-A
                                                    // British male exists in the catalog
    )

    internal val MAPPING_FOR_TEST: Map<String, String> get() = MAPPING

    fun resolve(voice: VoicePreset): String {
        return MAPPING[voice.id] ?: FALLBACK_VOICE_ID
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd android && ./gradlew testReaderDebugUnitTest --tests "*.PiperVoiceMappingTest*"`
Expected: PASS (2 tests) — all 10 built-in voices have a real, non-fallback mapping entry (Step 4's table), and the deliberately-unmapped-id case correctly falls back to `FALLBACK_VOICE_ID`.

- [ ] **Step 6: Wire `PiperVoiceMapping` into `RealtimeTTSService`**

In `android/app/src/main/java/com/listenai/service/tts/RealtimeTTSService.kt`, remove the `DEFAULT_VOICE_ID` companion constant and its usage in `synthesizeOverWebSocket`'s `message` JSON body (currently `put("voice", DEFAULT_VOICE_ID)`), replacing with:

```kotlin
put("voice", PiperVoiceMapping.resolve(voice))
```

This requires `synthesizeOverWebSocket` to receive the `voice: VoicePreset` parameter it doesn't currently take (today's test build's `synthesizeOverWebSocket(auth, text, options, taskId)` signature doesn't include it) — thread `voice` through from `synthesize()`'s existing parameter down to this call.

- [ ] **Step 7: Run the full Android unit test suite**

Run: `cd android && ./gradlew testReaderDebugUnitTest`
Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
cd android
git add app/src/main/java/com/listenai/service/tts/PiperVoiceMapping.kt app/src/main/java/com/listenai/service/tts/RealtimeTTSService.kt app/src/test/java/com/listenai/service/tts/PiperVoiceMappingTest.kt
git commit -m "android: real per-voice Piper mapping, replaces single hardcoded voice"
```

### Task 8: Point `RealtimeTTSService` at the backend-proxy instead of the gateway directly

**Files:**
- Modify: `android/app/src/main/java/com/listenai/service/tts/RealtimeTTSService.kt`
- Test: (manual — this task removes the embedded key, which is the actual production-safety fix; verify via the same on-device install-and-play flow used for today's test build, not a new automated test)

**Interfaces:**
- Consumes: `POST /api/realtime-tts/authorize` (Task 6) — request body `{engine: string}`, response `{token: string, url: string}` (identical shape to the direct gateway call this replaces, so `AuthResponse`'s existing parsing in `RealtimeTTSService.authorize()` doesn't need to change, only its target URL)
- Produces: `RealtimeTTSService` with the `API_KEY` constant and hardcoded `GATEWAY_BASE_URL` authorize path removed

- [ ] **Step 1: Remove the embedded key and change the authorize target**

In `RealtimeTTSService.kt`, delete the `API_KEY` constant entirely (currently holds the real minted test key — this is the exact thing Piece 3 exists to eliminate). Change `authorize()`'s request:

```kotlin
private fun authorize(): AuthResponse {
    val body = JSONObject().apply {
        put("engine", "piper")
    }
    val request = Request.Builder()
        .url("${BackendConfig.baseUrl}/api/realtime-tts/authorize")
        .post(body.toString().toRequestBody("application/json".toMediaType()))
        .addHeader("Content-Type", "application/json")
        // this app's existing session auth (whatever header/cookie CloudTTSService's
        // sibling calls to listenai-backend already send for a logged-in user) goes
        // here - check CloudTTSService.kt's actual request building for the exact
        // existing auth header this app already attaches to authenticated backend
        // calls, and match it exactly rather than inventing a new auth scheme
        .build()

    httpClient.newCall(request).execute().use { response ->
        val responseBody = response.body?.string() ?: ""
        if (!response.isSuccessful) handleErrorResponse(response.code, responseBody)
        val json = JSONObject(responseBody)
        return AuthResponse(token = json.getString("token"), wsUrl = json.getString("url"))
    }
}
```

(`BackendConfig.baseUrl` is illustrative — check the app for its existing base-URL config mechanism, likely a `BuildConfig` field or a constants object already used by `CloudTTSService`'s `baseUrl` — reuse that exact mechanism rather than hardcoding `listenai-backend.fly.dev` a second time in a new place.)

- [ ] **Step 2: Update the class doc comment removing the "TEMPORARY embedded key" warning**

The `RealtimeTTSService` class-level KDoc currently documents the embedded-key shortcut as temporary and unacceptable for wider release — once Step 1 removes it, update that comment to state plainly that auth now goes through the backend-proxy, matching how `CloudTTSService`'s doc comment describes its own backend relationship.

- [ ] **Step 3: Rebuild and manually verify on a real device**

Run: `cd android && ./gradlew assembleReaderDebug`, install via `adb install -r`, and repeat the same manual "tap play on an article" verification done for today's test build — this time confirming the request actually round-trips through the ReadAloudAI backend (check backend logs for the `/api/realtime-tts/authorize` hit) rather than hitting `api.readaloudai.org` directly.

- [ ] **Step 4: Commit**

```bash
cd android
git add app/src/main/java/com/listenai/service/tts/RealtimeTTSService.kt
git commit -m "android: route through backend-proxy, remove embedded platform API key"
```

---

## Final integration check (after all 8 tasks)

- [ ] Re-read the spec's "Not in scope" section and confirm nothing here accidentally touched Chatterbox/XTTS retirement, voice-cloning migration, or a true streaming rewrite — all three should remain completely untouched by this plan's 8 tasks.
- [ ] Confirm every secret introduced (`TIGRIS_*`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `REALTIME_TTS_API_KEY`) is set via `fly secrets set` only, never present in any commit from this plan — `git log -p` the branch and grep for anything resembling a key.
- [ ] Update the spec's "Open items before implementation planning" section: the real quota number (now decided implicitly by whatever `max_machines_running` ceiling Task 4 settled on) and the Tigris cost (now knowable from real usage after Task 3's backfill) should move from "open" to "resolved, here's the number" once this plan is fully executed.
