package com.listenai.service.voice

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * The client against a fake server serving the JSON documented in docs/VOICE_CLONING_CONSENT.md
 * and the shapes in backend/src/routes/voiceClones.ts / tts.ts. Nothing here touches production.
 */
class VoiceCloneApiTest {

    private lateinit var server: MockWebServer
    private var token: String? = "tok-123"

    private fun api() = VoiceCloneApi(
        baseUrl = server.url("/").toString().trimEnd('/'),
        http = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build(),
        accessToken = { token }
    )

    private fun clip(name: String, seconds: Int, size: Int = 2048) =
        AudioClip(name, "audio/mp4", seconds) { ByteArray(size) { 7 } }

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = server.shutdown()

    private fun <T> expectError(block: suspend () -> T): VoiceCloneException {
        try {
            runBlocking { block() }
        } catch (e: VoiceCloneException) {
            return e
        }
        fail("expected VoiceCloneException")
        throw AssertionError()
    }

    @Test
    fun `consent challenge is a bearer-authenticated POST and parses phrase and expiry`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"challenge_id":"9b2f5c1e-0000-4000-8000-000000000001","phrase":"I agree that ReadAloud may create a synthetic copy of my voice. My code words are apple, river, stone, lamp.","expires_at":"2026-10-06T12:05:00.000Z"}"""
            )
        )

        val c = api().requestConsentChallenge()

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/voice-clones/consent-challenges", req.path)
        assertEquals("Bearer tok-123", req.getHeader("Authorization"))
        assertNull("X-Device-ID is gone", req.getHeader("X-Device-ID"))
        assertEquals("9b2f5c1e-0000-4000-8000-000000000001", c.challengeId)
        assertTrue(c.phrase.endsWith("apple, river, stone, lamp."))
        assertEquals(java.time.Instant.parse("2026-10-06T12:05:00Z").toEpochMilli(), c.expiresAtMillis)
        assertFalse(c.isExpired(c.expiresAtMillis!! - 1))
        assertTrue(c.isExpired(c.expiresAtMillis))
    }

    @Test
    fun `create sends multipart with challenge_id name language consent and reference`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"id":"0b6d0a52-0000-4000-8000-0000000000aa","name":"My voice","language":"en","status":"active","reference_seconds":42.5,"model":"chatterbox-mtl-v3","created_at":"2026-10-06T12:00:00.000Z"}"""
            )
        )

        val v = api().createVoice(
            challengeId = "ch-1", name = "My voice", language = "en",
            consent = clip("consent.m4a", 6), reference = clip("reference.m4a", 40)
        )

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/voice-clones", req.path)
        assertEquals("Bearer tok-123", req.getHeader("Authorization"))
        assertTrue(req.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("name=\"challenge_id\"") && body.contains("ch-1"))
        assertTrue(body.contains("name=\"name\"") && body.contains("My voice"))
        assertTrue(body.contains("name=\"language\"") && body.contains("en"))
        assertTrue(body.contains("name=\"consent\"; filename=\"consent.m4a\""))
        assertTrue(body.contains("name=\"reference\"; filename=\"reference.m4a\""))
        assertTrue("part mime must be one the backend accepts", body.contains("Content-Type: audio/mp4"))
        assertEquals("0b6d0a52-0000-4000-8000-0000000000aa", v.id)
        assertTrue(v.isReady)
        assertEquals("en", v.language)
    }

    @Test
    fun `list returns voices and never expects audio`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"voices":[{"id":"a","name":"One","language":"en","status":"active","created_at":"2026-10-06T12:00:00.000Z"},{"id":"b","name":"Two","language":"fr","status":"disabled","created_at":"2026-10-05T12:00:00.000Z"}]}"""
            )
        )
        val voices = api().listVoices()
        assertEquals("GET", server.takeRequest().method)
        assertEquals(listOf("a", "b"), voices.map { it.id })
        assertTrue(voices[0].isReady)
        assertFalse("disabled voice is not usable", voices[1].isReady)
    }

    @Test
    fun `delete calls DELETE on the voice id`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"deleted":true,"alreadyDeleted":false}"""))
        api().deleteVoice("0b6d0a52-0000-4000-8000-0000000000aa")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/voice-clones/0b6d0a52-0000-4000-8000-0000000000aa", req.path)
    }

    @Test
    fun `sync synthesis posts text voice_id speed only and returns wav bytes`() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "audio/wav").setBody(okio.Buffer().write(byteArrayOf(1, 2, 3, 4))))
        val audio = api().synthesize("Hello there", "0b6d0a52-0000-4000-8000-0000000000aa", 1.25f)
        val req = server.takeRequest()
        assertEquals("/api/tts/cloned", req.path)
        assertEquals("Bearer tok-123", req.getHeader("Authorization"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"voice_id\":\"0b6d0a52-0000-4000-8000-0000000000aa\""))
        assertTrue(body.contains("\"text\":\"Hello there\""))
        assertTrue(body.contains("\"speed\":1.25"))
        assertFalse("voice_url is removed", body.contains("voice_url"))
        assertFalse("model:xtts is removed", body.contains("xtts"))
        assertEquals(4, audio.size)
    }

    @Test
    fun `job synthesis posts to job-cloned and parses the processing reply`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(202)
                .setBody("""{"job_id":"job-1","status":"processing","cache_hit":false,"estimated_wait_sec":160}""")
        )
        val job = api().createSynthesisJob("Hi", "0b6d0a52-0000-4000-8000-0000000000aa", 1.0f)
        val req = server.takeRequest()
        assertEquals("/api/tts/job-cloned", req.path)
        assertFalse(req.body.readUtf8().contains("voice_url"))
        assertEquals("job-1", job.jobId)
        assertEquals("processing", job.status)
        assertNull(job.audioUrl)
        assertEquals(160, job.estimatedWaitSec)
    }

    @Test
    fun `job synthesis cache hit carries the audio url`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"job_id":"cache-abc","status":"ready","cache_hit":true,"audio_url":"https://x/y.wav","estimated_wait_sec":0}"""))
        val job = api().createSynthesisJob("Hi", "v", 1.0f)
        assertEquals("ready", job.status)
        assertEquals("https://x/y.wav", job.audioUrl)
    }

    @Test
    fun `no token means sign-in required and no request is made`() {
        token = null
        val e = expectError { api().listVoices() }
        assertEquals(VoiceCloneException.CODE_SIGN_IN, e.code)
        assertEquals(0, server.requestCount)
        assertEquals(Recovery.SIGN_IN, VoiceCloneErrors.map(e).recovery)
    }

    @Test
    fun `voice-clones error envelope puts the code in code and message in error`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"Voice cloning is not available.","code":"unavailable"}"""))
        val e = expectError { api().requestConsentChallenge() }
        assertEquals(503, e.httpStatus)
        assertEquals("unavailable", e.code)
        assertEquals("Voice cloning is not available.", e.serverMessage)
    }

    @Test
    fun `global error handler envelope puts the code in error and message in message`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"CLONING_UNAVAILABLE","message":"Voice cloning is not available."}"""))
        val e = expectError { api().createSynthesisJob("Hi", "v", 1f) }
        assertEquals("CLONING_UNAVAILABLE", e.code)
        assertEquals("Voice cloning is not available.", e.serverMessage)
        assertEquals(VoiceCloneErrors.UNAVAILABLE_MESSAGE, VoiceCloneErrors.map(e).message)
    }

    @Test
    fun `details are preserved for attemptsLeft and failures`() {
        server.enqueue(
            MockResponse().setResponseCode(422).setBody(
                """{"error":"The voice in the consent recording does not match the reference audio.","code":"speaker_mismatch","details":{"attemptsLeft":2}}"""
            )
        )
        val e = expectError { api().createVoice("c", "n", "en", clip("c.m4a", 5), clip("r.m4a", 30)) }
        assertEquals(2, e.details!!.getInt("attemptsLeft"))
    }

    @Test
    fun `non-json error body still yields a code from the status`() {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
        val e = expectError { api().listVoices() }
        assertEquals(502, e.httpStatus)
        assertEquals("http_502", e.code)
        assertEquals(Recovery.RETRY, VoiceCloneErrors.map(e).recovery)
    }

    @Test
    fun `connection failure is a network error`() {
        val a = api()
        server.shutdown()
        val e = expectError { a.listVoices() }
        assertEquals(VoiceCloneException.CODE_NETWORK, e.code)
        assertEquals(Recovery.RETRY, VoiceCloneErrors.map(e).recovery)
    }

    @Test
    fun `malformed success body is reported not crashed`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"phrase":"x"}"""))
        val e = expectError { api().requestConsentChallenge() }
        assertEquals(VoiceCloneException.CODE_MALFORMED, e.code)
        assertNotNull(e.message)
    }

    @Test
    fun `config parses consent_required and works without a token`() = runBlocking {
        token = null
        server.enqueue(MockResponse().setBody("""{"consent_required":false}"""))
        server.enqueue(MockResponse().setBody("""{"consent_required":true}"""))
        assertFalse(api().getConfig().consentRequired)
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/voice-clones/config", req.path)
        assertNull(req.getHeader("Authorization"))
        token = "tok-123"
        assertTrue(api().getConfig().consentRequired)
        assertEquals("Bearer tok-123", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `config 404 and malformed bodies throw so the caller can fall back to strict`() {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found"}"""))
        assertEquals(404, expectError { api().getConfig() }.httpStatus)
        server.enqueue(MockResponse().setBody("""{"something":"else"}"""))
        assertEquals(VoiceCloneException.CODE_MALFORMED, expectError { api().getConfig() }.code)
        server.enqueue(MockResponse().setBody("not json"))
        assertEquals(VoiceCloneException.CODE_MALFORMED, expectError { api().getConfig() }.code)
    }

    @Test
    fun `attestation create sends attested true and no challenge_id and no consent part`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"id":"0b6d0a52-0000-4000-8000-0000000000aa","name":"My voice","language":"en","status":"active"}"""
            )
        )
        val v = api().createVoice(
            challengeId = null, name = "My voice", language = "en",
            consent = null, reference = clip("reference.m4a", 40), attested = true
        )
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("name=\"attested\"") && body.contains("\r\n\r\ntrue\r\n"))
        assertTrue(body.contains("name=\"name\"") && body.contains("My voice"))
        assertTrue(body.contains("name=\"language\""))
        assertTrue(body.contains("name=\"reference\"; filename=\"reference.m4a\""))
        assertFalse(body.contains("challenge_id"))
        assertFalse(body.contains("name=\"consent\""))
        assertTrue(v.isReady)
    }

    @Test
    fun `strict create does not send attested`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"x","name":"n","language":"en","status":"active"}"""))
        api().createVoice("ch-1", "n", "en", clip("consent.m4a", 6), clip("reference.m4a", 40))
        val body = server.takeRequest().body.readUtf8()
        assertFalse(body.contains("attested"))
        assertTrue(body.contains("name=\"consent\""))
    }
}
