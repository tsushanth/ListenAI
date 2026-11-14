package com.listenai.service.tts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LanguageChoiceTest {
    private class MapStore : KeyValueStore {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    @Test fun `override beats detection beats stored beats English`() {
        assertEquals("fr", LanguageChoice.resolve("fr", "es", "de"))
        assertEquals("es", LanguageChoice.resolve(null, "es", "de"))
        assertEquals("de", LanguageChoice.resolve(null, null, "de"))
        assertEquals("en", LanguageChoice.resolve(null, null, null))
        assertEquals("en", LanguageChoice.resolve("", " ", ""))
    }

    @Test fun `regional tags and case are normalised`() {
        assertEquals("es", LanguageChoice.resolve("ES-mx", null, null))
        assertEquals("pt", LanguageChoice.normalize("pt_BR"))
    }

    @Test fun `redetection is skipped once the user chose`() {
        assertTrue(LanguageChoice.shouldRedetect(null))
        assertTrue(LanguageChoice.shouldRedetect(""))
        assertFalse(LanguageChoice.shouldRedetect("ru"))
    }

    @Test fun `override is remembered per document and can be cleared`() {
        val prefs = LanguagePrefs(MapStore())
        assertNull(prefs.override("a1"))
        prefs.setOverride("a1", "ru")
        prefs.setOverride("a2", "ES-es")
        assertEquals("ru", prefs.override("a1"))
        assertEquals("es", prefs.override("a2"))
        prefs.setOverride("a1", null)
        assertNull(prefs.override("a1"))
        assertEquals("es", prefs.override("a2"))
    }

    @Test fun `preferred voice is kept per language`() {
        val prefs = LanguagePrefs(MapStore())
        prefs.setPreferredVoice("es-MX", "es-us-x-esc-local")
        assertEquals("es-us-x-esc-local", prefs.preferredVoice("es"))
        assertNull(prefs.preferredVoice("fr"))
        prefs.setPreferredVoice("es", null)
        assertNull(prefs.preferredVoice("es"))
    }

    @Test fun `menu lists speakable languages plus detected and chosen, sorted by name`() {
        val names = mapOf("es" to "Spanish", "fr" to "French", "ar" to "Arabic", "ru" to "Russian", "en" to "English")
        val menu = LanguageChoice.menuLanguages(listOf("fr", "es", "FR-ca", "en"), detected = "ar", override = "ru") { names[it] ?: it }
        assertEquals(listOf("ar", "en", "fr", "ru", "es"), menu)
    }

    @Test fun `menu has no duplicates and ignores blanks`() {
        val menu = LanguageChoice.menuLanguages(listOf("es", "es-ES", "", "es-MX"), detected = "es", override = null) { it }
        assertEquals(listOf("es"), menu)
    }
}
