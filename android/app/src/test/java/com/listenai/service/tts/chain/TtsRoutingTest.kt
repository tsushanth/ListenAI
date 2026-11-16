package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TtsRoutingTest {
    @Test fun `English built-in voice uses the chain unless offline AI is chosen or forced`() {
        assertTrue(TtsRouting.useChain(isCloned = false, forceOnDevice = false, userChoseOnDeviceKokoro = false, language = "en"))
        assertTrue(TtsRouting.useChain(false, false, false, null))
        assertFalse(TtsRouting.useChain(false, true, false, "en"))
        assertFalse(TtsRouting.useChain(false, false, true, "en-GB"))
    }

    @Test fun `a non-English read never goes to the English-only model`() {
        for (lang in listOf("es", "ja", "zh-CN", "th", "ar", "pt-BR")) {
            assertTrue(lang, TtsRouting.useChain(false, false, false, lang))
            assertTrue("$lang forced offline", TtsRouting.useChain(false, true, false, lang))
            assertTrue("$lang with offline model on", TtsRouting.useChain(false, false, true, lang))
        }
    }

    @Test fun `cloned voices keep their own path`() {
        assertFalse(TtsRouting.useChain(true, false, false, "es"))
        assertFalse(TtsRouting.useChain(true, true, true, "en"))
    }

    @Test fun `a forced offline read of another language puts the phone voice first`() {
        assertTrue(TtsRouting.preferPhoneVoice(true, "ko"))
        assertFalse(TtsRouting.preferPhoneVoice(false, "ko"))
        assertFalse(TtsRouting.preferPhoneVoice(true, "en"))
        assertFalse(TtsRouting.preferPhoneVoice(true, null))
        assertEquals(false, TtsRouting.isNonEnglish(" "))
    }

    @Test fun `phone voice order for a forced non-English read lists the phone before the cloud`() {
        assertEquals(listOf(SourceId.SYSTEM, SourceId.API), TtsFlagLogic.inAppOrder(apiEnabled = true, language = "ja", preferSystem = TtsRouting.preferPhoneVoice(true, "ja")))
    }
}
