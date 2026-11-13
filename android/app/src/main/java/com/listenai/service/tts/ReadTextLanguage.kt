package com.listenai.service.tts

import android.speech.tts.TextToSpeech
import com.listenai.service.LanguageDetector
import com.listenai.service.tts.chain.SystemTtsSource
import java.util.Locale

/**
 * Pure decisions for the camera / gallery "Read Text" tab: which language the recognised text is in and whether the
 * phone's speech engine can speak it. The tab used to force Locale.US, so Spanish or French text was read with an
 * English voice.
 */
object ReadTextLanguage {

    sealed class Plan {
        /** Speak with [locale] ([language] is the 2-letter code, for analytics and messages). */
        data class Speak(val language: String, val locale: Locale) : Plan()

        /** The engine has no usable voice for [language]: show the missing-voice message instead of speaking. */
        data class NoVoice(val language: String) : Plan()
    }

    /** Detected language, or English when the text is too short or the model is not confident (same rule as imports). */
    fun languageOrDefault(detected: String?): String = detected?.takeIf { it.isNotBlank() } ?: LanguageDetector.DEFAULT

    /**
     * [availability] is the result of `TextToSpeech.isLanguageAvailable(locale)`: anything below LANG_AVAILABLE
     * (missing data, not supported) means there is no voice to speak with.
     */
    fun plan(language: String, availability: Int): Plan {
        val locale = localeFor(language)
        return if (availability >= TextToSpeech.LANG_AVAILABLE) Plan.Speak(language, locale) else Plan.NoVoice(language)
    }

    fun localeFor(language: String): Locale = SystemTtsSource.localeFor(language)
}
