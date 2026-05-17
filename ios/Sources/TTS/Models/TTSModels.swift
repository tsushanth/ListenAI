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

// MARK: - Job-Based TTS API Models

/// Status of a TTS job in the processing pipeline
enum TTSJobStatus: String, Codable, Sendable {
    case queued = "queued"
    case processing = "processing"
    case partialReady = "partial_ready"
    case ready = "ready"
    case failed = "failed"
    case cancelled = "canceled"

    /// Whether the job is still in progress (not terminal)
    var isInProgress: Bool {
        switch self {
        case .queued, .processing, .partialReady:
            return true
        case .ready, .failed, .cancelled:
            return false
        }
    }

    /// Whether the job has completed successfully
    var isComplete: Bool {
        self == .ready
    }

    /// Whether there's audio available to play (preview or full)
    var hasAudio: Bool {
        switch self {
        case .partialReady, .ready:
            return true
        default:
            return false
        }
    }
}

/// Response from POST /api/tts when using job-based API
/// Returns either immediate audio (status: ready) or a job ID to poll (status: processing)
struct TTSJobStartResponse: Codable, Sendable {
    /// Job status - "ready" means audio is immediately available, "processing" means poll for status
    let status: TTSJobStatus

    /// Unique job identifier for polling
    let jobId: String

    /// Direct URL to download audio (when status is "ready")
    let audioUrl: String?

    /// Audio duration in seconds (when status is "ready")
    let durationSec: Double?

    /// Estimated wait time in seconds (when status is "processing")
    let estimatedWaitSec: Int?

    /// Queue position (when status is "queued")
    let queuePosition: Int?

    enum CodingKeys: String, CodingKey {
        case status
        case jobId = "job_id"
        case audioUrl = "audio_url"
        case durationSec = "duration_sec"
        case estimatedWaitSec = "estimated_wait_sec"
        case queuePosition = "queue_position"
    }
}

/// Progress information nested in job status response
struct TTSJobProgress: Codable, Sendable {
    /// Total expected audio duration in seconds
    let durationSec: Double?

    /// Progress in seconds of audio generated
    let progressSec: Double

    /// Total number of chunks (if chunked processing)
    let chunksTotal: Int?

    /// Number of completed chunks
    let chunksCompleted: Int

    /// Progress percentage (0-100)
    let percentage: Int

    /// Estimated remaining synthesis time in seconds (calculated by backend from measured rate)
    let estimatedRemainingSec: Int?

    enum CodingKeys: String, CodingKey {
        case durationSec = "duration_sec"
        case progressSec = "progress_sec"
        case chunksTotal = "chunks_total"
        case chunksCompleted = "chunks_completed"
        case percentage
        case estimatedRemainingSec = "estimated_remaining_sec"
    }
}

/// Error information in job status response
struct TTSJobErrorInfo: Codable, Sendable {
    let code: String
    let message: String
}

/// Response from GET /api/tts/job/:jobId for polling job status
struct TTSJobStatusResponse: Codable, Sendable {
    /// Current job status
    let status: TTSJobStatus

    /// Job identifier
    let jobId: String

    /// Progress information (nested object from backend)
    let progress: TTSJobProgress

    /// Total jobs in queued+processing across ALL users (system-wide load).
    /// Used to surface the "Use offline AI" CTA when the queue is busy.
    let queueDepth: Int?

    /// 1-based position of THIS job in the global queue.
    /// nil once the job leaves queued/processing (ready/failed/canceled).
    let queuePosition: Int?

    /// URL to preview audio (available when status is partial_ready or ready)
    let previewUrl: String?

    /// URL to full audio (available when status is ready)
    let audioUrl: String?

    /// Preview audio duration in seconds (available when status is partial_ready)
    let previewDurationSec: Double?

    /// Error info (when status is failed)
    let error: TTSJobErrorInfo?

    /// Timestamp when job was created
    let createdAt: String?

    /// Timestamp when job was last updated
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case status
        case jobId = "job_id"
        case progress
        case queueDepth = "queue_depth"
        case queuePosition = "queue_position"
        case previewUrl = "preview_url"
        case audioUrl = "audio_url"
        case previewDurationSec = "preview_duration_sec"
        case error
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    // MARK: - Convenience accessors for backwards compatibility

    /// Progress in seconds of audio generated
    var progressSec: Double? {
        progress.progressSec
    }

    /// Total audio duration in seconds
    var durationSec: Double? {
        progress.durationSec
    }

    /// Progress percentage (0-100)
    var percentage: Int {
        progress.percentage
    }

