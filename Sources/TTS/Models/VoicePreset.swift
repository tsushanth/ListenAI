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
}

// MARK: - Voice Gender

enum VoiceGender: String, Codable, CaseIterable, Sendable {
    case male
    case female
    case neutral

    var displayName: String {
        rawValue.capitalized
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

    var displayName: String {
        rawValue.capitalized
    }
}

// MARK: - Voice Emotion (for character voices)

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

    var displayName: String {
        rawValue.capitalized
    }
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

    // Character-specific presets
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

    // Characteristics
    var language: String // Locale identifier like "en-US"
    var supportedLanguages: [String]
    var gender: VoiceGender
    var age: VoiceAge
    var style: VoiceStyle
    var voiceDescription: String

    // Tier & Access
    var tier: VoiceTier
    var requiresDownload: Bool
    var downloadSizeBytes: Int64?
    var isDownloaded: Bool

    // Customization defaults
    var defaultSpeed: Float // 0.5 - 3.0, where 1.0 is normal
    var defaultPitch: Float // 0.5 - 2.0, where 1.0 is normal
    var defaultVolume: Float // 0.0 - 1.0
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

    // MARK: - Initialization

    init(
        id: UUID = UUID(),
        name: String,
        isBuiltIn: Bool = true,
        isCharacterVoice: Bool = false,
        provider: VoiceProvider,
        providerVoiceID: String,
        providerModelID: String? = nil,
        language: String = "en-US",
        supportedLanguages: [String] = ["en-US"],
        gender: VoiceGender = .neutral,
        age: VoiceAge = .adult,
        style: VoiceStyle = .neutral,
        voiceDescription: String = "",
        tier: VoiceTier = .free,
        requiresDownload: Bool = false,
        downloadSizeBytes: Int64? = nil,
        isDownloaded: Bool = true,
        defaultSpeed: Float = 1.0,
        defaultPitch: Float = 1.0,
        defaultVolume: Float = 1.0,
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
        self.language = language
        self.supportedLanguages = supportedLanguages
        self.gender = gender
        self.age = age
        self.style = style
        self.voiceDescription = voiceDescription
        self.tier = tier
        self.requiresDownload = requiresDownload
        self.downloadSizeBytes = downloadSizeBytes
        self.isDownloaded = isDownloaded
        self.defaultSpeed = defaultSpeed
        self.defaultPitch = defaultPitch
        self.defaultVolume = defaultVolume
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
}

// MARK: - Factory Methods for Common Voices

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
            voiceDescription: "Apple \(isEnhanced ? "Enhanced" : "Standard") Voice",
            tier: .free,
            requiresDownload: isEnhanced,
            isDownloaded: true, // Will be checked separately
            sampleText: "Hello, my name is \(voice.name)."
        )
    }

    // MARK: - Character Voice Presets

    static let santa = VoicePreset(
        name: "Santa Claus",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "santa_voice_id",
        providerModelID: "eleven_multilingual_v2",
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .male,
        age: .senior,
        style: .character,
        voiceDescription: "Jolly, warm voice of Santa Claus with a hearty laugh",
        tier: .premium,
        defaultSpeed: 0.9,
        defaultPitch: 0.95,
        emotion: .happy,
        cloudSettings: CloudVoiceSettings(
            stability: 0.6,
            similarityBoost: 0.8,
            style: 0.4,
            useSpeakerBoost: true,
            modelID: "eleven_multilingual_v2"
        ),
        characterID: "santa",
        characterDescription: "The warm, jolly voice of Santa Claus",
        specialInstructions: "Speak with warmth and occasional 'ho ho ho' energy",
        iconName: "gift.fill",
        accentColorHex: "#C41E3A",
        sampleText: "Ho ho ho! Let me read this wonderful story for you!"
    )

    static let storyteller = VoicePreset(
        name: "The Storyteller",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "storyteller_voice_id",
        providerModelID: "eleven_multilingual_v2",
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .male,
        age: .adult,
        style: .narrative,
        voiceDescription: "Rich, dramatic narrator voice perfect for stories",
        tier: .premium,
        defaultSpeed: 0.95,
        defaultPitch: 1.0,
        emotion: .calm,
        cloudSettings: .narrative,
        characterID: "storyteller",
        characterDescription: "A captivating narrator for immersive storytelling",
        specialInstructions: "Use dramatic pauses and varied intonation",
        iconName: "book.fill",
        accentColorHex: "#8B4513",
        sampleText: "Once upon a time, in a land far, far away..."
    )

    static let professor = VoicePreset(
        name: "The Professor",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .apple,
        providerVoiceID: "com.apple.voice.enhanced.en-US.evan",
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .male,
        age: .adult,
        style: .educational,
        voiceDescription: "Clear, authoritative voice for educational content",
        tier: .free,
        requiresDownload: true,
        defaultSpeed: 0.95,
        defaultPitch: 1.0,
        emotion: .neutral,
        characterID: "professor",
        characterDescription: "An articulate educator explaining complex topics",
        iconName: "graduationcap.fill",
        accentColorHex: "#1E3A5F",
        sampleText: "Let me explain this concept in detail."
    )

    static let bedtime = VoicePreset(
        name: "Bedtime Reader",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .elevenLabs,
        providerVoiceID: "bedtime_voice_id",
        providerModelID: "eleven_multilingual_v2",
        language: "en-US",
        supportedLanguages: ["en-US", "en-GB"],
        gender: .female,
        age: .adult,
        style: .calm,
        voiceDescription: "Soft, soothing voice perfect for bedtime stories",
        tier: .premium,
        defaultSpeed: 0.85,
        defaultPitch: 0.95,
        defaultVolume: 0.8,
        emotion: .calm,
        cloudSettings: CloudVoiceSettings(
            stability: 0.8,
            similarityBoost: 0.7,
            style: 0.2,
            useSpeakerBoost: false,
            modelID: "eleven_multilingual_v2"
        ),
        characterID: "bedtime",
        characterDescription: "A gentle voice to help you drift off to sleep",
        specialInstructions: "Speak softly and slowly with gentle intonation",
        iconName: "moon.stars.fill",
        accentColorHex: "#4A5568",
        sampleText: "Close your eyes and let me take you on a peaceful journey..."
    )

    static let newsAnchor = VoicePreset(
        name: "News Anchor",
        isBuiltIn: true,
        isCharacterVoice: true,
        provider: .openAI,
        providerVoiceID: "onyx",
        providerModelID: "tts-1-hd",
        language: "en-US",
        supportedLanguages: ["en-US"],
        gender: .male,
        age: .adult,
        style: .news,
        voiceDescription: "Professional broadcast voice for news and articles",
        tier: .premium,
        defaultSpeed: 1.05,
        defaultPitch: 1.0,
        emotion: .serious,
        characterID: "news",
        characterDescription: "A professional news broadcaster",
        iconName: "newspaper.fill",
        accentColorHex: "#2B6CB0",
        sampleText: "Good evening. Here are tonight's top stories."
    )
}

// MARK: - Voice Preset Collections

extension VoicePreset {

    static var allCharacterVoices: [VoicePreset] {
        [.santa, .storyteller, .professor, .bedtime, .newsAnchor]
    }

    static var freeCharacterVoices: [VoicePreset] {
        allCharacterVoices.filter { $0.tier == .free }
    }

    static var premiumCharacterVoices: [VoicePreset] {
        allCharacterVoices.filter { $0.tier == .premium }
    }
}
