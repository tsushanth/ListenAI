# TTS Strategy & Pricing

## Overview

ReadAloud AI uses a multi-provider TTS strategy to balance quality, cost, and user experience.

## Provider Stack

| Provider | Technology | Use Case | Cost |
|----------|------------|----------|------|
| **Self-Hosted (Primary)** | Kokoro-82M | Default for all users | ~$0.001/1K chars |
| **ElevenLabs (Premium)** | Eleven Multilingual v2 | Premium quality option | ~$0.03/1K chars |
| **Self-Hosted XTTS** | Coqui XTTS v2 | Voice cloning only | ~$0.002/1K chars |

### Why No Apple On-Device?

Apple's AVSpeechSynthesis produces robotic-sounding voices that don't match our premium positioning. Our differentiator is natural, human-like voices - on-device voices would diminish the experience.

**Trade-off**: App requires internet connection for TTS.

---

## Pricing Tiers

### Subscription Plans

| Plan | Price | Target User |
|------|-------|-------------|
| **Free** | $0 | Casual users, evaluation |
| **Pro** | $6.99/mo | Regular listeners |
| **Premium** | $12.99/mo | Power users, professionals |

### Feature Matrix

| Feature | Free | Pro | Premium |
|---------|------|-----|---------|
| **Standard Quality (Kokoro)** | Unlimited | Unlimited | Unlimited |
| **Premium Quality (ElevenLabs)** | 3 articles/day | 30 articles/day | Unlimited |
| **Premium Characters** | 5,000/day | 50,000/day | Unlimited |
| **Voice Cloning** | 1 voice | 5 voices | Unlimited |
| **All Voice Presets** | ✅ | ✅ | ✅ |
| **Speed Control** | ✅ | ✅ | ✅ |
| **Background Playback** | ✅ | ✅ | ✅ |
| **Offline Cached Audio** | ❌ | ✅ | ✅ |
| **Priority Processing** | ❌ | ❌ | ✅ |
| **API Access** | ❌ | ❌ | ✅ |

### Competitive Positioning

| Feature | ReadAloud AI Free | Competitor Free |
|---------|---------------|-----------------|
| Daily listening | **Unlimited** | 5 minutes |
| Voice quality | **Natural AI** | Basic TTS |
| Voice cloning | **1 voice** | None |
| Voice variety | **18+ voices** | 3-5 voices |

---

## Voice Quality Levels

### Standard Quality (Self-Hosted Kokoro)
- **Speed**: ~6 seconds for short text
- **Quality**: Natural, human-like
- **Languages**: English (American, British)
- **Voices**: 11 distinct voices
- **Cost to us**: ~$0.001 per 1,000 characters

### Premium Quality (ElevenLabs)
- **Speed**: ~15 seconds for short text
- **Quality**: Studio-grade, highly expressive
- **Languages**: 29 languages
- **Voices**: 100+ voices
- **Cost to us**: ~$0.03 per 1,000 characters

---

## UI Strategy

### Voice Selection

Users select a **voice character** (Rachel, Adam, Brian, etc.), then optionally choose quality level:

```
┌─────────────────────────────────────────┐
│ 🎙️ Rachel                              │
│ Warm & Clear                            │
│                                         │
│ Quality:                                │
│ ┌──────────────┬──────────────┐        │
│ │ ⚡ Standard  │ ✨ Premium   │        │
│ │    Free      │    Pro 🔒    │        │
│ └──────────────┴──────────────┘        │
└─────────────────────────────────────────┘
```

### Free User Experience

1. **First 3 articles**: Premium quality (taste of upgrade)
2. **After samples used**: Standard quality (still great)
3. **Voice cloning**: 1 free voice to try the feature
4. **Upgrade prompts**: Contextual, not annoying

### Premium Sample Counter

```
┌─────────────────────────────────────────┐
│ ✨ Premium Samples                      │
│ ████████░░░░░░░░░░░░ 2 of 3 left today │
│ Resets in 14 hours                      │
│                                         │
│ [Upgrade for Unlimited]                 │
└─────────────────────────────────────────┘
```

### Quota Exhausted State

```
┌─────────────────────────────────────────┐
│ ℹ️ Premium samples used for today      │
│                                         │
│ Your articles will play in Standard    │
│ quality, which still sounds great!     │
│                                         │
│ [Continue] [Upgrade to Pro]             │
└─────────────────────────────────────────┘
```

---

## Voice Mapping

### App Voice → Provider Voice

