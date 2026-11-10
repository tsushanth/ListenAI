"""HTTP surface of the voice-clone serving app (CPU Chatterbox). Implements the contract the backend client expects
(backend/src/lib/voiceCloning/serviceClient.ts): /analyze, /similarity, /voices, /voices/{id}/synthesize, /disable, DELETE,
plus an async job API (/voices/{id}/jobs, /jobs/{id}) and token-protected /metrics. Everything except /healthz needs
`Authorization: Bearer $VC_SERVICE_SECRET`. User identity, plan eligibility, the consent record and per-user daily limits stay in
listenai-backend (docs/VOICE_CLONING_CONSENT.md); this service enforces the cost and abuse guards that only it can see.
Nothing here logs text or audio."""
import hashlib
import hmac
import json
import os
import shutil
import threading
import time
import uuid
from contextlib import contextmanager

import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse

from audio import MAX_UPLOAD_BYTES, UUID_RE, AudioError, decode
from guards import BreakerOpen, Breaker, QueueFull, SlidingWindow, Telemetry, WorkQueue
from settings import Settings

SCHEME = "perth"


def log(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)  # ids, counts and timings only; never text or audio


def err(status: int, code: str, headers: dict | None = None) -> HTTPException:
    return HTTPException(status, detail={"code": code}, headers=headers)


