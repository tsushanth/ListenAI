package com.listenai.service.tts.chain

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private class ListCatalog(var list: List<CloudVoice>) : CloudVoiceCatalog {
    var invalidated = 0
    override suspend fun voices() = list
    override fun invalidate() { invalidated++ }
}

private val MULTI_LANGS = setOf("en", "cs", "nl", "fi", "fr", "de", "el", "hi", "hu", "id", "it", "ja", "pl", "pt", "ro", "ru", "es", "sv", "tr", "uk")
private val AR = CloudVoice("aria", "en", "female", "Aria", MULTI_LANGS, "live")
private val KA = CloudVoice("kai", "en", "male", "Kai", MULTI_LANGS, "live")

/** A fake worker over a real local socket: authorize on the app's backend path, then the synthesize WebSocket. */
internal class FakeWorker : AutoCloseable {
    val server = MockWebServer()
    val received = LinkedBlockingQueue<String>()
    val authorizeCalls = AtomicInteger()
    /** Called with every synthesize message, before the reply (a test uses it to change the catalog mid-read). */
    @Volatile var onFirst: () -> Unit = {}
    /** Answer every synthesize message with the worker's "language not supported" error. */
    @Volatile var refuse = false
    /** The authorize request bodies and headers, in order, and the WebSocket path of every socket that was opened ("/tts" for Piper, "/studio" for the studio route). */
    val authorizeBodies = LinkedBlockingQueue<String>()
    val authorizeHeaders = java.util.concurrent.CopyOnWriteArrayList<okhttp3.Headers>()
    val socketPaths = java.util.concurrent.CopyOnWriteArrayList<String>()
    /** When set, the answer to a synthesize message holds this many seconds of audio for its text, and [metaExtra] is added to chunk_meta (e.g. `"voice":"mira"`). */
    @Volatile var audioSeconds: ((String) -> Double)? = null
    @Volatile var metaExtra: String = ""
    /** The WebSocket handshake is answered this long after it is asked (a studio machine starting from zero). */
    @Volatile var upgradeDelayMs = 0L
    /** When set, the authorize call is answered with this status and body instead of a token. */
    @Volatile var authorizeError: Pair<Int, String>? = null
    @Volatile var reply: (WebSocket) -> Unit = { ws ->
        ws.send(ByteArray(9_600).toByteString())
        ws.send("""{"type":"chunk_meta","sample_rate":24000}""")
        ws.send("""{"type":"done"}""")
    }

    private val listener = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text); onFirst()
            val secs = audioSeconds
            if (secs != null && !refuse) {
                val seconds = secs(JSONObject(text).optString("text"))
                webSocket.send(ByteArray((seconds * 24_000).toInt() * 2).toByteString())
                webSocket.send("""{"type":"chunk_meta","sample_rate":24000${if (metaExtra.isEmpty()) "" else ",$metaExtra"}}""")
                webSocket.send("""{"type":"done"}""")
                return
            }
            if (refuse) webSocket.send("""{"type":"error","message":"language not supported"}""") else reply(webSocket)
        }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {}
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {}
    }

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/realtime-tts/authorize" -> {
                    authorizeCalls.incrementAndGet()
                    val body = request.body.readUtf8()
                    authorizeBodies.add(body); authorizeHeaders.add(request.headers)
                    val err = authorizeError
                    if (err != null) MockResponse().setResponseCode(err.first).setBody(err.second)
                    else {
                        val path = if (JSONObject(body).optString("engine") == "studio") "/studio" else "/tts"
                        MockResponse().setBody("""{"token":"tok","url":"${server.url(path).toString().replaceFirst("http", "ws")}"}""")
                    }
                }
                request.path!!.startsWith("/tts") || request.path!!.startsWith("/studio") -> { socketPaths.add(request.path!!.substringBefore('?')); MockResponse().setHeadersDelay(upgradeDelayMs, TimeUnit.MILLISECONDS).withWebSocketUpgrade(listener) }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
    }

    fun source(catalog: CloudVoiceCatalog, testKey: String = "", client: OkHttpClient = OkHttpClient(), studioTimeoutMs: Long = ReadAloudApiSource.STUDIO_TIMEOUT_MS, studioIdleMs: Long = ReadAloudApiSource.STUDIO_IDLE_MS) =
        ReadAloudApiSource(client, server.url("/").toString().trimEnd('/'), { true }, { "custom:en-us-kristin" }, catalog, testKey = testKey, studioTimeoutMs = studioTimeoutMs, studioIdleMs = studioIdleMs)

    fun nextMessage(): JSONObject = JSONObject(received.poll(5, TimeUnit.SECONDS) ?: error("no synthesize message arrived"))

    override fun close() = server.shutdown()
}

