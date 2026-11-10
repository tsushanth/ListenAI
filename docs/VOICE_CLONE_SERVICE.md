# Voice-clone serving app (CPU, scale-to-zero)

Status: deployed as the Fly app `listenai-voice-clone`, **dark**: reachable only with the service token; nothing in `listenai-backend`, the
website or the Android/iOS apps points at it. Code: `voice-clone-service/`. Owner: this repo. Related:
[`VOICE_CLONING_CONSENT.md`](VOICE_CLONING_CONSENT.md) (the consent-gated flow that calls it),
`internal-docs/cost-lab/gtm/voice-cloning/REPORT.md` (S5 licence/safety findings).

## What and why

The consent-gated cloning flow already lives in `listenai-backend` (`backend/src/lib/voiceCloning/`, dark): sign-in, verified email,
plan eligibility, consent record, reference gate, daily limits, watermark metadata, deletion, takedown. It calls a **serving app** over
HTTP (`serviceClient.ts`). The only serving app that existed was a Modal **L4 GPU** app (`backend/modal/chatterbox_clone.py`, about
USD 583/month if kept warm, USD 0.0126 per generated minute when scaled to zero). The owner chose CPU instead of GPU
(2026-11-06). This service is a drop-in replacement for that serving app on CPU, using Chatterbox **Turbo** (default) or **Nano**
(English only, MIT code and weights).

It does not duplicate what the backend owns. It adds what only the serving side can enforce: a bounded queue, a global spend breaker,
per-voice caps, rate limits, cached conditioning, retention and cost telemetry.

## Why a separate Fly app

* **Not the STT worker** (Modal GPU, shared with paying ReadAloud traffic, "no changes to it").
* **Not co-located with Piper / realtime-tts**: one cloning job holds all 8 cores for minutes and would starve live TTS.
* A separate app is the isolation and cost boundary: it can be killed (`fly apps destroy`) without touching anything else.

## Architecture

```
listenai-backend (consent, plan, daily limit, ASR)        listenai-voice-clone (this app, Fly, iad, scale-to-zero)
  POST /analyze, /similarity  ------------------------->   reference gate metrics (ECAPA, AST music, SNR)
  POST /voices (reference)    ------------------------->   store 24 kHz reference + meta, compute + CACHE conditionals once
  POST /voices/{id}/synthesize (sync, held open) ------->  bounded queue -> Chatterbox generate -> Perth watermark -> WAV
  POST /voices/{id}/jobs + GET /jobs/{id}?wait=55 ------>  same, async (long-poll)
  POST /voices/{id}/disable, DELETE /voices/{id} ------->  takedown marker / delete reference + conditionals
                                                           GET /metrics (token), /healthz (open, no state)
```

Voice storage: `/data/voices/<uuid>/{ref.wav, conds-<model>.pt, meta.json, DISABLED?}` on a 3 GB Fly volume (USD 0.45/month, billed even
when the machine is stopped). Deleting the directory removes the reference audio, the cached conditionals and the metadata. Model
weights are baked into the image (no download on cold start).

## HTTP contract

Everything except `/healthz` needs `Authorization: Bearer $VC_SERVICE_SECRET` (constant-time compare; the app refuses to start without it).

| Route | Purpose | Errors |
|---|---|---|
| `GET /healthz` | open, no state; used by the Fly check | |
| `GET /health` | model, load time, breaker, queue | |
| `GET /metrics` | today + last 7 days: jobs, failed, compute seconds, CPU seconds, audio seconds, chars, rejections; `est_cost_usd_today` if `VC_USD_PER_HOUR` is set | |
| `POST /analyze` multipart `audio` | duration, speech seconds, SNR, clipping, min window similarity, music probability | 422 undecodable |
| `POST /similarity` multipart `a`,`b` | ECAPA cosine | 422 |
| `POST /voices` multipart `voice_id` (UUID), `language`, `reference`, optional `consent_id` | store reference, cache conditionals | 400 `unsupported_language` (English only), 422 `reference_too_short` (< 6 s) / `reference_unusable` / `invalid_voice_id`, 409 `voice_exists` |
| `POST /voices/{id}/synthesize` json `{text <= 5000, language, speed 0.5-3}` | WAV (24 kHz, 16-bit mono), headers `X-Watermark-Scheme/Score`, `X-Sample-Rate`, `X-Model-Id`, `X-Audio-Seconds`, `X-Gen-Seconds` | 400, 403 `voice_disabled`, 404, 429 `queue_full` / `voice_daily_cap`, 503 `breaker_open` (`Retry-After`), 504 `generation_deadline` |
| `POST /voices/{id}/jobs` same body | 202 `{job_id, poll}` | as above |
| `GET /jobs/{id}?wait=N` | status `queued/running/done/error` (long-poll up to 55 s) | 404 |
| `GET /jobs/{id}/audio` | the WAV once done (kept 15 minutes, in memory) | 409 not ready |
| `POST /voices/{id}/disable` | takedown: unusable, evidence kept | 404 |
| `DELETE /voices/{id}` | removes everything derived | 404 (already gone) |

