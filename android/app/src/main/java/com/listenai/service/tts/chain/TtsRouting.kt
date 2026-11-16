package com.listenai.service.tts.chain

/**
 * Which synthesis path a built-in voice read takes. The on-device Kokoro model and the older self-hosted path speak
 * English only, so a read in any other language always goes through the source chain (the language is named to the cloud
 * voice, and the phone's own voice for that language is the fallback), even when "offline AI" was chosen or forced.
 */
object TtsRouting {

    /** True when the read must run through [TtsSourceChain]. [language] null means unknown, treated as English. */
    fun useChain(isCloned: Boolean, forceOnDevice: Boolean, userChoseOnDeviceKokoro: Boolean, language: String?): Boolean {
        if (isCloned) return false
        if (isNonEnglish(language)) return true
        return !forceOnDevice && !userChoseOnDeviceKokoro
    }

    /** A forced offline read in another language uses the phone's voice first: that is the offline voice for it. */
    fun preferPhoneVoice(forceOnDevice: Boolean, language: String?): Boolean = forceOnDevice && isNonEnglish(language)

    fun isNonEnglish(language: String?): Boolean {
        val key = language?.takeIf { it.isNotBlank() }?.let { LanguageKey.of(it) } ?: return false
        return key != "en"
    }
}
