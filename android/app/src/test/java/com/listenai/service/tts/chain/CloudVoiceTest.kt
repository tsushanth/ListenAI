package com.listenai.service.tts.chain

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** A catalog the test controls, counting how often it is asked. */
private class FakeCatalog(var list: List<CloudVoice>) : CloudVoiceCatalog {
    val asked = AtomicInteger()
    var invalidated = 0
    override suspend fun voices(): List<CloudVoice> { asked.incrementAndGet(); return list }
    override fun invalidate() { invalidated++ }
}

/** The real public listing, captured with a keyless GET of the API's /v1/catalog on 2026-11-15 (40 voices, 21 live languages). */
private fun liveCatalogJson(): String =
    CloudVoiceTest::class.java.getResourceAsStream("/readaloud/catalog_live_2026-11-15.json")!!.bufferedReader().readText()

private val ALL = listOf("en", "cs", "nl", "fi", "fr", "de", "el", "hi", "hu", "id", "it", "ja", "pl", "pt", "ro", "ru", "es", "sv", "tr", "uk")
private fun multi(id: String, name: String, langs: List<String> = ALL, tier: String = "live") =
    CloudVoice(id, "en", "female", name, langs.toSet(), tier)
private val ARIA = multi("aria", "Aria")
private val CORA = multi("cora", "Cora")
private val DE_F1 = CloudVoice("de-f1", "de", "female", "German female", setOf("de"), "live")
private val PT_BR = CloudVoice("pt-br-m1", "pt-BR", "male", "Portuguese male 1", setOf("pt"), "live")
private val EN_STUDIO = CloudVoice("en-heart", "en", "female", "Heart", setOf("en"), "studio")

class CloudVoiceTest {

    private fun live() = CloudVoicePolicy.parse(liveCatalogJson())

    // ---- the real listing ----

    @Test fun `the captured live catalog parses into 40 voices, 10 of them multilingual`() {
        val v = live()
        assertEquals(40, v.size)
        val m = v.filter { it.multilingual }
        assertEquals(listOf("aria", "cora", "dana", "elise", "faye", "gabe", "hugo", "ivan", "jonas", "kai"), m.map { it.id })
        assertTrue(m.all { it.tier == "live" && it.languages.size == 20 && "en" in it.languages })
        assertEquals("Aria", m[0].name)
        // ids are kept exactly as listed (no "custom:" prefix)
        assertTrue(v.none { it.id.startsWith("custom:") })
    }

    @Test fun `every language the live catalog lists besides English gets a voice, native single-language ones first`() {
        val v = live()
        val expected = setOf("de", "es", "fr", "it", "pt", "cs", "nl", "fi", "el", "hi", "hu", "id", "ja", "pl", "ro", "ru", "sv", "tr", "uk")
        assertEquals(expected, CloudVoicePolicy.languages(v))
        // a language with a listed voice of its own: that voice is the default (first listed)
        assertEquals("de-f1", CloudVoicePolicy.voiceFor("de", v)?.id)
        assertEquals("es-f1", CloudVoicePolicy.voiceFor("es", v)?.id)
        assertEquals("fr-f1", CloudVoicePolicy.voiceFor("fr", v)?.id)
        assertEquals("it-f1", CloudVoicePolicy.voiceFor("it", v)?.id)
        assertEquals("pt-br-m1", CloudVoicePolicy.voiceFor("pt", v)?.id)
        assertEquals("pt-br-m1", CloudVoicePolicy.voiceFor("pt-BR", v)?.id)
        // every other language: the first multilingual voice the list gives
        for (l in listOf("cs", "nl", "fi", "el", "hi", "hu", "id", "ja", "pl", "ro", "ru", "sv", "tr", "uk")) assertEquals("aria for $l", "aria", CloudVoicePolicy.voiceFor(l, v)?.id)
    }

    @Test fun `each voice is sent with its own listed code, a multilingual voice with the plain language code`() {
        val v = live()
        fun code(l: String) = CloudVoicePolicy.voiceFor(l, v)!!.let { CloudVoicePolicy.languageCode(it, l) }
        assertEquals("es", code("es"))
        assertEquals("de", code("de"))
        assertEquals("pt-BR", code("pt"))
        assertEquals("hi", code("hi"))
        assertEquals("ja", code("ja"))
    }

    @Test fun `languages the API holds back or hides are never read in the cloud`() {
        val v = live()
        for (l in listOf("hr", "sk", "ar", "bg", "da", "et", "ko", "lt", "lv", "sl", "vi", "zh", "th", "he", "xx")) {
            assertNull("$l", CloudVoicePolicy.voiceFor(l, v))
            assertTrue("$l", CloudVoicePolicy.voicesFor(l, v).isEmpty())
        }
    }

