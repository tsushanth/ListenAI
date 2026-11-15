package com.listenai.service.tts.chain

/**
 * Whether a non-English request asks the speech service to write digits as words (`"normalize":"numbers"`), per language.
 * Measured with a speech-recognition round trip, with and without it: it helps German, French, Italian and Spanish, makes
 * Japanese worse, and for Portuguese once added a digit to a phone number; for the other languages it is left off.
 * Hindi gets it only for text that contains Devanagari digits. A language not in the table gets no normalization.
 */
enum class NumberPolicy { NONE, ALWAYS, DEVANAGARI_DIGITS }

object NumberNormalization {
    private val POLICY: Map<String, NumberPolicy> = mapOf(
        "de" to NumberPolicy.ALWAYS,
        "fr" to NumberPolicy.ALWAYS,
        "it" to NumberPolicy.ALWAYS,
        "es" to NumberPolicy.ALWAYS,
        "hi" to NumberPolicy.DEVANAGARI_DIGITS,
    )

    fun policyFor(language: String?): NumberPolicy = ApiLanguageCode.of(language)?.let { POLICY[it] } ?: NumberPolicy.NONE

    private fun hasDevanagariDigit(text: String) = text.any { it in '०'..'९' }

    /** True when the request for [text] in [language] (any device or API form of the code) carries `normalize:"numbers"`. */
    fun send(language: String?, text: String): Boolean = when (policyFor(language)) {
        NumberPolicy.ALWAYS -> true
        NumberPolicy.DEVANAGARI_DIGITS -> hasDevanagariDigit(text)
        NumberPolicy.NONE -> false
    }
}
