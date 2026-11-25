package com.listenai

import com.listenai.service.tts.chain.FallbackReason
import com.listenai.service.tts.chain.SessionReport
import com.listenai.service.tts.chain.SourceId
import com.listenai.service.tts.chain.TtsFailureSignals
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FailureReporterInterceptorTest {

    /** Runs a request through the interceptor against a canned answer: no network. */
    private fun reportsFor(url: String, code: Int): List<Pair<String, String>> {
        val reports = mutableListOf<Pair<String, String>>()
        val client = OkHttpClient.Builder()
            .addInterceptor(FailureReporterInterceptor { flow, message -> reports += flow to message })
            .addInterceptor(Interceptor { chain ->
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x").body("".toResponseBody()).build()
            })
            .build()
        client.newCall(Request.Builder().url(url).build()).execute().use { assertEquals(code, it.code) }
        return reports
    }

    @Test
    fun serverErrorFromOurBackendIsReportedWithoutQueryOrIds() {
        val r = reportsFor("https://listenai-backend.fly.dev/api/tts/job/3f2a9c1e-1111-4222-8333-444455556666?token=secret", 503)
        assertEquals(listOf("GET /api/tts/job/:id" to "HTTP 503 from listenai-backend.fly.dev"), r)
    }

    @Test
    fun ownHostsAreRecognisedAndOthersAreNot() {
        for (host in listOf("api.readaloudai.org", "tts.readaloudai.org", "x.supabase.co", "a--b.modal.run", "piper-tts-sjc.fly.dev")) {
            assertTrue(host, FailureReporterInterceptor.isOwnHost(host))
        }
        for (url in listOf("https://example.com/a.pdf", "https://gmail.googleapis.com/x", "https://readaloudai.org.evil.test/x")) {
            assertTrue(url, reportsFor(url, 500).isEmpty())
        }
    }

    @Test
    fun clientErrorsAndSuccessAreQuiet() {
        for (code in listOf(200, 304, 400, 401, 402, 404, 429)) {
            assertTrue(reportsFor("https://listenai-backend.fly.dev/api/extract", code).isEmpty())
        }
    }

    @Test
    fun ordinaryPathSegmentsAreKept() {
        assertEquals("/api/tts/synthesize-long", FailureReporterInterceptor.routeOf("/api/tts/synthesize-long"))
        assertEquals("/api/marketplace/:id/rate", FailureReporterInterceptor.routeOf("/api/marketplace/0a1b2c3d4e/rate"))
    }

    @Test
    fun everyClientForOurServicesAddsTheInterceptor() {
        val main = listOf("src/main/java", "app/src/main/java").map { File(it) }.first { it.isDirectory }
        // These two only fetch other people's hosts.
        val thirdPartyOnly = setOf("GmailService.kt", "ImportViewModel.kt")
        val missing = main.walkTopDown().filter { it.extension == "kt" && it.name !in thirdPartyOnly }
            .filter { file ->
                val text = file.readText()
                Regex("OkHttpClient\\.Builder\\(\\)").findAll(text).count() > Regex("addInterceptor\\([a-z.]*FailureReporterInterceptor\\(\\)\\)").findAll(text).count()
            }
            .map { it.name }.toList()
        assertEquals(emptyList<String>(), missing)
    }

    private fun session(reasons: List<Pair<SourceId, FallbackReason>>, first: SourceId?) = SessionReport(
        firstSource = first, chunksBySource = emptyMap(), cacheHits = 0, chunks = 1, chars = 10, fallbackReasons = reasons,
        timeToFirstAudioMs = null, totalMs = 1, audioMs = 0, succeeded = false, language = "en",
    )

    @Test
    fun anApiFailureOnOurSideIsSignalledEvenWhenThePhoneVoiceReads() {
        val s = TtsFailureSignals.apiFallback(session(listOf(SourceId.API to FallbackReason.SERVER_ERROR), SourceId.SYSTEM))!!
        assertEquals("TTS_API_SERVER_ERROR", s.code)
        assertEquals("SYSTEM", s.context["spoke_with"])
    }

    @Test
    fun offlineQuotaUnsupportedLanguageAndUserStopAreNotSignalled() {
        for (reason in listOf(FallbackReason.OFFLINE, FallbackReason.QUOTA, FallbackReason.UNSUPPORTED_LANGUAGE, FallbackReason.FLAG_OFF)) {
            assertNull(TtsFailureSignals.apiFallback(session(listOf(SourceId.API to reason), SourceId.SYSTEM)))
        }
        assertNull(TtsFailureSignals.apiFallback(session(emptyList(), SourceId.API)))
        assertNull(TtsFailureSignals.noAudio(mapOf(SourceId.API to FallbackReason.OFFLINE, SourceId.SYSTEM to FallbackReason.LANGUAGE_MISSING), "de"))
    }

    @Test
    fun noAudioAtAllWithAServerReasonIsSignalled() {
        val s = TtsFailureSignals.noAudio(mapOf(SourceId.API to FallbackReason.TIMEOUT, SourceId.SYSTEM to FallbackReason.ENGINE_MISSING), "en")!!
        assertEquals("TTS_NO_AUDIO", s.code)
        assertEquals("API:TIMEOUT,SYSTEM:ENGINE_MISSING", s.context["reasons"])
    }
}
