package com.listenai.service.tts.chain

/**
 * Types for the speech source chain: ReadAloud API (Piper on CPU) -> the phone's own TextToSpeech engine
 * -> the on-device model. Everything in this package is plain Kotlin (no Android types), so the selection
 * and fallback logic is unit tested with fake sources.
 */

enum class SourceId { API, SYSTEM, ON_DEVICE }

/** Why a source could not be used. Sent to analytics by name; never contains text. */
enum class FallbackReason {
    /** The remote/BuildConfig switch says use the on-device path. */
    FLAG_OFF,
    OFFLINE,
    /** 402: the account's characters are used up. */
    QUOTA,
    /** 429 or "at capacity". */
    RATE_LIMITED,
    TIMEOUT,
    SERVER_ERROR,
    /** No usable system TTS engine is installed (or only our own engine is). */
    ENGINE_MISSING,
    /** The engine has no voice data for the language (or it needs the network and we are offline). */
    LANGUAGE_MISSING,
    MODEL_ABSENT,
    MODEL_TOO_SLOW,
    /** The source has no voice for this language (the API's app voices are English). */
    UNSUPPORTED_LANGUAGE,
    UNKNOWN,
}

/** What the user can do when every source failed. */
sealed class UserAction {
    /** Voice data for [language] is missing: offer ACTION_INSTALL_TTS_DATA. */
    data class InstallVoiceData(val language: String) : UserAction()
    /** No TTS engine at all: offer to install one (Speech Services by Google). */
    object InstallEngine : UserAction()
    object CheckConnection : UserAction()
    object TryLater : UserAction()
}

class SourceFailure(
    val reason: FallbackReason,
    /** For RATE_LIMITED / QUOTA: how long to leave this source alone, if the server said. */
    val retryAfterMs: Long? = null,
    message: String? = null,
    cause: Throwable? = null,
) : Exception(message ?: reason.name, cause)

class NoSourceAvailableException(
    val failures: Map<SourceId, FallbackReason>,
    val action: UserAction,
) : Exception("No speech source available: $failures")

/** One word's position inside a chunk: character offsets into the chunk text, seconds from the chunk's start. */
class TimedWord(val startChar: Int, val endChar: Int, val start: Double, val end: Double)

/** Mono 16-bit little-endian PCM, optionally with word timings (only the API's alignment worker supplies them). */
class PcmChunk(val pcm: ByteArray, val sampleRate: Int, val words: List<TimedWord>? = null) {
    val durationMs: Long get() = if (sampleRate <= 0) 0 else pcm.size / 2 * 1000L / sampleRate
}

data class TtsRequest(
    /** App voice id (e.g. "bella"); each source maps it to its own voice. */
    val voiceId: String,
    /** BCP-47 language of the text, e.g. "en" or "es-MX". */
    val language: String = "en",
    val speed: Float = 1.0f,
    /** Ask the API for word timings (the reader highlights words). Slower to start when the alignment worker is cold. */
    val wantWords: Boolean = false,
)

interface TtsSource {
    val id: SourceId

    /**
     * Cheap check before any chunk is attempted: null when the source can be tried, otherwise the reason it cannot.
     * Must not do network I/O longer than a few hundred ms.
     */
    suspend fun unavailableReason(request: TtsRequest): FallbackReason?

    /** Synthesizes one chunk. Throws [SourceFailure]. Cancellation must propagate. */
    suspend fun synthesize(text: String, request: TtsRequest): PcmChunk

    /** Called once per chunk with the real-time factor (synth seconds / audio seconds), for sources that measure it. */
    fun onChunkMeasured(synthMs: Long, audioMs: Long) {}
}

/** One piece of the spoken result, emitted in order. */
class SpokenChunk(
    val index: Int,
    val total: Int,
    val audio: PcmChunk,
    /** The source that produced the audio (for cache hits, the source that produced it originally is not tracked: [fromCache]). */
    val source: SourceId,
    val fromCache: Boolean,
    /** Characters of text this chunk covers. */
    val chars: Int,
    /** The text this chunk was made from, for word positions in the consumer. Never sent to telemetry. */
    val text: String = "",
)

/** No text content. */
data class SessionReport(
    val firstSource: SourceId?,
    val chunksBySource: Map<SourceId, Int>,
    val cacheHits: Int,
    val chunks: Int,
    val chars: Int,
    val fallbackReasons: List<Pair<SourceId, FallbackReason>>,
    val timeToFirstAudioMs: Long?,
    val totalMs: Long,
    val audioMs: Long,
    val succeeded: Boolean,
    val language: String,
)

interface TtsTelemetry {
    fun report(report: SessionReport)

    object None : TtsTelemetry {
        override fun report(report: SessionReport) {}
    }
}

data class ChainConfig(
    /** Chunks synthesized ahead of the one being played. */
    val prefetch: Int = 2,
    /** Sentence groups are cut at about this many characters. */
    val maxChunkChars: Int = 280,
    /** The first chunk is kept short so audio starts sooner. */
    val firstChunkChars: Int = 140,
    /** All emitted audio is converted to this rate so a stream never changes rate mid-way. */
    val outputSampleRate: Int = 24_000,
    /** Extra attempts on the same source for transient failures (timeout, server error) before falling back. */
    val retries: Int = 1,
    val retryBackoffMs: Long = 250,
    /** Per-chunk deadline = base + perChar * chars; the first chunk gets [firstChunkBaseTimeoutMs]. */
    val firstChunkBaseTimeoutMs: Long = 4_500,
    val chunkBaseTimeoutMs: Long = 6_000,
    val perCharTimeoutMs: Long = 25,
    /** How long a source is skipped after each kind of failure. */
    val cooldownOfflineMs: Long = 15_000,
    val cooldownTransientMs: Long = 30_000,
    val cooldownRateLimitMs: Long = 60_000,
    val cooldownQuotaMs: Long = 10 * 60_000,
    /** Sources whose output is stored in the chunk cache. */
    val cacheableSources: Set<SourceId> = setOf(SourceId.API),
)
