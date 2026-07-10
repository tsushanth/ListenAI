# ReadAloud System TTS Engine — Roadmap

Goal: register ReadAloud as a system-level Android TTS engine so its voices are
available to **every** app on the device — TalkBack, Google Maps, Kindle, Chrome's
read-page, third-party readers. Voice packs become a recurring revenue line on top
of the existing subscription product.

Origin: Warren Carr's June 13 podcast interview surfaced this as a request from the
blind Android user community. Existing references they cite: Acapela TTS, Vocalizer
(Nuance), eSpeak NG, Eloquence, CereProc.

---

## Architectural shape

```
Other apps (TalkBack, Maps, Kindle, etc.)
            │
            ▼  android.speech.tts.TextToSpeech API
[Android system TTS framework]
            │
            ▼  BIND_TEXT_TO_SPEECH_SERVICE
com.listenai.systemtts.ReadAloudTTSService  ← (this commit)
            │
            ▼  TTSService interface (existing)
   ┌──────────────┴──────────────┐
   ▼                             ▼
OnDeviceTTSService          SelfHostedTTSService  /  CloudTTSService
(Android system fallback)   (Kokoro on Hetzner)     (ElevenLabs)
```

Critical constraint: **TalkBack hits the engine constantly** — every button, every
notification, every screen reader gesture. Latency budget is **<100 ms per phrase**.
Cloud TTS at ~300-500 ms is unusable as the system engine. Only the on-device
Kokoro path will meet the latency requirement. Until on-device Kokoro is production
quality, the engine will function but be **noticeably slower than Google TTS** —
listeners should be warned in the in-app onboarding.

---

## Milestones

### ✅ Milestone 1 — Discoverable (2026-06-13)
### ✅ Milestone 2 — Real audio via existing pipeline (2026-06-13)
### ✅ Milestone 2.5 — Cloned voices in system catalog (2026-06-13)
### ✅ Milestone 4 scaffolding — In-Settings voice catalog UI (2026-06-13)
### ✅ Milestone 5 scaffolding — Multi-locale negotiation in engine (2026-06-13)
### ⏳ Milestone 3 — On-device Kokoro for <100 ms latency (still required for TalkBack)
### ⏳ Milestone 4 (full) — RevenueCat voice-pack purchase flow

### ✅ Milestone 2.5 — Cloned voices in system catalog (2026-06-13)

The user's cloned voices (via the existing `VoiceCloningService` + `chatterbox`
backend) now surface as system voices alongside the built-in Kokoro presets.

What shipped:
- `VoiceCatalog.refreshClonedVoices(context)` — async cache refresh from
  `VoiceCloningService.listClonedVoices()`. Fire-and-forget.
- `VoiceCatalog.systemVoices()` includes cached clones (filtered to
  `isReady = true`) alongside built-ins.
- Cloned voice name format: `readaloud-cloned-<voiceId>-en-us`.
- `resolvePreset()` recognises the cloned namespace and builds a synthetic
  `VoicePreset` (provider=SELF_HOSTED, providerModelId=chatterbox) so
  `TTSCoordinator`'s `isClonedVoice` check fires and routes to the cloning path.
- `ReadAloudTTSService.onCreate()` kicks off the first refresh.
- Settings activity gains a "Your cloned voices" section with the latency
  caveat surfaced as section caption.

Unique to Android — no other Android TTS engine (Acapela, Vocalizer, Eloquence,
Google) lets you clone a voice and have it become the system TTS for TalkBack,
Maps, Kindle, etc. Especially powerful for the BVI community: clone a deceased
family member, your own voice, or any sample, and have it become the voice of
the entire phone.

Caveats / TODOs:
- **Cloud round-trip latency** (~1-3 s). Marked `LATENCY_VERY_HIGH`,
  `requiresNetworkConnection = true`. Acceptable for one-shot reads
  (Kindle, Maps); too slow for TalkBack until on-device cloning is built.
- **Catalog is dynamic** — system framework caches `onGetVoices()`. When
  user adds a new clone, calling apps may need a restart to see it.
  Settings UI offers a manual refresh via re-opening the screen
  (LaunchedEffect polls the cache).