class NonEnglishWireTest {

    @Test fun `a non-English read names its language, voice, format and number handling`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(listOf(AR, KA)))
            val chunk = src.synthesize("Hola, tengo 3 gatos.", TtsRequest("bella", "es-MX"))
            assertEquals(24_000, chunk.sampleRate)
            assertTrue(chunk.pcm.isNotEmpty())
            val m = w.nextMessage()
            assertEquals("synthesize", m.getString("type"))
            assertEquals("aria", m.getString("voice"))
            assertEquals("es", m.getString("language_code"))
            assertEquals("pcm_24000", m.getString("format"))
            assertEquals("numbers", m.getString("normalize"))
            assertEquals("Hola, tengo 3 gatos.", m.getString("text"))
            assertFalse("no word timings for other languages", m.has("alignment"))
            src.close()
        }
    }

    @Test fun `number words are asked for only where they help - es de fr it, and hi with Devanagari digits`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(listOf(AR)))
            for (lang in listOf("es", "de", "fr", "it", "es-MX", "de-AT")) {
                src.synthesize("Es 3 und 4.", TtsRequest("bella", lang))
                assertEquals(lang, "numbers", w.nextMessage().optString("normalize"))
            }
            for (lang in listOf("ja", "ru", "pt", "pt-BR", "cs", "tr", "pl", "el", "fi", "hu", "id", "in", "nl", "ro", "sv", "uk")) {
                src.synthesize("Es 3 und 4.", TtsRequest("bella", lang))
                val m = w.nextMessage()
                assertFalse(lang, m.has("normalize"))
                assertTrue("language_code is still sent for $lang", m.has("language_code"))
                assertEquals("pcm_24000", m.getString("format"))
            }
            src.close()
        }
    }

    @Test fun `Hindi asks for number words only when the text has Devanagari digits`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(listOf(AR)))
            src.synthesize("मेरे पास ३ बिल्लियाँ हैं।", TtsRequest("bella", "hi"))
            assertEquals("numbers", w.nextMessage().optString("normalize"))
            src.synthesize("मेरे पास 3 बिल्लियाँ हैं।", TtsRequest("bella", "hi"))
            assertFalse(w.nextMessage().has("normalize"))
            src.synthesize("मेरे पास तीन बिल्लियाँ हैं।", TtsRequest("bella", "hi"))
            assertFalse(w.nextMessage().has("normalize"))
            src.close()
        }
    }

    @Test fun `every listed language sends its own code`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(listOf(AR)))
            for ((device, sent) in listOf("hi" to "hi", "ja" to "ja", "pt-BR" to "pt", "in" to "id", "uk" to "uk", "de-AT" to "de")) {
                src.synthesize("x", TtsRequest("bella", device))
                assertEquals(device, sent, w.nextMessage().getString("language_code"))
            }
            src.close()
        }
    }

    @Test fun `the user's ReadAloud voice pick is sent, and a stale pick falls back to the default`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(listOf(AR, KA)))
            src.synthesize("Hola.", TtsRequest("bella", "es", cloudVoiceId = "kai"))
            assertEquals("kai", w.nextMessage().getString("voice"))
            src.synthesize("Hola.", TtsRequest("bella", "es", cloudVoiceId = "gone"))
            assertEquals("aria", w.nextMessage().getString("voice"))
            src.close()
        }
    }

    @Test fun `a single-language voice sends the language as the catalog lists it`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(listOf(CloudVoice("pt-br-m1", "pt-BR", "male", "Portuguese male 1", setOf("pt"), "live"))))
            src.synthesize("Olá.", TtsRequest("bella", "pt"))
            val m = w.nextMessage()
            assertEquals("pt-br-m1", m.getString("voice"))
            assertEquals("pt-BR", m.getString("language_code"))
            src.close()
        }
    }

    @Test fun `English is unchanged on the wire - the app voice, no language_code, no normalize, no catalog`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(emptyList()))
            src.synthesize("Hello there.", TtsRequest("bella", "en-US"))
            val m = w.nextMessage()
            assertEquals("custom:en-us-kristin", m.getString("voice"))
            assertFalse(m.has("language_code"))
            assertFalse(m.has("normalize"))
            assertFalse(m.has("format"))
            src.close()
        }
    }

    @Test fun `an unlisted language is never sent to the worker`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(ListCatalog(listOf(AR)))
            try {
                src.synthesize("안녕하세요.", TtsRequest("bella", "ko"))
                org.junit.Assert.fail("expected a failure")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, e.reason)
            }
            assertEquals(0, w.authorizeCalls.get())
            assertNull(w.received.poll())
        }
    }

    @Test fun `the worker refusing a language is UNSUPPORTED_LANGUAGE and makes the app re-read the list`() = runBlocking {
        FakeWorker().use { w ->
            w.reply = { ws -> ws.send("""{"type":"error","message":"does not support language 'hu' (supported: cs de es)"}""") }
            val cat = ListCatalog(listOf(AR))
            val src = w.source(cat)
            try {
                src.synthesize("Szia.", TtsRequest("bella", "hu"))
                org.junit.Assert.fail("expected a failure")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, e.reason)
            }
            assertEquals(1, cat.invalidated)
            src.close()
        }
    }

    @Test fun `the same refusal on an English read is an ordinary server error, so English is not marked unsupported`() = runBlocking {
        FakeWorker().use { w ->
            w.reply = { ws -> ws.send("""{"type":"error","message":"unknown voice"}""") }
            val cat = ListCatalog(listOf(AR))
            val src = w.source(cat)
            try {
                src.synthesize("Hello.", TtsRequest("bella", "en"))
                org.junit.Assert.fail("expected a failure")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.SERVER_ERROR, e.reason)
            }
            assertEquals(0, cat.invalidated)
            src.close()
        }
    }

    @Test fun `worker error frames map to the right reasons`() {
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, ApiFailureMapping.fromWsError("engine does not support language 'xx'").reason)
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, ApiFailureMapping.fromWsError("unknown voice").reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromWsError("request failed").reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromWsError("worker at capacity").reason)
        assertEquals(FallbackReason.RATE_LIMITED, ApiFailureMapping.fromWsError("rate limit exceeded").reason)
        assertEquals(FallbackReason.QUOTA, ApiFailureMapping.fromWsError("quota used up").reason)
    }
}

