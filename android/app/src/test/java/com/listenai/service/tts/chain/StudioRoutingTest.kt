package com.listenai.service.tts.chain

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private fun freshCatalogJson(): String =
    StudioRoutingTest::class.java.getResourceAsStream("/readaloud/catalog_fresh_2026-11-20.json")!!.bufferedReader().readText()

/** What the policy did before studio voices existed (origin/main at 2.14.58): live-tier voices only, single-language ones first. */
private fun policyBeforeStudio(language: String, listed: List<CloudVoice>): List<CloudVoice> {
    val lang = ApiLanguageCode.of(language) ?: return emptyList()
    if (lang == "en") return emptyList()
    val speaking = listed.filter { (it.tier == null || it.tier.equals("live", ignoreCase = true)) && lang in it.languages }
    val (multi, single) = speaking.partition { it.multilingual }
    return single + multi
}

private val ALL_CODES = listOf(
    "en", "de", "es", "fr", "it", "pt", "pt-BR", "cs", "nl", "fi", "el", "hi", "hu", "id", "ja", "pl", "ro", "ru", "sv", "tr", "uk", "da", "vi", "ca", "ar",
    "ms", "sr", "hr", "sk", "sl", "no", "nb", "nn", "zh", "th", "ko", "he", "bg", "und",
)

private val MIRA = CloudVoice("mira", "en", "female", "Mira", setOf("en", "ms", "sr", "vi"), "studio")
private val REMY = CloudVoice("remy", "en", "male", "Remy", setOf("en", "sr", "vi"), "studio")
private val LIVE_MULTI = CloudVoice("aria", "en", "female", "Aria", setOf("en", "es", "de"), "live")

private class OneCatalog(var list: List<CloudVoice>) : CloudVoiceCatalog {
    var invalidated = 0
    override suspend fun voices() = list
    override fun invalidate() { invalidated++ }
}

/** Plausible audio for any text: 0.1 s per character. */
private val NORMAL: (String) -> Double = { it.codePointCount(0, it.length) * 0.1 }

class StudioRoutingTest {

    // ---- catalog: the studio tier only counts when tiers.studio.ws is true ----

    @Test fun `the catalog as published today (no ws flag) offers no studio voice at all - every language behaves as before`() {
        val v = CloudVoicePolicy.parse(freshCatalogJson())
        assertTrue("no studio voice is usable", v.none { it.studioUsable })
        val raw = JSONObject(freshCatalogJson()).getJSONArray("voices")
        assertTrue("the fixture really has studio voices", (0 until raw.length()).any { raw.getJSONObject(it).optString("tier") == "studio" })
        for (code in ALL_CODES) assertEquals(code, policyBeforeStudio(code, v).map { it.id }, CloudVoicePolicy.voicesFor(code, v).map { it.id })
        val before = ALL_CODES.filter { policyBeforeStudio(it, v).isNotEmpty() }.mapNotNull { ApiLanguageCode.of(it) }.toSet() - "en"
        assertEquals(before, CloudVoicePolicy.languages(v))
        for (l in listOf("hr", "ms", "no", "sk", "sl", "sr")) assertNull(l, CloudVoicePolicy.voiceFor(l, v))
    }

    @Test fun `with ws true the live languages keep their lists and defaults, studio voices only follow, and studio-only languages appear`() {
        val live = CloudVoicePolicy.parse(freshCatalogJson())
        val v = CloudVoicePolicy.parse(withStudioWs(freshCatalogJson(), true))
        assertTrue(v.any { it.studioUsable })
        for (code in ALL_CODES) {
            val before = policyBeforeStudio(code, live).map { it.id }
            val now = CloudVoicePolicy.voicesFor(code, v).map { it.id }
            // the voices that already read the language come first, in the same order; the default is unchanged
            if (before.isNotEmpty()) {
                assertEquals(code, before, now.take(before.size))
                assertEquals(code, before.first(), CloudVoicePolicy.voiceFor(code, v)?.id)
                assertTrue(code, CloudVoicePolicy.voicesFor(code, v).drop(before.size).all { it.studio })
            } else {
                assertTrue(code, CloudVoicePolicy.voicesFor(code, v).all { it.studio })
            }
        }
        val studioOnly = setOf("hr", "ms", "no", "sk", "sl", "sr")
        assertEquals(CloudVoicePolicy.languages(live) + studioOnly, CloudVoicePolicy.languages(v))
        for (l in studioOnly) assertEquals(l, "mira", CloudVoicePolicy.voiceFor(l, v)?.id)
        // keyed off what each voice speaks: Norwegian text labelled nb/nn is read with the voice that speaks "no"
        assertEquals("mira", CloudVoicePolicy.voiceFor("nb", v)?.id)
        assertEquals("remy", CloudVoicePolicy.voicesFor("sk", v).last().id)
        // English never goes through this path
        for (en in listOf("en", "en-US")) {
            assertTrue(CloudVoicePolicy.voicesFor(en, v).isEmpty())
            assertNull(CloudVoicePolicy.voiceFor(en, v))
        }
        assertFalse("en" in CloudVoicePolicy.languages(v))
        // Vietnamese and Catalan have a live voice today: it leads, the studio voices follow
        assertEquals("vi-f1", CloudVoicePolicy.voicesFor("vi", v).first().id)
        assertEquals(listOf("mira", "remy"), CloudVoicePolicy.voicesFor("vi", v).drop(1).map { it.id })
    }

