# ListenAI Project Memory

## Deployment

- **Backend auto-deploys on push**: There's a trigger set up, so `git push origin main` to the backend automatically deploys to Cloud Run. No need to run `./deploy.sh` manually.

## Key Services

- `listenai-backend` - Main API backend (Cloud Run, us-central1)
- `readaloud-tts-gpu` - GPU TTS service for Kokoro + voice cloning (Cloud Run, us-central1)
- `readaloud-tts` - CPU TTS fallback (Cloud Run, us-central1)

## Voice Cloning

- Models: Chatterbox (~0.3x realtime), XTTS v2 (~0.5x realtime)
- Job-based API: `/api/tts/job-cloned` for async synthesis with progress tracking
- Cloned voices stored in Supabase `cloned-voices` bucket

## Quotas (Free Tier)

- 30 minutes/day
- 3 hours/month
