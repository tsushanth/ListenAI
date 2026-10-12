package com.listenai.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LanguageDetectorTest {
    @Test fun picksHighestConfidence() =
        assertEquals("es", LanguageDetector.pickLanguage(listOf("en" to 0.1f, "es" to 0.85f)))

    @Test fun belowThresholdIsUnknown() =
        assertNull(LanguageDetector.pickLanguage(listOf("fr" to 0.4f, "en" to 0.3f)))

    @Test fun undeterminedIsUnknown() =
        assertNull(LanguageDetector.pickLanguage(listOf("und" to 0.99f)))

    @Test fun scriptSuffixDropped() = assertEquals("ja", LanguageDetector.normalize("ja-Latn"))

    @Test fun emptyCandidates() = assertNull(LanguageDetector.pickLanguage(emptyList()))

    @Test fun shortTextSampledWhole() = assertEquals("hola", LanguageDetector.sample("  hola "))

    @Test fun longTextSamplesStartAndMiddle() {
        val text = "A".repeat(2000) + "B".repeat(2000) + "C".repeat(2000)
        val s = LanguageDetector.sample(text)
        assertEquals(true, s.startsWith("A") && s.contains("B") && !s.contains("C"))
        assertEquals(true, s.length < 1600)
    }
}