private fun pcm(ms: Int = 1000) = PcmChunk(ByteArray(24_000 * 2 * ms / 1000), 24_000)

/** A cloud-like source whose behaviour per (language, call number) the test sets. */
private class ScriptedApi(
    var behave: suspend (lang: String, call: Int) -> Unit = { _, _ -> },
    var unavailable: FallbackReason? = null,
) : TtsSource {
    override val id = SourceId.API
    val calls = AtomicInteger()
    val callsByLang = java.util.concurrent.ConcurrentHashMap<String, AtomicInteger>()
    fun calls(lang: String) = callsByLang[lang]?.get() ?: 0
    override suspend fun cacheVoice(request: TtsRequest): String? = "aria"
    override suspend fun unavailableReason(request: TtsRequest) = unavailable
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
        val lang = request.language.substringBefore('-')
        val n = calls.incrementAndGet()
        callsByLang.getOrPut(lang) { AtomicInteger() }.incrementAndGet()
        behave(lang, n)
        return pcm()
    }
}

private class PhoneRecorder : TtsSource {
    override val id = SourceId.SYSTEM
    val texts = java.util.Collections.synchronizedList(ArrayList<String>())
    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = null
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk { texts += text; return pcm() }
}

private class Phone : TtsSource {
    override val id = SourceId.SYSTEM
    val calls = AtomicInteger()
    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = null
    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk { calls.incrementAndGet(); return pcm() }
}

