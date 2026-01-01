import Foundation
import AVFoundation

// MARK: - Voice Provider

enum VoiceProvider: String, Codable, CaseIterable, Sendable {
    case apple
    case elevenLabs
    case openAI
    case googleCloud
    case amazonPolly

    var displayName: String {
        switch self {
        case .apple: return "Apple"
        case .elevenLabs: return "ElevenLabs"
        case .openAI: return "OpenAI"
        case .googleCloud: return "Google Cloud"
        case .amazonPolly: return "Amazon Polly"
        }
    }

    var isCloudBased: Bool {
        self != .apple
    }

    var iconName: String {
        switch self {
        case .apple: return "apple.logo"
        case .elevenLabs: return "waveform"
        case .openAI: return "brain"
        case .googleCloud: return "cloud"
        case .amazonPolly: return "speaker.wave.3"
        }
    }
}

// MARK: - Voice Tier

enum VoiceTier: String, Codable, CaseIterable, Sendable {
    case free
    case premium
    case enterprise

    var displayName: String {
        switch self {
        case .free: return "Free"
        case .premium: return "Premium"
        case .enterprise: return "Enterprise"
        }
    }

    var badgeColor: String {
        switch self {
        case .free: return "#4CAF50"
        case .premium: return "#FFD700"
        case .enterprise: return "#9C27B0"
        }
    }
}

// MARK: - Voice Gender

enum VoiceGender: String, Codable, CaseIterable, Sendable {
    case male
    case female
    case neutral

    var displayName: String {
        rawValue.capitalized
    }

    var iconName: String {
        switch self {
        case .male: return "person.fill"
        case .female: return "person.fill"
        case .neutral: return "person.fill.questionmark"
        }
    }
}

// MARK: - Voice Age

enum VoiceAge: String, Codable, CaseIterable, Sendable {
    case child
    case young
    case adult
    case senior

    var displayName: String {
        rawValue.capitalized
    }
}

// MARK: - Voice Style

enum VoiceStyle: String, Codable, CaseIterable, Sendable {
    case neutral
    case narrative
    case news
    case conversational
    case educational
    case character
    case calm
    case excited
    case serious
    case friendly
    case dramatic
    case whimsical

    var displayName: String {
        rawValue.capitalized
    }

    var description: String {
        switch self {
        case .neutral: return "Natural, balanced tone"
        case .narrative: return "Storytelling with expression"
        case .news: return "Professional broadcast style"
        case .conversational: return "Casual, friendly chat"
        case .educational: return "Clear, instructive delivery"
        case .character: return "Distinctive personality"
        case .calm: return "Soothing and relaxed"
        case .excited: return "High energy, enthusiastic"
        case .serious: return "Formal and authoritative"
        case .friendly: return "Warm and approachable"
        case .dramatic: return "Theatrical with emotion"
        case .whimsical: return "Playful and fun"
        }
    }
}

// MARK: - Voice Emotion

enum VoiceEmotion: String, Codable, CaseIterable, Sendable {
    case neutral
    case happy
    case sad
    case angry
    case fearful
    case surprised
    case disgusted
    case calm
    case excited
    case warm
    case cheerful

    var displayName: String {
        rawValue.capitalized
    }
}

// MARK: - Voice Category

enum VoiceCategory: String, Codable, CaseIterable, Sendable {
    case narrator
    case educator
    case character
    case news
    case podcast
    case meditation
    case audiobook
    case custom

    var displayName: String {
        switch self {
        case .narrator: return "Narrators"
        case .educator: return "Educators"
        case .character: return "Characters"
        case .news: return "News & Articles"
        case .podcast: return "Podcast Style"
        case .meditation: return "Meditation & Sleep"
        case .audiobook: return "Audiobook"
        case .custom: return "Custom"
        }
    }

    var iconName: String {
        switch self {
        case .narrator: return "book.fill"
        case .educator: return "graduationcap.fill"
        case .character: return "theatermasks.fill"
        case .news: return "newspaper.fill"
        case .podcast: return "mic.fill"
        case .meditation: return "moon.stars.fill"
        case .audiobook: return "headphones"
        case .custom: return "slider.horizontal.3"
        }
    }
}

// MARK: - Style Parameters

/// Fine-tuned style parameters for voice customization.
struct StyleParameters: Codable, Hashable, Sendable {
    /// Speaking rate multiplier (0.5 - 2.0, where 1.0 is normal)
    var speakingRate: Float

    /// Pitch adjustment (0.5 - 2.0, where 1.0 is normal)
    var pitch: Float

