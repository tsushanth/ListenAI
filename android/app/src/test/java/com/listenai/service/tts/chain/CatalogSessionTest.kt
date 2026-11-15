package com.listenai.service.tts.chain

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.toList
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

private val LANGS = setOf("en", "es", "hi", "ja", "de")
private fun mv(id: String) = CloudVoice(id, "en", "female", id.replaceFirstChar { it.uppercase() }, LANGS, "live")
private val ARIA = mv("aria")
private val KAI = mv("kai")
private val CORA = mv("cora")

private class SwitchCatalog(@Volatile var list: List<CloudVoice>) : CloudVoiceCatalog {
    val asked = AtomicInteger()
    override suspend fun voices(): List<CloudVoice> { asked.incrementAndGet(); return list }
}

private class MemoryCache : ChunkCache {
    val map = java.util.concurrent.ConcurrentHashMap<String, PcmChunk>()
    override fun get(key: String) = map[key]
    override fun put(key: String, chunk: PcmChunk) { map[key] = chunk }
}

private val LONG_ES = (1..10).joinToString(" ") { "Esta es la oración número $it de una prueba más larga." }

/** The voice of a read is fixed once per read: a catalog that changes mid-read changes neither the voice nor the cache key. */
class CatalogSessionTest {

    private fun chain(src: ReadAloudApiSource, cache: ChunkCache?) = TtsSourceChain(
        sources = mapOf(SourceId.API to src, SourceId.SYSTEM to object : TtsSource {
            override val id = SourceId.SYSTEM
            override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = FallbackReason.LANGUAGE_MISSING
            override suspend fun synthesize(text: String, request: TtsRequest) = throw SourceFailure(FallbackReason.LANGUAGE_MISSING)
        }),
        order = { req -> TtsFlagLogic.inAppOrder(true, req.language, req.preferSystem) },
        cache = cache,
    )

    private fun FakeWorker.voices(): List<String> = generateSequence { received.poll() }.map { org.json.JSONObject(it).getString("voice") }.toList()

    @Test fun `a catalog reorder in the middle of a read does not change the voice, and the audio is stored under the voice that made it`() = runBlocking {
        FakeWorker().use { w ->
            val catalog = SwitchCatalog(listOf(ARIA, KAI, CORA))
            val cache = MemoryCache()
            val c = chain(w.source(catalog), cache)
            // After the first chunk reaches the worker the API reorders its list (kai first).
            val first = AtomicInteger()
            w.onFirst = { if (first.incrementAndGet() == 1) catalog.list = listOf(KAI, ARIA, CORA) }
            val out = c.speak(LONG_ES, TtsRequest("bella", "es")).toList()
            assertTrue(out.size >= 3)
            assertTrue(out.all { it.source == SourceId.API })
            assertEquals("every chunk is read by the voice the read started with", setOf("aria"), w.voices().toSet())
            val stored = cache.map.size
            assertEquals(out.size, stored)

            // A later read under the new order uses kai and does not find aria's audio under its key.
            val second = c.speak(LONG_ES, TtsRequest("bella", "es")).toList()
            assertTrue(second.none { it.fromCache })
            assertEquals(setOf("kai"), w.voices().toSet())
            assertEquals(stored * 2, cache.map.size)

            // The old order again: all of aria's audio is replayed from the cache, nothing reaches the worker.
            catalog.list = listOf(ARIA, KAI, CORA)
            val third = c.speak(LONG_ES, TtsRequest("bella", "es")).toList()
            assertTrue(third.all { it.fromCache })
            assertTrue(w.voices().isEmpty())
            w.source(catalog).close()
        }
    }