@OptIn(ExperimentalCoroutinesApi::class)
class NonEnglishChainTest {

    private fun TestScope.chain(api: TtsSource, phone: TtsSource, config: ChainConfig = ChainConfig()) = TtsSourceChain(
        sources = mapOf(SourceId.API to api, SourceId.SYSTEM to phone),
        order = { req -> TtsFlagLogic.inAppOrder(true, req.language, req.preferSystem) },
        config = config,
        nowMs = { currentTime },
    )

    // ---- chunking for an engine that is not streaming ----

    private val ES_LONG = (1..12).joinToString(" ") { "Esta es la oración número $it del texto de prueba, con una coma y bastantes palabras más." }

    @Test fun `non-English cloud reads use short chunks, English keeps the usual size`() = runTest {
        val c = chain(ScriptedApi(), Phone())
        val es = c.chunkPlan(ES_LONG, TtsRequest("bella", "es"), cloudWillRead = true)
        assertTrue("first chunk quick: ${es.first().length}", es.first().length <= 90)
        assertTrue(es.all { it.length <= 170 })
        val en = c.chunkPlan(ES_LONG, TtsRequest("bella", "en"), cloudWillRead = true)
        assertEquals(TextChunker.split(ES_LONG, 280, 140), en)
        assertTrue(en.any { it.length > 170 })
    }

    // The 2026-11-15 production check: a 170 character Japanese chunk made 42 s of audio and took 9.9 s against a 10.25 s deadline.
    private val JA_SENTENCE = "今日は天気がとても良いので、午後は公園まで散歩に行きます。"
    private val JA_LONG = JA_SENTENCE.repeat(12)

    @Test fun `Japanese and Chinese cloud reads use much smaller chunks`() = runTest {
        val c = chain(ScriptedApi(), Phone())
        val ja = c.chunkPlan(JA_LONG, TtsRequest("bella", "ja"), cloudWillRead = true)
        assertTrue("first <= 60: ${ja.first().length}", ja.first().length <= 60)
        assertTrue(ja.all { it.length <= 90 })
        assertTrue(ja.size > 4)
        val zh = c.chunkPlan("今天天气很好，我们下午去公园散步。".repeat(15), TtsRequest("bella", "zh-CN"), cloudWillRead = true)
        assertTrue(zh.first().length <= 60 && zh.all { it.length <= 90 })
        // Hindi and Russian keep the general sizes
        val ru = c.chunkPlan(ES_LONG, TtsRequest("bella", "ru"), cloudWillRead = true)
        assertEquals(TextChunker.split(ES_LONG, 170, 90), ru)
    }

    @Test fun `the first-chunk deadline for another language is 14 s plus the per-character allowance`() = runTest {
        val api = ScriptedApi(behave = { _, _ -> delay(13_000) })
        val out = chain(api, Phone(), ChainConfig(retries = 0)).speak("こんにちは。", TtsRequest("bella", "ja")).toList()
        assertTrue("a 13 s answer is still waited for", out.all { it.source == SourceId.API })
        val slow = ScriptedApi(behave = { _, _ -> delay(15_500) })
        val out2 = chain(slow, Phone(), ChainConfig(retries = 0)).speak("こんにちは。", TtsRequest("bella", "ja")).toList()
        assertTrue("a 15.5 s answer is not", out2.all { it.source == SourceId.SYSTEM })
    }

