import Foundation
import AVFoundation

// MARK: - Voice Provider

enum VoiceProvider: String, Codable, CaseIterable, Sendable {
    case apple
    case elevenLabs
    case openAI
    case googleCloud
    case amazonPolly
    case selfhosted  // Self-hosted TTS (Coqui XTTS v2)

    var displayName: String {
        switch self {
        case .apple: return "Apple"
        case .elevenLabs: return "ElevenLabs"
        case .openAI: return "OpenAI"
        case .googleCloud: return "Google Cloud"
        case .amazonPolly: return "Amazon Polly"
        case .selfhosted: return "ReadAloud AI"
        }
    }

    var isCloudBased: Bool {
        self != .apple
    }

    /// Whether this provider is our own infrastructure (not third-party)
    var isSelfHosted: Bool {
        self == .selfhosted
    }

    var iconName: String {
        switch self {
        case .apple: return "apple.logo"
        case .elevenLabs: return "waveform"
        case .openAI: return "brain"
        case .googleCloud: return "cloud"
        case .amazonPolly: return "speaker.wave.3"
        case .selfhosted: return "server.rack"
        }
    }
}

// MARK: - Voice Quality

/// Voice quality level - determines which TTS provider to use
enum VoiceQuality: String, Codable, CaseIterable, Sendable {
    case standard   // Self-hosted Kokoro - fast, free, natural
    case premium    // ElevenLabs - highest quality, quota-limited

    var displayName: String {
        switch self {
        case .standard: return "Standard"
        case .premium: return "Premium"
        }
    }

    var description: String {
        switch self {
        case .standard: return "Fast, natural AI voices"
        case .premium: return "Studio-quality voices"
        }
    }

    var iconName: String {
        switch self {
        case .standard: return "bolt.fill"
        case .premium: return "sparkles"
        }
    }

    var badgeColor: String {
        switch self {
        case .standard: return "#10B981"  // Green
        case .premium: return "#F59E0B"   // Gold
        }
    }

