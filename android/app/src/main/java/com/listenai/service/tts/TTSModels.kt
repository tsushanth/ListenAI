package com.listenai.service.tts

import java.io.File
import java.util.UUID

/**
 * Options for text-to-speech synthesis
 */
data class SynthesisOptions(
    /** Playback speed multiplier (0.5 - 2.0, where 1.0 is normal) */
    val speed: Float = 1.0f,

    /** Pitch multiplier (0.5 - 2.0, where 1.0 is normal) */
    val pitch: Float = 1.0f,

    /** Volume level (0.0 - 1.0) */
    val volume: Float = 1.0f,

    /** Output audio format */
    val outputFormat: AudioFormat = AudioFormat.M4A,

    /** Synthesis quality level */
    val quality: SynthesisQuality = SynthesisQuality.STANDARD,

    /** Enable SSML processing if supported */
    val enableSSML: Boolean = false,

    /** Maximum characters per synthesis chunk (for cloud APIs) */
    val chunkSize: Int? = null,

    /** Whether to generate word-level timestamps */
    val generateWordTimestamps: Boolean = false,

    /** Whether to generate section timestamps */
    val generateSectionTimestamps: Boolean = true
) {
    companion object {
        val DEFAULT = SynthesisOptions()

        fun withSpeed(speed: Float) = DEFAULT.copy(speed = speed)
    }
}

/**
 * Audio output format
 */
enum class AudioFormat(val extension: String, val mimeType: String) {
    M4A("m4a", "audio/mp4"),
    MP3("mp3", "audio/mpeg"),
    WAV("wav", "audio/wav"),
    OPUS("opus", "audio/opus"),
    AAC("aac", "audio/aac")
}

/**
 * Synthesis quality level
 */
enum class SynthesisQuality {
    DRAFT,      // Fast, lower quality
    STANDARD,   // Balanced
    HIGH        // Best quality, slower
}

/**
 * Result of a synthesis operation
 */
data class SynthesisResult(
    /** File containing the generated audio */
    val audioFile: File,

    /** Total duration of the audio in seconds */
    val duration: Double,

    /** Timestamps for each section (for navigation) */
    val sectionTimestamps: List<SectionTimestamp>,

    /** Word-level timestamps (for highlighting, optional) */
    val wordTimestamps: List<WordTimestamp>? = null,

    /** File size in bytes */
    val fileSizeBytes: Long,

    /** Cost information (for cloud synthesis) */
    val cost: SynthesisCost? = null,

    /** Additional metadata */
    val metadata: SynthesisMetadata
)

/**
 * Timestamp for a section
 */
data class SectionTimestamp(
    val sectionIndex: Int,
    val startTime: Double,
    val endTime: Double
) {
    val duration: Double get() = endTime - startTime
}

/**
 * Timestamp for a word
 */
data class WordTimestamp(
    val word: String,
    val startTime: Double,
    val endTime: Double,
    val sectionIndex: Int,
    val characterRange: IntRange
)

/**
 * Cost of a synthesis operation
 */
data class SynthesisCost(
    val charactersUsed: Int,
    val costUSD: Double,
    val quotaUsed: Int,
    val provider: String
)

/**
 * Metadata about a synthesis operation
 */
data class SynthesisMetadata(
    val voiceId: String,
    val voiceName: String,
    val provider: String,
    val startedAt: Long,
    val completedAt: Long,
    val inputCharacterCount: Int,
    val outputSampleRate: Int
) {
    val processingTimeSeconds: Double
        get() = (completedAt - startedAt) / 1000.0
}

/**
 * Progress of a synthesis operation
 */
data class SynthesisProgress(
    /** Overall progress (0.0 - 1.0) */
    val overallProgress: Float,

    /** Current section being processed */
    val currentSectionIndex: Int,

    /** Number of sections completed */
    val sectionsCompleted: Int,

    /** Total number of sections */
    val totalSections: Int,

    /** Estimated time remaining in seconds */
    val estimatedTimeRemaining: Double? = null,

    /** Current status message */
    val statusMessage: String,

    /** Characters processed so far */
    val charactersProcessed: Int,

    /** Total characters to process */
    val totalCharacters: Int,

    /** Preview audio URL when partial_ready (for immediate playback) */
    val previewUrl: String? = null,

    /** Preview audio duration in seconds */
    val previewDurationSec: Double? = null,

    /** Raw job status string ("queued" | "processing" | "partial_ready" | "ready" | "failed" | "canceled"), null for non-job-API paths */
    val jobStatus: String? = null,

    /** Total jobs in queued+processing across all users (system-wide load); null once past queued */
    val queueDepth: Int? = null,

    /** 1-based position of this job in the global queue; null once past queued */
    val queuePosition: Int? = null
) {
    /** Whether preview audio is available for immediate playback */
    val hasPreviewReady: Boolean
        get() = previewUrl != null

    /** Whether this job is still waiting for its turn (not yet processing) */
    val isQueued: Boolean
        get() = jobStatus == "queued"

    companion object {
        val INITIAL = SynthesisProgress(
            overallProgress = 0f,
            currentSectionIndex = 0,
            sectionsCompleted = 0,
            totalSections = 0,
            estimatedTimeRemaining = null,
            statusMessage = "Preparing...",
            charactersProcessed = 0,
            totalCharacters = 0
        )
    }
}

