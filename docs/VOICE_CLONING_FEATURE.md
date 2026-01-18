# Voice Cloning Feature Plan

## Overview

Voice cloning allows users to create custom AI voices from audio samples. This feature uses XTTS v2 which requires only a ~6 second audio sample to clone a voice.

## Legal Framework

### Permitted Use Cases

| Use Case | Allowed | Notes |
|----------|---------|-------|
| Clone your own voice | ✅ Yes | Primary use case |
| Clone family/friends | ✅ Yes | With explicit consent |
| Clone for your brand | ✅ Yes | Business/creator use |
| Clone deceased relatives | ⚠️ Careful | Estate permission may be needed |
| Clone public figures | ❌ No | Violates right of publicity |
| Clone celebrities | ❌ No | Legal liability |
| Clone politicians | ❌ No | Misinformation risk |
| Clone for fraud/deception | ❌ No | Illegal |

### Legal Risks We're Mitigating

1. **Right of Publicity** - Individuals own rights to their voice/likeness
2. **Trademark Infringement** - Voice can be part of personal brand
3. **Fraud/Impersonation** - Criminal liability for deceptive use
4. **State Laws** - California, New York, Tennessee have voice protection laws
5. **FTC Violations** - Deceptive advertising regulations

### Required Legal Documents

1. **Terms of Service** - Voice cloning policy section
2. **User Consent Agreement** - Before cloning
3. **DMCA/Takedown Process** - For reported violations

---

## Feature Tiers

| Feature | Free | Pro ($6.99) | Premium ($12.99) |
|---------|------|-------------|------------------|
| Cloned voices | 1 | 5 | Unlimited |
| Sample length | 10-30 sec | 10-60 sec | 10-120 sec |
| Voice quality | Standard | High | Highest |
| Languages | English only | 5 languages | All supported |
| Commercial use | ❌ | ✅ | ✅ |

---

## User Flow

### Step 1: Introduction & Consent

```
┌─────────────────────────────────────────┐
│ 🎤 Create a Custom Voice               │
│                                         │
│ Clone a voice from a short audio        │
│ recording. Great for:                   │
│                                         │
│ • Hearing articles in your own voice   │
│ • Creating a unique listening experience│
│ • Personalized content for your brand  │
│                                         │
│ ⚠️ Important: You may only clone voices │
│ that you own or have permission to use. │
│                                         │
│ ☐ I confirm I have the right to clone  │
│   this voice and agree to the Terms    │
│                                         │
│ [Continue]                              │
└─────────────────────────────────────────┘
```

### Step 2: Recording Options

```
┌─────────────────────────────────────────┐
│ 🎤 Record or Upload                     │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 🎙️ Record Now                       │ │
│ │ Use your microphone to record       │ │
│ │ 10-30 seconds of speech             │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 📁 Upload Audio File                │ │
│ │ MP3, WAV, M4A supported             │ │
│ │ 10-30 seconds recommended           │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ 💡 Tips for best results:              │
│ • Speak clearly in a quiet room        │
│ • Read naturally, not monotone         │
│ • Avoid background noise               │
└─────────────────────────────────────────┘
```

### Step 3: Recording Screen

```
┌─────────────────────────────────────────┐
│ 🎤 Recording...                         │
│                                         │
│ Please read the following text aloud:   │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ "The quick brown fox jumps over     │ │
│ │  the lazy dog. Pack my box with     │ │
│ │  five dozen liquor jugs. How        │ │
│ │  vexingly quick daft zebras jump!"  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│        ████████████░░░░░░░░░            │
│             15 / 30 seconds             │
│                                         │
│              🔴 Recording               │
│                                         │
│ [Cancel]                    [Done]      │
└─────────────────────────────────────────┘
```

### Step 4: Processing

```
┌─────────────────────────────────────────┐
│ ⏳ Creating Your Voice...              │
│                                         │
│        ┌─────────────────┐              │
│        │  🎤 → 🤖 → 🔊   │              │
│        └─────────────────┘              │
│                                         │
│ Analyzing voice characteristics...      │
│ This may take 30-60 seconds.           │
│                                         │
│ ████████████░░░░░░░░░░░░░░ 45%         │
└─────────────────────────────────────────┘
```

### Step 5: Preview & Save

```
┌─────────────────────────────────────────┐
│ ✅ Voice Created!                       │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 🎤 My Voice                         │ │
│ │                                     │ │
│ │ Preview:                            │ │
│ │ "Hello! This is a preview of your   │ │
│ │  new custom voice."                 │ │
│ │                                     │ │
│ │         ▶️   advancement────●──────  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Voice name:                             │
│ ┌─────────────────────────────────────┐ │
│ │ My Voice                            │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Re-record]           [Save Voice]      │
└─────────────────────────────────────────┘
```

### Step 6: Voice Library

