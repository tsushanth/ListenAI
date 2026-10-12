# ReadAloud system TTS engine: blind-user audit (2026-10-12)

The system TTS engine (`ReadAloudTTSService`, shipped as the `voice` flavor and inside the reader app) is what
TalkBack, Maps, Kindle and other apps speak through when the user selects "ReadAloud AI Voices". This audit
checks it against what blind and low-vision users need and against the engines they compare it with.

## How it works now

Request routing in `onSynthesizeText`, fastest first:

1. per-voice cache of past results, then a bundled cache of common TalkBack labels (under 1 ms)
2. Piper, for short text in the default voice (about 200 ms)
3. Kokoro on device, streamed chunk by chunk (about 7 s to first audio for long text, 1.5 to 3 s for short text)
4. **new:** eSpeak NG voices (a few ms), and eSpeak as a fallback when the neural model is missing

## Blind spots found (and status)

| # | Blind spot | Why it matters to a blind user | Status |
|---|---|---|---|
| 1 | Silence when the Kokoro model was not on disk: the engine returned an error | A user who picks the engine and presses a button hears nothing until an 80 MB download finishes | **Fixed:** falls back to eSpeak, so there is always speech |
| 2 | English only: non-English requests were not supported | A blind user whose phone is not in English cannot use the engine at all | **Fixed for 57 languages** with eSpeak; neural voices for other languages are still missing |
| 3 | No fast voice. Arbitrary short text took 1.5 to 3 s (Kokoro) | Experienced users run screen readers fast and expect immediate speech | **Fixed:** eSpeak voices, a few ms to first audio |
| 4 | Speech rate: caches serve only 1.0x; neural voices cap far below screen-reader speeds | Power users use 2x to 4x | **Partly fixed:** eSpeak reaches 450 wpm (about 2.6x); beyond that is not supported |
| 5 | `TtsSpan` markup thrown away (`toString()`): digits, spelled text and phone numbers read as words | TalkBack marks text to be read character by character | **Fixed** (`TextNormalizer`) |
| 6 | Single characters and symbols ("a", ".", "#") not read by name | Typing echo and read-by-character depend on it | **Fixed for English**; other languages use eSpeak's own character names |
| 7 | SSML read aloud as tags | Apps that send `<speak>` markup | **Fixed** (tags stripped) |
| 8 | No word positions (`rangeStart`) | Reader apps cannot highlight along | **Fixed** (estimated timing on all PCM paths) |
| 9 | Missing standard engine activities (`GET_SAMPLE_TEXT`, `CHECK_TTS_DATA`) | Settings cannot speak a proper example or list voices | **Fixed** |
| 10 | Settings screen offered no way to choose a fast or non-English voice | | **Fixed** (Fast voices section, TalkBack-friendly rows) |
| 11 | Neural-voice latency for arbitrary text (Piper only for the default voice) | Still the main gap against Google TTS | **Open** |
| 12 | No pronunciation dictionary / user rules | Users want to fix mispronounced names and abbreviations | **Open** |
| 13 | Russian (8 MB dictionary) and about 60 more eSpeak languages not bundled | | **Open:** language pack download |
| 14 | arm64-v8a only | 32-bit-only phones cannot run the native eSpeak library | **Open** (check the install base) |
| 15 | Debug activities (benchmarks) are exported in the production manifest | Needless attack surface | **Open** (move to a debug source set; the new self-test already lives there) |
| 16 | **Licensing:** eSpeak NG is GPL-3.0-or-later and is bundled | Distributing it inside a closed-source app needs a licence review | **Open, needs a decision** (the library was already shipped as a phonemizer before this change) |

## Parity with other engines (qualitative)

Compared on what blind users ask for. Strengths and gaps are from our code and public descriptions of the other
engines, not from head-to-head listening tests.

- **Google TTS**: widest language coverage and the default; natural voices; low latency. Gap: we have fewer
  languages with natural voices.
- **eSpeak NG app / RHVoice / Acapela / Vocalizer / Eloquence**: the engines experienced screen-reader users pick for
  speed and language coverage. With the new eSpeak voices we are at parity on speed and rate for the languages bundled.
  Gap: no pronunciation dictionary, fewer languages than full eSpeak, no commercial-grade fast voices.
- **What only we offer**: natural neural voices (Kokoro, Piper) running fully on the device as the system voice, next to the fast eSpeak voices. Cloned voices are *not* available system-wide (deliberately: they are cloud-only and consent was given for use inside the app), so `SYSTEM_TTS_ENGINE_ROADMAP.md` Milestone 2.5 is out of date.

## Verification

See the device results section below.
