package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceSelectionTest {
    private fun v(name: String, lang: String, region: String = "", quality: Int = 300, network: Boolean = false, installed: Boolean = true) =
        SystemVoiceInfo(name, lang, region, quality, network, installed)

    private val es = listOf(
        v("es-es-x-eea-local", "es", "ES", 400),
        v("es-us-x-esc-local", "es", "US", 400),
        v("es-es-x-eed-network", "es", "ES", 500, network = true),
        v("es-mx-x-gen-local", "es", "MX", 300),
        v("fr-fr-x-frb-local", "fr", "FR", 400),
    )

    @Test fun `only voices of the language are considered`() {
        assertEquals(4, VoiceSelection.forLanguage(es, "es").size)
        assertEquals(4, VoiceSelection.forLanguage(es, "ES-mx").size)
        assertEquals(1, VoiceSelection.forLanguage(es, "fr").size)
    }

    @Test fun `on-device beats network even when the network voice rates higher`() {
        val best = VoiceSelection.choose(es, "es", null, online = true)
        assertEquals(false, best!!.networkRequired)
        assertEquals(400, best.quality)
    }

    @Test fun `higher quality beats lower among on-device voices`() {
        val list = listOf(v("a", "es", quality = 300), v("b", "es", quality = 400), v("c", "es", quality = 200))
        assertEquals(listOf("b", "a", "c"), VoiceSelection.ranked(list, "es", online = true).map { it.name })
    }

    @Test fun `phone region breaks a quality tie`() {
        assertEquals("es-us-x-esc-local", VoiceSelection.choose(es, "es", null, online = true, deviceRegion = "US")!!.name)
        assertEquals("es-es-x-eea-local", VoiceSelection.choose(es, "es", null, online = true, deviceRegion = "ES")!!.name)
        // no region match: name order keeps the answer stable
        assertEquals("es-es-x-eea-local", VoiceSelection.choose(es, "es", null, online = true, deviceRegion = "AR")!!.name)
    }

    @Test fun `network voices do not count while offline`() {
        val onlyNet = listOf(v("n", "es", quality = 500, network = true))
        assertNull(VoiceSelection.choose(onlyNet, "es", null, online = false))
        assertEquals("n", VoiceSelection.choose(onlyNet, "es", null, online = true)!!.name)
    }

    @Test fun `a voice that is not downloaded is never chosen`() {
        val list = listOf(v("missing", "ru", quality = 500, installed = false), v("ok", "ru", quality = 200))
        assertEquals("ok", VoiceSelection.choose(list, "ru", null, online = true)!!.name)
        assertNull(VoiceSelection.choose(listOf(list[0]), "ru", null, online = true))
    }

    @Test fun `the user's stored pick wins while it works and is ignored when it stops working`() {
        assertEquals("es-mx-x-gen-local", VoiceSelection.choose(es, "es", "es-mx-x-gen-local", online = true)!!.name)
        val gone = es.map { if (it.name == "es-mx-x-gen-local") it.copy(installed = false) else it }
        assertEquals("es-es-x-eea-local", VoiceSelection.choose(gone, "es", "es-mx-x-gen-local", online = true)!!.name)
        assertEquals("es-es-x-eea-local", VoiceSelection.choose(es, "es", "no-such-voice", online = true)!!.name)
    }

    @Test fun `usable list excludes broken voices and keeps best first`() {
        val u = VoiceSelection.usable(es + v("es-ar-x-nope", "es", "AR", 500, installed = false), "es", online = false)
        assertEquals(listOf("es-es-x-eea-local", "es-us-x-esc-local", "es-mx-x-gen-local"), u.map { it.name })
    }

    @Test fun `status tells missing from unusable from fine`() {
        assertEquals(VoiceSelection.Status.NONE_LISTED, VoiceSelection.status(es, "ar", online = true))
        assertEquals(VoiceSelection.Status.USABLE, VoiceSelection.status(es, "es", online = false))
        val broken = listOf(v("x", "ar", installed = false), v("y", "ar", network = true))
        assertEquals(VoiceSelection.Status.NOT_USABLE, VoiceSelection.status(broken, "ar", online = false))
        assertEquals(VoiceSelection.Status.USABLE, VoiceSelection.status(broken, "ar", online = true))
    }

    @Test fun `speakable languages are those with a working voice`() {
        val list = es + v("ar-x", "ar", installed = false) + v("ru-net", "ru", network = true)
        assertEquals(setOf("es", "fr"), VoiceSelection.speakableLanguages(list, online = false))
        assertEquals(setOf("es", "fr", "ru"), VoiceSelection.speakableLanguages(list, online = true))
        assertTrue("ar" !in VoiceSelection.speakableLanguages(list, online = true))
    }
}
