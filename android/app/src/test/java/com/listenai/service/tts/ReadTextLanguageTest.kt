package com.listenai.service.tts

import android.speech.tts.TextToSpeech
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class ReadTextLanguageTest {
    @Test fun `detected language is used as is`() {
        assertEquals("es", ReadTextLanguage.languageOrDefault("es"))
        assertEquals("ru", ReadTextLanguage.languageOrDefault("ru"))
    }

    @Test fun `unknown or blank detection reads as English`() {
        assertEquals("en", ReadTextLanguage.languageOrDefault(null))
        assertEquals("en", ReadTextLanguage.languageOrDefault(""))
        assertEquals("en", ReadTextLanguage.languageOrDefault("  "))
    }

    @Test fun `an available language speaks with its own locale, not US`() {
        val plan = ReadTextLanguage.plan("fr", TextToSpeech.LANG_AVAILABLE)
        assertTrue(plan is ReadTextLanguage.Plan.Speak)
        assertEquals("fr", (plan as ReadTextLanguage.Plan.Speak).locale.language)
        assertEquals("fr", plan.language)
    }

    @Test fun `country and variant availability also speak`() {
        assertTrue(ReadTextLanguage.plan("es", TextToSpeech.LANG_COUNTRY_AVAILABLE) is ReadTextLanguage.Plan.Speak)
        assertTrue(ReadTextLanguage.plan("es", TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE) is ReadTextLanguage.Plan.Speak)
    }

    @Test fun `missing data or unsupported means no voice`() {
        assertEquals(ReadTextLanguage.Plan.NoVoice("ar"), ReadTextLanguage.plan("ar", TextToSpeech.LANG_MISSING_DATA))
        assertEquals(ReadTextLanguage.Plan.NoVoice("ar"), ReadTextLanguage.plan("ar", TextToSpeech.LANG_NOT_SUPPORTED))
    }

    @Test fun `English keeps the US locale and regional tags are kept`() {
        assertEquals(Locale.US, ReadTextLanguage.localeFor("en"))
        assertEquals("MX", ReadTextLanguage.localeFor("es-MX").country)
        assertEquals("BR", ReadTextLanguage.localeFor("pt_BR").country)
    }
}
