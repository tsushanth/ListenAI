package com.listenai.service.tts.chain

/**
 * Which speech failures are worth telling the owner about. The ReadAloud API failing is invisible to the user when the
 * phone's voice reads instead, and invisible to the server when audio never reaches it. Class names only, never text.
 */
object TtsFailureSignals {
    private val OUR_SIDE = setOf(FallbackReason.SERVER_ERROR, FallbackReason.TIMEOUT)

    data class Signal(val flow: String, val code: String, val context: Map<String, String>)

    /** The API failed for a reason on our side during a read. Offline, quota and unsupported languages are not failures. */
    fun apiFallback(report: SessionReport): Signal? {
        val reason = report.fallbackReasons.firstOrNull { it.first == SourceId.API && it.second in OUR_SIDE }?.second ?: return null
        val spokeWith = report.firstSource?.name ?: "none"
        return Signal("tts_api_fallback", "TTS_API_${reason.name}", mapOf("spoke_with" to spokeWith, "language" to report.language))
    }

    /** Nothing could speak, and at least one source failed for something other than this phone's setup or network. */
    fun noAudio(failures: Map<SourceId, FallbackReason>, language: String): Signal? {
        if (failures.values.none { it in OUR_SIDE }) return null
        val reasons = failures.entries.joinToString(",") { "${it.key.name}:${it.value.name}" }
        return Signal("tts_no_audio", "TTS_NO_AUDIO", mapOf("reasons" to reasons, "language" to language))
    }
}
