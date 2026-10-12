package com.listenai.systemtts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EspeakVoicesTest {

    @Test fun everyVoiceHasAUniqueNameAndAWellFormedLocale() {
        val names = EspeakVoices.all.map { it.systemVoiceName }
        assertEquals(names.size, names.toSet().size)
        for (e in EspeakVoices.all) {
            assertTrue("${e.espeakVoice} has no language", e.locale.language.isNotEmpty())
            assertTrue(e.systemVoiceName.startsWith(EspeakVoices.PREFIX))
        }
    }

    @Test fun voiceNamesRoundTrip() {
        for (e in EspeakVoices.all) assertEquals(e, EspeakVoices.fromVoiceName(e.systemVoiceName))
        assertNull(EspeakVoices.fromVoiceName("readaloud-bella-en-us"))
        assertNull(EspeakVoices.fromVoiceName(null))
        assertTrue(EspeakVoices.isEspeakVoiceName("readaloud-espeak-es"))
        assertFalse(EspeakVoices.isEspeakVoiceName("readaloud-bella-en-us"))
    }

    @Test fun anExactCountryMatchWins() {
        assertEquals("es", EspeakVoices.forLocale("es", "ES")!!.id)
        assertEquals("pt-br", EspeakVoices.forLocale("pt", "BR")!!.id)
        assertEquals("pt", EspeakVoices.forLocale("pt", "PT")!!.id)
        assertEquals("en-gb", EspeakVoices.forLocale("en", "GB")!!.id)
    }

    @Test fun regionAliasesPickTheRightVariant() {
        assertEquals("es-419", EspeakVoices.forLocale("es", "MX")!!.id)
        assertEquals("es-419", EspeakVoices.forLocale("es", "US")!!.id)
        assertEquals("en-gb", EspeakVoices.forLocale("en", "AU")!!.id)
        assertEquals("fr-fr", EspeakVoices.forLocale("fr", "CA")!!.id)
    }

    @Test fun aLanguageWithoutACountryGetsItsFirstVoice() {
        assertEquals("es", EspeakVoices.forLocale("es", null)!!.id)
        assertEquals("de", EspeakVoices.forLocale("de", "")!!.id)
    }

    @Test fun unsupportedLanguagesAreReportedAsSuch() {
        assertNull(EspeakVoices.forLocale("ru", "RU"))
        assertFalse(EspeakVoices.supportsLanguage("ru"))
        assertFalse(EspeakVoices.supportsLanguage(null))
        assertNull(EspeakVoices.forLocale(null, null))
    }

    @Test fun majorLanguagesAreCovered() {
        for (lang in listOf("en", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "hi", "ar", "nl", "pl", "tr", "vi", "th", "he", "id", "sw")) {
            assertTrue("missing $lang", EspeakVoices.supportsLanguage(lang))
        }
    }

    @Test fun countrySupportCoversAliases() {
        assertTrue(EspeakVoices.supportsLanguageCountry("es", "MX"))
        assertTrue(EspeakVoices.supportsLanguageCountry("en", "au"))
        assertFalse(EspeakVoices.supportsLanguageCountry("es", ""))
        assertFalse(EspeakVoices.supportsLanguageCountry("ru", "RU"))
    }

    @Test fun androidRateMapsToEspeakWordsPerMinuteWithinItsLimits() {
        assertEquals(175, EspeakVoices.rateToWpm(100))
        assertEquals(350, EspeakVoices.rateToWpm(200))
        assertEquals(450, EspeakVoices.rateToWpm(600))   // capped at eSpeak's maximum
        assertEquals(80, EspeakVoices.rateToWpm(10))      // and its minimum
    }

    @Test fun androidPitchMapsToEspeakPitch() {
        assertEquals(50, EspeakVoices.pitchToEspeak(100))
        assertEquals(100, EspeakVoices.pitchToEspeak(400))
        assertEquals(0, EspeakVoices.pitchToEspeak(-5))
    }

    @Test fun sampleTextFallsBackToEnglishStyleDefault() {
        assertNotNull(SampleTexts.forLanguage("es"))
        assertTrue(SampleTexts.forLanguage("zz").isNotEmpty())
        assertTrue(SampleTexts.forLanguage(null).isNotEmpty())
        assertEquals(SampleTexts.forLanguage("ES"), SampleTexts.forLanguage("es"))
    }

    @Test fun voicesWhoseFileNameDiffersFromTheirIdUseTheRealName() {
        // eSpeak resolves voices by file name: UK English is "en" and French is "fr" ("en-gb"/"fr-fr" are not found).
        assertEquals("en", EspeakVoices.forLocale("en", "GB")!!.espeakVoice)
        assertEquals("fr", EspeakVoices.forLocale("fr", "FR")!!.espeakVoice)
        assertEquals("readaloud-espeak-en-gb", EspeakVoices.forLocale("en", "GB")!!.systemVoiceName)
        assertEquals("readaloud-espeak-fr-fr", EspeakVoices.forLocale("fr", "FR")!!.systemVoiceName)
    }
}