The sync route is the one the backend client uses today (`serviceClient.ts`, 10-minute timeout; the backend's own job worker already
wraps it as an async user-facing job). The async job API is for callers that prefer polling.

**Scale-to-zero and async jobs:** Fly stops a machine when the proxy sees no traffic, regardless of background CPU work. A job is only
safe while a client keeps a request open (the sync call, or the 55-second long-poll). A submitted job nobody polls can be cut off by an
idle stop, and job results live in memory, so a stop or deploy loses them. Treat jobs as retryable (the backend worker already is).

## Guards (and what each does not do)

| Guard | Setting | Limit to be honest about |
|---|---|---|
| Service token | `VC_SERVICE_SECRET` (Fly secret) | single shared secret; rotate with `fly secrets set` + the backend env |
| Failed-auth limiter | 10/min/IP (`VC_AUTH_FAIL_RPM`) | in-process, one machine |
| Per-IP request limiter | 120/min/IP (`VC_IP_RPM`); IP from `Fly-Client-IP` | behind the backend all calls share its IPs; this is a floor, the backend's per-user limits are the real ones |
| Bounded queue | 1 running + 4 waiting (`VC_MAX_CONCURRENT`, `VC_MAX_QUEUE`), beyond that 429 + `Retry-After` | `VC_MAX_CONCURRENT` must stay 1: the model and its conditionals are not thread-safe |
| **Global daily breaker** | `VC_DAILY_GEN_SECONDS` = 3600 compute seconds per UTC day, then 503 until midnight UTC | bounds cost, not abuse; persisted on the volume so a restart does not reset it |
| Kill switch | env `VC_DISABLED=true`, or create `/data/KILL` (no redeploy) | manual |
| Per-voice daily cap | 20,000 characters per voice per UTC day | a voice id maps to one user's voice in the backend |
| Reference gate | service: 6-120 s, decodable, conditioning must succeed. Backend: >= 8 s, speech ratio, SNR, clipping, music, single speaker | the thresholds are from one dev run (see the consent doc) |
| Consent | owned by the backend (strict phrase or attestation mode, evidence rows). The service stores `ref_sha256`, timestamp and an optional `consent_id` with each voice | the service cannot verify consent; direct calls with the token bypass the backend flow (the try-it script requires `--i-am-the-speaker`) |
| Watermark | Perth is applied inside `generate()` and re-applied after any speed change; score returned in `X-Watermark-Score` | Perth is deterrence only (false positives, untested under speed change) |
| Retention | voices unused for 365 days are deleted (reference, conditionals, meta); temp dirs after 1 h; delete route removes on request | the backend keeps the consent evidence on its own schedule |
| Logging | structured JSON events with ids, counts and timings only; never text or audio (a test asserts it) | |

## Cost

Fly bills a started machine per second; a stopped machine bills only its root
filesystem (about USD 0.15 per GB-month of image) and the volume.

### Measured (2026-11-10, Fly `iad`, Turbo, one synthetic reference voice, single runs, audio not listened to)

| Machine | Result |
|---|---|
| **performance-8x, 16 GB** (8 dedicated vCPU) | RTF (generation seconds per audio second): 3.0 for a 3 s clip, 2.61 for 11 s, 2.57 for 36 s, **2.56 for 108 s of audio (one 277 s synchronous request through the Fly proxy, HTTP 200)**. Conditioning once per voice: 15-16 s. Model load after boot: 33 s. |
| shared-cpu-8x, 16 GB | RTF 2.6-3.15 for jobs up to about 90 s, then **8.9 on a 107 s-audio job (954 s)**: shared CPUs are throttled under sustained load. Model load 102 s. **Not usable for this workload.** |

Scale-to-zero (performance-8x): the Fly proxy logged "excess capacity, autostopping machine" about 3.3 minutes after the last request;
the machine state went `stopped`; the 60-second health check on the machine did not keep it awake. The first request after a stop
(`POST /analyze`, which needs the model) returned HTTP 200 in **54.5 s** (boot + 33 s model load + 2.5 s of work); the same request warm
took 2.5 s. An earlier build only listened after the model had loaded and the first request got a 503 after 48 s; the app now
listens at once and model routes wait for the model (503 `warming_up` only after 150 s).

