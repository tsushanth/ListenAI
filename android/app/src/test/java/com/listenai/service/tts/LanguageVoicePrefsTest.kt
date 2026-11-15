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

    private val langs = setOf("en", "es", "de")
    private fun mv(id: String) = com.listenai.service.tts.chain.CloudVoice(id, "en", "female", id, langs, "live")
    private val es1 = com.listenai.service.tts.chain.CloudVoice("es-f1", "es", "female", "Spanish female", setOf("es"), "live")

    @Test fun `the first default voice seen for a language is kept when the API reorders its list`() {
        val p = LanguagePrefs(MapStore())
        assertEquals("aria", p.resolveCloudVoice("de", listOf(mv("aria"), mv("kai")))?.id)
        assertEquals("aria", p.defaultCloudVoice("de"))
        assertEquals("a reorder does not change the voice", "aria", p.resolveCloudVoice("de", listOf(mv("kai"), mv("aria")))?.id)
    }

    @Test fun `the stored default is replaced when the list no longer offers it`() {
        val p = LanguagePrefs(MapStore())
        p.resolveCloudVoice("de", listOf(mv("aria"), mv("kai")))
        assertEquals("kai", p.resolveCloudVoice("de", listOf(mv("kai"), mv("cora")))?.id)
        assertEquals("kai", p.defaultCloudVoice("de"))
    }

    @Test fun `a native voice of the language is the first default`() {
        val p = LanguagePrefs(MapStore())
        assertEquals("es-f1", p.resolveCloudVoice("es", listOf(mv("aria"), es1))?.id)
    }

    @Test fun `a pick wins over the default and does not overwrite it`() {
        val p = LanguagePrefs(MapStore())
        p.resolveCloudVoice("es", listOf(mv("aria"), mv("kai")))
        p.setPreferredCloudVoice("es", "kai")
        assertEquals("kai", p.resolveCloudVoice("es", listOf(mv("aria"), mv("kai")))?.id)
        assertEquals("aria", p.defaultCloudVoice("es"))
    }

    @Test fun `a pick the fresh list does not offer is cleared and the default reads`() {
        val p = LanguagePrefs(MapStore())
        p.setPreferredCloudVoice("es", "gone")
        assertEquals("aria", p.resolveCloudVoice("es", listOf(mv("aria"), mv("kai")))?.id)
        assertNull(p.preferredCloudVoice("es"))
    }

    @Test fun `a pick that no longer speaks the language is cleared`() {
        val p = LanguagePrefs(MapStore())
        val kaiEs = com.listenai.service.tts.chain.CloudVoice("kai", "en", "male", "kai", setOf("en", "de"), "live")
        p.setPreferredCloudVoice("es", "kai")
        assertEquals("aria", p.resolveCloudVoice("es", listOf(mv("aria"), kaiEs))?.id)
        assertNull(p.preferredCloudVoice("es"))
    }

    @Test fun `an empty list changes nothing stored`() {
        val p = LanguagePrefs(MapStore())
        p.setPreferredCloudVoice("es", "kai")
        assertNull(p.resolveCloudVoice("es", emptyList()))
        assertEquals("kai", p.preferredCloudVoice("es"))
    }
}