```
┌─────────────────────────────────────────┐
│ 🎤 My Voices                            │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 👤 My Voice                         │ │
│ │ Created Jan 13, 2026                │ │
│ │ [▶️ Preview] [✏️ Edit] [🗑️ Delete] │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ ➕ Create New Voice                 │ │
│ │ 0 of 1 slots used (Free tier)      │ │
│ │ [Upgrade for more voices]           │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## Technical Implementation

### API Endpoints (Self-Hosted TTS Service)

```
POST /voice-clone/create
- Upload audio sample
- Returns voice_id

POST /voice-clone/synthesize
- text: string
- voice_id: string (cloned voice)
- Returns audio stream

GET /voice-clone/list
- Returns user's cloned voices

DELETE /voice-clone/{voice_id}
- Deletes a cloned voice
```

### Storage Requirements

| Component | Size | Storage |
|-----------|------|---------|
| Audio sample | ~500KB | Cloud Storage |
| Voice embedding | ~50KB | Database |
| Generated audio | Varies | Cached temporarily |

### Backend Flow

```
1. User uploads audio sample
2. Backend validates:
   - File format (MP3, WAV, M4A)
   - Duration (10-120 seconds)
   - Audio quality (sample rate, noise level)
3. Store sample in Cloud Storage
4. Generate voice embedding via XTTS v2
5. Store embedding in database with user_id
6. Return voice_id to client
7. On synthesis request:
   - Load voice embedding
   - Synthesize with XTTS v2
   - Return audio stream
```

---

## Safety & Moderation

### Pre-Upload Checks

```swift
struct VoiceCloneValidation {
    // User must agree to terms
    var consentGiven: Bool

    // Audio quality checks
    var meetsMinDuration: Bool  // >= 10 seconds
    var meetsMaxDuration: Bool  // <= 120 seconds
    var hasAcceptableNoiseLevel: Bool
    var hasAcceptableSampleRate: Bool  // >= 16kHz
}
```

### Consent Flow

```swift
struct VoiceCloneConsent: Codable {
    let userId: String
    let consentTimestamp: Date
    let consentVersion: String  // "1.0"
    let ipAddress: String
    let deviceId: String

    // User attestations
    let ownsVoiceRights: Bool
    let agreesToTerms: Bool
    let understandsProhibitedUses: Bool
}
```

### Prohibited Content Detection

1. **Audio fingerprinting** - Check against known celebrity voice databases
2. **User reporting** - Allow flagging of suspicious voices
3. **Usage patterns** - Flag accounts creating many voices rapidly
4. **Manual review** - Queue for review if flagged

### Takedown Process

```
1. Receive report (user report, automated detection, legal request)
2. Suspend voice immediately (precautionary)
3. Review within 24-48 hours
4. If violation confirmed:
   - Delete voice permanently
   - Warn user (first offense)
   - Suspend account (repeat offense)
5. If no violation:
   - Restore voice
   - Notify reporter
```

---

## Terms of Service Addition

Add to Terms of Service:

```
VOICE CLONING POLICY

1. PERMITTED USES
You may use our voice cloning feature to:
- Clone your own voice
- Clone voices of individuals who have given you explicit written consent
- Create voices for brands or organizations you own or represent

2. PROHIBITED USES
You may NOT use voice cloning to:
- Clone the voice of any public figure, celebrity, or politician
- Clone any voice without the owner's explicit consent
- Create voices intended to deceive, defraud, or impersonate
- Generate content that violates any person's right of publicity
- Create deepfakes or misleading media
- Circumvent our safety measures

3. YOUR RESPONSIBILITIES
- You are solely responsible for obtaining consent from voice owners
- You must maintain records of consent for voices you clone
- You agree to indemnify us against claims arising from your voice clones

4. ENFORCEMENT
- We may remove any voice clone that violates this policy
- Violations may result in account suspension or termination
- We cooperate with law enforcement on fraud investigations
- We comply with valid legal takedown requests

5. NO WARRANTY
- Voice clones are provided "as is"
- We do not guarantee voice accuracy or quality
- We reserve the right to modify or discontinue the feature
```

---

## UI Text & Microcopy

### Consent Screen
```
Title: "Create a Custom Voice"

Body: "Voice cloning lets you create an AI voice from a short recording.
You can use this to hear articles in your own voice or create a
personalized listening experience.

Important: Only clone voices you own or have permission to use.
Cloning public figures, celebrities, or others without consent
is prohibited and may violate their rights."

Checkbox: "I confirm I have the legal right to clone this voice
and agree to the Voice Cloning Terms of Use"

