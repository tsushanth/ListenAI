# Licensing of the Android apps

This directory builds two apps from one source tree:

| App | Flavor | Application id | Contains eSpeak NG | Licence |
|-----|--------|----------------|--------------------|---------|
| ReadAloud | `reader` | `com.listenai` | No | Proprietary, all rights reserved |
| ReadAloud Voice | `voice` | `com.listenai.voice` | Yes | GNU GPL v3 or later (this file) |

## Why the split

eSpeak NG (https://github.com/espeak-ng/espeak-ng) is licensed under the GNU General Public License,
version 3 or later. Shipping it inside an app makes that app a combined work that must be offered under the
same licence. To keep the reader proprietary, everything that touches eSpeak lives only in the `voice` flavor:

- `app/src/voice/` : the system TTS engine (`com.listenai.systemtts`), the JNI bridge (`cpp/`), the prebuilt
  `libespeak-ng.so` (`jniLibs/`) and eSpeak's language data (`assets/espeak-ng-data/`)
- `app/src/voiceDebug/`, `app/src/testVoice/` : debug-only and unit-test code for the above

The reader flavor ships none of it. It reads non-English articles through Android's public TextToSpeech
API, using whatever speech engine the phone has (which may be ReadAloud Voice).

## ReadAloud Voice (GPL-3.0-or-later)

ReadAloud Voice is free software: you can redistribute it and modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3 of the License, or (at your
option) any later version. It is distributed WITHOUT ANY WARRANTY. The licence text is in `COPYING` in this
directory. The complete corresponding source for a given release is the tag or commit it was built from.

`libespeak-ng.so` is eSpeak NG 1.52.0.1. Corresponding source: https://github.com/espeak-ng/espeak-ng
(release 1.52.0.1). Rebuild notes for the prebuilt library: see `docs/android-tts-engine-audit.md`.

## Scope of the grant

The copyright holders of this repository's Android code license the source tree under `android/` (the
complete source of the ReadAloud Voice build, including the code the two flavors share) under the GNU
General Public License, version 3 or later. The text is in `COPYING`. Third-party libraries keep their own
licences. The copyright holders also keep the right to distribute the `reader` flavor under other terms; the
GPL applies to ReadAloud Voice and to anyone who copies or modifies this source.

## Corresponding source for `libespeak-ng.so`

The prebuilt library is the unmodified eSpeak NG 1.52.0.1 release (https://github.com/espeak-ng/espeak-ng,
tag 1.52.0.1), built for arm64-v8a. We do not have the original build recipe on record (it came from an
earlier integration build dated 2026-02-17). To make the correspondence verifiable, rebuild the library from
that upstream tag with the Android NDK and replace `app/src/voice/jniLibs/arm64-v8a/libespeak-ng.so`.

## Still to do

- Rebuild `libespeak-ng.so` from the upstream tag and record the NDK version and flags here.
- Publish ReadAloud Voice on Google Play with a link to this repository and to this file in the store listing.
