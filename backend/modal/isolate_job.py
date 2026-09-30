"""Vocal isolation (music/speech source separation) built on Meta's Demucs (htdemucs, MIT licensed),
via the `demucs` python package's own pretrained-model inference path.

Given an input audio clip, separates it into stems and returns the isolated vocal stem (and,
optionally, an "instrumental"/accompaniment stem built by summing the non-vocal stems). No
per-speaker training: htdemucs is a general-purpose pretrained separation model, used as-is.

DEV / NON-PRODUCTION: app name is "voice-isolate-dev" and does not touch the voice-intake /
voice-train apps, their volumes, or the Piper serving machine. Scale-to-zero GPU: containers only
run for the duration of a job and cost nothing while idle. Do not deploy this under a
production-sounding name.

This mirrors convert_job.py's shape deliberately (see that file's docstring for the full rationale
on the async submit/status/fetch_result/cleanup pattern and the asgi_app HTTP wrapper vs.
dubbing/job_server.py's stdlib-thread pattern): same job id scheme, same status states
(queued/processing/done/failed/rejected), same Volume-per-job layout, same Bearer-secret auth via
modal.Secret.from_name, so the backend route (voiceIsolate.ts) can reuse near-identical plumbing to
voiceConvert.ts.

Consent/ownership: like convert_job.py, this is a single shared-secret gate (Bearer ISOLATE_SECRET,
modal.Secret.from_name("voice-isolate")), not a per-customer API-key/consent-attestation model -
meant to be called server-to-server by a backend that has already decided whose audio this is.

Usage:
    modal run isolate_job.py --input ./clip.wav --out ./vocals.wav   (CLI, unchanged)
    modal serve isolate_job.py                                        (HTTP, dev)
    modal deploy isolate_job.py                                       (HTTP, deployed)
"""
import os as _os
import modal

APP_SUFFIX = _os.environ.get("VOICE_ISOLATE_APP_SUFFIX", "")  # for spinning up a second throwaway copy
app = modal.App("voice-isolate-dev" + APP_SUFFIX)

jobs = modal.Volume.from_name("voice-isolate-dev-jobs" + APP_SUFFIX, create_if_missing=True)
# Optional: absent in dev by default (mirrors convert_job.py's CONVERT_SECRET requirement, but does
# not hard-fail import so `modal run` for local CLI testing keeps working without provisioning a
# secret). The secret name can be overridden via env var for per-user deployments.
SECRET_NAME = _os.environ.get("VOICE_ISOLATE_SECRET_NAME", "voice-isolate")
try:
    isolate_secret = modal.Secret.from_name(SECRET_NAME, required_keys=["ISOLATE_SECRET"])
except Exception:
    isolate_secret = None

MODEL_NAME = "htdemucs"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(
        "torch==2.1.2", "torchaudio==2.1.2", extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "demucs==4.0.1", "soundfile", "librosa", "numpy<2",
    )
    .add_local_python_source("quality")  # shared metrics/quality-gate module (voice-pipeline/quality.py)
)
web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi==0.109.0")

MAX_INPUT_SECONDS = 600.0
MIN_SECONDS = 0.5
MAX_BYTES = 100 * 1024 * 1024
AUDIO_EXT = (".wav", ".flac", ".ogg", ".mp3", ".m4a")


def _validate(path: str, kind: str, max_seconds: float):
    """Format + duration gate. Mirrors convert_job._validate: cheap, readable checks before any
    GPU time is spent."""
    import soundfile as sf

    ext = _os.path.splitext(path)[1].lower()
    if ext not in AUDIO_EXT:
        raise ValueError(f"{kind}: unsupported format '{ext}' (allowed: {', '.join(AUDIO_EXT)})")
    size = _os.path.getsize(path)
    if size == 0:
        raise ValueError(f"{kind}: empty file")
    if size > MAX_BYTES:
        raise ValueError(f"{kind}: file too large ({size} bytes, max {MAX_BYTES})")
    try:
        info = sf.info(path)
        duration = info.frames / info.samplerate
    except Exception:
        # soundfile can't read mp3/m4a on some builds; fall back to librosa (slower, decodes fully)
        import librosa

        y, sr = librosa.load(path, sr=None)
        duration = len(y) / sr
    if duration < MIN_SECONDS:
        raise ValueError(f"{kind}: too short ({duration:.2f}s, min {MIN_SECONDS}s)")
    if duration > max_seconds:
        raise ValueError(f"{kind}: too long ({duration:.1f}s, max {max_seconds:.0f}s)")
    return duration


def _job_dir(job_id: str) -> str:
    return f"/jobs/{job_id}"