- **Entitlement** — clones marked PREMIUM by default. M4 wires the
  RevenueCat entitlement check before allowing system-wide use.
- **No language tagging on clones** — currently hardcoded to en-US.
  Real implementation should record the language of the source audio
  and emit clones for that locale.

---

### ✅ Milestone 1 — Discoverable (2026-06-13)

What ships:
- `com.listenai.systemtts.ReadAloudTTSService` (`TextToSpeechService` subclass)
- `res/xml/tts_engine.xml` capability descriptor
- AndroidManifest entry with `android.intent.action.TTS_SERVICE` filter and
  `BIND_TEXT_TO_SPEECH_SERVICE` permission
- Output: **silent PCM** (16-bit, 22050 Hz, mono, ~250 ms per request)

Acceptance test:
1. Install the build on a device.
2. Open `Settings → Accessibility → Text-to-speech output`.
3. Verify "ReadAloud AI Voices" appears in the engine list with the app icon.
4. Tap to select it. Settings should not crash.
5. Tap "Listen to an example" — Settings will call our service; we return
   silence; no crash; the system message "No preview available" or a quiet
   ~250 ms pause is expected (NOT a real voice yet).
6. `adb logcat | grep ReadAloudTTSService` shows lifecycle logs.

**This unblocks every later milestone.** The hard part isn't the code — it's
the binder protocol and locale negotiation, which Milestone 1 proves works.

### ✅ Milestone 2 — Real synthesis via existing pipeline (2026-06-13)

Replace silence in `onSynthesizeText` with real audio from
`com.listenai.service.tts.TTSCoordinator`. Start with the cloud path
(ElevenLabs or self-hosted Kokoro). Output is real but latency will be poor
in TalkBack — fine for `Settings → Listen to an example`, fine for one-shot
read-aloud use cases, unusable for screen-reader use.

Tasks:
- Stand up a coroutine scope inside the service for synthesis
- Plug `TTSCoordinator.synthesize(...)` into `onSynthesizeText`
- Resample provider output to 22050 Hz if needed (Kokoro is 24000 Hz)
- Stream PCM chunks back via `callback.audioAvailable()` as they arrive,
  not after the whole response is generated (keeps perceived latency down)
- Handle `onStop()` cleanly — cancel the coroutine, break out of the chunk loop

Test path:
- Select ReadAloud TTS in Settings
- "Listen to an example" should speak a real phrase in a ReadAloud voice
- Open Google Play Books → choose a book → tap "Read aloud" → verify it
  uses ReadAloud's voice
- Selecting in TalkBack works but is noticeably laggy (expected; see Milestone 3)

**What shipped 2026-06-13:**
- `VoiceCatalog` maps the built-in `VoicePreset`s (Rachel, Adam, Bella, Josh,
  Brian, Charlotte, Elli, Bill, Matilda, Dorothy) to system `Voice` descriptors
- `ReadAloudTTSService.onSynthesizeText` calls `TTSCoordinator.synthesize(...)`
  with `outputFormat = WAV`, then streams PCM via `callback.audioAvailable()`
- Robust WAV chunk-walker (handles fmt + data + non-standard chunks)
- Speech rate / pitch from the Android API are forwarded into `SynthesisOptions`
- TTSCoordinator is injected via Koin (`org.koin.android.ext.android.inject`)
  — relies on `ListenAIApplication` having already configured Koin

**Known limitations to address in M3:**
- Latency is bounded by full-synthesis-before-stream (TTSCoordinator generates
  the WAV file, then we stream it). Adequate for one-shot "read aloud" cases;
  too slow for TalkBack. M3 introduces a streaming-synthesis path.
- Cloud voices fail offline. M3 makes Kokoro the on-device default and falls
  back to cloud only when the user explicitly selects a cloud voice.

### Milestone 3 — On-device Kokoro for sub-100 ms latency

The on-device Kokoro foundation shipped in 2.13.2 (commit `4f56a38`). Production-
hardening:
- Bundled model download flow (likely a 100-200 MB initial download via WorkManager)
- Streaming inference — emit PCM chunks as Kokoro generates them, not after
- Inference pinned to a real-time-friendly thread pool, not Dispatchers.Default
- Per-utterance warm-up (first call after install is allowed to be slow; later
  ones must be sub-100 ms)
