# Where the Android app gets speech (2026-11-04)

## Before

| Path | What happened |
|---|---|
| Reader, built-in voice | `TTSServiceFactory`: the ReadAloud API (Piper) through `RealtimeTTSService` (whole text, one WebSocket, buffered into one WAV before playback), unless the user had turned on offline Kokoro and the model was on disk. No fallback when the API failed: an error screen. |
| Reader, non-English | `PlatformLanguageSynth` through the **default** system engine, which can be ReadAloud's own engine. |
| ReadAloud system engine (`com.listenai.voice`), for other apps | On-device only: label caches, Piper (<= 80 chars), Kokoro, eSpeak. Never the API. |

## Now

One chain, `com.listenai.service.tts.chain.TtsSourceChain`, with three sources:

1. **API**: the ReadAloud API (Piper on CPU, Fly `piper-tts-sjc`). Sentence chunks, two chunks prefetched, one WebSocket reused for many chunks, 4.5 s first-chunk deadline, one retry on timeout / 5xx, no retry on 429 / 402.
2. **System TTS**: Android `TextToSpeech` bound to an explicit engine (Google, then Samsung, never `com.listenai*`), after `isLanguageAvailable`, an installed-voice check, and (offline) a "voice needs the network" check.
3. **On-device model**: only if downloaded and its measured real-time factor is <= 0.7 (measured once, stored per app version).

Order: online and the flag on: API, system, on-device (English only). Flag off: on-device, system. Audio chunks from the API are cached on disk (hash of voice + speed + text, 150 MB, least recently used removed), so re-reading is free and works offline.
When nothing can speak, the player shows an actionable message with an **Install voice data** (or **Install a speech engine**) button.

The ReadAloud system engine can try the API first for English text of 100+ characters from other apps, but **this is OFF by default** (see "Privacy: engine API route" below). With it off, the engine uses its own on-device path only, as before. If the route is enabled and the API cannot start, the engine continues on its own on-device path; if the API fails after audio has started, the engine reports an error (the voice cannot change mid-sentence). The in-app reader's API-first behaviour is unaffected.

### Fallback matrix (reader)

| Situation | Result | Reason logged |
|---|---|---|
| Online, API ok | API | none |
| Chunk already cached | cache, no network | none |
| Offline | cache, else system TTS | `OFFLINE` |
| API 5xx / at capacity / socket closed | one retry, then system for the rest of the read; API skipped for 30 s | `SERVER_ERROR` |
| API timeout (first chunk 4.5 s, later chunks 6 s + 25 ms/char) | one retry, then system; skipped 30 s | `TIMEOUT` |
| 429 | no retry, system; API skipped for `Retry-After` (default 60 s) | `RATE_LIMITED` |
| 402 | system; API skipped 10 min | `QUOTA` |
| Non-English text | system (API voices in the app are English) | `UNSUPPORTED_LANGUAGE` |
| Google/Samsung missing | on-device model if fast enough | `ENGINE_MISSING` |
| Engine has no voice data for the language, or the voice needs the network and we are offline | on-device model (English) else message + **Install voice data** | `LANGUAGE_MISSING` |
| Nothing works | message; install-engine / install-voice-data / check connection / try later | all of the above |

### Switch

`TtsSourceFlags`: local override (debug only) > remote `tts.apiEnabled` / `tts.engineApiEnabled` from `GET /api/config` (refreshed every 6 h, applies from the next read) > build default `BuildConfig.TTS_API_DEFAULT` (true; `-PttsApiDefault=false` builds an on-device-first variant) / `TTS_ENGINE_API_DEFAULT` (**false**; `-PttsEngineApiDefault=true` is for local benchmarks only).

### Events (no text)

`tts_session` (first_source, ttfa_ms, total_ms, audio_ms, chunks, cache_hits, chars, content_language, succeeded) and `tts_fallback` (from_source, reason). Sent only when the user allowed analytics; every read also logs one `TTS_CHAIN` line to logcat.

Language and voice events (added 2026-11-13). All sent only when the user allowed analytics; parameters are built in `LanguageAnalytics` and are limited to ISO language codes, a fixed set of reasons and true/false flags, never text, titles, document ids or voice names:

| Event | Parameters | When |
|---|---|---|
| `content_imported` | import_mode, content_language | an import finished (unchanged) |
| `voice_request` | content_language | the user tapped "Want a natural X voice?" (unchanged) |
| `voice_fallback` | content_language, reason (`no_voice`, `no_engine`, `offline`, `engine_error`) | a read ended with no usable voice (was declared but never sent before) |
| `lang_no_voice` | content_language, voice_exists (`true` = the engine lists a voice that is not downloaded, or is network-only while offline; `false` = it lists none), device_language | an import finished in a language other than English and the phone cannot speak it now |
| `lang_override` | from_language, to_language (`auto` = back to detection) | the user picked the reading language of a document |

