# Dubbing TTS backends and what to rebuild

Dubbing (`backend/src/routes/dub.ts`) is a **Spanish-only pilot**: targets **en** and **es** are offered. fr, hi, it, pt-BR, ja
and zh return `400 ... not offered yet` (flip `offered` in `backend/src/lib/dubLanguages.ts` to re-enable; the French Piper
code path is fully wired).

## Voices (owner provenance rule, 2026-10-06)
| Target | Engine | Voices (default first) | Provenance |
|---|---|---|---|
| es | Piper | `es-pilot-m`, `es-pilot-f` | tier A: CML-TTS (CC BY 4.0), base LibriTTS-R (CC BY 4.0). PILOT model (15.4k steps), quality unverified by ear |
| fr (not offered) | Piper | `fr-fr-mls-m`, `fr-fr-mls-f` | tier A: Multilingual LibriSpeech (CC BY 4.0) |
| en | Kokoro | `am_adam`, `af_*`, ... | unchanged |

CC BY 4.0 requires attribution wherever output is published; the strings are in each voice's `owner.json` on the Modal volume
`house-voices` and in realtime-tts `voices/catalog.json`. Kokoro non-English is **off** in every service (see below). Speed for
the measured-duration refit is Piper `length_scale / speed`, clamped to 0.8-1.5.

## `DUB_TTS_BACKEND` (backend env; default `modal-cpu`)
| Value | Where es audio is made | Redeploy needed | Extra config |
|---|---|---|---|
| `modal-cpu` (default, cheapest) | **`tts-service-modal/dub_piper.py`**: dedicated CPU-only Modal app `readaloud-dub-piper` (4 CPU, 2 GiB, no GPU, scale-to-zero, 60 s idle), `house-voices` volume mounted read-only, allowlisted voices only | **new Modal app** (`modal deploy dub_piper.py`, owner-run) + the **backend** | `DUB_PIPER_MODAL_URL` (the web URL of that app) and `DUB_PIPER_MODAL_SECRET` (Bearer shared secret). The matching Modal secret must be created by the owner: `modal secret create dub-piper DUB_PIPER_SECRET=<value>` (name overridable with `DUB_PIPER_SECRET_NAME`). **No gateway key and no Fly Piper-worker voices are needed.** |
| `gpu` | `tts-service-modal/app.py` `web` (Modal app `readaloud-tts`, the `GPU_TTS_URL` route): Piper runs inside the T4 container | **`readaloud-tts` Modal app** + backend | none |
| `cpu` | realtime-tts Piper CPU worker (Fly `piper-tts-sjc`) via the gateway `/tts/authorize {engine:"piper"}` | backend only | `DUB_PIPER_API_KEY` (else `STT_API_KEY`); the house voices must exist in that worker's voice storage (unverified) |

English dubbing always goes through the normal provider route (Kokoro) whatever the setting. With `modal-cpu` and no
URL/secret configured, Spanish jobs fail up front with an error naming the two env vars.

Auth of `dub_piper.py`: `Authorization: Bearer <secret>`, `hmac.compare_digest`, fail-closed if the secret is not configured,
same pattern as `backend/modal/convert_job.py`. Contract = `readaloud-tts` `POST /synthesize` (`{text, voice_id, language?, speed?}`
-> 24 kHz mono PCM16 WAV); `GET /health` is unauthenticated and returns only `{"status":"ok"}`.

## Kokoro non-English gate (voice-provenance rule)
`tts-service`, `tts-service-modal` and `tts-service-cpu-test` refuse Kokoro es/fr/hi/it/pt/ja/zh synthesis unless
`KOKORO_NON_ENGLISH_ENABLED=1` (default off): HTTP 403 (`tts-service`, `tts-service-modal`) / 501 (`tts-service-cpu-test`) with a message
naming the flag. English (a/b voices) is unchanged. Who may break: see the risk list in the PR notes (Audexa radio via the CPU worker).

## Other services touched (rebuild if you want the change live)
- `tts-service/` (Fly `readaloud-tts`) and `tts-service-modal/app.py`: one Kokoro pipeline per lang_code, Piper (modal app only), Kokoro non-English gate.
- `tts-service-cpu-test/` (Fly `listenai-tts-worker`, Kokoro ONNX): **Edge TTS off by default** (`ALLOW_UNLICENSED_EDGE_TTS=1`,
  local development only: unofficial Microsoft endpoint, no commercial licence) and the Kokoro non-English gate. A non-English request that
  used to fall back to Edge now gets HTTP 501.