    @Test fun `a phone-first read keeps the usual chunk size`() = runTest {
        val api = ScriptedApi()
        val phone = PhoneRecorder()
        val c = chain(api, phone)
        c.speak(ES_LONG, TtsRequest("bella", "es", preferSystem = true)).toList()
        assertEquals(TextChunker.split(ES_LONG, 280, 140).sorted(), phone.texts.sorted())
        assertEquals(0, api.calls.get())
    }

    @Test fun `a language the cloud has no voice for keeps the phone chunk sizes`() = runTest {
        val phone = PhoneRecorder()
        val c = chain(ScriptedApi(unavailable = FallbackReason.UNSUPPORTED_LANGUAGE), phone)
        c.speak(ES_LONG, TtsRequest("bella", "ko")).toList()
        assertEquals(TextChunker.split(ES_LONG, 280, 140).sorted(), phone.texts.sorted())
        assertTrue(phone.texts.any { it.length > 170 })
    }

    @Test fun `offline, the phone chunk sizes too`() = runTest {
        val phone = PhoneRecorder()
        val c = chain(ScriptedApi(unavailable = FallbackReason.OFFLINE), phone)
        c.speak(ES_LONG, TtsRequest("bella", "es")).toList()
        assertEquals(TextChunker.split(ES_LONG, 280, 140).sorted(), phone.texts.sorted())
    }

    @Test fun `a cloud read of another language uses the short chunk sizes`() = runTest {
        val api = ScriptedApi()
        val c = chain(api, Phone())
        val out = c.speak(ES_LONG, TtsRequest("bella", "es")).toList()
        assertEquals(TextChunker.split(ES_LONG, 170, 90), out.map { it.text })
    }

    @Test fun `chunks never cut a word`() {
        val words = ES_LONG.split(Regex("\\s+"))
        val chunks = TextChunker.split(ES_LONG, 170, 90)
        assertEquals(words, chunks.joinToString(" ").split(Regex("\\s+")))
    }

    @Test fun `Japanese and Chinese full stops split sentences although no space follows them`() {
        val ja = (1..12).joinToString("") { "今日は天気がとても良いので、公園まで散歩に行きます。" }
        val chunks = TextChunker.split(ja, 170, 90)
        assertTrue(chunks.size > 1)
        assertTrue(chunks.all { it.length <= 170 })
        assertTrue("each chunk ends at a sentence end", chunks.all { it.endsWith("。") })
        assertEquals(ja, chunks.joinToString("").replace(" ", ""))
    }

    @Test fun `Hindi sentences split at the danda`() {
        val hi = (1..14).joinToString(" ") { "यह परीक्षण का वाक्य संख्या $it है और इसमें कई शब्द हैं।" }
        val chunks = TextChunker.split(hi, 170, 90)
        assertTrue(chunks.size > 1)
        assertTrue(chunks.all { it.endsWith("।") })
        assertEquals(hi.split(Regex("\\s+")), chunks.joinToString(" ").split(Regex("\\s+")))
    }

    // ---- the first-request deadline ----

    @Test fun `a slow first non-English chunk (cold machine) is waited for, an English one is not`() = runTest {
        val api = ScriptedApi(behave = { _, _ -> delay(10_000) })
        val phone = Phone()
        val c = chain(api, phone, ChainConfig(retries = 0))
        val es = c.speak("Hola, esto es una prueba.", TtsRequest("bella", "es")).toList()
        assertTrue("Spanish stayed on the cloud voice", es.all { it.source == SourceId.API })
        assertEquals(0, phone.calls.get())
        val en = c.speak("Hello there, this is a test.", TtsRequest("bella", "en")).toList()
        assertTrue("English timed out at its normal deadline and went to the phone", en.all { it.source == SourceId.SYSTEM })
    }