    /// Volume level (0.0 - 1.0)
    var volume: Float

    /// Emphasis level (0.0 - 1.0) - how much to emphasize words
    var emphasis: Float

    /// Pause duration multiplier (0.5 - 2.0) - between sentences
    var pauseDuration: Float

    /// Expressiveness (0.0 - 1.0) - variation in tone
    var expressiveness: Float

    /// Warmth (0.0 - 1.0) - tonal warmth
    var warmth: Float

    /// Clarity (0.0 - 1.0) - articulation clarity
    var clarity: Float

    init(
        speakingRate: Float = 1.0,
        pitch: Float = 1.0,
        volume: Float = 1.0,
        emphasis: Float = 0.5,
        pauseDuration: Float = 1.0,
        expressiveness: Float = 0.5,
        warmth: Float = 0.5,
        clarity: Float = 0.7
    ) {
        self.speakingRate = speakingRate
        self.pitch = pitch
        self.volume = volume
        self.emphasis = emphasis
        self.pauseDuration = pauseDuration
        self.expressiveness = expressiveness
        self.warmth = warmth
        self.clarity = clarity
    }

    // MARK: - Preset Style Parameters

    static let `default` = StyleParameters()

    static let narrator = StyleParameters(
        speakingRate: 0.95,
        pitch: 1.0,
        volume: 1.0,
        emphasis: 0.6,
        pauseDuration: 1.2,
        expressiveness: 0.7,
        warmth: 0.6,
        clarity: 0.8
    )

    static let calmTeacher = StyleParameters(
        speakingRate: 0.9,
        pitch: 0.98,
        volume: 0.9,
        emphasis: 0.5,
        pauseDuration: 1.3,
        expressiveness: 0.4,
        warmth: 0.8,
        clarity: 0.9
    )

    static let energetic = StyleParameters(
        speakingRate: 1.15,
        pitch: 1.05,
        volume: 1.0,
        emphasis: 0.8,
        pauseDuration: 0.8,
        expressiveness: 0.9,
        warmth: 0.7,
        clarity: 0.7
    )

    static let soothing = StyleParameters(
        speakingRate: 0.85,
        pitch: 0.95,
        volume: 0.8,
        emphasis: 0.3,
        pauseDuration: 1.5,
        expressiveness: 0.3,
        warmth: 0.9,
        clarity: 0.6
    )

    static let professional = StyleParameters(
        speakingRate: 1.0,
        pitch: 1.0,
        volume: 1.0,
        emphasis: 0.5,
        pauseDuration: 1.0,
        expressiveness: 0.4,
        warmth: 0.4,
        clarity: 0.9
    )

    static let dramatic = StyleParameters(
        speakingRate: 0.9,
        pitch: 1.0,
        volume: 1.0,
        emphasis: 0.9,
        pauseDuration: 1.4,
        expressiveness: 1.0,
        warmth: 0.5,
        clarity: 0.8
    )

    static let whimsical = StyleParameters(
        speakingRate: 1.05,
        pitch: 1.1,
        volume: 1.0,
        emphasis: 0.7,
        pauseDuration: 0.9,
        expressiveness: 0.85,
        warmth: 0.9,
        clarity: 0.7
    )
}

// MARK: - Cloud Voice Settings

struct CloudVoiceSettings: Codable, Hashable, Sendable {
    /// Voice stability (0.0-1.0) - lower = more expressive/variable
    var stability: Float

    /// Voice similarity boost (0.0-1.0) - higher = more consistent with original
    var similarityBoost: Float

    /// Style exaggeration (0.0-1.0)
    var style: Float

    /// Enable speaker boost for clarity
    var useSpeakerBoost: Bool

    /// Provider-specific model ID
    var modelID: String?

    static let `default` = CloudVoiceSettings(
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0.0,
        useSpeakerBoost: true,
        modelID: nil
    )

    static let narrative = CloudVoiceSettings(
        stability: 0.7,
        similarityBoost: 0.8,
        style: 0.3,
        useSpeakerBoost: true,
        modelID: nil
    )

    static let expressive = CloudVoiceSettings(
        stability: 0.3,
        similarityBoost: 0.6,
        style: 0.6,
        useSpeakerBoost: true,
        modelID: nil
    )

    static let calm = CloudVoiceSettings(
        stability: 0.85,
        similarityBoost: 0.7,
        style: 0.1,
        useSpeakerBoost: false,
        modelID: nil
    )

