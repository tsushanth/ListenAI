package com.listenai.service.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCloneApiErrorBodyTest {
    @Test fun `global handler body keeps its category as the code even though it now also sends a lower-case code`() {
        val e = VoiceCloneApi.parseErrorBody(503, """{"error":"CLONING_UNAVAILABLE","message":"Voice cloning is not available.","code":"cloning_unavailable"}""")
        assertEquals("CLONING_UNAVAILABLE", e.code)
        assertEquals("Voice cloning is not available.", e.serverMessage)
    }

    @Test fun `voice-clones body uses its own code and puts the text in error`() {
        val e = VoiceCloneApi.parseErrorBody(400, """{"error":"Invalid report.","code":"validation"}""")
        assertEquals("validation", e.code)
        assertEquals("Invalid report.", e.serverMessage)
    }

    @Test fun `old global handler body without a code is unchanged`() {
        val e = VoiceCloneApi.parseErrorBody(402, """{"error":"QUOTA_EXCEEDED","message":"Daily limit reached"}""")
        assertEquals("QUOTA_EXCEEDED", e.code)
    }
}
