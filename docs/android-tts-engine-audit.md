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

**Unit tests:** 176 pass, including new suites for text normalization, word timing, language codes, the voice table,
the paywall and resume rules.

**On a Pixel 9 Pro (Android 17), reader debug build, through the public `TextToSpeech` API** (the path TalkBack uses),
using the debug-only `EngineSelfTestActivity`: 91 of 91 cases pass.

- every one of the 57 eSpeak voices, by exact name: first audio median 15 ms (9 to 28 ms)
- 22 languages with their default voice: each accepted and spoken by the right voice
- Russian correctly reported as unsupported
- single letters and symbols, a spelled-out span, a phone-number span, SSML, rates up to the eSpeak maximum
- word positions (`rangeStart`) arrive for every multi-word case
- never-silent fallback: with no neural model on disk the engine spoke with eSpeak, while the model downloaded in the background
- selecting an eSpeak voice in Settings makes it the system default (default English requests then speak in 3 to 14 ms)
- `GET_SAMPLE_TEXT` returns Spanish text for a Spanish request; `CHECK_TTS_DATA` passes and lists 57 locales

**Bugs the device tests found in my own first version (all fixed):**
1. a hard-coded language-code table supported only 12 languages and reported the rest as unsupported (it also mapped
   Saudi Arabia to the UAE), so most of the new voices were unreachable
2. two eSpeak voice names were wrong (`en-gb`, `fr-fr`; eSpeak wants `en`, `fr`), so French hung for 40 s
3. the first test's pass check accepted audio from the wrong voice; it now requires the right voice and language
4. the sample-text activity converted language codes incorrectly

**Not verified:**
- the `voice` flavor (the standalone engine app) on a device; it compiles and shares this code. Testing it would
  mean replacing the `com.listenai.voice` already on the phone.
- TalkBack itself, with a real screen-reader user. This needs a person: please ask a blind tester (for example the
  closed-testing user who reported the original latency problem) to try the Fast voices.
- audio quality by ear: the tests check that audio is non-silent and the right length, not that it sounds right.
- natural (neural) voice latency is unchanged: about 1.7 s for short text and 3 s to first audio for long text.
