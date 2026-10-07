# Consent-gated voice cloning (Chatterbox Multilingual V3)

Status: implemented on branch `feature/cloning-consent-chatterbox`, **not deployed, migration not applied, feature dark**.
Background and evidence: `internal-docs/cost-lab/gtm/voice-cloning/REPORT.md`.

## What this replaces

* XTTS v2 (Coqui Public Model License, non-commercial) is removed from `backend/`, `web/` and `tts-service/`.
* The old Chatterbox path (`/api/cloned-voices`, `/api/tts/cloned`, `/api/tts/job-cloned`) created voices from a
  client-chosen `X-Device-ID`, accepted any `voice_url`, and had no sign-in, payment, consent, watermark or limit.
  Creation there now returns `410 consent_required`; synthesis only accepts voices from the new `voice_clones` table.
* Serving moves from a CPU-only box (8-17 min per job) to a Modal L4 app, `backend/modal/chatterbox_clone.py`
  (scale-to-zero; measured RTF ~0.94, ~$0.0126 per generated minute, cold start 60-180 s).

## Flow

```
client                         backend (/api/voice-clones)                 Modal app          STT gateway
  |  POST /consent-challenges  ->  eligibility (verified email + paid plan)
  |  <- {challenge_id, phrase, expires_at}   random phrase with 4 code words, 5 min, single use
  |  (user records the phrase in-session, and a reference clip)
  |  POST /  multipart ------->  eligibility -> daily limit -> challenge valid
  |                              -> /analyze reference (gate) + consent clip  -------> metrics
  |                              -> consent: ASR(phrase) --------------------------------------------> transcript
  |                                          similarity(consent, reference) ----------> ECAPA cosine
  |                              -> create voice (reference stored on the Modal volume only)
  |                              -> persist consent evidence + voice, consume challenge
  |  <- 201 {id, status:"active", ...}
```

Order matters and is covered by tests (`lib/voiceCloning/service.test.ts`): a bad recording does not burn a consent
attempt; a wrong phrase skips the (paid) similarity call; nothing is created on any failure; if persisting fails after
the Modal app created the voice, the voice is removed again.

## HTTP contract

All user routes: `Authorization: Bearer <Supabase access token>` (verified against Supabase; there is **no** default-user
fallback, unlike `requireAuth`). Everything is `503 {code:"unavailable"}` until `VOICE_CLONE_SERVICE_URL`,
`VOICE_CLONE_SERVICE_SECRET` and `STT_API_KEY` are set.

| Route | Purpose | Notable errors (`code`) |
|---|---|---|
| `POST /api/voice-clones/consent-challenges` | issue phrase | 401 `unauthenticated`, 403 `email_unverified`, 402 `payment_required` |
| `POST /api/voice-clones` multipart: `challenge_id`, `name`, `language`, `consent` (audio), `reference` (audio) | create voice | 422 `reference_rejected` (`details.failures[]`: `too_short`, `too_long`, `not_enough_speech`, `too_noisy`, `clipped`, `multiple_speakers`, `music_detected`), 422 `consent_clip_rejected`, 422 `phrase_mismatch`, 422 `speaker_mismatch` (`details.attemptsLeft`), 429 `daily_limit`, 429 `creation_in_progress`, 410 `challenge_expired`, 409 `challenge_used`, 429 `challenge_attempts_exhausted`, 503 `asr_unavailable` / `service_unavailable` |
| `GET /api/voice-clones` | list own voices (never returns audio) | |
| `DELETE /api/voice-clones/:id` | delete reference audio, embeddings, cached prompts | 502 `deletion_pending` (voice is already unusable; retry) |
| `POST /api/voice-clones/abuse-reports` | public takedown intake (no sign-in; 5/h/IP) | |
| `POST /api/admin/voice-clones/:id/disable` `{reason}` | takedown, header `x-admin-key` | 401 if `ADMIN_API_KEY` unset (no built-in default) |
| `POST /api/admin/voice-clones/purge-expired` | retention sweep, header `x-admin-key` | |

Synthesis: `POST /api/tts/cloned` (sync, <= 1500 chars) and `POST /api/tts/job-cloned` (async job) with
`{text, voice_id (UUID from this API), speed}`. The client-supplied `voice_url` and `model:"xtts"` are gone. The voice must
be active, owned by the caller, and the plan still active at synthesis time (a takedown or cancelled plan stops queued jobs).
Responses carry `X-Watermark: perth`.

### Web UI for the consent step

Not built. The browser flow is: request a challenge, show `phrase`, record with `MediaRecorder` (`audio/webm` is accepted,
decoded server-side by ffmpeg), record or upload the reference, POST both. Left as a contract because the recording UX
(permission handling, retry after `speaker_mismatch`, showing `attemptsLeft`) deserves its own design pass.

## Safeguards: what each one does and does not do

