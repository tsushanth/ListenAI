import Foundation

// MARK: - Synthesis Options

struct SynthesisOptions: Sendable {
    /// Playback speed multiplier (0.5 - 3.0, where 1.0 is normal)
    var speed: Float

    /// Pitch multiplier (0.5 - 2.0, where 1.0 is normal)
    var pitch: Float

    /// Volume level (0.0 - 1.0)
    var volume: Float

    /// Output audio format
    var outputFormat: AudioFormat

    /// Synthesis quality level
    var quality: SynthesisQuality

    /// Enable SSML processing if supported
    var enableSSML: Bool

    /// Maximum characters per synthesis chunk (for cloud APIs)
    var chunkSize: Int?

    /// Whether to generate word-level timestamps
    var generateWordTimestamps: Bool

    /// Whether to generate section timestamps
    var generateSectionTimestamps: Bool

    static let `default` = SynthesisOptions(
        speed: 1.0,
        pitch: 1.0,
        volume: 1.0,
        outputFormat: .m4a,
        quality: .standard,
        enableSSML: false,
        chunkSize: nil,
        generateWordTimestamps: false,
        generateSectionTimestamps: true
    )

    static func withSpeed(_ speed: Float) -> SynthesisOptions {
        var options = SynthesisOptions.default
        options.speed = speed
        return options
    }
}

// MARK: - Audio Format

enum AudioFormat: String, Codable, CaseIterable, Sendable {
    case m4a
    case mp3
    case wav
    case opus
    case aac

    var fileExtension: String {
        rawValue
    }

    var mimeType: String {
        switch self {
        case .m4a: return "audio/mp4"
        case .mp3: return "audio/mpeg"
        case .wav: return "audio/wav"
        case .opus: return "audio/opus"
        case .aac: return "audio/aac"
        }
    }
}

// MARK: - Synthesis Quality

enum SynthesisQuality: String, Codable, CaseIterable, Sendable {
    case draft // Fast, lower quality
    case standard // Balanced
    case high // Best quality, slower

    var displayName: String {
        rawValue.capitalized
    }
}

// MARK: - Synthesis Result

struct SynthesisResult: Sendable {
    /// URL to the generated audio file
    let audioFileURL: URL

    /// Total duration of the audio
    let duration: TimeInterval

    /// Timestamps for each section (for navigation)
    let sectionTimestamps: [SectionTimestamp]

    /// Word-level timestamps (for highlighting, optional)
    let wordTimestamps: [WordTimestamp]?

    /// File size in bytes
    let fileSizeBytes: Int64

    /// Cost information (for cloud synthesis)
    let cost: SynthesisCost?

    /// Additional metadata
    let metadata: SynthesisMetadata
}

// MARK: - Section Timestamp

struct SectionTimestamp: Codable, Sendable {
    let sectionIndex: Int
    let startTime: TimeInterval
    let endTime: TimeInterval

    var duration: TimeInterval {
        endTime - startTime
    }
}

// MARK: - Word Timestamp

struct WordTimestamp: Codable, Sendable {
    let word: String
    let startTime: TimeInterval
    let endTime: TimeInterval
    let sectionIndex: Int
    let characterRange: Range<Int>
}

// MARK: - Synthesis Cost

struct SynthesisCost: Codable, Sendable {
    let charactersUsed: Int
    let costUSD: Decimal
    let quotaUsed: Int
    let provider: String
}

// MARK: - Synthesis Metadata

struct SynthesisMetadata: Codable, Sendable {
    let voiceID: UUID
    let voiceName: String
    let provider: VoiceProvider
    let startedAt: Date
    let completedAt: Date
    let inputCharacterCount: Int
    let outputSampleRate: Int
    let processingTimeSeconds: TimeInterval

    var processingRatio: Double {
        guard processingTimeSeconds > 0 else { return 0 }
        return duration / processingTimeSeconds
    }

    private var duration: TimeInterval {
        completedAt.timeIntervalSince(startedAt)
    }
}

// MARK: - Synthesis Progress

struct SynthesisProgress: Sendable {
    /// Overall progress (0.0 - 1.0)
    let overallProgress: Float

    /// Current section being processed
    let currentSectionIndex: Int

    /// Number of sections completed
    let sectionsCompleted: Int

    /// Total number of sections
    let totalSections: Int

    /// Estimated time remaining
    let estimatedTimeRemaining: TimeInterval?

    /// Current status message
    let statusMessage: String

    /// Characters processed so far
    let charactersProcessed: Int

    /// Total characters to process
    let totalCharacters: Int

