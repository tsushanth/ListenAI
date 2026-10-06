# Dubbing TTS backends and what to rebuild

Dubbing (`backend/src/routes/dub.ts`) offers **English, Spanish and French** targets. hi, it, pt-BR, ja and zh return
`400 ... not offered yet` (flip `offered` in `backend/src/lib/dubLanguages.ts` to re-enable).

## Voices (owner provenance rule, 2026-10-06)
| Target | Engine | Voices (default first) | Provenance |
|---|---|---|---|
| es | Piper | `es-pilot-m`, `es-pilot-f` | tier A: CML-TTS (CC BY 4.0), base LibriTTS-R (CC BY 4.0). PILOT model (15.4k steps), quality unverified by ear |
| fr | Piper | `fr-fr-mls-m`, `fr-fr-mls-f` | tier A: Multilingual LibriSpeech (CC BY 4.0), MLS speaker ids 105/55 |
| en | Kokoro | `am_adam`, `af_*`, ... | unchanged |

CC BY 4.0 requires attribution wherever output is published; the strings are in each voice's `owner.json` on the Modal volume
`house-voices` and in realtime-tts `voices/catalog.json`. No Kokoro Spanish/French/Hindi/Italian/Portuguese and no
Lessac-derived voice is used. Speed for the measured-duration refit is Piper `length_scale / speed`, clamped to 0.8-1.5.

## `DUB_TTS_BACKEND` (backend env, default `gpu`)
| Value | Where es/fr audio is made | Redeploy needed | Extra config |
|---|---|---|---|
| `gpu` (default) | `tts-service-modal/app.py` (Modal app `readaloud-tts`, the `GPU_TTS_URL` route): Piper voices served from the Modal volume `house-voices` (read-only mount, allowlist in `piper_engine.py`); English = Kokoro | **`readaloud-tts` Modal app** (`modal deploy`, owner-run) + the **backend** (`listenai-backend`) | none |
| `cpu` | realtime-tts Piper CPU worker (Fly `piper-tts-sjc`) via the gateway `/tts/authorize {engine:"piper"}` then `POST <http_url>` | **backend only** | `DUB_PIPER_API_KEY` (else `STT_API_KEY`) gateway key with billing enabled; optional `DUB_PIPER_GATEWAY_URL` (default = `STT_GATEWAY_URL`). The house voices must exist in that worker's voice storage (unverified from here) |

English dubbing goes through the normal provider route (Kokoro) on both settings.

## Other services touched
- `tts-service/` (Fly `readaloud-tts` CPU/GPU Kokoro) and `tts-service-modal`: one Kokoro pipeline per lang_code; not used by dubbing for es/fr any more. Rebuild only if you want those fixes live for other callers.
- `tts-service-cpu-test/` (Fly `listenai-tts-worker`, Kokoro ONNX): **Edge TTS is now OFF by default**
  (`ALLOW_UNLICENSED_EDGE_TTS=1` re-enables it, local development only: unofficial Microsoft endpoint, no licence for
  third-party commercial use). A non-English request that used to fall back to Edge now gets HTTP 501. Rebuild this
  worker for the change to take effect.
