package com.listenai.service.tts.chain

import com.listenai.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineCallerPolicyTest {
    @Test fun `engine API is off by default and with no remote value`() {
        assertFalse(BuildConfig.TTS_ENGINE_API_DEFAULT)
        assertEquals(false, TtsFlagLogic.resolve(null, null, BuildConfig.TTS_ENGINE_API_DEFAULT))
        // Absent or malformed remote config leaves it off.
        assertEquals(null, TtsFlagLogic.parseRemote("""{"tts":{"apiEnabled":true}}""").engineApiEnabled)
        assertEquals(null, TtsFlagLogic.parseRemote("not json").engineApiEnabled)
    }

    @Test fun `known screen readers are never routed even when nothing else is known`() {
        listOf(
            "com.google.android.marvin.talkback",
            "com.samsung.android.accessibility.talkback",
            "com.google.android.accessibility.selecttospeak",
            "com.google.android.accessibility.switchaccess",
        ).forEach {
            assertTrue(it, EngineCallerPolicy.isBlockedPackage(it))
            assertFalse(it, EngineCallerPolicy.mayRouteToApi(listOf(it), emptyList()))
        }
    }

    @Test fun `unlisted talkback or accessibility packages are blocked by name`() {
        assertTrue(EngineCallerPolicy.isBlockedPackage("com.vendor.TalkBack.lite"))
        assertTrue(EngineCallerPolicy.isBlockedPackage("com.vendor.accessibility.reader"))
    }

    @Test fun `any enabled accessibility service is never routed`() {
        assertFalse(EngineCallerPolicy.mayRouteToApi(listOf("com.example.helper"), listOf("com.example.helper")))
        // A caller sharing a uid with an accessibility service is refused too.
        assertFalse(EngineCallerPolicy.mayRouteToApi(listOf("com.example.a", "com.example.helper"), listOf("com.example.helper")))
    }

    @Test fun `an unidentified caller fails closed`() {
        assertFalse(EngineCallerPolicy.mayRouteToApi(emptyList(), emptyList()))
    }

    @Test fun `an ordinary reading app is allowed once the flag is on`() {
        assertTrue(EngineCallerPolicy.mayRouteToApi(listOf("com.amazon.kindle"), listOf("com.google.android.marvin.talkback")))
    }
}
