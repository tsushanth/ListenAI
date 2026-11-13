package com.listenai.service.tts.chain

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** A catalog the test controls, counting how often it is asked. */
private class FakeCatalog(var list: List<CloudVoice>) : CloudVoiceCatalog {
    val asked = AtomicInteger()
    override suspend fun voices(): List<CloudVoice> { asked.incrementAndGet(); return list }
}

private val ES_F = CloudVoice("custom:es-pilot-f", "es", "female")
private val ES_M = CloudVoice("custom:es-pilot-m", "es", "male")
private val FR_F = CloudVoice("custom:fr-fr-mls-f", "fr", "female")
private val EN = CloudVoice("custom:en-us-kristin", "en", "female")

class CloudVoiceTest {

    // ---- policy and parsing ----

    @Test fun `Spanish gets es-pilot-f when the catalog lists it`() {
        assertEquals(ES_F, CloudVoicePolicy.voiceFor("es", listOf(ES_M, ES_F)))
        assertEquals(ES_F, CloudVoicePolicy.voiceFor("es-MX", listOf(ES_F)))
    }

    @Test fun `a language is accepted only when the catalog lists its vetted voice`() {
        assertNull(CloudVoicePolicy.voiceFor("es", emptyList()))
        // the male pilot voice is listed but is not the vetted default: never chosen as a stand-in
        assertNull(CloudVoicePolicy.voiceFor("es", listOf(ES_M)))
        // French is listed by the API but has no vetted entry yet
        assertNull(CloudVoicePolicy.voiceFor("fr", listOf(FR_F)))
        assertNull(CloudVoicePolicy.voiceFor("en", listOf(EN)))
        // a voice id listed under a different language does not count
        assertNull(CloudVoicePolicy.voiceFor("es", listOf(CloudVoice("custom:es-pilot-f", "fr", null))))
    }

    @Test fun `languages come from the catalog, not a fixed list`() {
        assertEquals(emptySet<String>(), CloudVoicePolicy.languages(emptyList()))
        assertEquals(setOf("es"), CloudVoicePolicy.languages(listOf(ES_F, FR_F)))
    }

    @Test fun `gateway shaped voice list parses, keeping only piper voices with an id and language`() {
        val json = """{"voices":[
            {"voice_id":"custom:es-pilot-f","name":"Spanish female","language":"es","gender":"female","engine":"piper"},
            {"voice_id":"es-pilot-m","language":"es","gender":"male"},
            {"voice_id":"af_bella","language":"en","engine":"kokoro"},
            {"voice_id":"","language":"es","engine":"piper"},
            {"voice_id":"custom:de-de-mls-f","engine":"piper"}
        ]}"""
        val v = CloudVoicePolicy.parse(json)
        assertEquals(listOf("custom:es-pilot-f", "custom:es-pilot-m"), v.map { it.id })
        assertEquals("female", v[0].gender)
    }

    @Test fun `garbage or a missing list parses to nothing`() {
        assertTrue(CloudVoicePolicy.parse("").isEmpty())
        assertTrue(CloudVoicePolicy.parse("<html>").isEmpty())
        assertTrue(CloudVoicePolicy.parse("{}").isEmpty())
        assertTrue(CloudVoicePolicy.parse("""{"voices":"no"}""").isEmpty())
    }

    // ---- the cloud source's language gating ----

    private fun source(catalog: CloudVoiceCatalog, online: Boolean = true) =
        ReadAloudApiSource(OkHttpClient(), "https://example.invalid", { online }, { "custom:en-us-kristin" }, catalog)

    @Test fun `English never asks the catalog`() = runTest {
        val cat = FakeCatalog(listOf(ES_F))
        assertNull(source(cat).unavailableReason(TtsRequest("bella", "en-US")))
        assertEquals(0, cat.asked.get())
    }

    @Test fun `Spanish is accepted when listed and online`() = runTest {
        assertNull(source(FakeCatalog(listOf(ES_F))).unavailableReason(TtsRequest("bella", "es")))
        assertNull(source(FakeCatalog(listOf(ES_F))).unavailableReason(TtsRequest("bella", "es-MX")))
    }