/**
 * Estimate for a synthesis operation
 */
data class SynthesisEstimate(
    /** Estimated audio duration in seconds */
    val estimatedDuration: Double,

    /** Estimated processing time in seconds */
    val estimatedProcessingTime: Double,

    /** Total character count */
    val characterCount: Int,

    /** Estimated cost in USD (for cloud voices) */
    val estimatedCostUSD: Double? = null,

    /** Impact on user's quota */
    val quotaImpact: QuotaImpact? = null
)

/**
 * Impact on user quota
 */
data class QuotaImpact(
    val charactersToUse: Int,
    val remainingAfter: Int,
    val willExceedQuota: Boolean,
    val minutesUsed: Int = 0,
    val minutesRemaining: Int = 0,
    val percentageOfQuota: Float = 0f
)

/**
 * Text section for synthesis input
 */
data class TextSection(
    val id: UUID = UUID.randomUUID(),
    val index: Int,
    val type: SectionType = SectionType.PARAGRAPH,
    val text: String,
    val characterRange: IntRange
)

/**
 * Type of text section
 */
enum class SectionType(val pauseAfterSeconds: Double) {
    TITLE(1.0),
    HEADING(0.8),
    PARAGRAPH(0.5),
    BLOCKQUOTE(0.6),
    LIST_ITEM(0.3),
    CODE_BLOCK(0.5),
    CAPTION(0.4),
    FOOTNOTE(0.5);

    val shouldSpeak: Boolean
        get() = this != CODE_BLOCK
}

/**
 * Chunk of audio data for streaming
 */
data class AudioChunk(
    val data: ByteArray,
    val timestamp: Double,
    val isFinal: Boolean,
    val chunkIndex: Int
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as AudioChunk
        return data.contentEquals(other.data) &&
               timestamp == other.timestamp &&
               isFinal == other.isFinal &&
               chunkIndex == other.chunkIndex
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + timestamp.hashCode()
        result = 31 * result + isFinal.hashCode()
        result = 31 * result + chunkIndex
        return result
    }
}

/**
 * TTS error types
 */
sealed class TTSError : Exception() {
    data class VoiceNotAvailable(val voiceName: String) : TTSError() {
        override val message = "Voice '$voiceName' is not available on this device."
    }

    data class VoiceDownloadRequired(val voiceName: String, val sizeBytes: Long) : TTSError() {
        override val message = "Voice '$voiceName' requires download."
    }

    data class TextTooLong(val characterCount: Int, val limit: Int) : TTSError() {
        override val message = "Text is too long ($characterCount characters). Maximum is $limit."
    }

    object TextEmpty : TTSError() {
        override val message = "Cannot synthesize empty text."
    }

    data class QuotaExceeded(val remaining: Int, val required: Int) : TTSError() {
        override val message = "Quota exceeded. You have $remaining characters remaining, but need $required."
    }

    data class NetworkError(val underlying: String) : TTSError() {
        override val message = "Network error: $underlying"
    }

    data class ApiError(val provider: String, val code: Int, val errorMessage: String) : TTSError() {
        override val message = "$provider API error ($code): $errorMessage"
    }

    data class RateLimited(val retryAfterSeconds: Double) : TTSError() {
        override val message = "Rate limited. Please try again in ${retryAfterSeconds.toInt()} seconds."
    }

    data class AudioEncodingFailed(val reason: String) : TTSError() {
        override val message = "Failed to encode audio: $reason"
    }

    object Cancelled : TTSError() {
        override val message = "Synthesis was cancelled."
    }

    data class SubscriptionRequired(val tier: String) : TTSError() {
        override val message = "This voice requires a $tier subscription."
    }

    data class InvalidConfiguration(val reason: String) : TTSError() {
        override val message = "Invalid configuration: $reason"
    }

    object SynthesisTimeout : TTSError() {
        override val message = "Synthesis timed out."
    }

    data class UnsupportedLanguage(val language: String) : TTSError() {
        override val message = "Language '$language' is not supported by this voice."
    }
}