    @Test fun `English never takes the cloud policy path`() {
        assertNull(CloudVoicePolicy.voiceFor("en", live()))
        assertNull(CloudVoicePolicy.voiceFor("en-US", live()))
        assertFalse("en" in CloudVoicePolicy.languages(live()))
    }

    @Test fun `the picker offers the voices of the language first, then the multilingual voices`() {
        val offered = CloudVoicePolicy.voicesFor("de", live()).map { it.id }
        assertEquals(listOf("de-f1", "de-m1", "aria", "cora", "dana", "elise", "faye", "gabe", "hugo", "ivan", "jonas", "kai"), offered)
        val pt = CloudVoicePolicy.voicesFor("pt-BR", live()).map { it.id }
        assertEquals(listOf("pt-br-m1", "pt-br-m2", "aria"), pt.take(3))
        assertEquals(10, CloudVoicePolicy.voicesFor("ja", live()).size)
    }

    // ---- policy rules on hand-made lists ----

    @Test fun `a language the list drops is no longer read in the cloud, with no other change`() {
        val without = ALL.filter { it != "ja" }
        val listed = listOf(multi("aria", "Aria", without))
        assertNull(CloudVoicePolicy.voiceFor("ja", listed))
        assertEquals("aria", CloudVoicePolicy.voiceFor("es", listed)?.id)
        assertFalse("ja" in CloudVoicePolicy.languages(listed))
    }

    @Test fun `a single-language voice listed after the multilingual ones is still the default`() {
        val listed = listOf(ARIA, CORA, DE_F1)
        assertEquals("de-f1", CloudVoicePolicy.voiceFor("de", listed)?.id)
        assertEquals("aria", CloudVoicePolicy.voiceFor("es", listed)?.id)
    }

    @Test fun `a language with only a single-language voice uses that voice`() {
        assertEquals("de-f1", CloudVoicePolicy.voiceFor("de", listOf(DE_F1, EN_STUDIO))?.id)
        assertEquals("pt-br-m1", CloudVoicePolicy.voiceFor("pt", listOf(PT_BR))?.id)
        assertEquals(setOf("de", "pt"), CloudVoicePolicy.languages(listOf(DE_F1, PT_BR)))
    }

    @Test fun `the studio tier is never used for another language`() {
        val studioMulti = multi("zed", "Zed", ALL, tier = "studio")
        assertNull(CloudVoicePolicy.voiceFor("es", listOf(studioMulti, EN_STUDIO)))
    }

    @Test fun `the user's voice pick is used while the API still offers it for that language, else the default`() {
        val listed = listOf(ARIA, CORA, multi("kai", "Kai", listOf("en", "es")))
        assertEquals("cora", CloudVoicePolicy.voiceFor("es", listed, preferredId = "cora")?.id)
        // kai does not speak Hindi in this list: the pick no longer applies
        assertEquals("aria", CloudVoicePolicy.voiceFor("hi", listed, preferredId = "kai")?.id)
        // a pick the list no longer holds
        assertEquals("aria", CloudVoicePolicy.voiceFor("es", listed, preferredId = "gone")?.id)
    }

    // ---- language codes ----

    @Test fun `device and detector codes become the API's codes`() {
        assertEquals("es", ApiLanguageCode.of("es-MX"))
        assertEquals("es", ApiLanguageCode.of("ES"))
        assertEquals("pt", ApiLanguageCode.of("pt-BR"))
        assertEquals("pt", ApiLanguageCode.of("pt_PT"))
        assertEquals("id", ApiLanguageCode.of("in"))   // what older Android reports for Indonesian
        assertEquals("he", ApiLanguageCode.of("iw"))
        assertEquals("zh", ApiLanguageCode.of("zh-Hans-CN"))
        assertEquals("fil", ApiLanguageCode.of("fil"))
        assertNull(ApiLanguageCode.of("und"))
        assertNull(ApiLanguageCode.of(""))
        assertNull(ApiLanguageCode.of(null))
        assertNull(ApiLanguageCode.of("12"))
        assertNull(ApiLanguageCode.of("not a tag"))
    }

    @Test fun `an old Android Indonesian code still finds the Indonesian voice`() {
        assertEquals("aria", CloudVoicePolicy.voiceFor("in", live())?.id)
        assertEquals("id", CloudVoicePolicy.languageCode(CloudVoicePolicy.voiceFor("in", live())!!, "in"))
    }

    @Test fun `und is never read in the cloud`() {
        assertNull(CloudVoicePolicy.voiceFor("und", live()))
    }