    /// Best available audio URL (full if ready, preview if partial)
    var bestAudioUrl: String? {
        audioUrl ?? previewUrl
    }

    /// Estimated remaining wait time in seconds (calculated from progress)
    var estimatedWaitSec: Int? {
        guard let totalDuration = progress.durationSec, totalDuration > 0 else { return nil }
        let remainingAudio = totalDuration - progress.progressSec
        // GPU processes at ~8x realtime
        return Int(remainingAudio / 8.0)
    }
}

// MARK: - Job-Based TTS Errors

/// Errors specific to job-based TTS API
/// Designed for UI error handling with clear categorization
enum TTSJobError: LocalizedError, Sendable {

    // MARK: - Quota/Billing Errors (show paywall/upgrade prompt)

    /// User's daily quota is exhausted
    case dailyQuotaExceeded(used: Int, limit: Int)

    /// User's monthly quota is exhausted
    case monthlyQuotaExceeded(used: Int, limit: Int)

    /// Feature requires a higher subscription tier
    case upgradeRequired(currentTier: String, requiredTier: String)

    /// Account is in arrears or payment failed
    case paymentRequired

    // MARK: - Retryable Errors (automatic retry with backoff)

    /// Server is temporarily overloaded
    case serverOverloaded(retryAfterSec: Int)

    /// Rate limit exceeded (too many requests)
    case rateLimited(retryAfterSec: Int)

    /// Transient network error
    case networkError(underlying: String)

    /// Server returned 5xx error
    case serverError(statusCode: Int, message: String)

    /// Request timed out
    case timeout

    // MARK: - Non-Retryable Errors (show error and let user retry manually)

    /// Job failed during processing
    case jobFailed(jobId: String, reason: String)

    /// Job was cancelled
    case jobCancelled(jobId: String)

    /// Job not found (invalid ID or expired)
    case jobNotFound(jobId: String)

    /// Invalid request parameters
    case badRequest(message: String)

    /// Voice not available or not found
    case voiceNotFound(voiceId: String)

    /// Text too long for processing
    case textTooLong(length: Int, maxLength: Int)

    /// Authentication failed
    case unauthorized

    /// Unknown or unexpected error
    case unknown(message: String)

    // MARK: - LocalizedError

    var errorDescription: String? {
        switch self {
        case .dailyQuotaExceeded(let used, let limit):
            if used >= limit {
                return "Daily limit reached. Used all \(limit) seconds today."
            } else {
                return "Not enough quota. \(limit - used) seconds remaining today."
            }
        case .monthlyQuotaExceeded(let used, let limit):
            if used >= limit {
                return "Monthly limit reached. Used all \(limit) seconds this month."
            } else {
                return "Not enough quota. \(limit - used) seconds remaining this month."
            }
        case .upgradeRequired(let current, let required):
            return "This feature requires \(required) tier. Current tier: \(current)."
        case .paymentRequired:
            return "Payment required. Please update your billing information."
        case .serverOverloaded(let retryAfter):
            return "Server is busy. Please try again in \(retryAfter) seconds."
        case .rateLimited(let retryAfter):
            return "Too many requests. Please wait \(retryAfter) seconds."
        case .networkError(let underlying):
            return "Network error: \(underlying)"
        case .serverError(let code, let message):
            return "Server error (\(code)): \(message)"
        case .timeout:
            return "Request timed out. Please try again."
        case .jobFailed(_, let reason):
            return "Audio generation failed: \(reason)"
        case .jobCancelled:
            return "Audio generation was cancelled."
        case .jobNotFound:
            return "Job not found or expired."
        case .badRequest(let message):
            return "Invalid request: \(message)"
        case .voiceNotFound(let voiceId):
            return "Voice '\(voiceId)' not found."
        case .textTooLong(let length, let maxLength):
            return "Text too long (\(length) chars). Maximum is \(maxLength)."
        case .unauthorized:
            return "Please sign in to continue."
        case .unknown(let message):
            return "An error occurred: \(message)"
        }
    }

    // MARK: - Error Classification

    /// Whether this error should trigger a paywall/upgrade prompt
    var isQuotaError: Bool {
        switch self {
        case .dailyQuotaExceeded, .monthlyQuotaExceeded, .upgradeRequired, .paymentRequired:
            return true
        default:
            return false
        }
    }

    /// Whether this error can be automatically retried
    var isRetryable: Bool {
        switch self {
        case .serverOverloaded, .rateLimited, .networkError, .serverError, .timeout:
            return true
        default:
            return false
        }
    }

