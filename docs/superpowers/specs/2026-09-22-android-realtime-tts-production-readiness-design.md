# Android app → realtime-tts: production-readiness design

Status: approved by user 2026-09-22, pending implementation plan.

## Context

A one-off test build (branch `android-realtime-tts-migration`, `RealtimeTTSService.kt`)
proved that the ReadAloud AI Android app's normal reading flow can synthesize audio via
the realtime-tts platform (`api.readaloudai.org`) instead of the old Chatterbox/Kokoro
backend (`listenai-backend.fly.dev`). That build is **not** production-safe: it embeds a
real API key directly in the client, maps every voice to one hardcoded Piper voice
regardless of what the user picked, and was verified with exactly one manual run. This
document scopes the work to close those gaps and make the migration real.

It also captures a second, load-bearing finding from the same discussion: realtime-tts's
Piper worker currently runs a small **fixed** pool (`min_machines_running=1`, no
autoscaling), capped at 4 concurrent syntheses total across every customer, with a
per-key fairness cap of 2 added earlier today specifically to stop one customer
exhausting the pool. If the Android app's entire userbase shares one API key (the
natural shape of a backend-proxy), that fairness cap works against the app: two
concurrent "play" taps anywhere would leave a third person with an "at capacity" error.
Closing that is a prerequisite for the app migration being real, not an optional
follow-on.

## Scope

Four pieces, two repos:

| # | Piece | Repo | Depends on |
|---|---|---|---|
| 1 | Voice storage migration (Piper → Tigris object storage) | `realtime-tts` | — |
| 2 | Autoscaling group for the Piper worker | `realtime-tts` | #1 |
| 3 | Backend-proxy for the app's API key | `ReadAloudAI` | #2 (for the quota decision) |
| 4 | Real per-voice mapping | `ReadAloudAI` | none (independent of infra work) |

