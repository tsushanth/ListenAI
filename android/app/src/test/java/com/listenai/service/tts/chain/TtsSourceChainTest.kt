package com.listenai.service.tts.chain

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

private fun pcm(ms: Int = 1000, rate: Int = 24_000) = PcmChunk(ByteArray(rate * 2 * ms / 1000), rate)

/** A source whose behaviour is a lambda over (call number, text). */
private class FakeSource(
    override val id: SourceId,
    private val unavailable: () -> FallbackReason? = { null },
    private val rate: Int = 24_000,
    private val behave: suspend (call: Int, text: String) -> PcmChunk = { _, _ -> pcm(rate = rate) },
) : TtsSource {
    val calls = AtomicInteger()
    val inFlight = AtomicInteger()
    var maxInFlight = 0
    val measured = ArrayList<Pair<Long, Long>>()
    override suspend fun unavailableReason(request: TtsRequest) = unavailable()
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
        val n = calls.incrementAndGet()
        val now = inFlight.incrementAndGet()
        synchronized(this) { if (now > maxInFlight) maxInFlight = now }
        try { return behave(n, text) } finally { inFlight.decrementAndGet() }
    }
    override fun onChunkMeasured(synthMs: Long, audioMs: Long) { measured += synthMs to audioMs }
}

private class Recorder : TtsTelemetry {
    val reports = ArrayList<SessionReport>()
    override fun report(report: SessionReport) { reports += report }
}

// ~6 sentences of ~60 chars: chunks of 280 chars each hold several sentences, first chunk is shorter.
private val TEXT = (1..14).joinToString(" ") { "This is sentence number $it of the test paragraph." }
private val REQ = TtsRequest(voiceId = "bella", language = "en-US")

@OptIn(ExperimentalCoroutinesApi::class)
class TtsSourceChainTest {

    private fun TestScope.chain(
        api: TtsSource? = null,
        system: TtsSource? = null,
        device: TtsSource? = null,
        order: List<SourceId> = listOf(SourceId.API, SourceId.SYSTEM, SourceId.ON_DEVICE),
        cache: ChunkCache? = null,
        telemetry: TtsTelemetry = TtsTelemetry.None,
        config: ChainConfig = ChainConfig(),
    ) = TtsSourceChain(
        sources = listOfNotNull(api, system, device).associateBy { it.id },
        order = { order },
        cache = cache, config = config, telemetry = telemetry,
        nowMs = { currentTime },
    )