    @Test fun `a voice that disappears from the catalog mid-read keeps reading until the read ends`() = runBlocking {
        FakeWorker().use { w ->
            val catalog = SwitchCatalog(listOf(ARIA, KAI))
            val c = chain(w.source(catalog), null)
            val n = AtomicInteger()
            w.onFirst = { if (n.incrementAndGet() == 1) catalog.list = emptyList() }
            val out = c.speak(LONG_ES, TtsRequest("bella", "es")).toList()
            assertTrue("the read finished on the cloud voice", out.all { it.source == SourceId.API })
            assertEquals(setOf("aria"), w.voices().toSet())
            // the next read sees the empty catalog: no cloud voice for the language
            try {
                c.speak("Hola.", TtsRequest("bella", "es")).toList()
                org.junit.Assert.fail("expected NoSourceAvailableException")
            } catch (e: NoSourceAvailableException) {
                assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, e.failures[SourceId.API])
            }
        }
    }

    @Test fun `a voice the worker refuses mid-read is still a refusal for that language`() = runBlocking {
        FakeWorker().use { w ->
            val catalog = SwitchCatalog(listOf(ARIA))
            val src = w.source(catalog)
            w.refuse = true
            try {
                src.synthesize("Hola.", TtsRequest("bella", "es", cloudVoice = ARIA))
                org.junit.Assert.fail("expected a failure")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, e.reason)
            }
            src.close()
        }
    }

    // ---- catalog reads that are not a voice list ----

    private fun serve(vararg replies: MockResponse): Pair<MockWebServer, HttpCloudVoiceCatalog> {
        val server = MockWebServer()
        replies.forEach { server.enqueue(it) }
        server.start()
        var now = 0L
        val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/v1/catalog").toString(), nowMs = { now.also { now += 120_000 } }, okTtlMs = 60_000, failTtlMs = 1_000, staleMs = 6 * 3_600_000L)
        return server to cat
    }

    private val GOOD = """{"tiers":{},"voices":[{"voice_id":"aria","name":"Aria","language":"en","languages":["en","es"],"gender":"female","tier":"live"}]}"""

    private fun junkKeepsLastGood(junk: MockResponse) = runBlocking {
        val (server, cat) = serve(MockResponse().setHeader("Content-Type", "application/json").setBody(GOOD), junk)
        try {
            assertEquals(listOf("aria"), cat.voices().map { it.id })
            // the cache time is up on every call here, so the second call re-reads and gets the junk
            assertEquals("last good list stays after: ${junk.status}", listOf("aria"), cat.voices().map { it.id })
            assertEquals(2, server.requestCount)
        } finally { server.shutdown() }
    }

    @Test fun `a captive portal page with status 200 does not clear the list`() =
        junkKeepsLastGood(MockResponse().setHeader("Content-Type", "text/html").setBody("<html><body>Sign in to Wi-Fi</body></html>"))

    @Test fun `HTML served as JSON does not clear the list`() =
        junkKeepsLastGood(MockResponse().setHeader("Content-Type", "application/json").setBody("<html>Sign in</html>"))

    @Test fun `a truncated body does not clear the list`() =
        junkKeepsLastGood(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"tiers":{},"voices":[{"voice_id":"ar"""))

    @Test fun `a valid voice list with the wrong content type does not clear the list`() =
        junkKeepsLastGood(MockResponse().setHeader("Content-Type", "text/html").setBody(GOOD.replace("aria", "zed")))

    @Test fun `an empty object does not clear the list`() =
        junkKeepsLastGood(MockResponse().setHeader("Content-Type", "application/json").setBody("{}"))

    @Test fun `a list whose entries are all unusable does not clear the list`() =
        junkKeepsLastGood(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"voices":[{"name":"x"},{"voice_id":"","language":"es"}]}"""))

    @Test fun `a well-formed empty voice list does clear it (the API offers nothing)`() = runBlocking {
        val (server, cat) = serve(
            MockResponse().setHeader("Content-Type", "application/json").setBody(GOOD),
            MockResponse().setHeader("Content-Type", "application/json").setBody("""{"tiers":{},"voices":[]}"""),
        )
        try {
            assertEquals(1, cat.voices().size)
            assertTrue(cat.voices().isEmpty())
        } finally { server.shutdown() }
    }

    @Test fun `the strict parser tells junk from an empty list`() {
        assertNull(CloudVoicePolicy.parseStrict("<html>"))
        assertNull(CloudVoicePolicy.parseStrict("{}"))
        assertNull(CloudVoicePolicy.parseStrict("""{"voices":"x"}"""))
        assertNull(CloudVoicePolicy.parseStrict("""{"voices":[{"name":"x"}]}"""))
        assertEquals(emptyList<CloudVoice>(), CloudVoicePolicy.parseStrict("""{"voices":[]}"""))
        assertEquals(1, CloudVoicePolicy.parseStrict(GOOD)!!.size)
    }

    @Test fun `junk on the first read gives no voices and is retried after the failure time`() = runBlocking {
        val (server, cat) = serve(
            MockResponse().setHeader("Content-Type", "text/html").setBody("<html>portal</html>"),
            MockResponse().setHeader("Content-Type", "application/json").setBody(GOOD),
        )
        try {
            assertTrue(cat.voices().isEmpty())
            assertFalse(cat.voices().isEmpty())
        } finally { server.shutdown() }
    }
}
