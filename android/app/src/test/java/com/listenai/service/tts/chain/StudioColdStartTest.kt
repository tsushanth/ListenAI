package com.listenai.service.tts.chain

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

private val COLD_STUDIO_VOICE = CloudVoice("mira", "en", "female", "Mira", setOf("en", "ar", "zh"), "studio")
private val COLD_LIVE_VOICE = CloudVoice("aria", "en", "female", "Aria", setOf("en", "ar", "zh"), "live")

/**
 * A cloud source that pins [voice] and whose speech machine is starting from zero: a call made before [warmAtMs] (virtual time)
 * is answered at [warmAtMs], a later one at once. [never]: it does not answer at all.
 */
private class ColdApi(private val voice: CloudVoice, private val now: () -> Long, private val warmAtMs: Long, private val never: Boolean = false) : TtsSource {
    override val id = SourceId.API
    val calls = AtomicInteger()
    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = null
    override suspend fun pin(request: TtsRequest) = request.copy(cloudVoice = voice)
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
        calls.incrementAndGet()
        if (never) delay(10 * 60_000L)
        if (now() < warmAtMs) delay(warmAtMs - now())
        return PcmChunk(ByteArray(48_000), 24_000)
    }
}

private class ColdPhone : TtsSource {
    override val id = SourceId.SYSTEM
    val calls = AtomicInteger()
    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = null
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk { calls.incrementAndGet(); return PcmChunk(ByteArray(48_000), 24_000) }
}

private val COLD_TEXT = (1..14).joinToString(" ") { "Sentence number $it of the test paragraph." }

@OptIn(ExperimentalCoroutinesApi::class)
class StudioColdStartTest {

    private fun TestScope.chain(api: TtsSource, phone: ColdPhone) = TtsSourceChain(
        sources = mapOf(SourceId.API to api, SourceId.SYSTEM to phone),
        order = { listOf(SourceId.API, SourceId.SYSTEM) },
        nowMs = { currentTime },
    )

    private val req = TtsRequest("bella", "ar")

    @Test fun `a studio voice that needs 44 s for its first calls is waited for - no retry, no fallback, no cooldown`() = runTest {
        val api = ColdApi(COLD_STUDIO_VOICE, { currentTime }, warmAtMs = 44_000)
        val phone = ColdPhone()
        val c = chain(api, phone)
        val out = c.speak(COLD_TEXT, req).toList()
        assertTrue(out.size >= 3)
        assertTrue(out.all { it.source == SourceId.API })
        assertEquals(0, phone.calls.get())
        assertEquals("each chunk asked once, no retry", out.size, api.calls.get())
        assertTrue("first audio after the cold start, not before: ${currentTime}", currentTime >= 44_000)
        // the next read still goes to the cloud: the slow start did not start a cooldown
        val second = c.speak(COLD_TEXT, req).toList()
        assertTrue(second.all { it.source == SourceId.API })
        assertEquals(0, phone.calls.get())
    }

    @Test fun `a live voice with the same slow start still times out and falls back to the phone, as before`() = runTest {
        val api = ColdApi(COLD_LIVE_VOICE, { currentTime }, warmAtMs = 44_000)
        val phone = ColdPhone()
        val out = chain(api, phone).speak(COLD_TEXT, req).toList()
        assertTrue(out.isNotEmpty() && out.all { it.source == SourceId.SYSTEM })
        assertTrue(phone.calls.get() > 0)
    }

    @Test fun `a studio voice that never answers is still given up on, after the cold-start deadline, and the phone reads`() = runTest {
        val api = ColdApi(COLD_STUDIO_VOICE, { currentTime }, warmAtMs = 0, never = true)
        val phone = ColdPhone()
        val c = chain(api, phone)
        val out = c.speak(COLD_TEXT, req).toList()
        assertTrue(out.isNotEmpty() && out.all { it.source == SourceId.SYSTEM })
        // one wait of about the cold-start deadline, no second one for the same chunk
        assertTrue("took ${currentTime} ms", currentTime in 75_000..85_000)
    }

    @Test fun `a studio voice answering quickly keeps the usual path`() = runTest {
        val api = ColdApi(COLD_STUDIO_VOICE, { currentTime }, warmAtMs = 0)
        val phone = ColdPhone()
        val out = chain(api, phone).speak(COLD_TEXT, req).toList()
        assertTrue(out.all { it.source == SourceId.API })
        assertEquals(0, phone.calls.get())
    }
}