    @Test fun `only the JSON boolean true switches the studio tier on`() {
        for (flag in listOf(null, false, "true", "yes", 1, "false")) {
            val v = CloudVoicePolicy.parse(withStudioWs(freshCatalogJson(), flag))
            assertTrue("flag=$flag", v.none { it.studioUsable })
            assertNull("flag=$flag", CloudVoicePolicy.voiceFor("sr", v))
        }
        assertEquals("mira", CloudVoicePolicy.voiceFor("sr", CloudVoicePolicy.parse(withStudioWs(freshCatalogJson(), true)))?.id)
        // no tiers object at all (the older list shape): ignored too
        assertTrue(CloudVoicePolicy.parse("""{"voices":[{"voice_id":"mira","language":"en","languages":["en","sr"],"tier":"studio"},{"voice_id":"aria","language":"en","languages":["en","es"],"tier":"live"}]}""").none { it.studioUsable })
    }

    @Test fun `a catalog of studio voices only is still a voice list, not a failed read`() {
        val body = """{"tiers":{"studio":{"ws":false}},"voices":[{"voice_id":"mira","language":"en","languages":["en","sr"],"tier":"studio"}]}"""
        val parsed = CloudVoicePolicy.parseStrict(body)!!
        assertEquals(1, parsed.size)
        assertFalse(parsed.single().studioUsable)
    }

    @Test fun `a studio voice whose id the authorize call would not take is never offered`() {
        val body = """{"tiers":{"studio":{"ws":true}},"voices":[
            {"voice_id":"Mira X","language":"en","languages":["en","sr"],"tier":"studio"},
            {"voice_id":"remy","language":"en","languages":["en","sr"],"tier":"studio"}]}"""
        assertEquals(listOf("remy"), CloudVoicePolicy.parse(body).map { it.id })
    }

    @Test fun `order - live single, live multilingual, studio, then experimental voices last, stable`() {
        val single = CloudVoice("sr-f1", "sr", "female", "Serbian", setOf("sr"), "live")
        val singleExp = CloudVoice("sr-x", "sr", "male", "Serbian (EXPERIMENTAL)", setOf("sr"), "live")
        val multi = CloudVoice("m", "en", "female", "M", setOf("en", "sr"), "live")
        val studioExp = CloudVoice("s-exp", "en", "female", "Zed (Experimental)", setOf("en", "sr"), "studio")
        val studio = CloudVoice("s", "en", "female", "Studio", setOf("en", "sr"), "studio")
        val listed = listOf(studio, studioExp, multi, singleExp, single)
        assertEquals(listOf("sr-f1", "m", "s", "sr-x", "s-exp"), CloudVoicePolicy.voicesFor("sr", listed).map { it.id })
        assertEquals("sr-f1", CloudVoicePolicy.voiceFor("sr", listed)?.id)
        assertEquals("mira", CloudVoicePolicy.voiceFor("ms", listOf(MIRA))?.id)
    }

    // ---- authorize body and header ----