    /// The provider used for this quality level
    var provider: VoiceProvider {
        switch self {
        case .standard: return .selfhosted
        case .premium: return .elevenLabs
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

    /// Daily premium samples allowed for this tier
    var dailyPremiumSamples: Int {
        switch self {
        case .free: return 3
        case .premium: return 30
        case .enterprise: return .max
        }
    }

    /// Daily premium character limit for this tier
    var dailyPremiumCharacters: Int {
        switch self {
        case .free: return 5_000
        case .premium: return 50_000
        case .enterprise: return .max
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
struct OnDeviceVoiceMapping: Hashable, Sendable {
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
}

extension OnDeviceVoiceMapping: Codable {
    enum CodingKeys: String, CodingKey {
        case primaryVoiceID, fallbackVoiceIDs, language, minimumQuality
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        primaryVoiceID = try container.decode(String.self, forKey: .primaryVoiceID)
        fallbackVoiceIDs = try container.decodeIfPresent([String].self, forKey: .fallbackVoiceIDs) ?? []
        language = try container.decodeIfPresent(String.self, forKey: .language) ?? "en-US"
        let qualityRaw = try container.decodeIfPresent(Int.self, forKey: .minimumQuality) ?? 1
        minimumQuality = AVSpeechSynthesisVoiceQuality(rawValue: qualityRaw) ?? .default
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(primaryVoiceID, forKey: .primaryVoiceID)
        try container.encode(fallbackVoiceIDs, forKey: .fallbackVoiceIDs)
        try container.encode(language, forKey: .language)
        try container.encode(minimumQuality.rawValue, forKey: .minimumQuality)
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

    // Provider info (for premium quality - ElevenLabs/OpenAI)
    var provider: VoiceProvider
    var providerVoiceID: String
    var providerModelID: String?

    // Self-hosted voice ID (for standard quality - Kokoro)
    var kokoroVoiceID: String?

    // On-device fallback (deprecated - we don't use Apple voices)
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

    /// Face/avatar emoji for the voice (used in voice picker)
    var avatarEmoji: String?

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

    /// Whether this voice supports standard quality (self-hosted Kokoro)
    var supportsStandardQuality: Bool {
        kokoroVoiceID != nil
    }

    /// Whether this voice supports premium quality (ElevenLabs/OpenAI)
    var supportsPremiumQuality: Bool {
        provider == .elevenLabs || provider == .openAI
    }

    /// Available quality levels for this voice
    var availableQualities: [VoiceQuality] {
        var qualities: [VoiceQuality] = []
        if supportsStandardQuality {
            qualities.append(.standard)
        }
        if supportsPremiumQuality {
            qualities.append(.premium)
        }
        return qualities
    }

    /// Whether this voice is premium-only (no standard quality available)
    var isPremiumOnly: Bool {
        !supportsStandardQuality && supportsPremiumQuality
    }

    /// Get the voice ID for a specific quality level
    func voiceID(for quality: VoiceQuality) -> String? {
        switch quality {
        case .standard:
            return kokoroVoiceID
        case .premium:
            return providerVoiceID
        }
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
        kokoroVoiceID: String? = nil,
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
        avatarEmoji: String? = nil,
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
        self.kokoroVoiceID = kokoroVoiceID
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
        self.avatarEmoji = avatarEmoji
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

    // MARK: - Adam Preset (Narrator)

    /// Adam - Professional narrator voice for articles and books.
    static let narrator = VoicePreset(
        name: "Adam",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "pNInz6obpgDQGcFmaJgB", // Adam voice
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "am_adam", // Kokoro American male - Adam
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB", "en-AU"],
        gender: .male,
        age: .adult,
        style: .narrative,
        category: .narrator,
        voiceDescription: "Professional, clear narrator perfect for articles, news, and long-form content. Balanced pace with natural expression.",
        tier: .free,
        styleParameters: .narrator,
        emotion: .neutral,
        cloudSettings: .narrative,
        iconName: "book.fill",
        accentColorHex: "#3B82F6",
        avatarEmoji: "👨‍💼",
        sampleText: "Welcome to today's article. Let me guide you through this fascinating story with clarity and engagement."
    )

    // Alias for backward compatibility
    static let adam = narrator

    // MARK: - Bella Preset (Calm Teacher)

    /// Bella - Soothing educational voice for learning content.
    static let calmTeacher = VoicePreset(
        name: "Bella",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "EXAVITQu4vr4xnSDxMaL", // Bella voice
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "af_bella", // Kokoro American female - Bella
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .female,
        age: .adult,
        style: .educational,
        category: .educator,
        voiceDescription: "Patient, warm voice ideal for educational content. Slower pace with clear enunciation helps with comprehension and retention.",
        tier: .free,
        styleParameters: .calmTeacher,
        emotion: .calm,
        cloudSettings: .calm,
        iconName: "graduationcap.fill",
        accentColorHex: "#10B981",
        avatarEmoji: "👩‍🏫",
        sampleText: "Let's explore this concept together. Take your time to absorb each idea as we go through this material."
    )

    // Alias for backward compatibility
    static let bella = calmTeacher

    // MARK: - Josh Preset (Storyteller)

    /// Josh - Classic storyteller for audiobooks.
    static let storyteller = VoicePreset(
        name: "Josh",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "TxGEqnHWrfWFTfGW9XjX", // Josh voice
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "am_michael", // Kokoro American male - Michael
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .male,
        age: .adult,
        style: .dramatic,
        category: .audiobook,
        voiceDescription: "Rich, dramatic narrator voice that brings stories to life. Uses varied intonation and dramatic pauses for maximum impact.",
        tier: .free,
        styleParameters: .dramatic,
        emotion: .neutral,
        cloudSettings: .narrative,
        characterID: "storyteller",
        characterDescription: "A captivating narrator for immersive storytelling",
        specialInstructions: "Use dramatic pauses and varied intonation",
        iconName: "book.closed.fill",
        accentColorHex: "#8B5CF6",
        avatarEmoji: "🧙‍♂️",
        sampleText: "Once upon a time, in a land far, far away, there lived a hero whose destiny would change the world forever..."
    )

    // Alias for backward compatibility
    static let josh = storyteller

    // MARK: - Elli Preset (Bedtime Reader)

    /// Elli - Soothing voice for meditation and sleep content.
    static let bedtimeReader = VoicePreset(
        name: "Elli",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "MF3mGyEYCl7XYWbV9V6O", // Elli voice
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "af_sarah", // Kokoro American female - Sarah
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .female,
        age: .adult,
        style: .calm,
        category: .meditation,
        voiceDescription: "Soft, soothing voice perfect for bedtime stories and relaxation. Gentle pace helps you wind down and drift off peacefully.",
        tier: .free,
        styleParameters: .soothing,
        emotion: .calm,
        cloudSettings: .calm,
        characterID: "bedtime",
        characterDescription: "A gentle voice to help you drift off to sleep",
        specialInstructions: "Speak softly and slowly with gentle intonation",
        iconName: "moon.stars.fill",
        accentColorHex: "#6366F1",
        avatarEmoji: "🧘‍♀️",
        sampleText: "Close your eyes and let your thoughts drift away. Tonight, I'll take you on a peaceful journey through dreamland..."
    )

    // Alias for backward compatibility
    static let elli = bedtimeReader

    // MARK: - Additional Popular ElevenLabs Voices

    /// Rachel - Clear, warm female voice (most popular ElevenLabs voice)
    static let rachel = VoicePreset(
        name: "Rachel",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "21m00Tcm4TlvDq8ikWAM",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "af_nicole", // Kokoro American female - Nicole
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB", "es", "fr", "de", "it", "pt", "pl", "hi"],
        gender: .female,
        age: .adult,
        style: .conversational,
        category: .narrator,
        voiceDescription: "Clear, warm and friendly. One of the most popular voices for audiobooks and narration.",
        tier: .free,
        styleParameters: .narrator,
        emotion: .warm,
        cloudSettings: .narrative,
        iconName: "person.fill",
        accentColorHex: "#EC4899",
        avatarEmoji: "👩‍🦰",
        sampleText: "Hello! I'm Rachel. I have a clear and warm voice that's perfect for bringing your stories to life."
    )

    /// Brian - Deep British male voice
    static let brian = VoicePreset(
        name: "Brian",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "nPczCjzI2devNBz1zQrb",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "bm_george", // Kokoro British male - George
        language: "en-GB",
        supportedLanguages: ["en-GB", "en-US"],
        gender: .male,
        age: .adult,
        style: .narrative,
        category: .narrator,
        voiceDescription: "Deep, resonant British voice. Perfect for documentaries and authoritative narration.",
        tier: .free,
        styleParameters: .narrator,
        emotion: .neutral,
        cloudSettings: .narrative,
        iconName: "person.fill",
        accentColorHex: "#1E3A8A",
        avatarEmoji: "🧔",
        sampleText: "Good day. I'm Brian, and I'll be your guide through this fascinating journey."
    )

    /// Charlotte - Elegant Swedish-English female voice
    static let charlotte = VoicePreset(
        name: "Charlotte",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "XB0fDUnXU5powFXDhCwa",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "bf_emma", // Kokoro British female - Emma
        language: "en-US",
        supportedLanguages: ["en-US", "sv", "de", "fr"],
        gender: .female,
        age: .adult,
        style: .conversational,
        category: .podcast,
        voiceDescription: "Elegant and articulate with a slight European flair. Great for educational content.",
        tier: .free,
        styleParameters: .calmTeacher,
        emotion: .neutral,
        cloudSettings: .narrative,
        iconName: "person.fill",
        accentColorHex: "#7C3AED",
        avatarEmoji: "👩‍💼",
        sampleText: "Hello, I'm Charlotte. Let me take you through this content with clarity and elegance."
    )

    /// George - Warm British male voice
    static let george = VoicePreset(
        name: "George",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "JBFqnCBsd6RMkjVDRZzb",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "bm_lewis", // Kokoro British male - Lewis
        language: "en-GB",
        supportedLanguages: ["en-GB", "en-US"],
        gender: .male,
        age: .adult,
        style: .conversational,
        category: .narrator,
        voiceDescription: "Warm, friendly British voice. Perfect for stories and conversational content.",
        tier: .free,
        styleParameters: StyleParameters(
            speakingRate: 0.95,
            pitch: 1.0,
            volume: 1.0,
            emphasis: 0.6,
            pauseDuration: 1.1,
            expressiveness: 0.65,
            warmth: 0.8,
            clarity: 0.8
        ),
        emotion: .warm,
        cloudSettings: .narrative,
        iconName: "person.fill",
        accentColorHex: "#059669",
        avatarEmoji: "👨‍🦱",
        sampleText: "Hello there! I'm George. Let me share this wonderful story with you."
    )

    /// Lily - Warm British female voice
    static let lily = VoicePreset(
        name: "Lily",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "pFZP5JQG7iQjIQuC4Bku",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "bf_isabella", // Kokoro British female - Isabella
        language: "en-GB",
        supportedLanguages: ["en-GB", "en-US"],
        gender: .female,
        age: .adult,
        style: .conversational,
        category: .narrator,
        voiceDescription: "Warm and expressive British female voice. Great for audiobooks and storytelling.",
        tier: .free,
        styleParameters: .narrator,
        emotion: .warm,
        cloudSettings: .narrative,
        iconName: "person.fill",
        accentColorHex: "#DB2777",
        avatarEmoji: "👩",
        sampleText: "Hello! I'm Lily. I love bringing stories to life with warmth and expression."
    )

    /// Matilda - Warm Australian female voice
    static let matilda = VoicePreset(
        name: "Matilda",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "XrExE9yKIg1WjnnlVkGX",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "af_sky", // Kokoro American female - Sky (closest match)
        language: "en-AU",
        supportedLanguages: ["en-AU", "en-US", "en-GB"],
        gender: .female,
        age: .adult,
        style: .friendly,
        category: .narrator,
        voiceDescription: "Friendly and warm Australian voice. Perfect for approachable, engaging content.",
        tier: .free,
        styleParameters: StyleParameters(
            speakingRate: 1.0,
            pitch: 1.0,
            volume: 1.0,
            emphasis: 0.55,
            pauseDuration: 1.0,
            expressiveness: 0.65,
            warmth: 0.85,
            clarity: 0.8
        ),
        emotion: .warm,
        cloudSettings: .narrative,
        iconName: "person.fill",
        accentColorHex: "#F97316",
        avatarEmoji: "👱‍♀️",
        sampleText: "G'day! I'm Matilda. Let me take you through this with a friendly Aussie touch."
    )

    /// Bill - Deep, authoritative American male voice
    static let bill = VoicePreset(
        name: "Bill",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "pqHfZKP75CvOlQylNhV4",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "am_michael", // Kokoro American male - Michael
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .male,
        age: .adult,
        style: .serious,
        category: .news,
        voiceDescription: "Deep, authoritative American voice. Perfect for news and documentary narration.",
        tier: .free,
        styleParameters: .professional,
        emotion: .neutral,
        cloudSettings: CloudVoiceSettings(
            stability: 0.75,
            similarityBoost: 0.8,
            style: 0.2,
            useSpeakerBoost: true,
            modelID: nil
        ),
        iconName: "person.fill",
        accentColorHex: "#1F2937",
        avatarEmoji: "🧑‍⚖️",
        sampleText: "Good evening. I'm Bill, bringing you the latest news and in-depth analysis."
    )

    /// Dorothy - Friendly, pleasant female voice
    static let dorothy = VoicePreset(
        name: "Dorothy",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "ThT5KcBeYPX3keUQqHPh",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "af_heart", // Kokoro American female - Heart (default, warm)
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .female,
        age: .adult,
        style: .friendly,
        category: .narrator,
        voiceDescription: "Friendly and pleasant voice with a warm tone. Great for children's content.",
        tier: .free,
        styleParameters: StyleParameters(
            speakingRate: 0.95,
            pitch: 1.02,
            volume: 1.0,
            emphasis: 0.6,
            pauseDuration: 1.1,
            expressiveness: 0.7,
            warmth: 0.9,
            clarity: 0.8
        ),
        emotion: .cheerful,
        cloudSettings: .narrative,
        iconName: "person.fill",
        accentColorHex: "#A855F7",
        avatarEmoji: "👵",
        sampleText: "Hello there! I'm Dorothy. I just love sharing wonderful stories with you!"
    )

    /// Arnold - Deep, powerful male voice
    static let arnold = VoicePreset(
        name: "Arnold",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .elevenLabs,
        providerVoiceID: "VR6AewLTigWG4xSOukaG",
        providerModelID: "eleven_multilingual_v2",
        kokoroVoiceID: "am_adam", // Kokoro American male - Adam
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .male,
        age: .adult,
        style: .serious,
        category: .narrator,
        voiceDescription: "Deep, powerful voice with gravitas. Great for dramatic content and trailers.",
        tier: .free,
        styleParameters: .dramatic,
        emotion: .neutral,
        cloudSettings: CloudVoiceSettings(
            stability: 0.65,
            similarityBoost: 0.8,
            style: 0.4,
            useSpeakerBoost: true,
            modelID: nil
        ),
        iconName: "person.fill",
        accentColorHex: "#374151",
        avatarEmoji: "💪",
        sampleText: "In a world where stories come to life... let me take you on an epic journey."
    )
}

// MARK: - Preset Collections

extension VoicePreset {

    /// Popular presets - shown by default in voice picker.
    /// Prioritizes voices with selfhosted (Kokoro) support for cost efficiency.
    static var popularPresets: [VoicePreset] {
        [
            .adamKokoro,   // Default selfhosted voice
            .narrator,     // Adam (has Kokoro fallback)
            .calmTeacher,  // Bella (has Kokoro fallback)
            .brian,        // Popular British male (has Kokoro fallback)
            .charlotte,    // Elegant female (has Kokoro fallback)
            .george,       // Warm British male (has Kokoro fallback)
            .storyteller,  // Josh (has Kokoro fallback)
            .matilda,      // Australian female (has Kokoro fallback)
            .bill,         // Authoritative male (has Kokoro fallback)
            .bedtimeReader // Elli (has Kokoro fallback)
        ]
    }

    /// All built-in presets.
    /// Only includes voices with Kokoro (selfhosted) support for reliable, unlimited TTS.
    static var allBuiltInPresets: [VoicePreset] {
        [
            // Selfhosted default
            .adamKokoro,
            // Voices with Kokoro/selfhosted support (all free tier)
            .narrator,
            .calmTeacher,
            .brian,
            .charlotte,
            .george,
            .lily,
            .matilda,
            .bill,
            .dorothy,
            .arnold,
            .storyteller,
            .bedtimeReader
            // Premium-only voices removed - ElevenLabs has quota limits
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
    /// Uses selfhosted (Kokoro) provider by default for cost efficiency.
    static var defaultPreset: VoicePreset {
        .adamKokoro // Adam Kokoro voice is the default
    }

    /// Adam voice using Kokoro (selfhosted) provider - the default voice.
    static let adamKokoro = VoicePreset(
        name: "Adam",
        isBuiltIn: true,
        isCharacterVoice: false,
        provider: .selfhosted,
        providerVoiceID: "am_adam",
        providerModelID: nil,
        kokoroVoiceID: "am_adam",
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .male,
        age: .adult,
        style: .narrative,
        category: .narrator,
        voiceDescription: "Professional, clear narrator perfect for articles, news, and long-form content.",
        tier: .free,
        styleParameters: .narrator,
        emotion: .neutral,
        iconName: "book.fill",
        accentColorHex: "#3B82F6",
        avatarEmoji: "👨‍💼",
        sampleText: "Welcome to today's article. Let me guide you through this fascinating story."
    )

    /// Default Apple voice - used as fallback when no voices are loaded.
    static var defaultAppleVoice: VoicePreset {
        // Try to get the first available system voice
        if let systemVoice = AVSpeechSynthesisVoice(language: "en-US") {
            return VoicePreset(
                name: systemVoice.name,
                isBuiltIn: true,
                provider: .apple,
                providerVoiceID: systemVoice.identifier,
                language: "en-US",
                supportedLanguages: ["en-US"],
                gender: .neutral,
                category: .narrator,
                voiceDescription: "Default Apple voice",
                tier: .free,
                sampleText: "Hello, this is the default voice."
            )
        }

        // Absolute fallback - create a preset that will use any available voice
        return VoicePreset(
            name: "Default Voice",
            isBuiltIn: true,
            provider: .apple,
            providerVoiceID: "com.apple.ttsbundle.Samantha-compact",
            language: "en-US",
            supportedLanguages: ["en-US"],
            gender: .female,
            category: .narrator,
            voiceDescription: "Default Apple voice",
            tier: .free,
            sampleText: "Hello, this is the default voice."
        )
    }
}
