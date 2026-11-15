package com.listenai.service.tts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LanguageVoicePrefsTest {
    private class MapStore : KeyValueStore {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    @Test fun `a ReadAloud voice pick is remembered per language`() {
        val p = LanguagePrefs(MapStore())
        assertNull(p.preferredCloudVoice("es"))
        p.setPreferredCloudVoice("es", "kai")
        p.setPreferredCloudVoice("hi", "cora")
        assertEquals("kai", p.preferredCloudVoice("es"))
        assertEquals("cora", p.preferredCloudVoice("hi"))
        assertNull(p.preferredCloudVoice("ja"))
    }

    @Test fun `regional forms of a language share one pick`() {
        val p = LanguagePrefs(MapStore())
        p.setPreferredCloudVoice("es-MX", "kai")
        assertEquals("kai", p.preferredCloudVoice("es"))
        assertEquals("kai", p.preferredCloudVoice("ES-es"))
    }

    @Test fun `a pick survives a new LanguagePrefs over the same store`() {
        val store = MapStore()
        LanguagePrefs(store).setPreferredCloudVoice("de", "gabe")
        assertEquals("gabe", LanguagePrefs(store).preferredCloudVoice("de"))
    }

    @Test fun `picking a phone voice replaces the ReadAloud pick, and the other way round`() {
        val p = LanguagePrefs(MapStore())
        p.setPreferredCloudVoice("es", "kai")
        p.setPreferredVoice("es", "es-us-x-abc-local")
        assertNull(p.preferredCloudVoice("es"))
        assertEquals("es-us-x-abc-local", p.preferredVoice("es"))
        p.setPreferredCloudVoice("es", "aria")
        assertNull(p.preferredVoice("es"))
        assertEquals("aria", p.preferredCloudVoice("es"))
    }

    @Test fun `clearing the ReadAloud pick leaves a phone pick alone, and Automatic clears both`() {
        val p = LanguagePrefs(MapStore())
        p.setPreferredVoice("fr", "fr-voice")
        p.setPreferredCloudVoice("fr", null)
        assertEquals("fr-voice", p.preferredVoice("fr"))
        p.setPreferredCloudVoice("fr", "aria")
        p.setPreferredCloudVoice("fr", null)
        p.setPreferredVoice("fr", null)
        assertNull(p.preferredVoice("fr"))
        assertNull(p.preferredCloudVoice("fr"))
    }

    @Test fun `a pick for one language does not touch another's phone voice`() {
        val p = LanguagePrefs(MapStore())
        p.setPreferredVoice("de", "de-voice")
        p.setPreferredCloudVoice("es", "kai")
        assertEquals("de-voice", p.preferredVoice("de"))
    }
}