    /// Suggested retry delay in seconds (nil if not retryable)
    var retryDelaySec: Int? {
        switch self {
        case .serverOverloaded(let delay), .rateLimited(let delay):
            return delay
        case .networkError, .timeout:
            return 2  // Default retry delay
        case .serverError:
            return 5  // Longer delay for server errors
        default:
            return nil
        }
    }

    /// Whether user needs to take action (vs automatic retry)
    var requiresUserAction: Bool {
        switch self {
        case .dailyQuotaExceeded, .monthlyQuotaExceeded, .upgradeRequired, .paymentRequired,
             .unauthorized, .voiceNotFound, .textTooLong, .badRequest:
            return true
        default:
            return false
        }
    }

    // MARK: - Factory Methods

    /// Create error from HTTP status code and response body
    static func fromHTTPResponse(
        statusCode: Int,
        body: Data?,
        headers: [String: String] = [:]
    ) -> TTSJobError {
        // Parse JSON error response if available
        let errorInfo: [String: Any]? = body.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }

        let message = errorInfo?["error"] as? String
            ?? errorInfo?["message"] as? String
            ?? "Unknown error"

        let errorCode = errorInfo?["error_code"] as? String

        switch statusCode {
        case 401:
            return .unauthorized

        case 402:
            // Payment/quota error - parse details
            // Backend returns quota info in "details" key, not "quota"
            let quotaInfo = errorInfo?["details"] as? [String: Any] ?? errorInfo?["quota"] as? [String: Any]

            if let quota = quotaInfo {
                // The backend returns 402 when the requested synthesis WOULD exceed quota,
                // not just when quota is already exceeded. So we show the quota error
                // with current usage values to let user know their limits.

                // Prefer daily quota display if available (more relevant for user action)
                if let dailyUsed = quota["daily_used"] as? Int,
                   let dailyLimit = quota["daily_limit"] as? Int,
                   dailyLimit > 0 {
                    return .dailyQuotaExceeded(used: dailyUsed, limit: dailyLimit)
                }
                // Fall back to monthly quota
                if let monthlyUsed = quota["monthly_used"] as? Int,
                   let monthlyLimit = quota["monthly_limit"] as? Int,
                   monthlyLimit > 0 {
                    return .monthlyQuotaExceeded(used: monthlyUsed, limit: monthlyLimit)
                }
            }
            return .paymentRequired

        case 403:
            // Tier required
            let required = errorInfo?["required_tier"] as? String ?? "premium"
            let current = errorInfo?["current_tier"] as? String ?? "free"
            return .upgradeRequired(currentTier: current, requiredTier: required)

        case 404:
            if errorCode == "voice_not_found" {
                let voiceId = errorInfo?["voice_id"] as? String ?? "unknown"
                return .voiceNotFound(voiceId: voiceId)
            }
            if errorCode == "job_not_found" {
                let jobId = errorInfo?["job_id"] as? String ?? "unknown"
                return .jobNotFound(jobId: jobId)
            }
            return .badRequest(message: message)

        case 413:
            let length = errorInfo?["length"] as? Int ?? 0
            let maxLength = errorInfo?["max_length"] as? Int ?? 100000
            return .textTooLong(length: length, maxLength: maxLength)

        case 429:
            // Rate limited - check Retry-After header
            let retryAfter = headers["Retry-After"].flatMap { Int($0) } ?? 60
            return .rateLimited(retryAfterSec: retryAfter)

        case 503:
            let retryAfter = headers["Retry-After"].flatMap { Int($0) } ?? 30
            return .serverOverloaded(retryAfterSec: retryAfter)

        case 500...599:
            return .serverError(statusCode: statusCode, message: message)

        case 400:
            return .badRequest(message: message)

        default:
            return .unknown(message: "HTTP \(statusCode): \(message)")
        }
    }

    /// Create error from a failed job status response
    static func fromJobStatus(_ response: TTSJobStatusResponse) -> TTSJobError? {
        guard response.status == .failed else { return nil }

        let reason = response.error?.message ?? "Unknown error"
        let errorCode = response.error?.code

        // Map known error codes
        switch errorCode {
        case "quota_exceeded":
            return .dailyQuotaExceeded(used: 0, limit: 0)
        case "voice_not_found":
            return .voiceNotFound(voiceId: "unknown")
        case "timeout":
            return .timeout
        case "cancelled":
            return .jobCancelled(jobId: response.jobId)
        default:
            return .jobFailed(jobId: response.jobId, reason: reason)
        }
    }
}
