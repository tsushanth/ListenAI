# ReadAloud AI TTS API Contract v1

## Overview

The ReadAloud AI TTS system follows a three-layer architecture:

```
iOS Client → Backend (Node.js/Express) → TTS Service (Python/FastAPI) → Kokoro-82M
```

## Current Audio Format

| Property | Current Value |
|----------|---------------|
| Format | WAV (PCM) |
| Sample Rate | 24kHz |
| Channels | Mono (1) |
| Bit Depth | 16-bit signed integer |
| Size | ~48KB per second |
| Streaming | Base64-encoded chunks in NDJSON |

---

## 1. Backend Endpoints (Node.js/Express)

Base URL: `https://listenai-backend-{project}.run.app`

### Authentication

All endpoints require Bearer token authentication:
```
Authorization: Bearer {supabase_jwt_token}
```

---

### Voice Conversion (Self-Serve)

ReadAloud AI does not run a shared voice-conversion server. Instead, each user deploys their own Modal app (Seed-VC on GPU) and stores the URL + secret with us. The backend proxies requests to the user's Modal instance. Audio never touches ReadAloud servers.

#### Setup (one-time)

1. Clone the realtime-tts repo and run:
   ```bash
   cd voice-pipeline && modal deploy convert_job.py
   ```
2. Set a Modal secret:
   ```bash
   modal secret create voice-convert CONVERT_SECRET=your-secret-here
   ```
3. Copy the deployed URL and secret into the web UI at `/convert-voice` → Settings.

#### Config Endpoints

##### GET `/api/voice-convert/config`

Return the user's saved Modal endpoint URL (secret is never returned).

**Response:**
```json
{
  "modal_url": "https://your-name--voice-convert-api.modal.run",
  "configured": true
}
```

**Errors:**
| Status | Description |
|--------|-------------|
| 401 | Missing/invalid token |
| 404 | No config saved yet |

---

##### POST `/api/voice-convert/config`

Save the user's Modal endpoint.

**Request:**
```json
{
  "modal_url": "https://your-name--voice-convert-api.modal.run",
  "modal_secret": "your-modal-secret"
}
```

**Response:**
```json
{
  "configured": true,
  "modal_url": "https://your-name--voice-convert-api.modal.run"
}
```

**Validation:**
- `modal_url` must be HTTPS
- Both fields required

---

##### DELETE `/api/voice-convert/config`

Remove saved config.

**Response:**
```json
{
  "deleted": true
}
```

---

#### Conversion Endpoints

Convert speech from one voice to another using speech-to-speech conversion.

**Request:**
- Content-Type: `multipart/form-data`
- Files:
  - `source` — Source audio file (WAV, FLAC, OGG, MP3, M4A). The speech you want to convert.
  - `target` — Target voice reference audio (WAV, FLAC, OGG, MP3, M4A). The voice you want to sound like.
- Form fields:
  - `consent_statement` — Exact consent text (required, see below)

**Response:**
```json
{
  "job_id": "uuid-string",
  "status": "queued"
}
```

**Errors:**
| Status | Error Code | Description |
|--------|------------|-------------|
| 400 | validation_error | Missing files, unsupported format, or consent mismatch |
| 401 | unauthorized | Missing/invalid token |
| 402 | quota_exceeded | No active TTS subscription |
| 413 | file_too_large | Audio exceeds 25 MB |
| 429 | rate_limited | Max 10 conversions/hour exceeded |

**Consent Statement (exact text required):**
```
I confirm that I have the legal right to use both the source audio and the target voice reference, and that this conversion does not impersonate any person without their consent.
```

---

### GET `/api/voice-convert/conversions/:id`

Poll conversion status.

**Response:**
```json
{
  "status": "queued" | "running" | "done" | "failed"
}
```

---

### GET `/api/voice-convert/conversions/:id/audio`

Download converted audio.

**Response:**
- Content-Type: `audio/wav`
- Body: Binary WAV data

---

### DELETE `/api/voice-convert/conversions/:id`

Delete a conversion job and its audio.

**Response:**
```json
{
  "deleted": true
}
```

---

### POST `/api/tts`

Generate complete audio from text.

**Request:**
```json
{
  "text": "string (1-100,000 chars)",
  "voice_id": "am_adam",
  "provider": "selfhosted",
  "options": {
    "speed": 1.0
  }
}
```

**Response:**
- Content-Type: `audio/wav`
- Body: Binary WAV data

**Response Headers:**
| Header | Description |
|--------|-------------|
| X-Characters-Used | Characters synthesized |
| X-Audio-Duration-Ms | Audio duration in ms |
| X-Daily-Used | Daily quota used |
| X-Daily-Limit | Daily quota limit |
| X-Monthly-Used | Monthly quota used |
| X-Monthly-Limit | Monthly quota limit |

---

### POST `/api/tts/stream`

Stream audio chunks as NDJSON.

**Request:**
```json
{
  "text": "string (1-100,000 chars)",
  "voice_id": "am_adam",
  "provider": "selfhosted",
  "options": {
    "speed": 1.0
  }
}
```

**Response:**
- Content-Type: `application/x-ndjson`
- Transfer-Encoding: `chunked`

**Chunk Format (one JSON per line):**
```json
{
  "index": 0,
  "total": 5,
  "audio": "base64-encoded WAV data",
  "duration_ms": 1250,
  "synthesis_time_ms": 850,
  "final": false,
  "error": null
}
```

