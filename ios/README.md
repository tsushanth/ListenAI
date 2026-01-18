# ListenAI

A text-to-speech iOS app that converts articles, PDFs, websites, and documents into natural-sounding audio.

## Features

- **Multiple Content Sources**: Import web pages, PDFs, plain text, and documents
- **Hybrid TTS Engine**:
  - Tier 1: Free on-device Apple system voices
  - Tier 2: Premium cloud neural voices (ElevenLabs, OpenAI, Google Cloud, Amazon Polly)
- **Character Voices**: Special voice presets like Santa, Storyteller, Professor, and more
- **Background Playback**: Continue listening while using other apps
- **Listening Queue**: Manage your reading list with playlists
- **Adjustable Speed**: Control playback speed from 0.5x to 3.0x
- **Accessibility**: Full VoiceOver and accessibility support

## Architecture

```
Sources/
├── TTS/
│   ├── Models/
│   │   ├── VoicePreset.swift         # Voice configuration models
│   │   └── TTSModels.swift           # Synthesis options, results, errors
│   ├── Protocols/
│   │   └── TTSService.swift          # Core TTS protocol & manager
│   ├── Services/
│   │   ├── OnDeviceTTSService.swift  # Apple AVSpeechSynthesizer
│   │   └── CloudTTSService.swift     # Cloud API providers
│   └── TTSCoordinator.swift          # High-level coordinator
│
├── Playback/
│   ├── Models/
│   │   └── PlaybackModels.swift      # Playback state, progress, queue models
│   ├── Services/
│   │   ├── AudioPlaybackService.swift    # Main playback service
│   │   ├── AudioSessionManager.swift     # AVAudioSession handling
│   │   ├── NowPlayingManager.swift       # Lock screen & Control Center
│   │   └── PlaybackPositionStore.swift   # Position persistence
│   ├── Views/
│   │   ├── AudioPlayerView.swift     # Full-screen player UI
│   │   └── MiniPlayerView.swift      # Compact player bar
│   └── BackgroundAudioConfiguration.swift  # Setup guide
```

## Requirements

- iOS 17.0+
- Xcode 15.0+
- Swift 5.9+

## Installation

1. Clone the repository
2. Open `ListenAI.xcodeproj` in Xcode
3. Build and run

## TTS Service Usage

### Basic Synthesis

```swift
// Get the coordinator
let coordinator = TTSCoordinator.shared

// Synthesize text with default voice
let audioURL = try await coordinator.synthesize(text: "Hello, world!")

// Synthesize with specific voice
let santaVoice = VoicePreset.santa
let audioURL = try await coordinator.synthesize(
    text: "Ho ho ho! Merry Christmas!",
    voice: santaVoice
)
```

### Synthesis with Progress

```swift
let sections = [
    TextSection(index: 0, type: .title, text: "Chapter 1", characterRange: 0..<9),
    TextSection(index: 1, type: .paragraph, text: "Once upon a time...", characterRange: 10..<29)
]

let result = try await coordinator.synthesizeSections(sections) { progress in
    print("Progress: \(progress.overallProgress * 100)%")
}
```

### Voice Selection

```swift
// Get available voices
let allVoices = coordinator.availableVoices

// Filter voices
let premiumVoices = coordinator.voices(tier: .premium)
let characterVoices = coordinator.voices(isCharacter: true)

// Select a voice
coordinator.selectVoice(premiumVoices.first!)
```

### Speed Control

```swift
coordinator.setSpeed(1.5)  // 1.5x speed
coordinator.increaseSpeed() // +0.25x
coordinator.decreaseSpeed() // -0.25x
```

## Cloud Provider Setup

### ElevenLabs

```swift
let cloudService = CloudTTSService(
    provider: .elevenLabs,
    configuration: .elevenLabs
)
await cloudService.setAPIKey("your-api-key")
```

### OpenAI

```swift
let cloudService = CloudTTSService(
    provider: .openAI,
    configuration: .openAI
)
await cloudService.setAPIKey("your-api-key")
```

## Voice Presets

### Built-in Character Voices

| Voice | Style | Provider | Tier |
|-------|-------|----------|------|
| Santa Claus | Jolly, warm | ElevenLabs | Premium |
| The Storyteller | Dramatic narrator | ElevenLabs | Premium |
| The Professor | Educational | Apple | Free |
| Bedtime Reader | Soft, soothing | ElevenLabs | Premium |
| News Anchor | Professional | OpenAI | Premium |

### Creating Custom Presets

```swift
let customVoice = VoicePreset(
    name: "My Custom Voice",
    provider: .elevenLabs,
    providerVoiceID: "voice-id",
    style: .narrative,
    defaultSpeed: 0.9,
    defaultPitch: 1.1,
    emotion: .calm,
    cloudSettings: CloudVoiceSettings(
        stability: 0.7,
        similarityBoost: 0.8,
        style: 0.3,
        useSpeakerBoost: true
    )
)
```

## Audio Playback

### Basic Playback

```swift
let playbackService = AudioPlaybackService.shared

// Create a now playing item
let item = NowPlayingItem(
    id: UUID(),
    articleID: article.id,
    title: article.title,
    author: article.author,
    siteName: article.siteName,
    audioURL: audioFileURL,
    duration: 300,
    artworkURL: article.imageURL,
    artworkColor: .blue
)

// Start playback (resumes from last position automatically)
try await playbackService.play(item: item)

// Or start from a specific position
try await playbackService.play(item: item, from: 60.0)
```

### Playback Controls

```swift
// Play/Pause
playbackService.togglePlayPause()
playbackService.pause()
playbackService.resume()

// Seeking
playbackService.seek(to: 120.0)  // Seek to 2 minutes
playbackService.skipForward()    // +15 seconds
playbackService.skipBackward()   // -15 seconds

// Speed control
playbackService.setPlaybackSpeed(PlaybackSpeed(rate: 1.5))
playbackService.cyclePlaybackSpeed()  // Cycle through presets
```

### Queue Management

```swift
// Add to queue
let queueItem = QueueItem(
    articleID: article.id,
    title: article.title,
    duration: 300
)
playbackService.addToQueue(queueItem, position: .next)  // Play next
playbackService.addToQueue(queueItem, position: .last)  // Add to end

// Navigate queue
await playbackService.playNext()
await playbackService.playPrevious()

// Clear queue
playbackService.clearQueue()
```

### Sleep Timer

```swift
playbackService.setSleepTimer(.minutes(30))
playbackService.setSleepTimer(.endOfArticle)
playbackService.cancelSleepTimer()
```

### SwiftUI Integration

```swift
struct ContentView: View {
    @StateObject var playbackService = AudioPlaybackService.shared

    var body: some View {
        ZStack(alignment: .bottom) {
            // Your main content
            NavigationStack {
                LibraryView()
            }

            // Mini player at bottom
            MiniPlayerView(playbackService: playbackService)
        }
    }
}
```

## Background Playback Setup

For background audio to work, configure your Xcode project:

1. **Enable Background Modes Capability**
   - Target → Signing & Capabilities → + Capability → Background Modes
   - Check "Audio, AirPlay, and Picture in Picture"

2. **Info.plist** (auto-added by Xcode):
   ```xml
   <key>UIBackgroundModes</key>
   <array>
       <string>audio</string>
   </array>
   ```

See `BackgroundAudioConfiguration.swift` for detailed setup and testing guide.

## License

MIT License - See LICENSE file for details.

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.
