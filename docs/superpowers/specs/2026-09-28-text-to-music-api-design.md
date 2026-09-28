# Text-to-Music API — Design Spec

Date: 2026-09-28
Status: approved for planning

## Intent

Bring ReadAloud to feature parity with ElevenLabs Music by offering text-to-music
generation as a first-class ReadAloud API capability, and use that same API inside
Calldesk to provide per-agent background/hold music. Scope for this spec is
instrumental/background music only (no vocals), generated offline/async (not
real-time in a live call), built on an open model we finetune ourselves rather than
wrapping a vendor API.

Out of scope for this spec: actually mixing/playing generated music into a live
call. That logic lives in `call-loop-poc`, a repo not available in this workspace.
This spec stops at Calldesk storing a generated music asset URL on an agent record;
consuming that URL during a live call is a follow-up task once `call-loop-poc` is
accessible.

## Success criteria

- External ReadAloud API customers can call a music-generation endpoint and get back
  a cached, downloadable instrumental audio asset, billed per generation.
- Calldesk users can generate/select background music for an agent from the
  dashboard, and the resulting asset URL is persisted on the agent record.
- `calldesktech-node` and `calldesktech-python` expose SDK methods for the new
  endpoint so external customers aren't stuck calling raw HTTP.

## Architecture overview

Three new pieces, following existing patterns in each repo rather than inventing new
ones:

1. A finetuned Stable Audio Open model, served as a Modal serverless GPU function
   (mirrors `realtime-tts/worker-modal-readaloud/app.py`).
2. A new async job-based endpoint in the ReadAloud backend (mirrors
   `backend/src/routes/tts.ts`'s `/api/tts/job` pattern exactly).
3. Calldesk dashboard wiring (`calldesktech`) that calls the new endpoint via a new
   SDK resource, and stores the result on the agent record.

No live-call/telephony code is touched.

## Model & data pipeline

- **Base model**: Stable Audio Open. Open weights, diffusion-based, well suited to
  short instrumental/ambience generation (as opposed to MusicGen, which trends
  toward melody-conditioned genre pieces). License terms must be checked against
  Calldesk's commercial use before launch — flag for legal review, same as the
  VoxKey retention-policy precedent.
- **Training data**: MTG-Jamendo (~55k CC-licensed tracks, tagged) and the Free
  Music Archive (CC tracks, weaker tags), filtered to short (15s–2min), low/no-vocal,
  loop-friendly clips — this distribution matches hold-music/background use far
  better than full "songs."
- **Captioning**: Jamendo/FMA tags aren't free-text captions. Run an existing
  audio-captioning model (e.g. LP-MusicCaps) over the filtered corpus to synthesize
  text↔audio pairs for conditioning.
- **Finetune approach**: LoRA-style adapter on Stable Audio Open. Single general
  model for v1 — mood/genre/duration steered entirely through the text prompt at
  inference time (e.g. "corporate upbeat instrumental, 60s, loopable"), not separate
  per-category models. Multiple specialized models are an explicit non-goal for v1;
  revisit only if demand justifies the added training/hosting cost.
- **Location**: new directory alongside `worker-modal-readaloud` in `realtime-tts`,
  since that's where existing GPU/model-serving code and Modal patterns already
  live.

## Modal GPU worker

New Modal ASGI app modeled directly on `worker-modal-readaloud/app.py`:
loads the finetuned adapter + base model, exposes a generation function
(`gpu="T4"` or similar, `@modal.concurrent` as appropriate for expected load),
reuses the existing Modal Secrets pattern for auth, and calls back to the Node
backend's usage-report hook the same way the TTS worker does.

## ReadAloud backend API

New `backend/src/routes/textToMusic.ts`, mirroring `routes/tts.ts`:

- `POST /api/music/job`
  - Validates request (zod): `prompt` (string), `duration_sec` (bounded, e.g.
    15–120), optional `mood`/`genre` tags folded into the prompt server-side.
  - Computes a cache key from the normalized request (mirrors `lib/cacheKey.ts`);
    cache hit returns `{job_id: "cache-...", status: "ready", audio_url}`
    immediately.
  - Cache miss: creates a job row (new `music_jobs` table, Postgres RPC analogous
    to `create_tts_job`), publishes to the same DB-polling "queue" pattern used by
    `ttsJobWorker.ts` (a new `musicJobWorker.ts` polling `music_jobs` on the same
    interval), responds `202` with `{job_id, status: "processing",
    estimated_wait_sec}`.
- `GET /api/music/job/:jobId`
  - Polling endpoint, reuses `jobPollingRateLimit`, returns status/progress/
    `audio_url` once ready.
- **Storage**: Supabase Storage, same signed-URL pattern as TTS
  (`uploadAudio`/`getSignedAudioUrl`), new path convention
  `music/{userId}/{jobId}.mp3`, 1-hour signed URLs.
- **Auth**: `requireRealAuth` (the strict path already used for
  `routes/ttsApiKeys.ts`) — no permissive fallback, since this is a billable,
  external-API-facing feature from day one.
- **Billing**: new Stripe usage meter, per-generation (not per-character/per-second),
  following the existing Voice Design meter precedent
  (`scripts/create-voice-design-meter.mjs` → new
  `scripts/create-music-generation-meter.mjs`, new meter event name e.g.
  `MUSIC_GENERATION_METER_EVENT_NAME`). Reported via
  `stripe.billing.meterEvents.create` per successful job completion, alongside or
  inside the existing `reportUsageToStripe()` loop.

## Client SDKs

- `calldesktech-node`: new `MusicResource` class (mirrors existing resource
  classes like `AgentsResource`), methods `generate({prompt, duration_sec, mood})`
  and `pollJob(jobId)`, hitting the ReadAloud music endpoints.
- `calldesktech-python`: same shape, mirrored in the Python client's existing
  resource pattern.
- Both ship in this phase (not deferred), since the intent is explicitly to offer
  this to external ReadAloud API customers, not just use it internally in Calldesk.

## Calldesk dashboard integration

In `calldesktech`, add a background/hold-music field to agent configuration,
alongside the existing voice (`tts_backend`) config:

- UI: mood/genre picker + duration input on the agent edit screen.
- On save/generate: calls the new `MusicResource.generate()` SDK method, polls for
  completion, stores the resulting `audio_url` on the agent record (new column,
  e.g. `hold_music_url`, on the existing agents table).
- Billing: Calldesk is billed as a ReadAloud API customer for these generations,
  same per-generation Stripe meter as external customers — no special-cased free
  tier unless a product decision says otherwise.
- This column/URL is the handoff point for the future `call-loop-poc` work that
  will actually play it into a live call; that consumption logic is not built here.

## Testing

- **Model**: manual listening evaluation across a fixed prompt set spanning mood
  categories (corporate, upbeat, ambient, etc.), checked for loop-ability and
  artifacts. No automated audio-quality gate for v1.
- **API**: integration tests mirroring whatever test coverage exists today for
  `routes/tts.ts`'s job endpoints (cache hit, job creation, polling, auth
  rejection).
- **Dashboard**: manual click-through — generate music for an agent, confirm the
  asset URL persists and is retrievable.

## Open risks / follow-ups (explicitly not solved here)

- Stable Audio Open license terms for Calldesk's commercial use — needs legal
  review before launch.
- Actual in-call playback/mixing of generated music — blocked on `call-loop-poc`
  access.
- No automated audio-quality regression testing for the finetuned model.