| Safeguard | Implementation | Limits (be honest about these) |
|---|---|---|
| Live consent phrase | random 4 code words, single use, 5 min TTL, max 3 attempts, ASR WER <= 0.2 **and** code words in order | Does not stop a live voice changer, a real-time TTS clone of the victim, or a coerced speaker. |
| Speaker match | ECAPA cosine(consent clip, reference) >= `VOICE_CLONE_SIMILARITY_THRESHOLD` (default 0.40) | Calibrated only on 8 LibriVox readers (same-speaker real-vs-real avg 0.72, p05 0.43; different-speaker p95 0.38). Consent-vs-reference across sessions will score lower: **expect real false rejects; tune on consented audio.** 5% of same-sex impostor pairs already exceed 0.38. |
| Reference gate | >= 8 s, <= 120 s, speech ratio >= 0.5, SNR >= 18 dB, clipping <= 2%, music prob <= 0.3 (AST AudioSet), min 3 s-window similarity >= 0.60 (single-speaker heuristic) | Defaults were set from one dev run (8 LibriVox refs, one noisy, one two-speaker concat, one piano clip): thin evidence. The SNR estimator over-reads noise by ~5 dB; an 8 kHz mu-law phone-band reference passed every gate (no bandwidth check), though REPORT.md shows phone refs clone worse. |
| Rate limits | 3 creations / 24 h (paid), 10 (comped); deleted voices still count; burst limiter 20/h/user; one creation in flight per user | In-process guard: multiple backend instances can race past the daily count by one or two. A DB-level constraint would close it. |
| Eligibility | verified email + active billing row (paid or comped), OR an active unexpired RevenueCat entitlement (`revenuecat_entitlements`, fed by `POST /api/webhooks/revenuecat`, migration 034; Android/iOS subscribers). The legacy `subscriptions` table is NOT trusted: `/api/subscription/sync` is client-asserted. | "Payment" means an active billing row; the $2.50/voice charge (`chargeForVoiceClone`) is **not** wired into this flow. |
| Watermark | Perth applied by Chatterbox inside `generate()`; re-applied after any speed change; detection score returned and stored | Survives MP3/8 kHz/noise in the S5 test but had a false-positive on real speech (mean 0.167) and speed change was untested. Defeats casual re-encoding only. |
| Output hashes | sha256 + bytes + chars + watermark metadata per output, 90 days | Hashes are of the delivered WAV; a re-encode defeats lookup. Sweep not scheduled. |
| Deletion | status `deleting` (unusable) -> Modal volume dir removed -> `deleted`; consent evidence retained until deletion + 12 months, then `purge-expired` removes clip + row | Tension between evidence retention and biometric-data minimisation: counsel decision. Generated audio already delivered is not recalled. |
| Takedown | admin `disable`: status `disabled`, Modal `DISABLED` marker, generated outputs + cache entries purged; reference, consent and hashes preserved as evidence | Manual: needs someone watching `abuse@readaloudai.org` (mailbox must exist) and the report table. |
| Training | none; customer audio never used for training | Policy statement; nothing technical enforces it beyond not building such a pipeline. |

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VOICE_CLONE_SERVICE_URL`, `VOICE_CLONE_SERVICE_SECRET` | unset (dark) | Modal app base URL and bearer secret |
| `STT_API_KEY`, `STT_GATEWAY_URL` | existing | ASR for the consent phrase (existing gateway path) |
| `VOICE_CLONE_SIMILARITY_THRESHOLD` | 0.40 | speaker-match threshold |
| `VOICE_CLONE_BORDERLINE_MARGIN` | 0.10 | accepted-but-flagged band above the threshold |
| `VOICE_CLONE_MAX_PHRASE_WER` | 0.20 | ASR tolerance |
| `VOICE_CLONE_DAILY_LIMIT` / `VOICE_CLONE_TRIAL_DAILY_LIMIT` | 3 / 10 | per 24 h, paid / comped |
| `VOICE_CLONE_MIN_REFERENCE_SEC`, `_MAX_REFERENCE_SEC`, `_MIN_SNR_DB`, `_MIN_SPEECH_RATIO`, `_MAX_CLIPPING_RATIO`, `_MIN_WINDOW_SIMILARITY`, `_MAX_MUSIC_PROB` | see `lib/voiceCloning/policy.ts` | reference gate |
| `VOICE_CLONE_OUTPUT_HASH_RETENTION_DAYS`, `VOICE_CLONE_CONSENT_RETENTION_MONTHS` | 90 / 12 | retention |

Modal app (separate from backend env): `RA_CLONE_APP_NAME`, `RA_CLONE_VOLUME`, `RA_CLONE_SECRET_NAME`,
`RA_CLONE_SCALEDOWN_SEC`, `RA_CLONE_CHATTERBOX_REF`. The secret `readaloud-chatterbox-clone-secret` must contain
`CLONE_SERVICE_SECRET`.

## Rollout checklist (nothing below has been done)

1. Counsel review of Terms section 4 draft (`docs/legal-drafts/`), privacy copy, retention windows, BIPA/CUBI wording.
2. Create/monitor `abuse@readaloudai.org`.
3. Review and apply `backend/supabase/migrations/033_voice_clone_consent.sql` (RLS-on, service-role only; the legacy
   `tts_jobs.cloned_voice_id` foreign key is dropped).
4. Deploy `chatterbox_clone.py` with prod names, then set the three backend env vars (owner action: `flyctl secrets set`).
5. Record consented audio (owner + 2-3 accent-diverse volunteers, `RECORDING_SCRIPT.md`) and re-tune
   `VOICE_CLONE_SIMILARITY_THRESHOLD` and the reference-gate thresholds; sample `borderline` consents.
6. Schedule `purge-expired` (daily) and decide where it runs.
7. Update iOS/Android clients (see below) before expecting existing users to clone again.

## Known breakage and follow-ups

* iOS and Android cloning screens call `/api/cloned-voices` + `/api/tts/cloned` with a `voice_url`. Creation now fails
  (410) and old voices cannot synthesise. This is intentional (REPORT.md: put behind a consent gate or switch off) but the
  clients still reference an `xtts` model option; both need an app release.
* Legacy `cloned_voices` rows and their Supabase Storage audio are untouched (no data deleted); they are inert.
  `/api/cloned-voices` still lists/updates/deletes by `X-Device-ID` (unauthenticated by design of the old app).
* The Postgres `cloning_model` enum keeps the `xtts` value and `xtts_cloned_voices` keeps its rows.
* `tts-service/` (legacy Cloud Run/Hetzner image) had XTTS removed from code, Dockerfiles, requirements and load test;
  it was not built or run here.