Last chunk has `"final": true`.

---

### POST `/api/tts/preview`

Generate short voice preview (no quota charge).

**Request:**
```json
{
  "voice_id": "am_adam",
  "text": "optional preview text (max 200 chars)"
}
```

**Response:**
- Content-Type: `audio/wav`
- Cache-Control: `public, max-age=3600`

---

### POST `/api/tts/estimate`

Get cost/duration estimate without synthesizing.

**Request:**
```json
{
  "text_length": 5000,
  "voice_id": "am_adam",
  "speed": 1.0
}
```

**Response:**
```json
{
  "can_proceed": true,
  "estimate": {
    "characters": 5000,
    "estimated_duration_ms": 30000
  },
  "quota": {
    "daily": { "used": 2000, "limit": 4000, "remaining": 2000 },
    "monthly": { "used": 15000, "limit": 25000, "remaining": 10000 }
  }
}
```

---

## 2. TTS Service Endpoints (Python/FastAPI)

Base URL: `https://tts.listenai.app` (internal)

---

### GET `/health`

**Response:**
```json
{
  "status": "ok",
  "default_model": "kokoro",
  "models_loaded": ["kokoro"],
  "device": "cuda",
  "gpu_available": true
}
```

---

### GET `/voices`

**Response:**
```json
{
  "voices": [
    {
      "id": "am_adam",
      "name": "Adam (Kokoro)",
      "language": "en",
      "gender": "male"
    }
  ]
}
```

**Available Kokoro Voices:**
| ID | Name | Gender | Accent |
|----|------|--------|--------|
| af_heart | Heart | Female | American |
| af_bella | Bella | Female | American |
| af_nicole | Nicole | Female | American |
| af_sarah | Sarah | Female | American |
| af_sky | Sky | Female | American |
| am_adam | Adam | Male | American |
| am_michael | Michael | Male | American |
| bf_emma | Emma | Female | British |
| bf_isabella | Isabella | Female | British |
| bm_george | George | Male | British |
| bm_lewis | Lewis | Male | British |

---

### POST `/synthesize`

Synthesize short text (<1000 chars).

**Request:**
```json
{
  "text": "Hello world",
  "voice_id": "am_adam",
  "language": "en",
  "speed": 1.0,
  "model": "kokoro"
}
```

**Response:**
- Content-Type: `audio/wav`
- Body: Binary WAV (24kHz, mono, 16-bit)

---

### POST `/synthesize-long`

Synthesize long text with chunking.

**Request:**
```json
{
  "text": "Long article text...",
  "voice_id": "am_adam",
  "language": "en",
  "speed": 1.0,
  "model": "kokoro",
  "max_chunk_chars": 250
}
```

**Response:**
- Content-Type: `audio/wav`
- Body: Complete concatenated WAV

---

### POST `/synthesize-stream`

Stream chunks as NDJSON.

**Request:** Same as `/synthesize-long`

**Response:**
- Content-Type: `application/x-ndjson`

**Chunk Format:**
```json
{
  "index": 0,
  "total": 3,
  "audio": "base64-encoded WAV",
  "duration_ms": 1250,
  "synthesis_time_ms": 850,
  "final": false
}
```

---

## 3. iOS Client Implementation

### Non-Streaming Synthesis

```swift
// ListenAICloudService.synthesize()
POST /api/tts
Authorization: Bearer {token}
Content-Type: application/json

{
  "text": "Article text",
  "voice_id": "am_adam",
  "provider": "selfhosted",
  "options": { "speed": 1.0 }
}
```

### Streaming Synthesis

```swift
// StreamingTTSService.startStreaming()
POST /api/tts/stream
Authorization: Bearer {token}
Content-Type: application/json
Accept: application/x-ndjson

{
  "text": "Article text",
  "voice_id": "am_adam",
  "provider": "selfhosted",
  "options": { "speed": 1.0 }
}
```

**Client Processing:**
1. Parse NDJSON lines as they arrive
2. Decode base64 audio chunks
3. Convert WAV Int16 → Float32 for AVAudioEngine
4. Schedule buffers for immediate playback
5. Accumulate PCM data for disk caching
6. Save combined audio when streaming completes

**Caching:**
- Location: `{cachesDirectory}/StreamedAudio/{articleID}.wav`

---

## Error Responses

All endpoints return standardized errors:

```json
{
  "error": "error_code",
  "message": "Human-readable message"
}
```

| Status | Error Code | Description |
|--------|------------|-------------|
| 400 | validation_error | Invalid request body |
| 401 | unauthorized | Missing/invalid token |
| 402 | quota_exceeded | Usage quota exceeded |
| 403 | forbidden | Subscription required |
| 404 | not_found | Voice not found |
| 429 | rate_limited | Too many requests |
| 500 | server_error | Internal error |

---

## Quota System

| Tier | Daily Limit | Monthly Limit |
|------|-------------|---------------|
| Free | 4,000 chars | 25,000 chars |

Charged per character synthesized (not by duration).

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Synthesis latency (Kokoro) | 10-30 seconds |
| Streaming first chunk | 5-10 seconds |
| Audio file size | ~48KB/second |
| Network overhead | 1-2 seconds |
