package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Test

class PickStateTest {
    private fun v(name: String, lang: String = "es", installed: Boolean = true, net: Boolean = false) =
        SystemVoiceInfo(name, lang, "ES", 300, net, installed)

    private val voices = listOf(v("es-a-local"), v("es-b-network", net = true), v("fr-a-local", "fr"))

    @Test fun `no pick`() {
        assertEquals(VoiceSelection.PickState.NONE, VoiceSelection.pickState(voices, "es", null, true))
        assertEquals(VoiceSelection.PickState.NONE, VoiceSelection.pickState(voices, "es", "", true))
    }

    @Test fun `a pick that is installed is valid`() {
        assertEquals(VoiceSelection.PickState.VALID, VoiceSelection.pickState(voices, "es", "es-a-local", true))
    }

    @Test fun `a network voice while offline is kept, not cleared`() {
        assertEquals(VoiceSelection.PickState.UNUSABLE_NOW, VoiceSelection.pickState(voices, "es", "es-b-network", false))
        assertEquals(VoiceSelection.PickState.VALID, VoiceSelection.pickState(voices, "es", "es-b-network", true))
    }

    @Test fun `a voice that is not downloaded is kept`() {
        val l = listOf(v("es-a-local", installed = false), v("es-c-local"))
        assertEquals(VoiceSelection.PickState.UNUSABLE_NOW, VoiceSelection.pickState(l, "es", "es-a-local", true))
    }

    @Test fun `a voice the engine no longer lists is gone`() {
        assertEquals(VoiceSelection.PickState.GONE, VoiceSelection.pickState(voices, "es", "es-uninstalled", true))
        // listed, but for another language
        assertEquals(VoiceSelection.PickState.GONE, VoiceSelection.pickState(voices, "es", "fr-a-local", true))
    }

    @Test fun `an engine that lists nothing cannot tell, so the pick stays`() {
        assertEquals(VoiceSelection.PickState.UNUSABLE_NOW, VoiceSelection.pickState(emptyList(), "es", "es-a-local", true))
    }
}
