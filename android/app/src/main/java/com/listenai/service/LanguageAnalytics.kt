package com.listenai.service

import java.util.Locale

/**
 * The parameters of the language and voice events, built as plain maps so a unit test can check what leaves the
 * phone. Only ISO language codes, a fixed set of reasons and yes/no flags: never text, titles, ids or voice names.
 * Sending is still gated by the user's analytics choice (FirebaseAnalyticsHelper.logEvent).
 */
object LanguageAnalytics {
    private val CODE = Regex("^[a-z]{2,3}$")

    /** A 2 or 3 letter language code in lower case, "auto" is kept for the override target, anything else is "unknown". */
    fun code(raw: String?): String {
        val c = raw?.trim()?.lowercase(Locale.ROOT)?.replace('_', '-')?.substringBefore('-').orEmpty()
        return if (CODE.matches(c)) c else "unknown"
    }

    /** The phone has no working system voice for the language of a document just imported. */
    fun noVoice(language: String?, voiceExists: Boolean, deviceLanguage: String?): Map<String, String> = mapOf(
        "content_language" to code(language),
        // true: the engine lists a voice for it but it is not downloaded (or network only and we are offline); false: it lists none.
        "voice_exists" to voiceExists.toString(),
        "device_language" to code(deviceLanguage),
    )

    /** The user changed the reading language of a document; [to] null means back to automatic. */
    fun override(from: String?, to: String?): Map<String, String> = mapOf(
        "from_language" to code(from),
        "to_language" to (to?.let { code(it) } ?: "auto"),
    )

    /**
     * Which kind of voice served a read: `cloud_<language>` for the ReadAloud API (cloud_es for the Spanish voice,
     * cloud_en for English), `system` (the phone's engine), `on_device` or `none`. Codes only, never a voice name.
     */
    fun voiceSource(first: com.listenai.service.tts.chain.SourceId?, language: String?): String = when (first) {
        com.listenai.service.tts.chain.SourceId.API -> "cloud_" + code(language)
        com.listenai.service.tts.chain.SourceId.SYSTEM -> "system"
        com.listenai.service.tts.chain.SourceId.ON_DEVICE -> "on_device"
        null -> "none"
    }

    /**
     * The language and voice kind of a playback event. [voiceSource] is "system" (made on the phone) or "cloud" (the
     * ReadAloud API); audio whose origin is not known (made before this was recorded) is "unknown".
     */
    fun playbackParams(voiceSource: String?, language: String?): Map<String, String> = mapOf(
        "voice_source" to (if (voiceSource == "system" || voiceSource == "cloud") voiceSource else "unknown"),
        "content_language" to code(language),
    )

    private val FALLBACK_REASONS = setOf("no_voice", "no_engine", "offline", "engine_error")

    /** A read ended with no usable voice. [reason] is one of no_voice, no_engine, offline, engine_error. */
    fun voiceFallback(language: String?, reason: String): Map<String, String> = mapOf(
        "content_language" to code(language),
        "reason" to (if (reason in FALLBACK_REASONS) reason else "engine_error"),
    )
}