- Battery profiling — TalkBack will hit the engine thousands of times per day

Acceptance:
- Single short phrase ("OK") synthesizes in <100 ms p95 on a Pixel 6-class device
- Battery impact over a 4-hour reading session within 5% of Google TTS

### ✅ Milestone 4 scaffolding — Voice catalog UI (2026-06-13)

What shipped:
- `TTSEngineSettingsActivity` (Compose, uses `ListenAITheme`) — wired in
  `res/xml/tts_engine.xml` via `android:settingsActivity` so it launches when
  the user taps the ⚙ next to "ReadAloud AI Voices" in `Settings → TTS output`
- Voice list with avatar / name / locale / gender / premium badge
- Preview button (TODO — wires to `TTSCoordinator.previewVoice(...)`)
- Premium chip (TODO — wires to `RevenueCatManager.purchase(...)`)

### Milestone 4 (remaining) — Voice-pack purchase flow

In-Settings activity (set `android:settingsActivity` in `tts_engine.xml`) showing:
- List of installed voices
- Preview button per voice (synthesizes "The quick brown fox..." sample)
- Download buttons for paid voice packs (gated through existing RevenueCat
  entitlements — voice packs become a new product family alongside the
  subscription)
- Per-voice rating, language tag, sample-rate badge

Voice pack monetization shape (drafted, not committed):
- Free voices: 1-2 ReadAloud Kokoro voices per language (parity with Google TTS)
- Paid singles: $2.99 / voice (Acapela-style pricing)
- Bundles: 10-voice pack at $19.99
- "All voices" sub: add to existing ReadAloud Premium subscription tier

### Milestone 5 — Multi-language expansion

Kokoro multi-language coverage is the constraint. Roll out:
- English (US/UK/IN) — required for launch
- Spanish — large market, reasonable demand from this community
- French / German / Italian / Portuguese — European market
- Hindi — large user base, especially for accessibility
- Japanese / Korean — Kokoro support landing
- Mandarin — last because of segmentation complexity

Each new language is its own voice-pack bundle.

---

## Hard requirements / pitfalls

1. **Offline required.** TalkBack and Android Auto won't tolerate network round-trips.
   Until Milestone 3 lands, the engine works but isn't a viable TalkBack replacement.
   Be explicit about this in in-app onboarding and in App Store / Play Store copy.
2. **Locale tuples are weird.** Android uses **ISO-3** for `lang` and `country` in
   `onIsLanguageAvailable()` (e.g., `eng`/`USA` not `en`/`US`). Keep `Locale.US.isO3Language`
   etc. as the canonical form — easy to get wrong.
3. **Voice name namespacing.** Voice names are global within an engine and must be
   stable across releases. Convention: `readaloud-<voice>-<lang>-<region>`
   (e.g., `readaloud-default-en-us`, `readaloud-eloquence-en-gb`).
4. **`callback.audioAvailable()` must respect `maxBufferSize`.** Exceeding it
   returns an error code and the synthesis aborts.
5. **No foreground-service promotion.** Unlike `PlaybackMediaService`, the TTS
   service should stay a bound background service. Promoting to foreground will
   show a notification every time TalkBack speaks — unacceptable UX.
6. **Don't rebuild Kokoro per-request.** Initialize once in `onCreate()`, reuse
   across requests. Cold-start the first request after install but cache for the
   life of the service.
7. **Don't claim "best voices in Android" until Milestone 3+.** Until then we're
   slower than Google TTS. Be honest in marketing.

---

## Test devices needed

- A real Pixel running Android 14+ (modern TalkBack, locale handling)
- A Samsung running Android 13+ (Samsung's One UI ships its own TTS engine — verify
  we install alongside without conflict)
- An older device on Android 8 (API 26 = our minSdk) to validate the bottom end

---

## What this is NOT

- Not a screen reader. We're a TTS engine; TalkBack remains the screen reader.
- Not a "voice library." We don't host other vendors' voices (no Acapela / Vocalizer
  licensing). Only ReadAloud's own synthesized voices.
- Not for iOS in this scope. iOS has no equivalent third-party TTS engine API.
  Voice cloning + in-app reading remains the iOS story.