Button: "Continue"
```

### Recording Tips
```
"For best results:
• Find a quiet room with minimal echo
• Speak in your natural voice
• Read at a normal pace
• Hold your device 6-12 inches from your mouth
• Record for at least 15 seconds"
```

### Error Messages
```
Too short: "Recording must be at least 10 seconds. Please try again."
Too noisy: "Background noise detected. Please find a quieter location."
Poor quality: "Audio quality is too low. Please use a better microphone."
Processing failed: "We couldn't process your voice. Please try recording again."
Limit reached: "You've reached your voice limit. Upgrade to create more voices."
```

### Success Messages
```
Created: "Your voice has been created! Try it out on your next article."
Deleted: "Voice deleted successfully."
Updated: "Voice name updated."
```

---

## Metrics to Track

| Metric | Purpose |
|--------|---------|
| Clones created | Feature adoption |
| Clone success rate | Quality/UX issues |
| Clone usage rate | Engagement |
| Upgrade conversions | Monetization |
| Reports received | Safety monitoring |
| Takedowns issued | Policy enforcement |

---

## Implementation Phases

### Phase 1: MVP (2 weeks)
- [ ] Basic recording UI
- [ ] Upload to backend
- [ ] XTTS v2 integration
- [ ] Voice storage
- [ ] Consent flow
- [ ] 1 voice limit for free

### Phase 2: Polish (1 week)
- [ ] Audio quality validation
- [ ] Better recording UX
- [ ] Voice preview
- [ ] Error handling

### Phase 3: Safety (1 week)
- [ ] Reporting system
- [ ] Takedown workflow
- [ ] Usage monitoring
- [ ] Rate limiting

### Phase 4: Monetization (1 week)
- [ ] Tier limits enforcement
- [ ] Upgrade prompts
- [ ] Analytics

---

## Voice Sharing (Community Voices)

### Overview

Users can optionally share their cloned voices with the community. This creates a library of user-contributed voices for narration.

### Sharing Tiers

| Level | Description | Who Can Use |
|-------|-------------|-------------|
| **Private** | Only you | Just the creator |
| **Friends** | Share with approved users | Invited users only |
| **Community** | Anyone on ListenAI | All ListenAI users |
| **Featured** | Curated, high-quality | All users + promoted |

### Consent Flow for Sharing

```
┌─────────────────────────────────────────┐
│ 🌐 Share Your Voice                     │
│                                         │
│ Let other ListenAI users enjoy your    │
│ voice! You'll be credited as creator.   │
│                                         │
│ Choose sharing level:                   │
│                                         │
│ ○ Private (only you can use)           │
│ ○ Friends Only (invite specific users) │
│ ○ Community (any ListenAI user)        │
│                                         │
│ ☐ Allow use in commercial content      │
│                                         │
│ ⚠️ You can change this anytime         │
│                                         │
│ [Save Preference]                       │
└─────────────────────────────────────────┘
```

### Voice Library UI

```
┌─────────────────────────────────────────┐
│ 🎤 Community Voices                     │
│                                         │
│ 🌟 Featured                             │
│ ┌─────────────────────────────────────┐ │
│ │ ▶️ "Storyteller Mike"               │ │
│ │    Deep, warm narrator voice        │ │
│ │    ⭐ 4.8 (234 users)   [Use Voice] │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ 📚 Popular for Articles                 │
│ ┌─────────────────────────────────────┐ │
│ │ ▶️ "Sarah's Calm Voice"             │ │
│ │    Perfect for long-form reading    │ │
│ │    ⭐ 4.9 (89 users)    [Use Voice] │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Browse All] [Submit Your Voice]        │
└─────────────────────────────────────────┘
```

### Legal Agreement for Sharing

```
VOICE SHARING LICENSE AGREEMENT

By sharing your voice on ListenAI, you grant:

1. LICENSE TO LISTENAI
   - Host and distribute your voice clone
   - Allow other users to synthesize audio
   - Feature your voice in our library

2. LICENSE TO OTHER USERS
   - Use your voice for personal listening
   - [If selected] Use for commercial content

3. YOUR RIGHTS
   - Ownership of your voice
   - Right to withdraw at any time
   - Right to be credited as creator
   - Right to report misuse

4. RESTRICTIONS
   Your voice may NOT be used for:
   - Fraud or impersonation
   - Illegal or harmful content
   - Political misinformation
```

### Moderation Process

1. **Quality review** - Clear audio, usable voice
2. **Content check** - No offensive content
3. **Identity verification** - Confirm it's their voice
4. **Community guidelines** - Appropriate name/description

### Voice Creator Stats

```
┌─────────────────────────────────────────┐
│ 📊 Your Shared Voice Stats             │
│                                         │
│ "My Narrator Voice"                     │
│                                         │
│ 👥 234 users using your voice          │
│ 🎧 12,450 articles read                │
│ ⭐ 4.8 average rating                  │
│                                         │
│ [Edit] [Analytics] [Stop Sharing]       │
└─────────────────────────────────────────┘
```

---

## Open Questions

1. **Voice expiration?** - Should cloned voices expire if not used?
2. **Export?** - Can users download their voice embedding?
3. **Celebrity detection?** - How sophisticated should detection be?
4. **Parental consent?** - Special handling for minors' voices?
5. **Revenue sharing?** - Pay creators for popular voices? (Future)
