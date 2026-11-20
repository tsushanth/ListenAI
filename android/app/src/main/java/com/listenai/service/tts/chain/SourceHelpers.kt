package com.listenai.service.tts.chain

/** Pure helpers behind the Android sources, kept here so they are unit tested on the JVM. */

/** Maps what the ReadAloud API and its authorize hop say to a [SourceFailure]. */
object ApiFailureMapping {

    /**
     * [retryAfterHeader] is the raw header value: delta-seconds (HTTP dates are ignored). [body] is the response body when the caller has
     * it: a 400 `{"error":"UNKNOWN_VOICE"}` (the route cannot serve that voice) is the same per-language answer as the worker's "unknown voice".
     */
    fun fromHttp(status: Int, retryAfterHeader: String? = null, online: Boolean = true, body: String? = null): SourceFailure {
        val retryMs = retryAfterHeader?.trim()?.toLongOrNull()?.takeIf { it in 0..3600 }?.times(1000)
        if (status == 400 && body != null && isUnknownVoice(body)) return SourceFailure(FallbackReason.UNSUPPORTED_LANGUAGE, null, "400 unknown voice")
        return when (status) {
            402 -> SourceFailure(FallbackReason.QUOTA, retryMs, "402 quota")
            429 -> SourceFailure(FallbackReason.RATE_LIMITED, retryMs, "429")
            // At capacity (503 + Retry-After) is a short, transient condition: one retry may land on another machine.
            503 -> SourceFailure(FallbackReason.SERVER_ERROR, retryMs, "503")
            408, 504 -> SourceFailure(FallbackReason.TIMEOUT, null, "$status")
            else -> SourceFailure(if (online) FallbackReason.SERVER_ERROR else FallbackReason.OFFLINE, null, "http $status")
        }
    }

    private fun isUnknownVoice(body: String): Boolean {
        val err = try { org.json.JSONObject(body).optString("error", "") } catch (e: Exception) { "" }
        return err.equals("UNKNOWN_VOICE", ignoreCase = true) || (err.isEmpty() && body.contains("UNKNOWN_VOICE"))
    }

    /** A `{"type":"error","message":...}` frame from the WebSocket. */
    fun fromWsError(message: String): SourceFailure {
        val m = message.lowercase()
        return when {
            // The worker does not speak that language (or no longer has that voice): per language, never a reason to leave English.
            ("language" in m && ("support" in m || "not listed" in m || "unknown" in m)) || "unknown voice" in m ->
                SourceFailure(FallbackReason.UNSUPPORTED_LANGUAGE, null, message)
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

/**
 * Is this audio plausibly the text read aloud? The speech worker answers with audio for any text, so a runaway that loops (64 s for 78
 * Chinese characters, 94 s for 159 Arabic) or a near-empty answer is caught here, from the length of the audio alone.
 * Upper bound: [secondsPerChar] per character, with a floor of 2 s, stretched for speeds below 1. Lower bound: 0.01 s per character.
 * The per-character numbers are about 2.5 times the slowest healthy pace measured (Latin 0.07-0.17, Japanese 0.20, Chinese about 0.25).
 */
object AudioPlausibility {
    private val CJK = setOf("zh", "ja", "ko", "yue")
    private val THAI_LIKE = setOf("th", "lo", "km", "my")
    private val SLOW_SCRIPTS = setOf("ar", "he", "iw", "fa", "ur", "yi", "hi", "mr", "ne", "bn", "ta", "te", "kn", "ml", "gu", "pa", "si")

    /** Generous seconds of audio per character of text, by language (2-letter code, any case, regional forms allowed). */
    fun secondsPerChar(language: String): Double {
        val l = language.substringBefore('-').substringBefore('_').lowercase()
        return when (l) {
            in CJK -> 0.50
            in THAI_LIKE -> 0.40
            in SLOW_SCRIPTS -> 0.30
            else -> 0.25 // Latin, Cyrillic, Greek
        }
    }

    /** Null when the audio is plausible, otherwise a short reason (no text in it). [chars] counts code points. */
    fun problem(chars: Int, audioSeconds: Double, speed: Float, language: String): String? {
        val slowest = if (speed > 0f) minOf(speed, 1f).toDouble() else 1.0
        val maxSeconds = maxOf(2.0, chars * secondsPerChar(language) / slowest)
        val minSeconds = chars * 0.01
        return when {
            audioSeconds > maxSeconds -> "audio too long: %.1f s for %d chars".format(java.util.Locale.ROOT, audioSeconds, chars) // i18n-ok: log reason
            audioSeconds < minSeconds -> "audio too short: %.1f s for %d chars".format(java.util.Locale.ROOT, audioSeconds, chars) // i18n-ok: log reason
            else -> null
        }
    }

    /**
     * The worker may say which voice and language it spoke (`chunk_meta.voice`, `chunk_meta.language`). Null when it says nothing or says
     * what was asked for; otherwise a short reason. Voice ids compare ignoring case, languages by their 2-letter code.
     */
    fun echoMismatch(sentVoice: String, sentLanguage: String?, echoedVoice: String?, echoedLanguage: String?): String? {
        if (echoedVoice != null && !echoedVoice.trim().equals(sentVoice.trim(), ignoreCase = true)) return "answered with another voice"
        if (echoedLanguage != null && sentLanguage != null) {
            val a = ApiLanguageCode.of(echoedLanguage)
            val b = ApiLanguageCode.of(sentLanguage)
            if (a != null && b != null && a != b) return "answered in another language"
        }
        return null
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