    @Test fun `Spanish is declined when the catalog does not list the voice`() = runTest {
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, source(FakeCatalog(emptyList())).unavailableReason(TtsRequest("bella", "es")))
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, source(CloudVoiceCatalog.Empty).unavailableReason(TtsRequest("bella", "es")))
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, source(FakeCatalog(listOf(ES_M))).unavailableReason(TtsRequest("bella", "es")))
    }

    @Test fun `languages the API lists but we have not vetted stay on the phone`() = runTest {
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, source(FakeCatalog(listOf(FR_F))).unavailableReason(TtsRequest("bella", "fr")))
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, source(FakeCatalog(listOf(FR_F, ES_F))).unavailableReason(TtsRequest("bella", "ru")))
    }

    @Test fun `a listed language offline is OFFLINE, not unsupported`() = runTest {
        assertEquals(FallbackReason.OFFLINE, source(FakeCatalog(listOf(ES_F)), online = false).unavailableReason(TtsRequest("bella", "es")))
    }

    // ---- order of sources ----

    @Test fun `Spanish order is cloud then phone, and a phone voice pick puts the phone first`() {
        assertEquals(listOf(SourceId.API, SourceId.SYSTEM), TtsFlagLogic.inAppOrder(true, "es"))
        assertEquals(listOf(SourceId.SYSTEM, SourceId.API), TtsFlagLogic.inAppOrder(true, "es-MX", preferSystem = true))
        assertEquals(listOf(SourceId.SYSTEM), TtsFlagLogic.inAppOrder(false, "es", preferSystem = true))
        // English is not affected by the preference
        assertEquals(listOf(SourceId.API, SourceId.SYSTEM, SourceId.ON_DEVICE), TtsFlagLogic.inAppOrder(true, "en", preferSystem = true))
    }

    private class PhoneSource(private val missing: Boolean = false) : TtsSource {
        override val id = SourceId.SYSTEM
        override suspend fun unavailableReason(request: TtsRequest) = if (missing) FallbackReason.LANGUAGE_MISSING else null
        override suspend fun synthesize(text: String, request: TtsRequest) = PcmChunk(ByteArray(48_000), 24_000)
    }

    private fun chain(cat: CloudVoiceCatalog, phone: TtsSource, online: Boolean = true, preferSystem: Boolean = false) = TtsSourceChain(
        sources = mapOf(SourceId.API to source(cat, online), SourceId.SYSTEM to phone),
        order = { req -> TtsFlagLogic.inAppOrder(true, req.language, req.preferSystem) },
    ) to TtsRequest("bella", "es", preferSystem = preferSystem)

    @Test fun `chain - no catalog voice means the phone reads Spanish`() = runTest {
        val (c, req) = chain(FakeCatalog(emptyList()), PhoneSource())
        val out = c.speak("Hola, esto es una prueba.", req).toList()
        assertTrue(out.isNotEmpty() && out.all { it.source == SourceId.SYSTEM })
    }

    @Test fun `chain - listed voice but offline, the phone reads Spanish`() = runTest {
        val (c, req) = chain(FakeCatalog(listOf(ES_F)), PhoneSource(), online = false)
        val out = c.speak("Hola, esto es una prueba.", req).toList()
        assertTrue(out.isNotEmpty() && out.all { it.source == SourceId.SYSTEM })
    }

    @Test fun `chain - no catalog voice and no phone voice ends in the install-voice-data action`() = runTest {
        val (c, req) = chain(FakeCatalog(emptyList()), PhoneSource(missing = true))
        try {
            c.speak("Hola, esto es una prueba.", req).toList()
            org.junit.Assert.fail("expected NoSourceAvailableException")
        } catch (e: NoSourceAvailableException) {
            assertEquals(UserAction.InstallVoiceData("es"), e.action)
            assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, e.failures[SourceId.API])
            assertEquals(FallbackReason.LANGUAGE_MISSING, e.failures[SourceId.SYSTEM])
        }
    }

    // ---- catalog fetching ----

    @Test fun `http catalog parses the backend list and caches it`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"voices":[{"voice_id":"custom:es-pilot-f","language":"es","engine":"piper"}]}"""))
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/").toString().trimEnd('/'))
            assertEquals(listOf("custom:es-pilot-f"), cat.voices().map { it.id })
            assertEquals(listOf("custom:es-pilot-f"), cat.voices().map { it.id })
            assertEquals(1, server.requestCount)
            assertEquals("/api/realtime-tts/voices", server.takeRequest().path)
        }
    }

    @Test fun `http catalog - a backend without the route gives an empty list and is not asked again soon`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404))
            var now = 0L
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/").toString().trimEnd('/'), nowMs = { now }, failTtlMs = 1_000)
            assertTrue(cat.voices().isEmpty())
            assertTrue(cat.voices().isEmpty())
            assertEquals(1, server.requestCount)
            now = 2_000
            server.enqueue(MockResponse().setBody("""{"voices":[{"voice_id":"custom:es-pilot-f","language":"es"}]}"""))
            assertEquals(1, cat.voices().size)
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun `http catalog - an unreachable backend gives an empty list`() = runTest {
        val cat = HttpCloudVoiceCatalog(OkHttpClient(), "http://127.0.0.1:1")
        assertTrue(cat.voices().isEmpty())
    }
}