Play Data safety: no change. These are app-interaction events through the Firebase Analytics SDK that is already declared, with no new data type, no identifier and no content.

## Languages other than English (added 2026-11-13)

- The reading language of a document is detected on the phone (ML Kit). The reader shows a language chip: **Auto (detected language)** or the user's choice, with the languages the phone can speak. The choice is stored per document on the device (`LanguagePrefs`) and beats re-detection when playback starts; changing it drops the audio already made.
- Non-English text is read by the phone's engine (the API voices are English). `VoiceSelection` ranks the engine's voices: one that works now, on-device over network-only, higher engine quality rating, the phone's region, then name. The reader lists the working voices for the language; the pick is stored per language and ignored if that voice later stops working.
- No voice for the language: the error and the button are translated, the button opens the engine's voice-data installer, else the text-to-speech settings, else Settings, and the reader or Read Text re-checks when the user comes back. An import in a language the phone cannot speak shows a one-line notice.
- Read Text (gallery photo): the recognised text goes through the same language detection and is spoken with that language's locale. Text recognition there is the Latin-script model, so Cyrillic, Arabic, CJK and similar scripts are not recognised yet.


## Privacy: engine API route (added 2026-11-04)

The engine is a system service that **other apps** call. Their text can be a private message, an email, a form field, or whatever TalkBack or another screen reader is reading aloud. Sending it to our API, anonymously and without the user being told, is a privacy risk, so:

