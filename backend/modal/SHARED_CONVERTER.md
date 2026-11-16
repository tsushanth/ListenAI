# Using a shared converter endpoint

The voice converter routes (`/api/voice-convert/...`) can use one shared, scale-to-zero converter service instead of a converter deployed per user. A user's first conversion then starts right away instead of waiting for a per-user deployment.

Backend environment:

| Name | Value |
|---|---|
| `VOICE_SHARED_ENDPOINT` | `1` (opt in; without it a leftover URL never turns "deploy" into a fake "ready") |
| `VOICE_CONVERT_URL` | base URL of the shared converter |
| `VOICE_CONVERT_SECRET` | the converter's static bearer token |

With these set, `POST /deploy` answers `{status: "ready", shared: true}`, `GET /deploy` reports the same, and `POST /conversions` uses the shared endpoint for users without their own deployment. A user who does have a ready deployment keeps using it.

The converter contract the backend relies on (unchanged): `POST /convert` (multipart `source`, `target`) answers 202 `{job_id, status, source_seconds, target_seconds}` or 400 `{status: "rejected", error}`; `GET /convert/{id}` returns the status; `GET /convert/{id}/result` returns the audio; `DELETE /convert/{id}` removes the job. Requests carry `Authorization: Bearer <secret>`. Audio the converter rejects (too short, too long, silent, unreadable) is returned to the caller as a 400 with the converter's message.

Contract test: `src/routes/voiceConvertSharedWorker.test.ts`.
