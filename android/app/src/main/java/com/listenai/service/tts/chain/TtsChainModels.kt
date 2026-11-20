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
    /** The source has no voice for this language (not in the API's list, or the API refused it). */
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
    /** The user picked one of the phone's own voices for this language: try the phone's engine before the cloud. */
    val preferSystem: Boolean = false,
    /** The ReadAloud voice the user picked for this (non-English) language; used when the API still lists it for the language, else the default voice. */
    val cloudVoiceId: String? = null,
    /**
     * The ReadAloud voice this read is fixed to. The chain sets it once per read (see [TtsSource.pin]) so the voice that reads
     * chunk 1 is the voice that reads the last chunk and the one the chunk cache key names, even if the catalog changes mid-read.
     */
    val cloudVoice: CloudVoice? = null,
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

    /**
     * Names the voice this source would speak [request] with, for the chunk cache key; null when the source has no
     * voice for the request right now (then nothing of this source's may be replayed from the cache or stored).
     * The default is the app voice id, which is all an English-only source needs.
     */
    suspend fun cacheVoice(request: TtsRequest): String? = request.voiceId

    /**
     * Fixes the choices that must not change within one read (for the cloud: which voice speaks the language). Called once per
     * read and source, before the cache key is made and before any chunk is synthesized; the result replaces [request] for
     * this source for the rest of the read. The default changes nothing.
     */
    suspend fun pin(request: TtsRequest): TtsRequest = request

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
    /**
     * The cloud voices for languages other than English do not stream inside a sentence: the first audio is the whole chunk, and
     * a long sentence takes seconds. So those reads use shorter chunks, and the first chunk gets a longer deadline (a speech
     * machine that has just restarted needs about 5-6 s for its first call; the retry then finds it warm).
     */
    val nonEnglishMaxChunkChars: Int = 170,
    val nonEnglishFirstChunkChars: Int = 90,
    /**
     * Languages whose characters carry a lot of speech each (a 170 character Japanese chunk made 42 s of audio and took about 10 s)
     * get smaller chunks: language -> (first chunk, later chunks) in characters.
     */
    val nonEnglishChunkSizes: Map<String, Pair<Int, Int>> = mapOf("ja" to (60 to 90), "zh" to (60 to 90), "ko" to (60 to 90)),
    val nonEnglishFirstChunkBaseTimeoutMs: Long = 14_000,
    /**
     * A studio-tier voice (Beta) scales to zero: the first call after idle takes about 44 s while the machine starts. For a read with a
     * studio voice, the chunks of the first prefetch window (the ones asked for while it may still be cold) get at least this deadline, so
     * a slow start is waited for instead of counted as a timeout (retry, cooldown, the phone's voice). Later chunks, and every
     * other voice, keep the usual deadlines.
     */
    val studioColdStartTimeoutMs: Long = 75_000,
    /** How long the cloud is skipped for ONE language after the API refused it (not listed any more, unknown voice). English is not affected. */
    val cooldownUnsupportedMs: Long = 10 * 60_000,
    /** Sources whose output is stored in the chunk cache. */
    val cacheableSources: Set<SourceId> = setOf(SourceId.API),
)
