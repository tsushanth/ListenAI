package com.listenai.service

import com.listenai.service.tts.ChainSynthesizer
import com.listenai.service.tts.TTSError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LanguageAnalyticsTest {
    @Test fun `codes are normalised and anything else is unknown`() {
        assertEquals("es", LanguageAnalytics.code("es"))
        assertEquals("pt", LanguageAnalytics.code("pt-BR"))
        assertEquals("zh", LanguageAnalytics.code("ZH_cn"))
        assertEquals("fil", LanguageAnalytics.code("fil"))
        assertEquals("unknown", LanguageAnalytics.code(null))
        assertEquals("unknown", LanguageAnalytics.code(""))
        assertEquals("unknown", LanguageAnalytics.code("Hola, esto es un texto privado"))
        assertEquals("unknown", LanguageAnalytics.code("a1"))
    }

    @Test fun `lang_no_voice carries language, whether a voice exists and the device language`() {
        val p = LanguageAnalytics.noVoice("ar", voiceExists = false, deviceLanguage = "en-US")
        assertEquals(mapOf("content_language" to "ar", "voice_exists" to "false", "device_language" to "en"), p)
        assertEquals("true", LanguageAnalytics.noVoice("ru", true, "ru")["voice_exists"])
    }

    @Test fun `lang_override carries only the two languages and auto`() {
        assertEquals(mapOf("from_language" to "es", "to_language" to "fr"), LanguageAnalytics.override("es", "fr"))
        assertEquals(mapOf("from_language" to "ru", "to_language" to "auto"), LanguageAnalytics.override("ru", null))
        assertEquals("unknown", LanguageAnalytics.override(null, "de")["from_language"])
    }

    @Test fun `voice_fallback reasons are a fixed set`() {
        assertEquals("no_voice", LanguageAnalytics.voiceFallback("ar", "no_voice")["reason"])
        assertEquals("engine_error", LanguageAnalytics.voiceFallback("ar", "some exception message with a url")["reason"])
        assertEquals("no_voice", ChainSynthesizer.voiceFallbackReason(TTSError.SpeechUnavailable.Kind.NO_VOICE_DATA))
        assertEquals("no_engine", ChainSynthesizer.voiceFallbackReason(TTSError.SpeechUnavailable.Kind.NO_ENGINE))
        assertEquals("offline", ChainSynthesizer.voiceFallbackReason(TTSError.SpeechUnavailable.Kind.OFFLINE))
        assertEquals("engine_error", ChainSynthesizer.voiceFallbackReason(TTSError.SpeechUnavailable.Kind.BUSY))
    }

    @Test fun `no event carries free text, ids or voice names`() {
        val all = listOf(
            LanguageAnalytics.noVoice("es", true, "en"),
            LanguageAnalytics.override("es", "fr"),
            LanguageAnalytics.voiceFallback("es", "no_voice"),
        ).flatMap { it.entries }
        // every value is a short token: a language code, auto, unknown, true/false, or a reason
        assertTrue(all.all { it.value.length <= 12 && it.value.all { c -> c.isLowerCase() || c == '_' } })
        assertFalse(all.any { it.key.contains("text") || it.key.contains("title") || it.key.contains("voice_name") || it.key.contains("article") })
    }
}