    @Test fun `a live voice is authorized with exactly the piper engine body, a studio voice with engine studio and its public id`() = runBlocking {
        FakeWorker().use { w ->
            w.audioSeconds = NORMAL
            val src = w.source(OneCatalog(listOf(LIVE_MULTI, MIRA)))
            src.synthesize("Hola, buenos dias.", TtsRequest("bella", "es"))
            assertEquals("""{"engine":"piper"}""", w.authorizeBodies.poll(5, TimeUnit.SECONDS))
            src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
            val studioBody = JSONObject(w.authorizeBodies.poll(5, TimeUnit.SECONDS)!!)
            assertEquals(setOf("engine", "voice"), studioBody.keys().asSequence().toSet())
            assertEquals("studio", studioBody.getString("engine"))
            assertEquals("mira", studioBody.getString("voice"))
            src.close()
        }
    }

    @Test fun `English reads and live reads send the same body as 2_14_58, alignment included`() = runBlocking {
        FakeWorker().use { w ->
            val src = w.source(OneCatalog(listOf(LIVE_MULTI, MIRA)))
            src.synthesize("Hello there.", TtsRequest("bella", "en", wantWords = true))
            val b = JSONObject(w.authorizeBodies.poll(5, TimeUnit.SECONDS)!!)
            assertEquals(setOf("engine", "alignment"), b.keys().asSequence().toSet())
            assertEquals("piper", b.getString("engine"))
            src.close()
        }
    }

    @Test fun `the test header is absent when the key is empty, present with the key when it is not, on both routes`() = runBlocking {
        FakeWorker().use { w ->
            w.audioSeconds = NORMAL
            val none = w.source(OneCatalog(listOf(LIVE_MULTI, MIRA)))
            none.synthesize("Hola, buenos dias.", TtsRequest("bella", "es"))
            none.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
            assertEquals(2, w.authorizeHeaders.size)
            for (h in w.authorizeHeaders) assertNull(h["X-Tts-Test-Key"])
            none.close()
        }
        FakeWorker().use { w ->
            w.audioSeconds = NORMAL
            val keyed = w.source(OneCatalog(listOf(LIVE_MULTI, MIRA)), testKey = "unit-test-key-0123")
            keyed.synthesize("Hola, buenos dias.", TtsRequest("bella", "es"))
            keyed.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
            assertEquals(2, w.authorizeHeaders.size)
            for (h in w.authorizeHeaders) assertEquals("unit-test-key-0123", h["X-Tts-Test-Key"])
            // the key is a header only: it is not in the body
            for (b in w.authorizeBodies) assertFalse(b.contains("unit-test-key"))
            keyed.close()
        }
    }

    // ---- sockets are never shared across routes ----

    @Test fun `a Piper socket is never reused for a studio voice and a studio socket never for Piper, but each is reused on its own route`() = runBlocking {
        FakeWorker().use { w ->
            w.audioSeconds = NORMAL
            val src = w.source(OneCatalog(listOf(LIVE_MULTI, MIRA, REMY)))
            src.synthesize("Hola, buenos dias.", TtsRequest("bella", "es"))
            assertEquals(1, w.authorizeCalls.get())
            src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms")) // mira
            assertEquals("a studio read does not take the idle Piper socket", 2, w.authorizeCalls.get())
            src.synthesize("Hola de nuevo, amigos.", TtsRequest("bella", "es"))
            assertEquals("the Piper read reuses the Piper socket, not the studio one", 2, w.authorizeCalls.get())
            src.synthesize("Jos jedan red za citanje.", TtsRequest("bella", "ms"))
            assertEquals("the studio read reuses the studio socket", 2, w.authorizeCalls.get())
            src.synthesize("Dobar dan opet.", TtsRequest("bella", "ms", cloudVoiceId = "mira"))
            assertEquals(2, w.authorizeCalls.get())
            // another studio voice is its own route
            src.synthesize("Dobar dan opet.", TtsRequest("bella", "sr", cloudVoiceId = "remy"))
            assertEquals(3, w.authorizeCalls.get())
            assertEquals(listOf("/tts", "/studio", "/studio"), w.socketPaths.toList())
            assertEquals("mira", JSONObject(w.authorizeBodies.toList()[1]).getString("voice"))
            assertEquals("remy", JSONObject(w.authorizeBodies.toList()[2]).getString("voice"))
            src.close()
        }
    }

