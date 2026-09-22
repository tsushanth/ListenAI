package com.listenai.service.tts

import com.listenai.data.models.VoicePreset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PiperVoiceMappingTest {

    @Test
    fun `every built-in voice has a real, non-fallback mapping entry`() {
        for (voice in VoicePreset.builtInVoices) {
            val resolved = PiperVoiceMapping.resolve(voice)
            assertTrue("voice ${voice.id} resolved to blank", resolved.isNotBlank())
            assertTrue("voice ${voice.id} resolved to $resolved, expected custom: prefix", resolved.startsWith("custom:"))
            assertTrue(
                "voice ${voice.id} silently fell back to the default - add a real mapping entry",
                PiperVoiceMapping.MAPPING_FOR_TEST.containsKey(voice.id)
            )
        }
    }

    @Test
    fun `unmapped voice falls back to the documented default, not a crash`() {
        val unknownVoice = VoicePreset.builtInVoices.first().copy(id = "totally-unmapped-voice-id")
        val resolved = PiperVoiceMapping.resolve(unknownVoice)
        assertEquals(PiperVoiceMapping.FALLBACK_VOICE_ID, resolved)
    }
}