def _read_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _write_json(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def sweep_expired(settings: Settings, engine=None, now: float | None = None) -> int:
    """Retention: delete voices (reference audio + cached conditionals + meta) unused for voice_ttl_days, and stale temp dirs."""
    now = now if now is not None else time.time()
    root = os.path.join(settings.data_dir, "voices")
    removed = 0
    if not os.path.isdir(root):
        return 0
    for name in os.listdir(root):
        d = os.path.join(root, name)
        try:
            if name.startswith(".tmp-"):
                if now - os.path.getmtime(d) > 3600:
                    shutil.rmtree(d, ignore_errors=True)
                continue
            meta = _read_json(os.path.join(d, "meta.json"))
            last = float(meta.get("last_used") or meta.get("created") or os.path.getmtime(d))
            if now - last > settings.voice_ttl_days * 86400:
                shutil.rmtree(d, ignore_errors=True)
                if engine is not None:
                    engine.forget_voice(d)
                removed += 1
                log("voice_expired", voice_id=name)
        except (OSError, ValueError):
            continue
    return removed


def create_app(engine, settings: Settings, clock=time.time) -> FastAPI:
    if not settings.secret:
        raise RuntimeError("VC_SERVICE_SECRET is not set; refusing to start without service auth")
    os.makedirs(os.path.join(settings.data_dir, "voices"), exist_ok=True)
    api = FastAPI(title="listenai-voice-clone", docs_url=None, redoc_url=None, openapi_url=None)
    tel = Telemetry(settings.data_dir, clock=clock)
    breaker = Breaker(tel, settings.daily_gen_seconds, settings.data_dir, env_disabled=settings.disabled, clock=clock)
    queue = WorkQueue(settings.max_concurrent, settings.max_queue)
    ip_limiter, fail_limiter = SlidingWindow(settings.ip_rpm), SlidingWindow(settings.auth_fail_rpm)
    jobs: dict = {}
    jobs_lock = threading.Lock()
    expected = f"Bearer {settings.secret}".encode()
    ref_sr = engine.sample_rate

    def client_ip(request: Request) -> str:
        return request.headers.get("fly-client-ip") or (request.client.host if request.client else "unknown")

    @api.middleware("http")
    async def rate_limit(request: Request, call_next):
        if request.url.path != "/healthz" and not ip_limiter.allow(client_ip(request)):
            tel.reject("ip_rate_limit")
            return JSONResponse({"detail": {"code": "rate_limited"}}, status_code=429, headers={"Retry-After": "30"})
        return await call_next(request)

    def auth(request: Request):
        got = request.headers.get("authorization", "").encode()
        if not hmac.compare_digest(got, expected):
            if not fail_limiter.allow(client_ip(request)):
                raise err(429, "rate_limited", {"Retry-After": "60"})
            raise err(401, "unauthorized")

    def vdir_of(voice_id: str) -> str:
        if not UUID_RE.match(voice_id):
            raise err(404, "voice_not_found")
        return os.path.join(settings.data_dir, "voices", voice_id)

    def guard_breaker() -> None:
        try:
            breaker.check()
        except BreakerOpen as e:
            tel.reject(f"breaker_{e.reason}")
            raise err(503, "breaker_open", {"Retry-After": str(e.retry_after)})

    @contextmanager
    def work():
        try:
            queue.admit()
        except QueueFull:
            tel.reject("queue_full")
            raise err(429, "queue_full", {"Retry-After": "30"})
        queue.infer.acquire()
        try:
            yield
        finally:
            queue.infer.release()
            queue.leave()

    async def read_upload(f: UploadFile) -> bytes:
        data = await f.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise err(413, "file_too_large")
        return data

    def touch_last_used(vdir: str) -> None:
        try:
            meta = _read_json(os.path.join(vdir, "meta.json"))
            meta["last_used"] = clock()
            _write_json(os.path.join(vdir, "meta.json"), meta)
        except (OSError, ValueError):
            pass

    # ------------------------------------------------------------------ health / metrics
    @api.get("/healthz")
    def healthz():
        return {"ok": True}  # unauthenticated, no state: used by the Fly check (which does not count as proxy traffic)

    @api.get("/health")
    def health(_=Depends(auth)):
        return {"ok": True, "model": engine.model_id, "load_s": getattr(engine, "load_s", None), "breaker": breaker.status(),
                "queue": {"admitted": queue.position(), "capacity": queue.capacity}}

    @api.get("/metrics")
    def metrics(_=Depends(auth)):
        today = tel.today()
        today.pop("voice_chars", None)
        out = {"today": today, "recent": tel.recent(7), "breaker": breaker.status()}
        usd_h = os.environ.get("VC_USD_PER_HOUR")
        if usd_h:
            out["est_cost_usd_today"] = round(today["gen_seconds"] / 3600 * float(usd_h), 4)
        return out

    # ------------------------------------------------------------------ analysis (reference gate inputs)
    # Endpoints are `async` only to read uploads; every blocking step (ffmpeg, torch, the inference slot) runs in the thread pool
    # so /healthz and rate limiting stay responsive while a job is running.
    @api.post("/analyze")
    async def analyze(audio: UploadFile = File(...), _=Depends(auth)):
        guard_breaker()
        data = await read_upload(audio)

        def go():
            try:
                y = decode(data, 16000)
            except AudioError as e:
                raise err(422, str(e).replace(" ", "_"))
            t0 = time.time()
            with work():
                m = engine.analyze(y)
            tel.add_compute(time.time() - t0)
            return m

        return await _in_thread(go)

    @api.post("/similarity")
    async def similarity(a: UploadFile = File(...), b: UploadFile = File(...), _=Depends(auth)):
        guard_breaker()
        da, db = await read_upload(a), await read_upload(b)

        def go():
            try:
                ya, yb = decode(da, 16000), decode(db, 16000)
            except AudioError as e:
                raise err(422, str(e).replace(" ", "_"))
            t0 = time.time()
            with work():
                s = engine.similarity(ya, yb)
            tel.add_compute(time.time() - t0)
            return {"similarity": s, "model": "speechbrain/spkrec-ecapa-voxceleb"}

        return await _in_thread(go)

    # ------------------------------------------------------------------ voices
    @api.post("/voices")
    async def create_voice(voice_id: str = Form(...), language: str = Form(...), reference: UploadFile = File(...),
                           consent_id: str = Form(""), _=Depends(auth)):
        guard_breaker()
        if language not in settings.langs:
            raise err(400, "unsupported_language")
        if not UUID_RE.match(voice_id):
            raise err(422, "invalid_voice_id")
        data = await read_upload(reference)
        return await _in_thread(lambda: _create_voice(voice_id, language, data, consent_id))

    def _create_voice(voice_id: str, language: str, data: bytes, consent_id: str) -> dict:
        import soundfile as sf

        final = vdir_of(voice_id)
        try:
            y = decode(data, ref_sr, max_sec=int(settings.max_reference_sec))
        except AudioError as e:
            raise err(422, str(e).replace(" ", "_"))
        dur = len(y) / ref_sr
        if dur < settings.min_reference_sec:
            raise err(422, "reference_too_short")
        if os.path.exists(final):
            raise err(409, "voice_exists")  # ids are server-generated UUIDs; never overwrite
        tmp = os.path.join(settings.data_dir, "voices", f".tmp-{uuid.uuid4().hex}")
        os.makedirs(tmp)
        try:
            sf.write(os.path.join(tmp, "ref.wav"), y.astype(np.float32), ref_sr, subtype="PCM_16")
            now = clock()
            _write_json(os.path.join(tmp, "meta.json"), {
                "language": language, "created": now, "last_used": now, "model": engine.model_id,
                "ref_sha256": hashlib.sha256(data).hexdigest(), "consent_id": consent_id or None})
            t0 = time.time()
            try:
                with work():
                    engine.prepare_voice(tmp)  # cache the conditionals once per voice (the 15-20 s cost)
            except (AssertionError, ValueError, RuntimeError) as e:
                tel.record(ok=False, gen_s=time.time() - t0, created=True)
                log("voice_rejected", voice_id=voice_id, reason=type(e).__name__)
                raise err(422, "reference_unusable")
            gen_s = time.time() - t0
            engine.forget_voice(tmp)
            try:
                os.rename(tmp, final)
            except OSError:
                raise err(409, "voice_exists")
            tel.record(ok=True, gen_s=gen_s, created=True)
            log("voice_created", voice_id=voice_id, reference_sec=round(dur, 2), condition_s=round(gen_s, 1))
            return {"voice_id": voice_id, "reference_sec": round(dur, 2)}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def validated_request(voice_id: str, body: dict):
        vdir = vdir_of(voice_id)
        if not os.path.exists(os.path.join(vdir, "ref.wav")):
            raise err(404, "voice_not_found")
        if os.path.exists(os.path.join(vdir, "DISABLED")):
            raise err(403, "voice_disabled")
        text = str(body.get("text", "")).strip()
        lang = str(body.get("language", "en"))
        try:
            speed = float(body.get("speed", 1.0))
        except (TypeError, ValueError):
            raise err(400, "invalid_request")
        if not text or len(text) > settings.max_text_chars or lang not in settings.langs or not (0.5 <= speed <= 3.0):
            raise err(400, "invalid_request")
        if tel.voice_chars_today(voice_id) + len(text) > settings.max_chars_per_voice_per_day:
            tel.reject("voice_daily_cap")
            raise err(429, "voice_daily_cap", {"Retry-After": "3600"})
        return vdir, text, speed

    def run_synth(voice_id: str, vdir: str, text: str, speed: float) -> dict:
        """Caller holds the inference slot."""
        t0 = time.time()
        try:
            breaker.check()
            r = engine.synthesize(vdir, text, speed, settings.chunk_chars, settings.max_gen_seconds_per_request)
        except BreakerOpen:
            raise
        except Exception:
            tel.record(ok=False, gen_s=time.time() - t0, voice_id=voice_id, chars=len(text))
            raise
        tel.record(ok=True, gen_s=r["gen_s"], cpu_s=r["cpu_s"], audio_s=r["audio_s"], chars=len(text), voice_id=voice_id)
        touch_last_used(vdir)
        log("synthesized", voice_id=voice_id, chars=len(text), audio_s=round(r["audio_s"], 2), gen_s=round(r["gen_s"], 2),
            rtf=round(r["gen_s"] / max(r["audio_s"], 0.01), 2), watermark_score=round(r["watermark_score"], 3))
        return r

    def audio_headers(r: dict) -> dict:
        return {"X-Watermark-Scheme": SCHEME, "X-Watermark-Score": f"{r['watermark_score']:.4f}", "X-Sample-Rate": str(r["sample_rate"]),
                "X-Model-Id": engine.model_id, "X-Audio-Seconds": f"{r['audio_s']:.2f}", "X-Gen-Seconds": f"{r['gen_s']:.2f}"}

    @api.post("/voices/{voice_id}/synthesize")
    async def synthesize(voice_id: str, request: Request, _=Depends(auth)):
        body = await request.json()
        guard_breaker()
        vdir, text, speed = validated_request(voice_id, body if isinstance(body, dict) else {})
        return await _in_thread(lambda: _sync_synth(voice_id, vdir, text, speed))

    def _sync_synth(voice_id, vdir, text, speed):
        with work():
            try:
                r = run_synth(voice_id, vdir, text, speed)
            except BreakerOpen as e:
                raise err(503, "breaker_open", {"Retry-After": str(e.retry_after)})
            except TimeoutError:
                raise err(504, "generation_deadline")
        return Response(r["wav"], media_type="audio/wav", headers=audio_headers(r))

    async def _in_thread(fn):
        from starlette.concurrency import run_in_threadpool

        return await run_in_threadpool(fn)

    # ------------------------------------------------------------------ async jobs (long-poll)
    def prune_jobs() -> None:
        now = clock()
        with jobs_lock:
            for k in [k for k, j in jobs.items() if j["status"] in ("done", "error") and now - j["finished"] > settings.job_result_ttl_sec]:
                del jobs[k]

    @api.post("/voices/{voice_id}/jobs", status_code=202)
    async def submit_job(voice_id: str, request: Request, _=Depends(auth)):
        body = await request.json()
        guard_breaker()
        vdir, text, speed = validated_request(voice_id, body if isinstance(body, dict) else {})
        prune_jobs()
        try:
            queue.admit()
        except QueueFull:
            tel.reject("queue_full")
            raise err(429, "queue_full", {"Retry-After": "30"})
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "voice_id": voice_id, "status": "queued", "created": clock(), "event": threading.Event(), "result": None, "code": None}
        with jobs_lock:
            jobs[job_id] = job

        def run():
            queue.infer.acquire()
            try:
                job["status"] = "running"
                job["result"] = run_synth(voice_id, vdir, text, speed)
                job["status"] = "done"
            except BreakerOpen:
                job["status"], job["code"] = "error", "breaker_open"
            except TimeoutError:
                job["status"], job["code"] = "error", "generation_deadline"
            except Exception:  # noqa: BLE001
                job["status"], job["code"] = "error", "synthesis_failed"
            finally:
                job["finished"] = clock()
                queue.infer.release()
                queue.leave()
                job["event"].set()

        threading.Thread(target=run, daemon=True).start()
        return {"job_id": job_id, "status": "queued", "poll": f"/jobs/{job_id}?wait={int(settings.job_wait_max_sec)}"}

    def job_view(job: dict) -> dict:
        out = {"job_id": job["id"], "status": job["status"]}
        if job["status"] == "error":
            out["code"] = job["code"]
        if job["status"] == "done":
            r = job["result"]
            out.update(audio_seconds=round(r["audio_s"], 2), gen_seconds=round(r["gen_s"], 2), watermark_score=round(r["watermark_score"], 4),
                       audio_url=f"/jobs/{job['id']}/audio")
        return out

    @api.get("/jobs/{job_id}")
    async def get_job(job_id: str, wait: float = 0.0, _=Depends(auth)):
        job = jobs.get(job_id)
        if job is None:
            raise err(404, "job_not_found")
        wait = max(0.0, min(wait, settings.job_wait_max_sec))
        if wait and job["status"] in ("queued", "running"):
            await _in_thread(lambda: job["event"].wait(wait))  # holds the connection open: counts as traffic, so the machine is not stopped mid-job
        return job_view(job)

    @api.get("/jobs/{job_id}/audio")
    def get_job_audio(job_id: str, _=Depends(auth)):
        job = jobs.get(job_id)
        if job is None:
            raise err(404, "job_not_found")
        if job["status"] != "done":
            raise err(409, "job_not_ready")
        r = job["result"]
        return Response(r["wav"], media_type="audio/wav", headers=audio_headers(r))

    # ------------------------------------------------------------------ takedown / deletion
    @api.post("/voices/{voice_id}/disable")
    def disable(voice_id: str, _=Depends(auth)):
        vdir = vdir_of(voice_id)
        if not os.path.isdir(vdir):
            raise err(404, "voice_not_found")
        with open(os.path.join(vdir, "DISABLED"), "w") as f:
            f.write(str(clock()))
        log("voice_disabled", voice_id=voice_id)
        return {"ok": True}

    @api.delete("/voices/{voice_id}")
    def delete(voice_id: str, _=Depends(auth)):
        vdir = vdir_of(voice_id)
        if not os.path.isdir(vdir):
            raise err(404, "voice_not_found")
        shutil.rmtree(vdir)  # reference audio, cached conditionals, meta: everything derived lives in this directory
        engine.forget_voice(vdir)
        log("voice_deleted", voice_id=voice_id)
        return {"deleted": True}

    api.state.jobs, api.state.telemetry, api.state.breaker, api.state.queue = jobs, tel, breaker, queue
    return api