    @Test fun `an idle studio socket is closed after the studio idle time, so the machine can scale down`() = runBlocking {
        FakeWorker().use { w ->
            w.audioSeconds = NORMAL
            val src = w.source(OneCatalog(listOf(MIRA)), studioIdleMs = 250)
            src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
            assertEquals(1, w.authorizeCalls.get())
            src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
            assertEquals("a quick second chunk reuses it", 1, w.authorizeCalls.get())
            delay(900)
            src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
            assertEquals("after the idle time it was closed, a new one is opened", 2, w.authorizeCalls.get())
            src.close()
        }
    }

    // ---- the studio route's budget: a slow start is waited for, the live route is unchanged ----

    @Test fun `a studio handshake slower than the app's usual timeouts is waited for, a live one with the same delay times out`() = runBlocking {
        FakeWorker().use { w ->
            w.audioSeconds = NORMAL
            w.upgradeDelayMs = 1_500
            val quick = OkHttpClient.Builder().connectTimeout(500, TimeUnit.MILLISECONDS).readTimeout(500, TimeUnit.MILLISECONDS).build()
            val src = w.source(OneCatalog(listOf(LIVE_MULTI, MIRA)), client = quick, studioTimeoutMs = 8_000)
            val chunk = src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
            assertTrue(chunk.pcm.isNotEmpty())
            try {
                src.synthesize("Hola, buenos dias.", TtsRequest("bella", "es"))
                fail("the live route keeps its short timeouts")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.TIMEOUT, e.reason)
            }
            src.close()
        }
    }

    // ---- error mapping ----

    @Test fun `HTTP 400 UNKNOWN_VOICE from authorize is a per-language refusal and the list is looked at again`() = runBlocking {
        FakeWorker().use { w ->
            w.authorizeError = 400 to """{"error":"UNKNOWN_VOICE"}"""
            val cat = OneCatalog(listOf(MIRA))
            val src = w.source(cat)
            try {
                src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
                fail("expected a refusal")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, e.reason)
            }
            assertEquals(1, cat.invalidated)
            src.close()
        }
    }

    @Test fun `the other authorize answers keep their mapping`() {
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, ApiFailureMapping.fromHttp(400, null, true, """{"error":"UNKNOWN_VOICE"}""").reason)
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, ApiFailureMapping.fromHttp(400, null, true, """{"error":"unknown_voice"}""").reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromHttp(400, null, true, """{"error":"BAD_REQUEST"}""").reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromHttp(400, null, true, null).reason)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromHttp(400, null, true, "not json").reason)
        assertEquals(FallbackReason.QUOTA, ApiFailureMapping.fromHttp(402, null, true, """{"error":"QUOTA_EXCEEDED"}""").reason)
        assertEquals(FallbackReason.RATE_LIMITED, ApiFailureMapping.fromHttp(429, "7", true, """{"error":"RATE_LIMITED"}""").reason)
        assertEquals(7_000L, ApiFailureMapping.fromHttp(429, "7", true, "{}").retryAfterMs)
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromHttp(503, "5", true, "{}").reason)
        // only a 400 carries the unknown-voice meaning
        assertEquals(FallbackReason.SERVER_ERROR, ApiFailureMapping.fromHttp(500, null, true, """{"error":"UNKNOWN_VOICE"}""").reason)
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, ApiFailureMapping.fromWsError("unknown voice").reason)
        assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, ApiFailureMapping.fromWsError("Unknown voice: mira").reason)
    }

    @Test fun `a WebSocket error unknown voice is a per-language refusal`() = runBlocking {
        FakeWorker().use { w ->
            w.reply = { ws -> ws.send("""{"type":"error","message":"unknown voice"}""") }
            val cat = OneCatalog(listOf(MIRA))
            val src = w.source(cat)
            try {
                src.synthesize("Dobar dan, kako ste.", TtsRequest("bella", "ms"))
                fail("expected a refusal")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.UNSUPPORTED_LANGUAGE, e.reason)
            }
            assertEquals(1, cat.invalidated)
            src.close()
        }
    }

    // ---- safety net ----

    /** (language, characters, seconds of audio) as measured on the live worker on 2026-11-20 (ws_duration_check) and the owner-reported runaways. */
    private val healthy = listOf(
        Triple("ms", 126, 8.9), Triple("ca", 122, 8.2), Triple("ca", 122, 8.4), Triple("hr", 123, 10.2), Triple("hr", 123, 10.4),
        Triple("no", 120, 9.1), Triple("no", 120, 8.7), Triple("sk", 112, 9.2), Triple("sk", 112, 8.9), Triple("sl", 115, 9.7),
        Triple("sr", 115, 8.6), Triple("sr", 115, 8.6), Triple("vi", 103, 17.0), Triple("vi", 103, 16.7), Triple("ja", 88, 17.4),
        Triple("en", 132, 8.9), Triple("en", 132, 7.0),
    )
    private val runaways = listOf(Triple("zh", 78, 66.2), Triple("zh", 78, 64.2), Triple("ar", 159, 94.6), Triple("th", 60, 68.4), Triple("zh", 34, 26.9))

    @Test fun `measured healthy audio passes for every language, measured runaways are rejected`() {
        for ((l, c, s) in healthy) assertNull("$l $c chars $s s", AudioPlausibility.problem(c, s, 1f, l))
        for ((l, c, s) in runaways) assertNotNull("$l $c chars $s s", AudioPlausibility.problem(c, s, 1f, l))
    }

    @Test fun `seconds per character by script, the bound has a 2 s floor and stretches for slow speeds, and a near-empty answer fails`() {
        assertEquals(0.25, AudioPlausibility.secondsPerChar("sr"), 0.0)
        assertEquals(0.25, AudioPlausibility.secondsPerChar("ru"), 0.0)
        assertEquals(0.25, AudioPlausibility.secondsPerChar("el"), 0.0)
        for (l in listOf("ar", "he", "hi")) assertEquals(l, 0.30, AudioPlausibility.secondsPerChar(l), 0.0)
        assertEquals(0.40, AudioPlausibility.secondsPerChar("th"), 0.0)
        for (l in listOf("zh", "ja", "ko", "zh-CN")) assertEquals(l, 0.50, AudioPlausibility.secondsPerChar(l), 0.0)
        // floor: 3 characters may take up to 2 s
        assertNull(AudioPlausibility.problem(3, 1.9, 1f, "sr"))
        assertNotNull(AudioPlausibility.problem(3, 2.1, 1f, "sr"))
        // 100 Latin characters: up to 25 s at speed 1; at speed 0.5 up to 50 s; faster than 1 does not stretch the bound
        assertNull(AudioPlausibility.problem(100, 24.0, 1f, "sr")); assertNotNull(AudioPlausibility.problem(100, 26.0, 1f, "sr"))
        assertNull(AudioPlausibility.problem(100, 48.0, 0.5f, "sr")); assertNotNull(AudioPlausibility.problem(100, 52.0, 0.5f, "sr"))
        assertNotNull(AudioPlausibility.problem(100, 26.0, 2f, "sr"))
        // at least 0.01 s per character
        assertNotNull(AudioPlausibility.problem(100, 0.3, 1f, "sr"))
        assertNull(AudioPlausibility.problem(100, 1.0, 1f, "sr"))
        assertNotNull(AudioPlausibility.problem(100, 0.0, 1f, "sr"))
    }

    private fun studioWorker(w: FakeWorker, seconds: Double) { w.audioSeconds = { seconds } }

    @Test fun `a studio chunk with runaway audio fails as BAD_AUDIO and its socket is not reused`() = runBlocking {
        FakeWorker().use { w ->
            val text = "Dobar dan, kako ste danas, nadam se da je sve u redu."
            studioWorker(w, 60.0)
            val src = w.source(OneCatalog(listOf(MIRA)))
            try {
                src.synthesize(text, TtsRequest("bella", "ms"))
                fail("expected BAD_AUDIO")
            } catch (e: SourceFailure) {
                assertEquals(FallbackReason.BAD_AUDIO, e.reason)
            }
            studioWorker(w, 5.0)
            assertTrue(src.synthesize(text, TtsRequest("bella", "ms")).pcm.isNotEmpty())
            assertEquals("the socket that carried the bad answer was dropped", 2, w.authorizeCalls.get())
            src.close()
        }
    }

    @Test fun `a studio chunk with near-empty audio fails, normal audio passes`() = runBlocking {
        FakeWorker().use { w ->
            val text = "x".repeat(200)
            studioWorker(w, 0.5)
            val src = w.source(OneCatalog(listOf(MIRA)))
            try { src.synthesize(text, TtsRequest("bella", "ms")); fail() } catch (e: SourceFailure) { assertEquals(FallbackReason.BAD_AUDIO, e.reason) }
            studioWorker(w, 14.0)
            assertEquals(14_000L, src.synthesize(text, TtsRequest("bella", "ms")).durationMs)
            src.close()
        }
    }

    @Test fun `the same runaway on a live voice is not touched (the check is for studio voices only)`() = runBlocking {
        FakeWorker().use { w ->
            studioWorker(w, 60.0)
            val src = w.source(OneCatalog(listOf(LIVE_MULTI)))
            assertEquals(60_000L, src.synthesize("Hola, buenos dias, amigos.", TtsRequest("bella", "es")).durationMs)
            src.close()
        }
    }

    @Test fun `chunk_meta that names another voice or language fails a studio chunk, matching or absent fields do not`() = runBlocking {
        val text = "Dobar dan, kako ste danas."
        for ((extra, ok) in listOf(
            """"voice":"mira","language":"ms"""" to true,
            """"voice":"MIRA"""" to true,
            """"language":"ms-MY"""" to true,
            "" to true,
            """"voice":"remy"""" to false,
            """"language":"es"""" to false,
            """"voice":"mira","language":"th"""" to false,
        )) {
            FakeWorker().use { w ->
                w.audioSeconds = NORMAL
                w.metaExtra = extra
                val src = w.source(OneCatalog(listOf(MIRA)))
                try {
                    src.synthesize(text, TtsRequest("bella", "ms"))
                    assertTrue("accepted: $extra", ok)
                } catch (e: SourceFailure) {
                    assertFalse("rejected: $extra", ok)
                    assertEquals(FallbackReason.BAD_AUDIO, e.reason)
                }
                src.close()
            }
        }
    }

    @Test fun `the voice echo is not checked for a live voice`() = runBlocking {
        FakeWorker().use { w ->
            w.audioSeconds = NORMAL
            w.metaExtra = """"voice":"someone-else""""
            val src = w.source(OneCatalog(listOf(LIVE_MULTI)))
            assertTrue(src.synthesize("Hola, buenos dias.", TtsRequest("bella", "es")).pcm.isNotEmpty())
            src.close()
        }
    }
}