    @Test fun `healthy API serves every chunk in order with prefetch`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> delay(100); pcm() }
        val system = FakeSource(SourceId.SYSTEM)
        val out = chain(api, system).speak(TEXT, REQ).toList()
        assertTrue(out.size >= 3)
        assertEquals(out.indices.toList(), out.map { it.index })
        assertTrue(out.all { it.source == SourceId.API && !it.fromCache && it.total == out.size })
        assertEquals(0, system.calls.get())
        assertTrue("prefetch should overlap chunks", api.maxInFlight >= 2)
        assertTrue("prefetch window is 2", api.maxInFlight <= 2)
    }

    @Test fun `API down falls back to system after one retry and stays down for the cooldown`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> throw SourceFailure(FallbackReason.SERVER_ERROR) }
        val system = FakeSource(SourceId.SYSTEM)
        val rec = Recorder()
        val c = chain(api, system, telemetry = rec)
        val out = c.speak(TEXT, REQ).toList()
        assertTrue(out.all { it.source == SourceId.SYSTEM })
        // Two chunks are prefetched at once, each tries the API twice (1 retry); after that the session is on system.
        assertTrue("api calls ${api.calls.get()}", api.calls.get() in 2..4)
        val callsAfterFirst = api.calls.get()
        assertEquals(SourceId.SYSTEM, rec.reports.single().firstSource)
        assertTrue(rec.reports.single().fallbackReasons.contains(SourceId.API to FallbackReason.SERVER_ERROR))

        // Second read within the cooldown does not touch the API at all.
        c.speak(TEXT, REQ).toList()
        assertEquals(callsAfterFirst, api.calls.get())
        // After the cooldown it is tried again.
        delay(31_000)
        c.speak(TEXT, REQ).toList()
        assertTrue(api.calls.get() > callsAfterFirst)
    }

    @Test fun `429 is not retried and honours Retry-After`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> throw SourceFailure(FallbackReason.RATE_LIMITED, retryAfterMs = 5_000) }
        val system = FakeSource(SourceId.SYSTEM)
        val c = chain(api, system)
        c.speak("One short sentence.", REQ).toList()
        assertEquals(1, api.calls.get())
        c.speak("One short sentence.", REQ).toList()
        assertEquals("cooling down", 1, api.calls.get())
        delay(5_001)
        c.speak("One short sentence.", REQ).toList()
        assertEquals(2, api.calls.get())
    }

    @Test fun `quota exhausted (402) skips the API for ten minutes`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> throw SourceFailure(FallbackReason.QUOTA) }
        val system = FakeSource(SourceId.SYSTEM)
        val rec = Recorder()
        val c = chain(api, system, telemetry = rec)
        c.speak("Hello there.", REQ).toList()
        delay(9 * 60_000L)
        c.speak("Hello there.", REQ).toList()
        assertEquals(1, api.calls.get())
        assertEquals(FallbackReason.QUOTA, rec.reports.last().fallbackReasons.first().second)
        delay(2 * 60_000L)
        c.speak("Hello there.", REQ).toList()
        assertEquals(2, api.calls.get())
    }

    @Test fun `timeout mid-stream moves the rest of the session to system`() = runTest {
        val api = FakeSource(SourceId.API) { call, _ -> if (call == 1) pcm() else awaitCancellation() }
        val system = FakeSource(SourceId.SYSTEM)
        val out = chain(api, system, config = ChainConfig(retries = 0)).speak(TEXT, REQ).toList()
        assertEquals(SourceId.API, out.first().source)
        assertTrue(out.drop(1).all { it.source == SourceId.SYSTEM })
        assertEquals(out.indices.toList(), out.map { it.index })
    }

    @Test fun `hung first chunk times out and system speaks`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> awaitCancellation() }
        val system = FakeSource(SourceId.SYSTEM)
        val rec = Recorder()
        val out = chain(api, system, config = ChainConfig(retries = 0), telemetry = rec).speak("Hi there.", REQ).toList()
        assertEquals(SourceId.SYSTEM, out.single().source)
        assertEquals(FallbackReason.TIMEOUT, rec.reports.single().fallbackReasons.first().second)
        assertTrue("fell back after the first-chunk deadline", currentTime in 4_500..6_000)
    }

    @Test fun `system engine missing falls through to the on-device model`() = runTest {
        val api = FakeSource(SourceId.API, unavailable = { FallbackReason.OFFLINE })
        val system = FakeSource(SourceId.SYSTEM, unavailable = { FallbackReason.ENGINE_MISSING })
        val device = FakeSource(SourceId.ON_DEVICE)
        val out = chain(api, system, device).speak(TEXT, REQ).toList()
        assertTrue(out.all { it.source == SourceId.ON_DEVICE })
        assertEquals(0, api.calls.get())
        assertEquals(0, system.calls.get())
    }

    @Test fun `language data missing everywhere asks for voice data`() = runTest {
        val api = FakeSource(SourceId.API, unavailable = { FallbackReason.OFFLINE })
        val system = FakeSource(SourceId.SYSTEM, unavailable = { FallbackReason.LANGUAGE_MISSING })
        val device = FakeSource(SourceId.ON_DEVICE, unavailable = { FallbackReason.MODEL_ABSENT })
        try {
            chain(api, system, device).speak("Hola, buenos dias.", TtsRequest("bella", "es-MX")).toList()
            fail("expected NoSourceAvailableException")
        } catch (e: NoSourceAvailableException) {
            assertEquals(UserAction.InstallVoiceData("es"), e.action)
            assertEquals(FallbackReason.LANGUAGE_MISSING, e.failures[SourceId.SYSTEM])
            assertEquals(FallbackReason.MODEL_ABSENT, e.failures[SourceId.ON_DEVICE])
        }
    }

    @Test fun `no engine installed asks to install an engine, offline with no engine problem asks to connect`() = runTest {
        val api = FakeSource(SourceId.API, unavailable = { FallbackReason.OFFLINE })
        val noEngine = FakeSource(SourceId.SYSTEM, unavailable = { FallbackReason.ENGINE_MISSING })
        val e1 = try { chain(api, noEngine).speak("Hi.", REQ).toList(); null } catch (e: NoSourceAvailableException) { e }
        assertTrue(e1!!.action is UserAction.InstallEngine)
        val tooSlow = FakeSource(SourceId.ON_DEVICE, unavailable = { FallbackReason.MODEL_TOO_SLOW })
        val sysOk = FakeSource(SourceId.SYSTEM) { _, _ -> throw SourceFailure(FallbackReason.UNKNOWN) }
        val e2 = try { chain(api, sysOk, tooSlow).speak("Hi.", REQ).toList(); null } catch (e: NoSourceAvailableException) { e }
        assertEquals(UserAction.CheckConnection, e2!!.action)
    }

    @Test fun `cached chunks play offline and only API audio is cached`() = runTest {
        val cache = MemoryChunkCache()
        val api = FakeSource(SourceId.API)
        val c1 = chain(api, FakeSource(SourceId.SYSTEM), cache = cache)
        val first = c1.speak(TEXT, REQ).toList()
        assertEquals(first.size, cache.map.size)

        // Now the network is gone and the API is down: everything comes from the cache, system is never asked.
        val dead = FakeSource(SourceId.API, unavailable = { FallbackReason.OFFLINE })
        val system = FakeSource(SourceId.SYSTEM)
        val again = chain(dead, system, cache = cache).speak(TEXT, REQ).toList()
        assertTrue(again.all { it.fromCache })
        assertEquals(0, system.calls.get())
        assertEquals(first.size, again.size)

        // A chunk spoken by system TTS is not cached.
        val cache2 = MemoryChunkCache()
        chain(FakeSource(SourceId.API, unavailable = { FallbackReason.OFFLINE }), FakeSource(SourceId.SYSTEM), cache = cache2)
            .speak("Only system.", REQ).toList()
        assertTrue(cache2.map.isEmpty())
    }

    @Test fun `flag off puts the on-device model first and never calls the API`() = runTest {
        var apiOn = true
        val api = FakeSource(SourceId.API)
        val device = FakeSource(SourceId.ON_DEVICE)
        val system = FakeSource(SourceId.SYSTEM)
        val chain = TtsSourceChain(
            sources = listOf(api, system, device).associateBy { it.id },
            order = { if (apiOn) listOf(SourceId.API, SourceId.SYSTEM, SourceId.ON_DEVICE) else listOf(SourceId.ON_DEVICE, SourceId.SYSTEM) },
            nowMs = { currentTime },
        )
        assertEquals(SourceId.API, chain.speak("One.", REQ).toList().single().source)
        apiOn = false
        assertEquals(SourceId.ON_DEVICE, chain.speak("Two.", REQ).toList().single().source)
        assertEquals(1, api.calls.get())
    }

    @Test fun `all output is one sample rate`() = runTest {
        val api = FakeSource(SourceId.API, rate = 24_000) { call, _ -> if (call == 1) pcm(rate = 24_000) else throw SourceFailure(FallbackReason.SERVER_ERROR) }
        val system = FakeSource(SourceId.SYSTEM, rate = 22_050)
        val out = chain(api, system, config = ChainConfig(retries = 0)).speak(TEXT, REQ).toList()
        assertTrue(out.any { it.source == SourceId.SYSTEM })
        assertTrue(out.all { it.audio.sampleRate == 24_000 })
        // 1 s of 22.05 kHz audio is still about 1 s at 24 kHz.
        val sys = out.first { it.source == SourceId.SYSTEM }
        assertTrue(sys.audio.durationMs in 990..1010)
    }

    @Test fun `telemetry carries no text and reports time to first audio`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> delay(300); pcm() }
        val rec = Recorder()
        chain(api, FakeSource(SourceId.SYSTEM), telemetry = rec).speak("Secret diary entry number one. And more.", REQ).toList()
        val r = rec.reports.single()
        assertEquals(SourceId.API, r.firstSource)
        assertEquals(300L, r.timeToFirstAudioMs)
        assertTrue(r.succeeded)
        assertFalse(r.toString().contains("diary"))
        assertEquals("en", r.language)
    }

    @Test fun `on-chunk measurement reaches the source`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> delay(200); pcm(2000) }
        chain(api, null).speak("Hello world.", REQ).toList()
        assertEquals(listOf(200L to 2000L), api.measured)
    }

    @Test fun `empty text emits nothing`() = runTest {
        assertTrue(chain(FakeSource(SourceId.API)).speak("   ", REQ).toList().isEmpty())
    }

    @Test fun `empty audio from the API counts as a failure`() = runTest {
        val api = FakeSource(SourceId.API) { _, _ -> PcmChunk(ByteArray(0), 24_000) }
        val out = chain(api, FakeSource(SourceId.SYSTEM), config = ChainConfig(retries = 0)).speak("Hi.", REQ).toList()
        assertEquals(SourceId.SYSTEM, out.single().source)
    }
}