    static let energetic = CloudVoiceSettings(
        stability: 0.4,
        similarityBoost: 0.65,
        style: 0.7,
        useSpeakerBoost: true,
        modelID: nil
    )
}

// MARK: - On-Device Voice Mapping

/// Maps a preset to available on-device Apple voices.
struct OnDeviceVoiceMapping: Codable, Hashable, Sendable {
    /// Primary Apple voice identifier
    let primaryVoiceID: String

    /// Fallback voice identifiers in order of preference
    let fallbackVoiceIDs: [String]

    /// Language requirement
    let language: String

    /// Minimum voice quality required
    let minimumQuality: AVSpeechSynthesisVoiceQuality

    init(
        primaryVoiceID: String,
        fallbackVoiceIDs: [String] = [],
        language: String = "en-US",
        minimumQuality: AVSpeechSynthesisVoiceQuality = .default
    ) {
        self.primaryVoiceID = primaryVoiceID
        self.fallbackVoiceIDs = fallbackVoiceIDs
        self.language = language
        self.minimumQuality = minimumQuality
    }

    /// Get the best available voice
    func bestAvailableVoice() -> AVSpeechSynthesisVoice? {
        // Try primary
        if let voice = AVSpeechSynthesisVoice(identifier: primaryVoiceID) {
            return voice
        }

        // Try fallbacks
        for fallbackID in fallbackVoiceIDs {
            if let voice = AVSpeechSynthesisVoice(identifier: fallbackID) {
                return voice
            }
        }

        // Try any voice for the language
        return AVSpeechSynthesisVoice(language: language)
    }
}

// MARK: - Voice Preset

struct VoicePreset: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var name: String
    var isBuiltIn: Bool
    var isCharacterVoice: Bool

    // Provider info
    var provider: VoiceProvider
    var providerVoiceID: String
    var providerModelID: String?

    // On-device fallback
    var onDeviceMapping: OnDeviceVoiceMapping?

    // Characteristics
    var language: String
    var supportedLanguages: [String]
    var gender: VoiceGender
    var age: VoiceAge
    var style: VoiceStyle
    var category: VoiceCategory
    var voiceDescription: String

    // Tier & Access
    var tier: VoiceTier
    var requiresDownload: Bool
    var downloadSizeBytes: Int64?
    var isDownloaded: Bool

    // Style parameters
    var styleParameters: StyleParameters
    var emotion: VoiceEmotion

    // Cloud-specific settings
    var cloudSettings: CloudVoiceSettings?

    // Character voice extras
    var characterID: String?
    var characterDescription: String?
    var specialInstructions: String?
    var iconName: String?
    var accentColorHex: String?

    // Preview
    var sampleAudioURL: URL?
    var sampleText: String

    // MARK: - Computed Properties

    var defaultSpeed: Float {
        styleParameters.speakingRate
    }

    var defaultPitch: Float {
        styleParameters.pitch
    }

    var defaultVolume: Float {
        styleParameters.volume
    }

    var isCloudVoice: Bool {
        provider.isCloudBased
    }

    var hasOnDeviceFallback: Bool {
        onDeviceMapping != nil
    }

    var displayTier: String {
        tier == .free ? "" : tier.displayName
    }

    // MARK: - Initialization

    init(
        id: UUID = UUID(),
        name: String,
        isBuiltIn: Bool = true,
        isCharacterVoice: Bool = false,
        provider: VoiceProvider,
        providerVoiceID: String,
        providerModelID: String? = nil,
        onDeviceMapping: OnDeviceVoiceMapping? = nil,
        language: String = "en-US",
        supportedLanguages: [String] = ["en-US"],
        gender: VoiceGender = .neutral,
        age: VoiceAge = .adult,
        style: VoiceStyle = .neutral,
        category: VoiceCategory = .narrator,
        voiceDescription: String = "",
        tier: VoiceTier = .free,
        requiresDownload: Bool = false,
        downloadSizeBytes: Int64? = nil,
        isDownloaded: Bool = true,
        styleParameters: StyleParameters = .default,
        emotion: VoiceEmotion = .neutral,
        cloudSettings: CloudVoiceSettings? = nil,
        characterID: String? = nil,
        characterDescription: String? = nil,
        specialInstructions: String? = nil,
        iconName: String? = nil,
        accentColorHex: String? = nil,
        sampleAudioURL: URL? = nil,
        sampleText: String = "Hello, this is a sample of my voice."
    ) {
        self.id = id
        self.name = name
        self.isBuiltIn = isBuiltIn
        self.isCharacterVoice = isCharacterVoice
        self.provider = provider
        self.providerVoiceID = providerVoiceID
        self.providerModelID = providerModelID
        self.onDeviceMapping = onDeviceMapping
        self.language = language
        self.supportedLanguages = supportedLanguages
        self.gender = gender
        self.age = age
        self.style = style
        self.category = category
        self.voiceDescription = voiceDescription
        self.tier = tier
        self.requiresDownload = requiresDownload
        self.downloadSizeBytes = downloadSizeBytes
        self.isDownloaded = isDownloaded
        self.styleParameters = styleParameters
        self.emotion = emotion
        self.cloudSettings = cloudSettings
        self.characterID = characterID
        self.characterDescription = characterDescription
        self.specialInstructions = specialInstructions
        self.iconName = iconName
        self.accentColorHex = accentColorHex
        self.sampleAudioURL = sampleAudioURL
        self.sampleText = sampleText
    }

    // MARK: - Voice Resolution

    /// Get the appropriate AVSpeechSynthesisVoice for on-device playback.
    func resolveOnDeviceVoice() -> AVSpeechSynthesisVoice? {
        if provider == .apple {
            return AVSpeechSynthesisVoice(identifier: providerVoiceID)
                ?? AVSpeechSynthesisVoice(language: language)
        }

        // Use on-device fallback for cloud voices
        return onDeviceMapping?.bestAvailableVoice()
            ?? AVSpeechSynthesisVoice(language: language)
    }

    /// Create a copy with modified style parameters.
    func withStyleParameters(_ parameters: StyleParameters) -> VoicePreset {
        var copy = self
        copy.styleParameters = parameters
        return copy
    }
}