/** The chain's answer to BAD_AUDIO: one retry on the cloud, then the phone's voice, and the cloud rests for that language. */
@OptIn(ExperimentalCoroutinesApi::class)
class BadAudioChainTest {
    private class BadApi(private val voice: CloudVoice) : TtsSource {
        override val id = SourceId.API
        val calls = AtomicInteger()
        var bad = true
        override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = null
        override suspend fun pin(request: TtsRequest) = request.copy(cloudVoice = voice)
        override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
            calls.incrementAndGet()
            if (bad) throw SourceFailure(FallbackReason.BAD_AUDIO, null, "audio too long")
            return PcmChunk(ByteArray(48_000), 24_000)
        }
    }

    private class Phone : TtsSource {
        override val id = SourceId.SYSTEM
        val calls = AtomicInteger()
        override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = null
        override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk { calls.incrementAndGet(); return PcmChunk(ByteArray(48_000), 24_000) }
    }

    private fun TestScope.chain(api: TtsSource, phone: Phone) = TtsSourceChain(
        sources = mapOf(SourceId.API to api, SourceId.SYSTEM to phone),
        order = { listOf(SourceId.API, SourceId.SYSTEM) },
        nowMs = { currentTime },
    )

    @Test fun `bad audio is retried once, then the phone reads, and the language rests for 30 s but other languages and English do not`() = runTest {
        val api = BadApi(CloudVoice("mira", "en", "female", "Mira", setOf("en", "ms", "sr"), "studio"))
        val phone = Phone()
        val c = chain(api, phone)
        val out = c.speak("Dobar dan.", TtsRequest("bella", "ms")).toList()
        assertTrue(out.all { it.source == SourceId.SYSTEM })
        assertEquals("one try and one retry", 2, api.calls.get())
        // within 30 s the cloud is not asked again for Malay
        c.speak("Dobar dan.", TtsRequest("bella", "ms")).toList()
        assertEquals(2, api.calls.get())
        // another language is not affected
        api.bad = false
        assertTrue(c.speak("Dobar dan.", TtsRequest("bella", "sr")).toList().all { it.source == SourceId.API })
        // after the rest the cloud is tried again
        delay(31_000)
        assertTrue(c.speak("Dobar dan.", TtsRequest("bella", "ms")).toList().all { it.source == SourceId.API })
    }
}