- `TTS_ENGINE_API_DEFAULT` is **false** and a missing or malformed remote `tts.engineApiEnabled` also resolves to false. Only an explicit local override or an explicit remote `true` turns it on.
- Even with the flag on, `EngineCallerPolicy` refuses to route when the caller (`SynthesisRequest.getCallerUid()` resolved to its packages) is a known screen reader (TalkBack, Samsung TalkBack, Select to Speak, Switch Access and others), has an accessibility-looking package name, shares a uid with any currently enabled accessibility service, or **cannot be identified** (fail closed; Android package visibility can hide the caller's package). Refused requests use the engine's on-device path.
- The in-app reader is unchanged: it reads the user's own documents through the user's own action, API first.

What leaves the phone when the engine route is enabled: the full text of each request (English, 100+ characters, split into sentence chunks) plus the chosen voice and speed, sent over TLS to `listenai-backend` (`/api/realtime-tts/authorize`) and the Piper worker. No account or device id is attached, but the connection exposes the IP address. The audio chunks are cached on the phone (hash of voice + speed + text). The `tts_session` events carry no text. The server-side retention of request text was not audited here; it must be before this is enabled.

Preconditions before turning it on for users:
1. An explicit in-app opt-in (off until the user chooses it) with a clear disclosure that text read aloud by other apps is sent to ReadAloud servers.
2. A line in the privacy policy and the Play data-safety form covering this transfer and its retention.
3. A caller allow-list (only named reading apps such as e-book readers), replacing today's deny-list, so that unknown callers stay on-device.
4. The remote flag must not be able to enable it for users who have not opted in (today a remote `true` would; keep the remote value as a kill switch only).
5. Server-side confirmation that request text is not logged or retained.

## Measurements

Galaxy S22 (SM-S901U), Wi-Fi, Android debug build `com.listenai.voice.debug` (side by side; the production app and the default engine setting were not touched). Three paragraphs of about 218 characters (about 12-13 s of audio), each cut into 2 chunks. TTFA = start of the read to the first audio; RTF = time to synthesize everything / audio duration (below 1 is faster than playback). "first" = first pass (cold socket / engine init), "warm" = second pass. One run each; no confidence intervals. Source: `TtsSourceBenchActivity`.

| Source | TTFA first (ms) | TTFA warm (ms) | RTF |
|---|---|---|---|
| ReadAloud API (Piper CPU), chain | 1248 / 630 / 463 | 347 / 717 / 515 | 0.044 - 0.117 |
| Google TTS (explicit engine) | 2083 / 437 / 357 | 148 / 171 / 132 | 0.013 - 0.189 |
| Samsung TTS (explicit engine) | 297 / 153 / 163 | 176 / 167 / 139 | 0.012 - 0.024 |
| On-device Kokoro, chain (140-char first chunk) | 7286 / 8549 / 7827 | 6285 / 9941 / 9260 | 0.83 - 1.01 |
| ReadAloud engine called as another app, API on (flag forced on for the benchmark) | 994 / 609 / 704 | n/a | n/a |
| Same, replayed from the chunk cache | 3 / 5 / 6 | | |
| ReadAloud engine called as another app, API off (its own path: Kokoro) | 3351 / 3410 / 2448 | 4118 (para 2), 2701 (para 3) | 0.79 - 1.02 |
| Offline, text already cached | 2 - 10 | | |
| Offline, text not cached | first chunk cached (15), then system | | `API:OFFLINE` logged |

Notes and caveats
- On this phone **Google and Samsung system TTS beat the API on latency** (about 150 ms vs 350-700 ms warm) and work offline. The API is the default for voice quality and consistency (one Piper voice everywhere), not speed. If speed or offline use is the goal, the system engine should come first; that is one line in `TtsFlagLogic.inAppOrder`.
- The on-device Kokoro model runs at about 0.8-1.0x real time with 6-10 s to first audio here: too slow to be a default. The verdict threshold is 0.7, so on this phone the model would be skipped after two measured chunks.
- One engine-on run had a 10.9 s first request right after the app process started (engine start plus Kokoro warm-up competing); a second run did not reproduce it (994 ms). The bench's own engine timings are unreliable for the engine-on case (file synthesis), so the engine rows above come from the service's `T_API_FIRST_AUDIO` and `T_FIRST_AUDIO_PUSH` log lines.
- Cold: `piper-tts-sjc` keeps one machine always running, so a machine cold start was not measured (stopped machines were not woken). A cold **voice** was measured from a laptop: first request for `custom:en-us-kristin` 2652 ms to first audio, the next 382 ms. The app's voice mapping uses voices that are not in the worker's `PRELOAD_VOICES`, so the first read per voice per machine pays 2-3 s.
- Authorize through the app backend: 320-390 ms from a laptop; the socket reuse means only the first chunk of a read pays it.

## What the API costs us and how it is metered

- `piper-tts-sjc`: Fly `performance-2x`, 4 GB, about $64 per month per machine while started; 4 machines exist, 1 always on, the others start under load. About 6-8 concurrent streams per machine at the measured latency (worker's `CAPACITY_PLAN.md`). At a measured RTF of about 0.075 per stream a saturated machine could synthesize on the order of 80 s of audio per second, so the marginal cost per character is far below the $0.004 per 1,000 characters list price; the real cost is the always-on machine (about $64 per month) and, past its capacity, extra machines.
- The app's path (`POST /api/realtime-tts/authorize` on `listenai-backend`) is anonymous, billed to one shared platform key, bounded only by an IP rate limit. There is **no per-user quota or plan check on this path**; the plan quotas and `402` apply to developer API keys. So `QUOTA` handling is in place but nothing returns 402 to the app today, and an abusive client can only be limited by IP.

## Backend changes this needs (not deployed)

1. `GET /api/config`: add `tts: { apiEnabled, engineApiEnabled }` (from env) so the switch can be flipped without a release.
2. Preload the app's mapped voices (`custom:en-us-kristin`, `-john`, `-libritts_r-f383`, ...) in `PRELOAD_VOICES` or map the app voices onto already-preloaded ones; otherwise the first read per voice pays 2-3 s.
3. Real per-user auth or a session-bound quota on `/api/realtime-tts/authorize` (today anyone can mint sessions on the shared key).
4. Decide whether the alignment worker (word highlighting) should stay scale-to-zero: the app now waits at most 2.5 s for it and skips it for 10 minutes after a miss.

### Update 2026-11-06: backend config flags and authorize quota (PR feat/backend-tts-config-quota, not deployed)

Items 1 and 3 above are implemented in `backend/` (nothing is live until deployed with the env below).

- `GET /api/config` now returns `tts: { apiEnabled, engineApiEnabled }` next to `paywallMode` / `paywall`. `apiEnabled` = env `TTS_API_ENABLED` (default true; false/0/no/off turn it off; garbled keeps true). `engineApiEnabled` is a kill switch only: false unless `TTS_ENGINE_API_ENABLED` is exactly `true`. Leave it unset until the in-app opt-in exists; the client requires that opt-in too.
- `POST /api/realtime-tts/authorize` accepts an optional `X-Install-Id` header (random UUID generated by the app, not authenticated). Without a valid one the request still works under a stricter anonymous bucket keyed by IP. Per bucket: daily budget (402) and per-minute count (429 + `Retry-After`); globally: a daily circuit breaker (503 + `Retry-After`, capped at 1 h). The backend never sees the text (the app talks to the Piper worker over the WebSocket), so each authorize is charged a character ESTIMATE (`TTS_AUTHORIZE_CHARS_ESTIMATE`, default 4000). This bounds sessions, not characters inside a session. Counters are in memory per instance (reset on deploy and at 00:00 UTC). See `backend/src/lib/ttsQuota.ts`.
- The Android app does not send `X-Install-Id` yet; until it does every app request is anonymous (per-IP).