    @Test fun `language_code - plain code for a multilingual voice, the listed language for a single-language voice, none for English`() {
        assertEquals("es", CloudVoicePolicy.languageCode(ARIA, "es-MX"))
        assertEquals("pt", CloudVoicePolicy.languageCode(ARIA, "pt-BR"))
        assertEquals("de", CloudVoicePolicy.languageCode(DE_F1, "de"))
        assertEquals("pt-BR", CloudVoicePolicy.languageCode(PT_BR, "pt"))
        assertNull(CloudVoicePolicy.languageCode(ARIA, "en"))
        assertNull(CloudVoicePolicy.languageCode(ARIA, "und"))
    }

    // ---- parsing ----

    @Test fun `the older list shape still parses, dropping other engines and entries without an id or language`() {
        val json = """{"voices":[
            {"voice_id":"custom:es-pilot-f","name":"Spanish female","language":"es","gender":"female","engine":"piper"},
            {"voice_id":"af_bella","language":"en","engine":"kokoro"},
            {"voice_id":"","language":"es","engine":"piper"},
            {"voice_id":"custom:de-de-mls-f","engine":"piper"}
        ]}"""
        val v = CloudVoicePolicy.parse(json)
        assertEquals(listOf("custom:es-pilot-f"), v.map { it.id })
        assertEquals(setOf("es"), v[0].languages)
        assertEquals("female", v[0].gender)
    }

    @Test fun `garbage or a missing list parses to nothing`() {
        assertTrue(CloudVoicePolicy.parse("").isEmpty())
        assertTrue(CloudVoicePolicy.parse("<html>").isEmpty())
        assertTrue(CloudVoicePolicy.parse("{}").isEmpty())
        assertTrue(CloudVoicePolicy.parse("""{"voices":"no"}""").isEmpty())
    }

    @Test fun `the languages list response is not a voice list and parses to nothing`() {
        val json = CloudVoiceTest::class.java.getResourceAsStream("/readaloud/languages_live_2026-11-15.json")!!.bufferedReader().readText()
        assertTrue(CloudVoicePolicy.parse(json).isEmpty())
    }

    // ---- the cloud source's language gating ----

    private fun source(catalog: CloudVoiceCatalog, online: Boolean = true) =
        ReadAloudApiSource(OkHttpClient(), "https://example.invalid", { online }, { "custom:en-us-kristin" }, catalog)

    @Test fun `English never asks the catalog`() = runTest {
        val cat = FakeCatalog(live())
        assertNull(source(cat).unavailableReason(TtsRequest("bella", "en-US")))
        assertEquals(0, cat.asked.get())
    }

    @Test fun `a listed language is accepted when online, under any regional form`() = runTest {
        for (l in listOf("es", "es-MX", "hi", "ja", "pt-BR", "in", "uk"))
            assertNull(l, source(FakeCatalog(live())).unavailableReason(TtsRequest("bella", l)))
    }