// MARK: - Factory Methods

extension VoicePreset {

    /// Create a preset from an Apple AVSpeechSynthesisVoice
    static func fromAppleVoice(_ voice: AVSpeechSynthesisVoice) -> VoicePreset {
        let gender: VoiceGender = switch voice.gender {
        case .male: .male
        case .female: .female
        default: .neutral
        }

        let quality = voice.quality
        let isEnhanced = quality == .enhanced || quality == .premium

        return VoicePreset(
            name: voice.name,
            isBuiltIn: true,
            provider: .apple,
            providerVoiceID: voice.identifier,
            language: voice.language,
            supportedLanguages: [voice.language],
            gender: gender,
            category: .narrator,
            voiceDescription: "Apple \(isEnhanced ? "Enhanced" : "Standard") Voice",
            tier: .free,
            requiresDownload: isEnhanced,
            isDownloaded: true,
            sampleText: "Hello, my name is \(voice.name)."
        )
    }
}

// MARK: - Built-in Presets

extension VoicePreset {

    // MARK: - Narrator Preset

    /// Professional narrator voice for articles and books.
    static let narrator = VoicePreset(
        name: "Narrator",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "pNInz6obpgDQGcFmaJgB", // Adam voice
        providerModelID: "eleven_multilingual_v2",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-US.evan",
            fallbackVoiceIDs: [
                "com.apple.voice.enhanced.en-US.Aaron",
                "com.apple.ttsbundle.siri_male_en-US_compact"
            ],
            language: "en-US",
            minimumQuality: .enhanced
        ),
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB", "en-AU"],
        gender: .male,
        age: .adult,
        style: .narrative,
        category: .narrator,
        voiceDescription: "Professional, clear narrator perfect for articles, news, and long-form content. Balanced pace with natural expression.",
        tier: .free, // Free with on-device, premium for cloud
        requiresDownload: true,
        styleParameters: .narrator,
        emotion: .neutral,
        cloudSettings: .narrative,
        iconName: "book.fill",
        accentColorHex: "#3B82F6",
        sampleText: "Welcome to today's article. Let me guide you through this fascinating story with clarity and engagement."
    )

    // MARK: - Calm Teacher Preset

    /// Soothing educational voice for learning content.
    static let calmTeacher = VoicePreset(
        name: "Calm Teacher",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "EXAVITQu4vr4xnSDxMaL", // Bella voice
        providerModelID: "eleven_multilingual_v2",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-US.Samantha",
            fallbackVoiceIDs: [
                "com.apple.voice.enhanced.en-US.Allison",
                "com.apple.ttsbundle.siri_female_en-US_compact"
            ],
            language: "en-US",
            minimumQuality: .enhanced
        ),
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .female,
        age: .adult,
        style: .educational,
        category: .educator,
        voiceDescription: "Patient, warm voice ideal for educational content. Slower pace with clear enunciation helps with comprehension and retention.",
        tier: .free,
        requiresDownload: true,
        styleParameters: .calmTeacher,
        emotion: .calm,
        cloudSettings: .calm,
        iconName: "graduationcap.fill",
        accentColorHex: "#10B981",
        sampleText: "Let's explore this concept together. Take your time to absorb each idea as we go through this material."
    )

    // MARK: - Santa Storyteller Preset

    /// Jolly Santa Claus voice for festive storytelling.
    static let santaStoryteller = VoicePreset(
        name: "Santa Storyteller",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "VR6AewLTigWG4xSOukaG", // Arnold voice (deep, warm)
        providerModelID: "eleven_multilingual_v2",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-US.evan",
            fallbackVoiceIDs: [
                "com.apple.voice.enhanced.en-GB.Daniel"
            ],
            language: "en-US"
        ),
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .male,
        age: .senior,
        style: .whimsical,
        category: .character,
        voiceDescription: "Ho ho ho! The warm, jolly voice of Santa Claus brings magic to every story. Perfect for bedtime tales and festive content.",
        tier: .premium,
        styleParameters: StyleParameters(
            speakingRate: 0.88,
            pitch: 0.92,
            volume: 1.0,
            emphasis: 0.7,
            pauseDuration: 1.3,
            expressiveness: 0.85,
            warmth: 1.0,
            clarity: 0.7
        ),
        emotion: .cheerful,
        cloudSettings: CloudVoiceSettings(
            stability: 0.55,
            similarityBoost: 0.75,
            style: 0.5,
            useSpeakerBoost: true,
            modelID: "eleven_multilingual_v2"
        ),
        characterID: "santa",
        characterDescription: "The warm, jolly voice of Santa Claus",
        specialInstructions: "Speak with warmth and occasional 'ho ho ho' energy. Add hearty chuckles between sentences.",
        iconName: "gift.fill",
        accentColorHex: "#DC2626",
        sampleText: "Ho ho ho! Come sit by the fire, little one. Let me tell you a wonderful story about a magical Christmas Eve..."
    )

    // MARK: - Energetic YouTuber Preset

    /// High-energy voice for engaging podcast/YouTube style content.
    static let energeticYouTuber = VoicePreset(
        name: "Energetic YouTuber",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "jBpfuIE2acCO8z3wKNLl", // Gigi voice
        providerModelID: "eleven_multilingual_v2",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-US.Nicky",
            fallbackVoiceIDs: [
                "com.apple.voice.enhanced.en-US.Alex"
            ],
            language: "en-US"
        ),
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .female,
        age: .young,
        style: .excited,
        category: .podcast,
        voiceDescription: "Upbeat, enthusiastic voice that keeps you engaged! Perfect for listicles, how-tos, and content that needs extra energy.",
        tier: .premium,
        styleParameters: .energetic,
        emotion: .excited,
        cloudSettings: .energetic,
        characterID: "youtuber",
        characterDescription: "High-energy content creator voice",
        specialInstructions: "Maintain high energy throughout. Add enthusiasm to key points.",
        iconName: "play.rectangle.fill",
        accentColorHex: "#EF4444",
        sampleText: "Hey everyone! Welcome back to another amazing article! Today we're going to dive into something really exciting, so let's get started!"
    )

    // MARK: - Additional Presets

    /// Classic storyteller for audiobooks.
    static let storyteller = VoicePreset(
        name: "The Storyteller",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "TxGEqnHWrfWFTfGW9XjX", // Josh voice
        providerModelID: "eleven_multilingual_v2",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-GB.Daniel",
            fallbackVoiceIDs: ["com.apple.voice.enhanced.en-US.evan"],
            language: "en-US"
        ),
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .male,
        age: .adult,
        style: .dramatic,
        category: .audiobook,
        voiceDescription: "Rich, dramatic narrator voice that brings stories to life. Uses varied intonation and dramatic pauses for maximum impact.",
        tier: .premium,
        styleParameters: .dramatic,
        emotion: .neutral,
        cloudSettings: .narrative,
        characterID: "storyteller",
        characterDescription: "A captivating narrator for immersive storytelling",
        specialInstructions: "Use dramatic pauses and varied intonation",
        iconName: "book.closed.fill",
        accentColorHex: "#8B5CF6",
        sampleText: "Once upon a time, in a land far, far away, there lived a hero whose destiny would change the world forever..."
    )

    /// Soothing voice for meditation and sleep content.
    static let bedtimeReader = VoicePreset(
        name: "Bedtime Reader",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "MF3mGyEYCl7XYWbV9V6O", // Elli voice
        providerModelID: "eleven_multilingual_v2",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-US.Samantha",
            fallbackVoiceIDs: ["com.apple.voice.enhanced.en-GB.Kate"],
            language: "en-US"
        ),
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .female,
        age: .adult,
        style: .calm,
        category: .meditation,
        voiceDescription: "Soft, soothing voice perfect for bedtime stories and relaxation. Gentle pace helps you wind down and drift off peacefully.",
        tier: .premium,
        styleParameters: .soothing,
        emotion: .calm,
        cloudSettings: .calm,
        characterID: "bedtime",
        characterDescription: "A gentle voice to help you drift off to sleep",
        specialInstructions: "Speak softly and slowly with gentle intonation",
        iconName: "moon.stars.fill",
        accentColorHex: "#6366F1",
        sampleText: "Close your eyes and let your thoughts drift away. Tonight, I'll take you on a peaceful journey through dreamland..."
    )

    /// Professional news anchor voice.
    static let newsAnchor = VoicePreset(
        name: "News Anchor",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .openAI,
        providerVoiceID: "onyx",
        providerModelID: "tts-1-hd",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-US.Aaron",
            fallbackVoiceIDs: ["com.apple.voice.enhanced.en-US.evan"],
            language: "en-US"
        ),
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .male,
        age: .adult,
        style: .news,
        category: .news,
        voiceDescription: "Authoritative, professional voice for news and serious articles. Clear delivery with appropriate gravitas.",
        tier: .premium,
        styleParameters: .professional,
        emotion: .serious,
        cloudSettings: CloudVoiceSettings(
            stability: 0.75,
            similarityBoost: 0.8,
            style: 0.2,
            useSpeakerBoost: true,
            modelID: "tts-1-hd"
        ),
        characterID: "news",
        characterDescription: "A professional news broadcaster",
        iconName: "newspaper.fill",
        accentColorHex: "#1E40AF",
        sampleText: "Good evening. In today's top story, we examine the latest developments that are shaping our world."
    )

    /// Friendly podcast host voice.
    static let podcastHost = VoicePreset(
        name: "Podcast Host",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .openAI,
        providerVoiceID: "alloy",
        providerModelID: "tts-1-hd",
        onDeviceMapping: OnDeviceVoiceMapping(
            primaryVoiceID: "com.apple.voice.enhanced.en-US.Alex",
            fallbackVoiceIDs: ["com.apple.voice.enhanced.en-US.Nicky"],
            language: "en-US"
        ),
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .neutral,
        age: .adult,
        style: .conversational,
        category: .podcast,
        voiceDescription: "Warm, conversational tone like your favorite podcast host. Natural flow keeps content engaging and easy to listen to.",
        tier: .free,
        requiresDownload: true,
        styleParameters: StyleParameters(
            speakingRate: 1.0,
            pitch: 1.0,
            volume: 1.0,
            emphasis: 0.55,
            pauseDuration: 1.0,
            expressiveness: 0.6,
            warmth: 0.7,
            clarity: 0.75
        ),
        emotion: .friendly,
        iconName: "mic.fill",
        accentColorHex: "#F59E0B",
        sampleText: "Hey there! Thanks for tuning in. Today we're going to have a great conversation about something I've been really excited to share with you."
    )
}

// MARK: - Preset Collections

extension VoicePreset {

    /// All built-in presets.
    static var allBuiltInPresets: [VoicePreset] {
        [
            .narrator,
            .calmTeacher,
            .santaStoryteller,
            .energeticYouTuber,
            .storyteller,
            .bedtimeReader,
            .newsAnchor,
            .podcastHost
        ]
    }

    /// Free presets (can use on-device voices).
    static var freePresets: [VoicePreset] {
        allBuiltInPresets.filter { $0.tier == .free }
    }

    /// Premium presets (require cloud voices for full experience).
    static var premiumPresets: [VoicePreset] {
        allBuiltInPresets.filter { $0.tier == .premium }
    }

    /// Character voice presets.
    static var characterPresets: [VoicePreset] {
        allBuiltInPresets.filter { $0.isCharacterVoice }
    }

    /// Presets by category.
    static func presets(for category: VoiceCategory) -> [VoicePreset] {
        allBuiltInPresets.filter { $0.category == category }
    }

    /// Get default preset.
    static var defaultPreset: VoicePreset {
        .narrator
    }
}
