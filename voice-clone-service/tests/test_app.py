import json
import os
import threading
import time

import pytest

from app import sweep_expired
from conftest import AUTH, SECRET, VID, VID2, FakeEngine, create_voice, wav_bytes


def synth(client, vid=VID, text="Hello there.", **kw):
    return client.post(f"/voices/{vid}/synthesize", headers=AUTH, json={"text": text, "language": "en", **kw})


# ---- auth and rate limits -----------------------------------------------------------------------
def test_refuses_to_start_without_secret(tmp_path):
    from app import create_app
    from settings import Settings
    with pytest.raises(RuntimeError):
        create_app(FakeEngine(), Settings(secret="", data_dir=str(tmp_path)))


def test_healthz_is_open_everything_else_needs_token(make):
    c, *_ = make()
    assert c.get("/healthz").json() == {"ok": True}
    for method, path in [("get", "/health"), ("get", "/metrics"), ("post", "/analyze"), ("delete", f"/voices/{VID}")]:
        assert getattr(c, method)(path).status_code in (401, 422)
    assert c.get("/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert c.get("/health", headers=AUTH).json()["ok"] is True


def test_failed_auth_attempts_are_rate_limited(make):
    c, *_ = make(auth_fail_rpm=3)
    codes = [c.get("/health", headers={"Authorization": "Bearer nope"}).status_code for _ in range(5)]
    assert codes[:3] == [401, 401, 401] and codes[3] == 429


def test_per_ip_rate_limit(make):
    c, *_ = make(ip_rpm=5)
    codes = [c.get("/health", headers=AUTH).status_code for _ in range(7)]
    assert codes.count(429) == 2
    assert c.get("/healthz").status_code == 200  # health check is never limited


# ---- voice creation: reference gate, consent record, conditioning cache ------------------------
def test_create_voice_stores_reference_meta_and_conditionals(make):
    c, eng, s, _ = make()
    r = create_voice(c, consent_id="consent-123")
    assert r.status_code == 200 and r.json()["voice_id"] == VID and r.json()["reference_sec"] == pytest.approx(10.0, abs=0.1)
    d = os.path.join(s.data_dir, "voices", VID)
    assert os.path.exists(f"{d}/ref.wav") and os.path.exists(f"{d}/conds-fake.pt")
    meta = json.load(open(f"{d}/meta.json"))
    assert meta["consent_id"] == "consent-123" and len(meta["ref_sha256"]) == 64 and meta["language"] == "en"
    assert not any(n.startswith(".tmp-") for n in os.listdir(os.path.join(s.data_dir, "voices")))


def test_create_voice_rejections(make):
    c, eng, s, _ = make()
    assert create_voice(c, seconds=3).status_code == 422                       # reference too short
    assert create_voice(c, language="fr").status_code == 400                    # English-only models
    assert create_voice(c, vid="not-a-uuid").status_code == 422
    r = c.post("/voices", headers=AUTH, data={"voice_id": VID, "language": "en"}, files={"reference": ("x", b"garbage" * 500, "audio/wav")})
    assert r.status_code == 422
    assert not os.listdir(os.path.join(s.data_dir, "voices"))                  # nothing left behind on any failure


def test_unusable_reference_leaves_nothing_and_counts_as_failure(make):
    c, eng, s, _ = make(engine=FakeEngine(fail_prepare=True))
    assert create_voice(c).status_code == 422
    assert not os.listdir(os.path.join(s.data_dir, "voices"))
    assert c.get("/metrics", headers=AUTH).json()["today"]["failed"] == 1


def test_duplicate_voice_id_is_refused_not_overwritten(make):
    c, *_ = make()
    assert create_voice(c).status_code == 200
    assert create_voice(c).status_code == 409


# ---- synthesis, takedown, deletion ---------------------------------------------------------------
def test_synthesize_returns_watermarked_wav_with_contract_headers(make):
    c, eng, *_ = make()
    create_voice(c)
    r = synth(c, speed=1.2)
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    assert r.headers["X-Watermark-Scheme"] == "perth" and float(r.headers["X-Watermark-Score"]) > 0
    assert r.headers["X-Sample-Rate"] == "24000" and r.headers["X-Model-Id"] == "fake-cpu"


def test_synthesize_validation(make):
    c, *_ = make(max_text_chars=50)
    create_voice(c)
    assert synth(c, text="").status_code == 400
    assert synth(c, text="x" * 51).status_code == 400
    assert synth(c, speed=9).status_code == 400
    assert c.post(f"/voices/{VID}/synthesize", headers=AUTH, json={"text": "hi", "language": "fr"}).status_code == 400
    assert synth(c, vid=VID2).status_code == 404
    assert synth(c, vid="nope").status_code == 404


def test_disabled_voice_cannot_synthesize_but_is_kept(make):
    c, eng, s, _ = make()
    create_voice(c)
    assert c.post(f"/voices/{VID}/disable", headers=AUTH).json() == {"ok": True}
    assert synth(c).status_code == 403
    assert os.path.exists(os.path.join(s.data_dir, "voices", VID, "ref.wav"))  # evidence preserved
    assert c.post(f"/voices/{VID2}/disable", headers=AUTH).status_code == 404


def test_delete_removes_reference_conditionals_everything(make):
    c, eng, s, _ = make()
    create_voice(c)
    assert c.delete(f"/voices/{VID}", headers=AUTH).json() == {"deleted": True}
    assert not os.path.exists(os.path.join(s.data_dir, "voices", VID))
    assert eng.forgotten and synth(c).status_code == 404
    assert c.delete(f"/voices/{VID}", headers=AUTH).status_code == 404         # idempotent from the client's point of view


def test_analyze_and_similarity_pass_through(make):
    c, *_ = make()
    m = c.post("/analyze", headers=AUTH, files={"audio": ("a.wav", wav_bytes(5), "audio/wav")}).json()
    assert m["duration_sec"] == pytest.approx(5.0, abs=0.1) and "music_prob" in m
    s = c.post("/similarity", headers=AUTH, files={"a": ("a.wav", wav_bytes(5), "audio/wav"), "b": ("b.wav", wav_bytes(5), "audio/wav")}).json()
    assert s["similarity"] == 0.8


# ---- cost guards -----------------------------------------------------------------------------------
def test_global_daily_budget_opens_breaker(make):
    c, *_ = make(daily_gen_seconds=1.0)
    create_voice(c)
    assert synth(c).status_code == 200          # gen_s 0.5 per call in the fake
    assert synth(c).status_code == 200
    r = synth(c)
    assert r.status_code == 503 and int(r.headers["Retry-After"]) > 0 and r.json()["detail"]["code"] == "breaker_open"
    assert c.get("/health", headers=AUTH).json()["breaker"]["open"] is True
    assert create_voice(c, vid=VID2).status_code == 503                         # creation is blocked too


def test_kill_switch_file_and_env(make, tmp_path):
    c, eng, s, _ = make()
    create_voice(c)
    open(os.path.join(s.data_dir, "KILL"), "w").write("1")
    assert synth(c).status_code == 503
    os.remove(os.path.join(s.data_dir, "KILL"))
    assert synth(c).status_code == 200
    c2, *_ = make(disabled=True)
    assert synth(c2).status_code in (503,)


def test_per_voice_daily_character_cap(make):
    c, *_ = make(max_chars_per_voice_per_day=25)
    create_voice(c)
    assert synth(c, text="x" * 20).status_code == 200
    r = synth(c, text="y" * 20)
    assert r.status_code == 429 and r.json()["detail"]["code"] == "voice_daily_cap"


def test_telemetry_counts_jobs_seconds_and_never_stores_text(make, capsys):
    c, eng, s, _ = make()
    create_voice(c)
    secret_text = "my very private sentence about nothing"
    synth(c, text=secret_text)
    t = c.get("/metrics", headers=AUTH).json()["today"]
    assert t["jobs"] == 1 and t["voices_created"] == 1 and t["chars"] == len(secret_text) and t["gen_seconds"] > 0
    out = capsys.readouterr().out
    assert secret_text not in out and "private" not in out
    for root, _, files in os.walk(s.data_dir):
        for f in files:
            if f.endswith((".json",)):
                assert secret_text not in open(os.path.join(root, f)).read()


# ---- bounded queue ------------------------------------------------------------------------------
def test_queue_full_returns_429_and_recovers(make):
    eng = FakeEngine()
    eng.gate = threading.Event()
    c, _, s, app = make(engine=eng, max_concurrent=1, max_queue=1, ip_rpm=1000)
    create_voice(c)
    results = []
    threads = [threading.Thread(target=lambda: results.append(synth(c).status_code)) for _ in range(3)]
    for t in threads:
        t.start()
        time.sleep(0.15)
    time.sleep(0.3)
    eng.gate.set()
    for t in threads:
        t.join()
    assert sorted(results) == [200, 200, 429]
    assert synth(c).status_code == 200
    assert app.state.queue.position() == 0


# ---- async jobs (long-poll) ---------------------------------------------------------------------
def test_async_job_flow(make):
    c, *_ = make()
    create_voice(c)
    r = c.post(f"/voices/{VID}/jobs", headers=AUTH, json={"text": "Hello async.", "language": "en"})
    assert r.status_code == 202
    jid = r.json()["job_id"]
    j = c.get(f"/jobs/{jid}?wait=5", headers=AUTH).json()
    assert j["status"] == "done" and j["audio_seconds"] == 1.0
    a = c.get(f"/jobs/{jid}/audio", headers=AUTH)
    assert a.status_code == 200 and a.content[:4] == b"RIFF" and a.headers["X-Watermark-Scheme"] == "perth"
    assert c.get("/jobs/unknown", headers=AUTH).status_code == 404


def test_async_job_not_ready_and_queue_bound(make):
    eng = FakeEngine()
    eng.gate = threading.Event()
    c, _, s, app = make(engine=eng, max_concurrent=1, max_queue=0, ip_rpm=1000)
    create_voice(c)
    j1 = c.post(f"/voices/{VID}/jobs", headers=AUTH, json={"text": "one."}).json()["job_id"]
    time.sleep(0.2)
    assert c.get(f"/jobs/{j1}/audio", headers=AUTH).status_code == 409
    assert c.post(f"/voices/{VID}/jobs", headers=AUTH, json={"text": "two."}).status_code == 429
    eng.gate.set()
    assert c.get(f"/jobs/{j1}?wait=5", headers=AUTH).json()["status"] == "done"


def test_async_job_error_is_reported_not_raised(make):
    class Boom(FakeEngine):
        def synthesize(self, *a, **k):
            raise RuntimeError("boom")
    c, *_ = make(engine=Boom())
    create_voice(c)
    jid = c.post(f"/voices/{VID}/jobs", headers=AUTH, json={"text": "x."}).json()["job_id"]
    j = c.get(f"/jobs/{jid}?wait=5", headers=AUTH).json()
    assert j["status"] == "error" and j["code"] == "synthesis_failed"
    assert c.get("/metrics", headers=AUTH).json()["today"]["failed"] == 1


# ---- retention ---------------------------------------------------------------------------------
def test_retention_sweep_deletes_only_expired_voices_and_stale_tmp(make):
    c, eng, s, _ = make(voice_ttl_days=30)
    create_voice(c)
    create_voice(c, vid=VID2)
    old = os.path.join(s.data_dir, "voices", VID, "meta.json")
    meta = json.load(open(old))
    meta["last_used"] = time.time() - 40 * 86400
    json.dump(meta, open(old, "w"))
    stale = os.path.join(s.data_dir, "voices", ".tmp-abc")
    os.makedirs(stale)
    os.utime(stale, (time.time() - 7200, time.time() - 7200))
    assert sweep_expired(s, eng) == 1
    assert not os.path.exists(os.path.join(s.data_dir, "voices", VID))
    assert os.path.exists(os.path.join(s.data_dir, "voices", VID2)) and not os.path.exists(stale)


# ---- cold start: wait for the model instead of failing ---------------------------------------------
def test_requests_wait_for_model_load_then_succeed(make):
    import threading as th
    eng = FakeEngine()
    eng.ready = th.Event()
    c, _, s, _ = make(engine=eng, load_wait_sec=5, ip_rpm=1000)
    assert c.get("/healthz").status_code == 200                        # process is up immediately
    assert c.get("/health", headers=AUTH).json()["ready"] is False     # ...and says it is still loading
    th.Timer(0.5, eng.ready.set).start()
    t0 = time.time()
    assert create_voice(c).status_code == 200                          # held until the model is ready, not a 503
    assert time.time() - t0 >= 0.4
    assert c.get("/health", headers=AUTH).json()["ready"] is True


def test_warming_up_503_when_model_never_loads(make):
    import threading as th
    eng = FakeEngine()
    eng.ready = th.Event()
    c, *_ = make(engine=eng, load_wait_sec=0.3, ip_rpm=1000)
    r = create_voice(c)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "warming_up" and r.headers["Retry-After"] == "15"