    @Test fun `a first non-English chunk that never answers falls back to the phone within the deadline plus one retry`() = runTest {
        val api = ScriptedApi(behave = { _, _ -> delay(60_000) })
        val phone = Phone()
        val c = chain(api, phone)
        val out = c.speak("Namaste.", TtsRequest("bella", "hi")).toList()
        assertTrue(out.all { it.source == SourceId.SYSTEM })
        assertEquals(2, api.calls.get())
        assertTrue("gave up after about two deadlines, not more: $currentTime", currentTime < 2 * 14_500 + 2_000)
    }

    // ---- cooldown per (source, language) ----

    @Test fun `a timeout in one language skips the cloud for that language only`() = runTest {
        val api = ScriptedApi(behave = { lang, _ -> if (lang == "hi") delay(60_000) })
        val phone = Phone()
        val c = chain(api, phone, ChainConfig(retries = 0))
        c.speak("Namaste.", TtsRequest("bella", "hi")).toList()
        assertEquals(1, api.calls("hi"))
        // second Hindi read: cloud skipped
        c.speak("Namaste.", TtsRequest("bella", "hi")).toList()
        assertEquals(1, api.calls("hi"))
        // Spanish and English still use the cloud
        assertTrue(c.speak("Hola.", TtsRequest("bella", "es")).toList().all { it.source == SourceId.API })
        assertTrue(c.speak("Hello.", TtsRequest("bella", "en")).toList().all { it.source == SourceId.API })
    }

    @Test fun `the API refusing a language is not retried, is skipped for that language for a while, and never touches English`() = runTest {
        val api = ScriptedApi(behave = { lang, _ -> if (lang == "hu") throw SourceFailure(FallbackReason.UNSUPPORTED_LANGUAGE) })
        val phone = Phone()
        val c = chain(api, phone) // default config: one retry for transient failures
        val first = c.speak("Szia világ.", TtsRequest("bella", "hu")).toList()
        assertTrue(first.all { it.source == SourceId.SYSTEM })
        assertEquals("no retry for a refusal", 1, api.calls("hu"))

        c.speak("Szia világ.", TtsRequest("bella", "hu")).toList()
        assertEquals("skipped while cooling", 1, api.calls("hu"))

        assertTrue(c.speak("Hello.", TtsRequest("bella", "en")).toList().all { it.source == SourceId.API })
        assertTrue(c.speak("Hola.", TtsRequest("bella", "es")).toList().all { it.source == SourceId.API })

        delay(11 * 60_000L)
        c.speak("Szia világ.", TtsRequest("bella", "hu")).toList()
        assertEquals("tried again after the cooldown", 2, api.calls("hu"))
    }

    @Test fun `the list not offering a language is not remembered, so a later listing works at once`() = runTest {
        val api = ScriptedApi(unavailable = FallbackReason.UNSUPPORTED_LANGUAGE)
        val phone = Phone()
        val c = chain(api, phone)
        c.speak("Szia.", TtsRequest("bella", "hu")).toList()
        assertEquals(0, api.calls("hu"))
        api.unavailable = null
        val out = c.speak("Szia.", TtsRequest("bella", "hu")).toList()
        assertTrue(out.all { it.source == SourceId.API })
    }

    @Test fun `a source-wide failure still applies to every language`() = runTest {
        val api = ScriptedApi(behave = { _, _ -> throw SourceFailure(FallbackReason.RATE_LIMITED, 30_000) })
        val phone = Phone()
        val c = chain(api, phone)
        c.speak("Hello.", TtsRequest("bella", "en")).toList()
        val before = api.calls.get()
        c.speak("Hola.", TtsRequest("bella", "es")).toList()
        assertEquals(before, api.calls.get())
    }
}