@app.function(image=image, volumes={"/jobs": jobs}, timeout=120)
def submit(job_id: str, input_bytes: bytes, input_ext: str, want_instrumental: bool = False) -> dict:
    """Validates input, stores it on the jobs Volume, writes job.json (status=queued), and spawns
    the GPU separation. Returns immediately - poll status() / fetch_result()."""
    import json, time

    d = _job_dir(job_id)
    _os.makedirs(d, exist_ok=True)
    in_path = f"{d}/input{input_ext}"
    open(in_path, "wb").write(input_bytes)

    try:
        in_dur = _validate(in_path, "input", MAX_INPUT_SECONDS)
    except ValueError as e:
        json.dump({"status": "rejected", "error": str(e)}, open(f"{d}/job.json", "w"))
        jobs.commit()
        return {"job_id": job_id, "status": "rejected", "error": str(e)}

    json.dump({
        "status": "queued", "submitted_at": int(time.time()),
        "input_seconds": round(in_dur, 2), "want_instrumental": want_instrumental,
    }, open(f"{d}/job.json", "w"))
    jobs.commit()

    run_isolation.spawn(job_id, want_instrumental)
    return {"job_id": job_id, "status": "queued", "input_seconds": round(in_dur, 2)}


@app.function(image=image, gpu="A10G", volumes={"/jobs": jobs}, timeout=900)
def run_isolation(job_id: str, want_instrumental: bool = False):
    """Runs demucs's own pretrained-model separation (htdemucs) as a subprocess (`python3 -m
    demucs`), the package's standard non-realtime entrypoint. Two stems are produced from the
    model's four (vocals, drums, bass, other): vocals kept as-is, and, if requested, an
    "instrumental" stem built by summing drums+bass+other."""
    import glob, json, subprocess, time

    d = _job_dir(job_id)
    job = json.load(open(f"{d}/job.json"))
    job["status"] = "processing"
    job["started_at"] = int(time.time())
    json.dump(job, open(f"{d}/job.json", "w"))
    jobs.commit()

    input_path = glob.glob(f"{d}/input.*")[0]
    out_dir = f"{d}/out"
    _os.makedirs(out_dir, exist_ok=True)

    t0 = time.time()
    cmd = [
        "python3", "-m", "demucs",
        "-n", MODEL_NAME, "--two-stems", "vocals",
        "-o", out_dir, input_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.time() - t0

    vocals_matches = glob.glob(f"{out_dir}/{MODEL_NAME}/*/vocals.wav")
    accomp_matches = glob.glob(f"{out_dir}/{MODEL_NAME}/*/no_vocals.wav")
    if proc.returncode != 0 or not vocals_matches:
        job.update({
            "status": "failed", "finished_at": int(time.time()), "gpu_seconds": round(elapsed, 1),
            "stderr_tail": proc.stderr[-4000:], "stdout_tail": proc.stdout[-2000:],
        })
        json.dump(job, open(f"{d}/job.json", "w"))
        jobs.commit()
        return

    result_path = f"{d}/result_vocals.wav"
    _os.rename(vocals_matches[0], result_path)

    instrumental_path = None
    if want_instrumental and accomp_matches:
        instrumental_path = f"{d}/result_instrumental.wav"
        _os.rename(accomp_matches[0], instrumental_path)

    quality = None
    try:
        from quality import validate_conversion_quality
        quality = validate_conversion_quality(input_path, input_path, result_path)
    except Exception as e:  # a broken quality check must never fail a separation that otherwise succeeded
        quality = {"passed": None, "reasons": [], "warnings": [f"quality check itself errored: {e!r}"], "metrics": {}}

    job.update({
        "status": "done", "finished_at": int(time.time()), "gpu_seconds": round(elapsed, 1),
        "quality": quality, "has_instrumental": instrumental_path is not None,
    })
    json.dump(job, open(f"{d}/job.json", "w"))
    jobs.commit()


@app.function(image=modal.Image.debian_slim(), volumes={"/jobs": jobs}, timeout=30)
def status(job_id: str) -> dict:
    import json

    jobs.reload()
    p = f"{_job_dir(job_id)}/job.json"
    if not _os.path.exists(p):
        return {"job_id": job_id, "status": "unknown"}
    return {"job_id": job_id, **json.load(open(p))}


@app.function(image=modal.Image.debian_slim(), volumes={"/jobs": jobs}, timeout=30)
def fetch_result(job_id: str, stem: str = "vocals") -> bytes:
    jobs.reload()
    fname = "result_vocals.wav" if stem == "vocals" else "result_instrumental.wav"
    p = f"{_job_dir(job_id)}/{fname}"
    if not _os.path.exists(p):
        raise FileNotFoundError(f"no {stem} result for {job_id} (check status first)")
    return open(p, "rb").read()


@app.function(image=modal.Image.debian_slim(), volumes={"/jobs": jobs}, timeout=30)
def cleanup(job_id: str) -> dict:
    """Removes a job's audio from the Volume (input/result stems) - call after fetching the
    result so nothing lingers billing Volume storage."""
    import shutil

    d = _job_dir(job_id)
    existed = _os.path.exists(d)
    shutil.rmtree(d, ignore_errors=True)
    jobs.commit()
    return {"job_id": job_id, "deleted": existed}


@app.function(
    image=web_image,
    secrets=[isolate_secret] if isolate_secret else [],
    volumes={"/jobs": jobs},
    timeout=60,
)
@modal.asgi_app()
def api():
    """HTTP front door onto submit/status/fetch_result/cleanup - see convert_job.py's module
    docstring for why this asgi_app pattern was chosen over dubbing/job_server.py's stdlib-thread
    pattern.

      POST   /isolate            multipart form: input=<file>, want_instrumental?=bool (default false)
                                  -> 202 {job_id, status: queued|rejected, input_seconds}
      GET    /isolate/{job_id}   -> job.json contents, e.g. {status: queued|processing|done|failed,
                                  quality: {passed, reasons, warnings, metrics}} once done
      GET    /isolate/{job_id}/result?stem=vocals|instrumental   -> audio/wav bytes
                                  (409 if not done yet, 404 if unknown, 410 if stem unavailable)
      DELETE /isolate/{job_id}   -> removes the job's audio from the Volume, {deleted: bool}

    Auth: Bearer ISOLATE_SECRET on every route (hmac.compare_digest, fail-closed if the secret is
    unset - same posture as convert_job.py's auth()). Shared secret for a trusted caller (e.g. a
    product backend), not a per-customer API key/consent model.
    """
    import hmac
    import json
    import secrets as pysecrets

    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import Response

    web = FastAPI()

    def auth(request: Request):
        secret = _os.environ.get("ISOLATE_SECRET")
        tok = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not secret or not tok or not hmac.compare_digest(tok.encode(), secret.encode()):
            raise HTTPException(401, "unauthorized")

    @web.post("/isolate")
    async def isolate(request: Request, want_instrumental: bool = False):
        auth(request)
        form = await request.form()
        input_file = form.get("input")
        if input_file is None:
            raise HTTPException(400, "multipart field 'input' (audio file) is required")
        job_id = "job-" + pysecrets.token_hex(5)
        input_bytes = await input_file.read()
        in_ext = _os.path.splitext(input_file.filename or "")[1].lower() or ".wav"
        result = submit.remote(job_id, input_bytes, in_ext, want_instrumental)
        status_code = 400 if result["status"] == "rejected" else 202
        return Response(content=json.dumps(result), media_type="application/json", status_code=status_code)

    @web.get("/isolate/{job_id}")
    async def get_status(job_id: str, request: Request):
        auth(request)
        return status.remote(job_id)

    @web.get("/isolate/{job_id}/result")
    async def get_result(job_id: str, request: Request, stem: str = "vocals"):
        auth(request)
        if stem not in ("vocals", "instrumental"):
            raise HTTPException(400, "stem must be 'vocals' or 'instrumental'")
        st = status.remote(job_id)
        if st["status"] == "unknown":
            raise HTTPException(404, "unknown job")
        if st["status"] != "done":
            raise HTTPException(409, f"job is not done (status: {st['status']})")
        if stem == "instrumental" and not st.get("has_instrumental"):
            raise HTTPException(410, "instrumental stem was not requested/produced for this job")
        try:
            audio = fetch_result.remote(job_id, stem)
        except FileNotFoundError:
            raise HTTPException(410, "result no longer available")
        return Response(audio, media_type="audio/wav")

    @web.delete("/isolate/{job_id}")
    async def delete(job_id: str, request: Request):
        auth(request)
        return cleanup.remote(job_id)

    return web


@app.local_entrypoint()
def main(input: str, out: str = "./vocals.wav", instrumental_out: str = "", job_id: str = "",
         want_instrumental: bool = False, poll_seconds: int = 5, timeout_seconds: int = 600, keep: bool = False):
    """modal run isolate_job.py --input ./clip.wav --out ./vocals.wav"""
    import secrets, time

    jid = job_id or "job-" + secrets.token_hex(5)
    in_ext = _os.path.splitext(input)[1].lower()
    in_bytes = open(input, "rb").read()

    res = submit.remote(jid, in_bytes, in_ext, want_instrumental)
    print("submit:", res)
    if res["status"] == "rejected":
        raise SystemExit(f"rejected: {res['error']}")

    t0 = time.time()
    while time.time() - t0 < timeout_seconds:
        st = status.remote(jid)
        print("status:", st["status"], f"(+{int(time.time() - t0)}s)")
        if st["status"] in ("done", "failed"):
            break
        time.sleep(poll_seconds)
    else:
        raise SystemExit("timed out waiting for isolation")

    if st["status"] == "failed":
        print("STDERR TAIL:\n", st.get("stderr_tail", ""))
        raise SystemExit("isolation failed")

    audio = fetch_result.remote(jid, "vocals")
    open(out, "wb").write(audio)
    print(f"wrote {out} ({len(audio)} bytes), gpu_seconds={st.get('gpu_seconds')}")

    if want_instrumental and st.get("has_instrumental") and instrumental_out:
        inst_audio = fetch_result.remote(jid, "instrumental")
        open(instrumental_out, "wb").write(inst_audio)
        print(f"wrote {instrumental_out} ({len(inst_audio)} bytes)")

    if not keep:
        print(cleanup.remote(jid))
