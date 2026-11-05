package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceHelpersTest {
    @Test fun `429 keeps Retry-After, 402 is quota, 503 is retryable server error`() {
        assertEquals(FallbackReason.RATE_LIMITED, ApiFailureMapping.fromHttp(429, "12").reason)
        assertEquals(12_000L, ApiFailureMapping.fromHttp(429, "12").retryAfterMs)
        assertNull(ApiFailureMapping.fromHttp(429, "Wed, 21 Oct 2026 07:28:00 GMT").retryAfterMs)
        assertNull(ApiFailureMapping.fromHttp(429, "999999").retryAfterMs)
        assertEquals(FallbackReason.QUOTA, ApiFailureMapping.fromHttp(402).reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromHttp(503, "2").reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromHttp(502).reason)
        assertEquals(FallbackReason.TIMEOUT, ApiFailureMapping.fromHttp(504).reason)
        assertEquals(FallbackReason.OFFLINE, ApiFailureMapping.fromHttp(500, online = false).reason)
    }

    @Test fun `websocket error frames`() {
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromWsError("at capacity, retry shortly").reason)
        assertEquals(FallbackReason.QUOTA, ApiFailureMapping.fromWsError("free credits used up").reason)
        assertEquals(FallbackReason.RATE_LIMITED, ApiFailureMapping.fromWsError("rate limit exceeded").reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromWsError("boom").reason)
    }

    @Test fun `exceptions map by connectivity first`() {
        assertEquals(FallbackReason.OFFLINE, ApiFailureMapping.fromThrowable(java.net.UnknownHostException(), online = false).reason)
        assertEquals(FallbackReason.TIMEOUT, ApiFailureMapping.fromThrowable(java.net.SocketTimeoutException(), online = true).reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromThrowable(java.net.ConnectException(), online = true).reason)
    }

    @Test fun `engine picker prefers Google then Samsung and never picks our own engine`() {
        assertEquals("com.google.android.tts", TtsEnginePicker.pick(listOf("com.samsung.SMT", "com.google.android.tts", "com.listenai.voice")))
        assertEquals("com.samsung.SMT", TtsEnginePicker.pick(listOf("com.listenai.voice", "com.samsung.SMT")))
        assertEquals("com.acme.tts", TtsEnginePicker.pick(listOf("com.listenai.voice.debug", "com.acme.tts")))
        assertNull(TtsEnginePicker.pick(listOf("com.listenai.voice", "com.listenai.voice.debug", "com.listenai")))
        assertNull(TtsEnginePicker.pick(emptyList()))
        assertNull(TtsEnginePicker.pick(listOf("org.other.tts"), ownPackage = "org.other.tts"))
    }

    @Test fun `rtf verdict drops the warm-up sample and decides once`() {
        val v = RtfVerdict(needed = 2, maxRtf = 1.0)
        assertNull(v.add(9_000, 1_000)) // warm-up, ignored
        assertNull(v.add(500, 1_000))
        assertEquals(true, v.add(600, 1_000))
        assertEquals(true, v.add(90_000, 1_000)) // decided already
        val slow = RtfVerdict(needed = 2)
        slow.add(1, 1); slow.add(3_000, 1_000)
        assertEquals(false, slow.add(2_500, 1_000))
        assertTrue(slow.medianRtf!! > 1.0)
    }
}

class TtsFlagLogicTest {
    @Test fun `override beats remote beats build default`() {
        assertEquals(false, TtsFlagLogic.resolve(false, true, true))
        assertEquals(true, TtsFlagLogic.resolve(null, true, false))
        assertEquals(true, TtsFlagLogic.resolve(null, null, true))
        assertEquals(false, TtsFlagLogic.resolve(null, null, false))
    }

    @Test fun `remote config parsing`() {
        assertEquals(TtsFlagLogic.Remote(false, true), TtsFlagLogic.parseRemote("""{"paywallMode":"x","tts":{"apiEnabled":false,"engineApiEnabled":true}}"""))
        assertEquals(TtsFlagLogic.Remote(null, null), TtsFlagLogic.parseRemote("""{"paywall":{"cooldownHours":4}}"""))
        assertEquals(TtsFlagLogic.Remote(null, false), TtsFlagLogic.parseRemote("""{"tts": { "engineApiEnabled" : false }}"""))
        assertEquals(TtsFlagLogic.Remote(null, null), TtsFlagLogic.parseRemote("""{"tts":{"apiEnabled":"yes"}}"""))
        assertEquals(TtsFlagLogic.Remote(null, null), TtsFlagLogic.parseRemote("not json"))
    }

    @Test fun `in-app order`() {
        assertEquals(listOf(SourceId.API, SourceId.SYSTEM, SourceId.ON_DEVICE), TtsFlagLogic.inAppOrder(true, "en-US"))
        assertEquals(listOf(SourceId.ON_DEVICE, SourceId.SYSTEM), TtsFlagLogic.inAppOrder(false, "en"))
        // The on-device model is English only: other languages never reach it.
        assertEquals(listOf(SourceId.API, SourceId.SYSTEM), TtsFlagLogic.inAppOrder(true, "es-MX"))
        assertEquals(listOf(SourceId.SYSTEM), TtsFlagLogic.inAppOrder(false, "de"))
    }
}