Price: Fly's pricing page lists shared-cpu-1x 256 MB = USD 2.19/month, 512 MB = 3.69, 1 GB = 6.70 (so RAM is about USD 6/GB-month),
performance-1x 2 GB = 33.00 and performance-2x 4 GB = 66.00. That gives performance-8x 16 GB = 8 x 21 + 16 x 6 = **about USD 264/month =
USD 0.367/hour while running** (derived from those figures, not read from an invoice). A stopped machine bills only its root filesystem
(image 3.8 GB x USD 0.15 = about USD 0.57/month) plus the 3 GB volume (USD 0.45/month): **about USD 1.0/month idle**.

### Cost per cloned minute

* Compute: RTF 2.56 x USD 0.367/60 = **USD 0.0157 per generated audio minute** (warm). One-time per voice: about 16 s = USD 0.0016.
* Isolated burst overhead: 55 s cold start + about 3.3 min idle tail = about USD 0.026 per burst that arrives after the machine has stopped.
* For comparison: the Modal L4 app measured USD 0.0126 per generated minute (REPORT.md), so CPU costs about 25% more per minute and runs
  at 0.39x real time instead of about real time. It is cheaper only because nothing runs or bills when idle, and there is no GPU.
* One machine generates at most 60 / 2.56 = 23 audio minutes per wall hour (about 16,900 per month at 100% utilisation).

Scenarios (the usage numbers are my assumptions; there is no cloning usage today). Each user makes 10 audio minutes a month:

| Users | Audio min/month | Compute | Burst overhead | Idle (volume + rootfs) | Total | Per user |
|---|---|---|---|---|---|---|
| 1x (1) | 10 | 0.16 | ~0.10 (4 bursts) | 1.02 | ~USD 1.3 | n/a |
| 10x (10) | 100 | 1.57 | ~0.52 (20 bursts) | 1.02 | ~USD 3.1 | 0.31 |
| 100x (100) | 1,000 | 15.7 | ~2.6 | 1.02 | ~USD 19 | 0.19 |

At 100x the machine is busy about 43 hours a month (6% duty), so always-on options only win at much higher volume: a flat Hetzner
shared 16 vCPU (about USD 35/month, shared CPU, not tested here) breaks even near 2,200 audio minutes a month, and an always-on
performance-8x (USD 264/month) never beats scale-to-zero below ~16,900 minutes.

**Limits that matter for cost:**

* The default global breaker (`VC_DAILY_GEN_SECONDS` = 3600) is about 23 audio minutes (USD 0.37) a day. It protects against a
  runaway, and it will trip well before 100x load; raise it deliberately when real usage exists.
* `listenai-backend` has **no per-user monthly cap on cloned synthesis**: only the voice-creation daily limit and hourly rate limits
  (20 per hour on the website route, 60 speech calls per hour on the API-key route, up to 1500 characters each). Worst case that is
  roughly 90 audio minutes per user per hour (about USD 1.4). A per-user monthly minutes cap (like the realtime-tts authorize route)
  must be added in the backend **before** this service is connected. Not done in this pass.


## Not done (explicitly)

* Not wired to `listenai-backend` (`VOICE_CLONE_SERVICE_URL` / `VOICE_CLONE_SERVICE_SECRET` are not set there), the website, or any
  app. The backend's migration `033_voice_clone_consent.sql` is a separate owner decision. No user can reach cloning.
* No quality judgement: audio was not listened to. The service reports objective values only (duration, watermark score, timings).
* English only (Turbo/Nano). Multilingual V3 on CPU (RTF 3.9-4.7) is a config option that is not built or deployed.
* No horizontal scale: the voice store is one Fly volume on one machine. Past one machine's throughput, move references and
  conditionals to object storage (Tigris/S3) and add machines.
* No `abuse@` mailbox, no counsel review, no payment hook (see the consent doc's rollout checklist). Output hashes are recorded by the
  backend, not here.
* Async job results are in memory and lost on stop or deploy.
* The `Retry-After` and 429/503 codes are not yet consumed by the backend client beyond "service unavailable".

## Operating it

```bash
fly status -a listenai-voice-clone
fly logs -a listenai-voice-clone
# metrics (token from ~/.listenai_voice_clone_token, never print it)
curl -s -H "Authorization: Bearer $(cat ~/.listenai_voice_clone_token)" https://listenai-voice-clone.fly.dev/metrics
# kill switch without a redeploy
fly ssh console -a listenai-voice-clone -C "touch /data/KILL"      # remove the file to re-enable
# rollback / removal
fly apps destroy listenai-voice-clone                              # also deletes the volume and every stored reference
# try it with your own clip
python3 voice-clone-service/scripts/try_clone.py --clip ~/Documents/my-voice.m4a --i-am-the-speaker --text "Hello, this is my cloned voice."
```