    @Test fun `an unlisted language, an empty catalog and und are declined as unsupported`() = runTest {
        for (l in listOf("ar", "ko", "vi", "hr", "und")) assertEquals(l, FallbackReason.UNSUPPORTED_LANGUAGE, source(FakeCatalog(live())).unavailableReason(TtsRequest("bella", l)))
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, source(FakeCatalog(emptyList())).unavailableReason(TtsRequest("bella", "es")))
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, source(CloudVoiceCatalog.Empty).unavailableReason(TtsRequest("bella", "es")))
    }

    @Test fun `a listed language offline is OFFLINE, not unsupported`() = runTest {
        assertEquals(FallbackReason.OFFLINE, source(FakeCatalog(live()), online = false).unavailableReason(TtsRequest("bella", "es")))
    }

    @Test fun `the cache voice is the catalog voice for the language, the user's pick when offered, and null when not listed`() = runTest {
        val s = source(FakeCatalog(live()))
        assertEquals("es-f1", s.cacheVoice(TtsRequest("bella", "es")))
        assertEquals("aria", s.cacheVoice(TtsRequest("bella", "hi")))
        assertEquals("kai", s.cacheVoice(TtsRequest("bella", "es", cloudVoiceId = "kai")))
        assertEquals("bella", s.cacheVoice(TtsRequest("bella", "en")))
        assertNull(s.cacheVoice(TtsRequest("bella", "ko")))
    }

    // ---- order of sources ----

    @Test fun `non-English order is cloud then phone, and a phone voice pick puts the phone first`() {
        assertEquals(listOf(SourceId.API, SourceId.SYSTEM), TtsFlagLogic.inAppOrder(true, "hi"))
        assertEquals(listOf(SourceId.SYSTEM, SourceId.API), TtsFlagLogic.inAppOrder(true, "es-MX", preferSystem = true))
        assertEquals(listOf(SourceId.SYSTEM), TtsFlagLogic.inAppOrder(false, "es", preferSystem = true))
        assertEquals(listOf(SourceId.API, SourceId.SYSTEM, SourceId.ON_DEVICE), TtsFlagLogic.inAppOrder(true, "en", preferSystem = true))
    }

    private class PhoneSource(private val missing: Boolean = false) : TtsSource {
        override val id = SourceId.SYSTEM
        override suspend fun unavailableReason(request: TtsRequest) = if (missing) FallbackReason.LANGUAGE_MISSING else null
        override suspend fun synthesize(text: String, request: TtsRequest) = PcmChunk(ByteArray(48_000), 24_000)
    }

    private fun chain(cat: CloudVoiceCatalog, phone: TtsSource, online: Boolean = true, lang: String = "es") = TtsSourceChain(
        sources = mapOf(SourceId.API to source(cat, online), SourceId.SYSTEM to phone),
        order = { req -> TtsFlagLogic.inAppOrder(true, req.language, req.preferSystem) },
    ) to TtsRequest("bella", lang)

    @Test fun `chain - an unlisted language is read by the phone`() = runTest {
        val (c, req) = chain(FakeCatalog(live()), PhoneSource(), lang = "ko")
        val out = c.speak("안녕하세요. 테스트입니다.", req).toList()
        assertTrue(out.isNotEmpty() && out.all { it.source == SourceId.SYSTEM })
    }

    @Test fun `chain - listed language but offline, the phone reads it`() = runTest {
        val (c, req) = chain(FakeCatalog(live()), PhoneSource(), online = false)
        val out = c.speak("Hola, esto es una prueba.", req).toList()
        assertTrue(out.isNotEmpty() && out.all { it.source == SourceId.SYSTEM })
    }

    @Test fun `chain - not listed and no phone voice ends in the install-voice-data action`() = runTest {
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

    @Test fun `http catalog reads the public catalog URL and caches it`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(liveCatalogJson()))
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/v1/catalog").toString())
            assertEquals(40, cat.voices().size)
            assertEquals(40, cat.voices().size)
            assertEquals(1, server.requestCount)
            val req = server.takeRequest()
            assertEquals("/v1/catalog", req.path)
            assertNull("no key or bearer is sent to the public catalog", req.getHeader("Authorization"))
        }
    }

    @Test fun `http catalog - re-read after the cache time, a failed refresh keeps the last good list for a while`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(liveCatalogJson()))
            server.enqueue(MockResponse().setResponseCode(503))
            var now = 1_000_000L
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/v1/catalog").toString(), nowMs = { now }, okTtlMs = 60_000, failTtlMs = 60_000, staleMs = 3_600_000)
            assertEquals(40, cat.voices().size)
            now += 61_000
            assertEquals("503 on refresh keeps the last good list", 40, cat.voices().size)
            assertEquals(2, server.requestCount)
            // not asked again before the failure time is up
            now += 10_000
            assertEquals(40, cat.voices().size)
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun `http catalog - after the stale limit a failing API means no cloud voices`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(liveCatalogJson()))
            server.enqueue(MockResponse().setResponseCode(500))
            var now = 0L
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/v1/catalog").toString(), nowMs = { now }, okTtlMs = 60_000, failTtlMs = 60_000, staleMs = 120_000)
            assertEquals(40, cat.voices().size)
            now = 200_000
            assertTrue(cat.voices().isEmpty())
        }
    }

    @Test fun `http catalog - a well-formed empty list is believed at once (the API hid everything)`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(liveCatalogJson()))
            server.enqueue(MockResponse().setBody("""{"tiers":{},"voices":[]}"""))
            var now = 0L
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/v1/catalog").toString(), nowMs = { now }, okTtlMs = 60_000)
            assertEquals(40, cat.voices().size)
            now = 61_000
            assertTrue(cat.voices().isEmpty())
        }
    }

    @Test fun `http catalog - invalidate forces a re-read, but not more than once a minute`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(liveCatalogJson()))
            server.enqueue(MockResponse().setBody(liveCatalogJson()))
            var now = 0L
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/v1/catalog").toString(), nowMs = { now }, okTtlMs = 900_000, minRefreshMs = 60_000)
            cat.voices()
            now = 10_000
            cat.invalidate(); cat.voices()
            assertEquals("too soon after the last read", 1, server.requestCount)
            now = 70_000
            cat.invalidate(); cat.voices()
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun `http catalog - an unreachable API gives an empty list`() = runTest {
        val cat = HttpCloudVoiceCatalog(OkHttpClient(), "http://127.0.0.1:1/v1/catalog")
        assertTrue(cat.voices().isEmpty())
    }

    @Test fun `http catalog - the old backend route 404 gives an empty list and is not asked again soon`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404))
            val cat = HttpCloudVoiceCatalog(OkHttpClient(), server.url("/api/realtime-tts/voices").toString())
            assertTrue(cat.voices().isEmpty())
            assertTrue(cat.voices().isEmpty())
            assertEquals(1, server.requestCount)
        }
    }
}
