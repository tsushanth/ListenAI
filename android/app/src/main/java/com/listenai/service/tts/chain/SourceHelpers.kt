package com.listenai.service.tts.chain

/** Pure helpers behind the Android sources, kept here so they are unit tested on the JVM. */

/** Maps what the ReadAloud API and its authorize hop say to a [SourceFailure]. */
object ApiFailureMapping {

    /** [retryAfterHeader] is the raw header value: delta-seconds (HTTP dates are ignored). */
    fun fromHttp(status: Int, retryAfterHeader: String? = null, online: Boolean = true): SourceFailure {
        val retryMs = retryAfterHeader?.trim()?.toLongOrNull()?.takeIf { it in 0..3600 }?.times(1000)
        return when (status) {
            402 -> SourceFailure(FallbackReason.QUOTA, retryMs, "402 quota")
            429 -> SourceFailure(FallbackReason.RATE_LIMITED, retryMs, "429")
            // At capacity (503 + Retry-After) is a short, transient condition: one retry may land on another machine.
            503 -> SourceFailure(FallbackReason.SERVER_ERROR, retryMs, "503")
            408, 504 -> SourceFailure(FallbackReason.TIMEOUT, null, "$status")
            else -> SourceFailure(if (online) FallbackReason.SERVER_ERROR else FallbackReason.OFFLINE, null, "http $status")
        }
    }

    /** A `{"type":"error","message":...}` frame from the WebSocket. */
    fun fromWsError(message: String): SourceFailure {
        val m = message.lowercase()
        return when {
            "capacity" in m || "busy" in m || "overload" in m -> SourceFailure(FallbackReason.SERVER_ERROR, null, message)
            "quota" in m || "credit" in m || "402" in m -> SourceFailure(FallbackReason.QUOTA, null, message)
            "rate" in m && "limit" in m -> SourceFailure(FallbackReason.RATE_LIMITED, null, message)
            else -> SourceFailure(FallbackReason.SERVER_ERROR, null, message)
        }
    }

    /** A connection-level exception. [online] is the connectivity check at the time of failure. */
    fun fromThrowable(t: Throwable, online: Boolean): SourceFailure = when {
        !online -> SourceFailure(FallbackReason.OFFLINE, null, t.message, t)
        t is java.net.SocketTimeoutException || t is java.io.InterruptedIOException ->
            SourceFailure(FallbackReason.TIMEOUT, null, t.message, t)
        else -> SourceFailure(FallbackReason.SERVER_ERROR, null, t.message, t)
    }
}

/** Chooses the system TextToSpeech engine to use: an explicit package, never our own engine (it would call back into the API path). */
object TtsEnginePicker {
    val PREFERRED = listOf("com.google.android.tts", "com.samsung.SMT")
    private val OWN_PREFIX = "com.listenai"

    /** [installed] are the packages that declare a TTS service. Null when there is nothing usable. */
    fun pick(installed: Collection<String>, ownPackage: String? = null): String? {
        fun isOwn(p: String) = p.startsWith(OWN_PREFIX) || p == ownPackage
        val usable = installed.filterNot(::isOwn)
        PREFERRED.firstOrNull { it in usable }?.let { return it }
        return usable.sorted().firstOrNull()
    }
}

/**
 * Decides once whether the on-device model keeps up with playback. The first sample of a process is dropped
 * (session load and warm-up); after [needed] further samples the verdict is the median real-time factor
 * (synthesis seconds per audio second) against [maxRtf].
 */
class RtfVerdict(private val needed: Int = 2, private val maxRtf: Double = 1.0) {
    private val samples = ArrayList<Double>()
    private var seen = 0
    var verdict: Boolean? = null // true = fast enough
        private set

    fun add(synthMs: Long, audioMs: Long): Boolean? {
        if (verdict != null || audioMs <= 0) return verdict
        if (seen++ == 0) return null
        samples += synthMs.toDouble() / audioMs
        if (samples.size >= needed) {
            val median = samples.sorted()[samples.size / 2]
            verdict = median <= maxRtf
        }
        return verdict
    }

    val medianRtf: Double? get() = samples.sorted().getOrNull(samples.size / 2)
}