| App Voice | Kokoro (Standard) | ElevenLabs (Premium) |
|-----------|-------------------|----------------------|
| Rachel | af_nicole | 21m00Tcm4TlvDq8ikWAM |
| Adam | am_adam | pNInz6obpgDQGcFmaJgB |
| Brian | bm_george | nPczCjzI2devNBz1zQrb |
| Bella | af_bella | EXAVITQu4vr4xnSDxMaL |
| Josh | am_michael | TxGEqnHWrfWFTfGW9XjX |
| Charlotte | bf_emma | XB0fDUnXU5powFXDhCwa |
| George | bm_lewis | JBFqnCBsd6RMkjVDRZzb |
| Elli | af_sarah | MF3mGyEYCl7XYWbV9V6O |
| Lily | bf_isabella | pFZP5JQG7iQjIQuC4Bku |
| Matilda | af_sky | XrExE9yKIg1WjnnlVkGX |
| Default | af_heart | - |

### Voices Without Kokoro Equivalent

These voices are Premium-only (no standard equivalent):
- **Santa** (knrPHWnBmmDHMoiMeP3l) - Character voice
- **Gigi** (jBpfuIE2acCO8z3wKNLl) - High-energy YouTuber
- **Onyx** (OpenAI) - News anchor
- **Alloy** (OpenAI) - Podcast host

---

## Backend Architecture

### Request Flow

```
iOS App
    │
    ▼
ListenAI Backend (Cloud Run)
    │
    ├─► Check user tier & quota
    │
    ├─► If Premium quality requested:
    │   └─► Route to ElevenLabs API
    │
    └─► If Standard quality:
        └─► Route to Self-Hosted TTS (Cloud Run)
            └─► Kokoro-82M or XTTS v2
```

### Endpoints

```
POST /api/tts/synthesize
{
  "text": "Article content...",
  "voice_id": "rachel",
  "quality": "standard" | "premium",
  "speed": 1.0
}

Response: audio/wav stream
Headers:
  X-Provider: "kokoro" | "elevenlabs"
  X-Characters-Used: 1234
  X-Quota-Remaining: 45678
```

---

## Cost Analysis

### Per-User Cost (Monthly)

| User Type | Articles/Month | Chars/Month | Self-Hosted | ElevenLabs |
|-----------|----------------|-------------|-------------|------------|
| Light | 10 | 50,000 | $0.05 | $1.50 |
| Medium | 30 | 150,000 | $0.15 | $4.50 |
| Heavy | 100 | 500,000 | $0.50 | $15.00 |

### Break-Even Analysis

| Plan | Revenue | Max ElevenLabs Cost | Margin |
|------|---------|---------------------|--------|
| Free ($0) | $0 | $0 (self-hosted only) | -$0.15* |
| Pro ($6.99) | $6.99 | $1.50 (50K chars) | $5.34 |
| Premium ($12.99) | $12.99 | $4.50 (150K avg) | $8.34 |

*Free users cost ~$0.15/month in self-hosted compute

---

## Conversion Triggers

### Upgrade Prompts (Non-Intrusive)

1. **After 3rd premium sample**:
   > "Enjoyed premium quality? Upgrade for unlimited access"

2. **After 7 days of active use**:
   > "You've listened to 5 hours this week! Go Pro for the best experience"

3. **When importing long article**:
   > "This 20-minute article would sound amazing in Premium quality"

4. **When creating 2nd cloned voice**:
   > "Upgrade to Pro for up to 5 custom voices"

5. **When selecting Premium-only voice**:
   > "Santa voice is a Pro feature. Try it free for 3 articles!"

### A/B Test Ideas

- Free premium samples: 3 vs 5 vs 10 per day
- Upgrade prompt timing: Immediate vs delayed
- Voice cloning limit: 1 vs 2 for free tier
- Premium character limit: 5K vs 10K for free tier

---

## Metrics to Track

### Usage Metrics
- Daily/Monthly Active Users
- Articles synthesized per user
- Characters consumed by tier
- Provider breakdown (Kokoro vs ElevenLabs)
- Voice cloning adoption

### Business Metrics
- Conversion rate (Free → Pro)
- Upgrade triggers (which prompts work)
- Churn rate by tier
- Revenue per user
- Cost per user

### Quality Metrics
- Synthesis success rate
- Error rate by provider
- Latency (p50, p95, p99)
- User ratings/feedback

---

## Implementation Phases

### Phase 1: Self-Hosted Integration (Current)
- [x] Deploy Kokoro-82M to Cloud Run
- [x] Add multi-model support
- [x] Load testing
- [ ] iOS integration with self-hosted

### Phase 2: Tier System
- [ ] Update VoicePreset with quality levels
- [ ] Add premium sample counter
- [ ] Quota tracking by provider
- [ ] Upgrade prompts

### Phase 3: Voice Cloning
- [ ] XTTS v2 voice cloning API
- [ ] iOS voice recording UI
- [ ] Consent flow
- [ ] Voice library management

### Phase 4: Optimization
- [ ] Caching layer
- [ ] Priority queues for premium
- [ ] Cost monitoring
- [ ] A/B testing framework