    static let initial = SynthesisProgress(
        overallProgress: 0,
        currentSectionIndex: 0,
        sectionsCompleted: 0,
        totalSections: 0,
        estimatedTimeRemaining: nil,
        statusMessage: "Preparing...",
        charactersProcessed: 0,
        totalCharacters: 0
    )
}

// MARK: - Synthesis Estimate

struct SynthesisEstimate: Sendable {
    /// Estimated audio duration
    let estimatedDuration: TimeInterval

    /// Estimated processing time
    let estimatedProcessingTime: TimeInterval

    /// Total character count
    let characterCount: Int

    /// Estimated cost in USD (for cloud voices)
    let estimatedCostUSD: Decimal?

    /// Impact on user's quota
    let quotaImpact: QuotaImpact?
}

// MARK: - Quota Impact

struct QuotaImpact: Codable, Sendable {
    let minutesUsed: Int
    let minutesRemaining: Int
    let percentageOfQuota: Float
    let willExceedQuota: Bool
}

// MARK: - Audio Chunk (for streaming)

struct AudioChunk: Sendable {
    let data: Data
    let timestamp: TimeInterval
    let isFinal: Bool
    let chunkIndex: Int
}

// MARK: - Text Section (input for synthesis)

struct TextSection: Identifiable, Sendable {
    let id: UUID
    let index: Int
    let type: SectionType
    let text: String
    let characterRange: Range<Int>

    init(
        id: UUID = UUID(),
        index: Int,
        type: SectionType = .paragraph,
        text: String,
        characterRange: Range<Int>
    ) {
        self.id = id
        self.index = index
        self.type = type
        self.text = text
        self.characterRange = characterRange
    }
}

// MARK: - Section Type

enum SectionType: String, Codable, CaseIterable, Sendable {
    case title
    case heading
    case paragraph
    case blockquote
    case listItem
    case codeBlock
    case caption
    case footnote

    /// Whether this section type should be spoken
    var shouldSpeak: Bool {
        switch self {
        case .codeBlock:
            return false // Often skip code blocks
        default:
            return true
        }
    }

    /// Suggested pause duration after this section type
    var pauseAfterSeconds: TimeInterval {
        switch self {
        case .title: return 1.0
        case .heading: return 0.8
        case .paragraph: return 0.5
        case .blockquote: return 0.6
        case .listItem: return 0.3
        case .codeBlock: return 0.5
        case .caption: return 0.4
        case .footnote: return 0.5
        }
    }
}

// MARK: - TTS Error

enum TTSError: LocalizedError, Sendable {
    case voiceNotAvailable(voiceName: String)
    case voiceDownloadRequired(voiceName: String, sizeBytes: Int64)
    case textTooLong(characterCount: Int, limit: Int)
    case textEmpty
    case quotaExceeded(remaining: Int, required: Int)
    case networkError(underlying: String)
    case apiError(provider: String, code: Int, message: String)
    case rateLimited(retryAfter: TimeInterval)
    case audioEncodingFailed(reason: String)
    case audioWriteFailed(reason: String)
    case cancelled
    case subscriptionRequired(tier: VoiceTier)
    case invalidConfiguration(reason: String)
    case synthesisTimeout
    case unsupportedLanguage(language: String)
    case internalError(reason: String)

    var errorDescription: String? {
        switch self {
        case .voiceNotAvailable(let name):
            return "Voice '\(name)' is not available on this device."
        case .voiceDownloadRequired(let name, let size):
            let sizeStr = ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
            return "Voice '\(name)' requires download (\(sizeStr))."
        case .textTooLong(let count, let limit):
            return "Text is too long (\(count) characters). Maximum is \(limit)."
        case .textEmpty:
            return "Cannot synthesize empty text."
        case .quotaExceeded(let remaining, let required):
            return "Quota exceeded. You have \(remaining) characters remaining, but need \(required)."
        case .networkError(let underlying):
            return "Network error: \(underlying)"
        case .apiError(let provider, let code, let message):
            return "\(provider) API error (\(code)): \(message)"
        case .rateLimited(let retryAfter):
            return "Rate limited. Please try again in \(Int(retryAfter)) seconds."
        case .audioEncodingFailed(let reason):
            return "Failed to encode audio: \(reason)"
        case .audioWriteFailed(let reason):
            return "Failed to write audio file: \(reason)"
        case .cancelled:
            return "Synthesis was cancelled."
        case .subscriptionRequired(let tier):
            return "This voice requires a \(tier.displayName) subscription."
        case .invalidConfiguration(let reason):
            return "Invalid configuration: \(reason)"
        case .synthesisTimeout:
            return "Synthesis timed out."
        case .unsupportedLanguage(let language):
            return "Language '\(language)' is not supported by this voice."
        case .internalError(let reason):
            return "Internal error: \(reason)"
        }
    }
}