**Sequencing**: infra first (#1 → #2, verified under real load), then app work (#3, #4),
then a real (non-debug, non-embedded-key) app rollout. #4 has no infra dependency and
could start in parallel with #1/#2 if useful, but nothing goes to real users until #1-#3
are all verified — a build with a hardcoded key and a 2-concurrent-request ceiling stays
a local test artifact only.

## 1. Voice storage migration

**Problem**: every Piper voice — built-in and custom/cloned alike — currently lives on
each machine's local disk, baked into the image or written there at publish time. A
freshly-scaled-up machine wouldn't have any of that available, which is what makes
horizontal scaling unsafe today.

**Design**: move all voices (built-in and custom) to Fly's Tigris object storage
(S3-compatible; already the named target in the existing capacity plan). `worker-piper-fly`
stops assuming any voice is pre-baked into the machine image; every voice loads from
Tigris on first use per machine, into a local LRU cache sized to fit comfortably in the
machine's available disk/memory, so repeat requests on a warm machine stay fast and only
a cold cache pays the fetch cost. `publish_voice.py` writes to Tigris directly instead of
per-machine, which also simplifies publishing (one write, not N machine deploys).

**Data flow change**: `GET /v1/tts/stream` or WS `/tts` request for voice X → check local
LRU cache → on miss, fetch from Tigris, populate cache, then serve → same as before on
cache hit.

**Error handling**: Tigris unavailable → fail the specific request with a clear 503
(same "at capacity, retry shortly" shape already used elsewhere), not a full worker
crash. Cache eviction under memory pressure uses standard LRU, no per-voice pinning needed
initially (revisit if a specific customer's voice is disproportionately hot).

**Testing**: verify a voice published via the new path is fetchable from a machine that
never had it locally cached; verify LRU eviction under a synthetic multi-voice load;
re-run the existing `worker-piper-fly` test suite against the Tigris-backed code path.

## 2. Autoscaling group

**Design**: Fly Machines' own autoscaling — not a platform switch, not a custom
autoscaler. Keep `min_machines_running = 1` (preserves the always-warm latency guarantee:
no request should ever pay a cold-start penalty), add a `max_machines_running` ceiling,
and let Fly add/remove machines automatically based on `[http_service.concurrency]` load
crossing a threshold. Because of Section 1, every machine is now stateless with respect
to voices, so this is safe — a new machine has the full catalog available immediately via
Tigris, no warm-up gap.

**Sizing input**: reuse the capacity numbers already measured in this project
(`shared-cpu-4x`: 2-4 concurrent calls; `performance-2x`: 8-16 concurrent @ 325-345ms) as
the per-machine budget for however many machines the group scales to. The concurrency
threshold that triggers scale-up should be set comfortably under each machine's measured
ceiling, not at it, so scale-up has time to complete before a machine actually saturates.

**Testing**: load-test the autoscaled group directly (not just a single machine, as
today's hardening pass did) — confirm machines actually spin up under sustained load
above one machine's capacity, confirm they scale back down after load drops, confirm no
request fails during a scale-up transition.

## 3. Backend-proxy

**Design**: new routes in the existing ReadAloudAI backend (`listenai-backend.fly.dev`),
e.g. `POST /api/realtime-tts/authorize`, that the app calls instead of hitting
`api.readaloudai.org` directly. The backend holds one dedicated, billing-enabled
realtime-tts API key server-side — provisioned with a real quota tied to Section 2's
autoscaling ceiling, not reused from today's ad hoc test key — forwards the authorize
call, and returns the resulting short-lived session token + WebSocket URL to the app. The
app still speaks the realtime-tts WebSocket protocol directly for the actual audio
streaming (keeps the latency path short); it just never sees the raw platform API key.
This mirrors how the app's existing Chatterbox integration already keeps real credentials
server-side.

**Rate limiting**: per-app-user limiting in this new backend route, so one buggy or
compromised app instance can't exhaust the app's whole quota — same fairness problem
`MAX_PER_KEY` solved at the platform layer, solved again at this layer since the app now
looks like a single customer to the platform.

**Error handling**: platform "at capacity" (503/1013) surfaces to the app as the existing
`TTSError.RateLimited`/similar app-level error type (`RealtimeTTSService` already has the
error-mapping shape from today's test build; extend it, don't replace it), so the
existing `PlayerScreen` error UI handles it without new UI work.

## 4. Real per-voice mapping

**Design**: two tiers, based on confirmed compatibility between the app's existing
Kokoro voice catalog and realtime-tts's Kokoro worker (both use the same standard
voice-pack naming — `af_heart`, `af_bella`, etc. — and the worker passes whatever voice
ID it's given straight through to the underlying engine):

- **Kokoro-provider voices** (the app's current default catalog): pass the app's existing
  voice ID straight through unchanged. No mapping table needed for this tier.
- **Piper-provider voices** (if/when offered as a cheaper option, or for any voice with
  no direct Kokoro equivalent): a real mapping table, app voice → closest Piper voice by
  locale/gender/accent, replacing today's single-hardcoded-voice shim
  (`DEFAULT_VOICE_ID = "custom:en-us-john"` in the test build). Any app voice with no
  reasonable match falls back to one documented default voice, not a silent wrong pick.

**Testing**: for every voice in `VoicePreset.builtInVoices`, confirm it resolves to a
real, working voice ID on the new backend (either passthrough or mapped) — this was
explicitly *not* tested in today's build, which only exercised one voice end to end.

## Not in scope for this project

- Retiring the old Chatterbox/XTTS backend and infra — a later project, gated on this
  one being live and verified, per the three-sub-project decomposition this migration
  was already broken into.
- Voice cloning's migration to `voice-api` — a separate, already-scoped, larger project
  (consent/marketplace/moderation work), unrelated to the regular-reading flow this
  covers.
- A true streaming (incremental-playback) rewrite of the app's audio pipeline — today's
  shim (accumulate full audio, then play) stays the model; real streaming is future work
  if the latency win is ever worth the playback-pipeline rework.

## Open items before implementation planning

- Actual quota/tier for the dedicated backend key (Section 3) needs a real number, which
  needs a rough estimate of the app's concurrent usage — not established in this
  conversation, currently a placeholder "big enough for the autoscaling ceiling."
- Tigris cost at the App's real voice-storage volume hasn't been estimated.
