package com.listenai.service.tts.chain

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

private fun audio(ms: Int = 1000) = PcmChunk(ByteArray(24_000 * 2 * ms / 1000), 24_000)

/** A cloud-like source: [voiceFor] names the voice per language (null = not offered), [fail] makes a language fail. */
private class CloudLike(
    var voiceFor: (String) -> String? = { lang -> if (lang == "es") "custom:es-pilot-f" else "kristin" },
    var fail: (String) -> FallbackReason? = { null },
    var unavailable: FallbackReason? = null,
) : TtsSource {
    override val id = SourceId.API
    val calls = AtomicInteger()
    override suspend fun cacheVoice(request: TtsRequest) = voiceFor(request.language.substringBefore('-'))
    override suspend fun unavailableReason(request: TtsRequest) = unavailable
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
        calls.incrementAndGet()
        fail(request.language.substringBefore('-'))?.let { throw SourceFailure(it) }
        return audio()
    }
}

private class PhoneLike : TtsSource {
    override val id = SourceId.SYSTEM
    val calls = AtomicInteger()
    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = null
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk { calls.incrementAndGet(); return audio() }
}

private class MemCache : ChunkCache {
    val map = HashMap<String, PcmChunk>()
    override fun get(key: String) = map[key]
    override fun put(key: String, chunk: PcmChunk) { map[key] = chunk }
}

private const val ES_TEXT = "Hola, esto es una prueba."

@OptIn(ExperimentalCoroutinesApi::class)
class CacheAndCooldownTest {

    private fun TestScope.chain(api: TtsSource, phone: TtsSource, cache: ChunkCache?) = TtsSourceChain(
        sources = mapOf(SourceId.API to api, SourceId.SYSTEM to phone),
        order = { req -> TtsFlagLogic.inAppOrder(true, req.language, req.preferSystem) },
        cache = cache,
        config = ChainConfig(retries = 0),
        nowMs = { currentTime },
    )

    // ---- chunk cache and the user's voice / the catalog ----

    @Test fun `cloud Spanish audio is not replayed after the user picks a phone voice, even offline`() = runTest {
        val cache = MemCache()
        val api = CloudLike()
        val phone = PhoneLike()
        val c = chain(api, phone, cache)
        // Read once with the cloud voice: stored.
        val first = c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        assertTrue(first.all { it.source == SourceId.API })
        assertEquals(1, cache.map.size)

        // The user now picks a phone voice (preferSystem), and the network is gone.
        api.unavailable = FallbackReason.OFFLINE
        val out = c.speak(ES_TEXT, TtsRequest("bella", "es", preferSystem = true)).toList()
        assertTrue("phone voice must read it, not the cached cloud audio", out.all { it.source == SourceId.SYSTEM && !it.fromCache })
        assertEquals(1, phone.calls.get())
    }

    @Test fun `cloud Spanish audio is not replayed once the catalog stops listing the voice`() = runTest {
        val cache = MemCache()
        val api = CloudLike()
        val phone = PhoneLike()
        val c = chain(api, phone, cache)
        c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        api.voiceFor = { lang -> if (lang == "es") null else "kristin" }
        api.unavailable = FallbackReason.UNSUPPORTED_LANGUAGE
        val out = c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        assertTrue(out.all { it.source == SourceId.SYSTEM && !it.fromCache })
    }

    @Test fun `a different cloud voice or language never hits another voice's entry`() = runTest {
        val cache = MemCache()
        val api = CloudLike()
        val c = chain(api, PhoneLike(), cache)
        c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        // same text and app voice, other language: distinct key
        c.speak(ES_TEXT, TtsRequest("bella", "en")).toList()
        assertEquals(2, cache.map.size)
        // the catalog now lists a different voice for Spanish
        api.voiceFor = { lang -> if (lang == "es") "custom:es-pilot-m" else "kristin" }
        val calls = api.calls.get()
        val out = c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        assertTrue(out.none { it.fromCache })
        assertEquals(calls + 1, api.calls.get())
    }

    @Test fun `English cache entries keep working offline`() = runTest {
        val cache = MemCache()
        val api = CloudLike()
        val c = chain(api, PhoneLike(), cache)
        c.speak("Hello there.", TtsRequest("bella", "en-US")).toList()
        api.unavailable = FallbackReason.OFFLINE
        val out = c.speak("Hello there.", TtsRequest("bella", "en-US")).toList()
        assertTrue(out.all { it.fromCache })
    }

    // ---- cooldown per language ----

    @Test fun `a Spanish-only cloud failure does not put English cloud reading in cooldown`() = runTest {
        val api = CloudLike(fail = { lang -> if (lang == "es") FallbackReason.SERVER_ERROR else null })
        val phone = PhoneLike()
        val c = chain(api, phone, null)
        val es = c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        assertTrue(es.all { it.source == SourceId.SYSTEM })
        val callsAfterEs = api.calls.get()

        val en = c.speak("Hello there.", TtsRequest("bella", "en")).toList()
        assertTrue("English must still use the cloud", en.all { it.source == SourceId.API })
        assertEquals(callsAfterEs + 1, api.calls.get())

        // Spanish itself is still cooling down
        c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        assertEquals(callsAfterEs + 1, api.calls.get())
        delay(31_000)
        c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        assertEquals(callsAfterEs + 2, api.calls.get())
    }

    @Test fun `quota and rate limits still silence the cloud for every language`() = runTest {
        val api = CloudLike(fail = { FallbackReason.QUOTA })
        val c = chain(api, PhoneLike(), null)
        c.speak(ES_TEXT, TtsRequest("bella", "es")).toList()
        val calls = api.calls.get()
        val en = c.speak("Hello there.", TtsRequest("bella", "en")).toList()
        assertTrue(en.all { it.source == SourceId.SYSTEM })
        assertEquals(calls, api.calls.get())
    }

    // ---- catalog single flight ----

    @Test fun `concurrent catalog callers share one fetch`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse().setBodyDelay(300, java.util.concurrent.TimeUnit.MILLISECONDS)
                    .setBody("""{"voices":[{"voice_id":"custom:es-pilot-f","language":"es","engine":"piper"}]}""")
            )
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/").toString().trimEnd('/'))
            val results = kotlinx.coroutines.coroutineScope {
                (1..4).map { kotlinx.coroutines.async(kotlinx.coroutines.Dispatchers.Default) { cat.voices() } }.map { it.await() }
            }
            assertTrue(results.all { it.map { v -> v.id } == listOf("custom:es-pilot-f") })
            assertEquals(1, server.requestCount)
        }
    }
}
