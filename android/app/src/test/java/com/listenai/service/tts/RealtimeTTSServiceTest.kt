package com.listenai.service.tts

import android.content.ContextWrapper
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Regression coverage for two of the final-review findings on RealtimeTTSService:
 *
 * 1. isAvailable() must reflect whether the REAL synthesis path (backend-proxy authorize call,
 *    then gateway WebSocket) will work, not just the gateway's own /health - probing only the
 *    gateway is exactly why an undeployed backend-proxy route previously surfaced as a confusing
 *    mid-synthesis 404 instead of a clean "service unavailable" signal shown before the user taps
 *    play.
 * 2. handleErrorResponse's messages must reflect that the client no longer holds a platform API
 *    key (the backend does) - a 401/500 from the backend means server misconfiguration, and a 404
 *    (the exact failure hit during on-device testing) should say so plainly instead of falling
 *    through to a generic, unhelpful ApiError.
 *
 * Uses a real MockWebServer per fake host (no Context/network framework mocking available in this
 * module) rather than Robolectric/Mockito, neither of which is a dependency here. `Context` is
 * never actually touched by isAvailable()/authorize()/handleErrorResponse (only buildResult()
 * needs context.cacheDir, which none of these tests reach), so an inert ContextWrapper(null) is a
 * safe stand-in.
 */
class RealtimeTTSServiceTest {

    private val fakeContext = ContextWrapper(null)

    private lateinit var backend: MockWebServer
    private lateinit var gateway: MockWebServer

    private fun service(): RealtimeTTSService {
        return RealtimeTTSService(
            context = fakeContext,
            backendBaseUrl = backend.url("/").toString().trimEnd('/'),
            gatewayBaseUrl = gateway.url("/").toString().trimEnd('/')
        )
    }

    @After
    fun tearDown() {
        if (::backend.isInitialized) backend.shutdown()
        if (::gateway.isInitialized) gateway.shutdown()
    }

    @Test
    fun `isAvailable is true only when both backend and gateway health checks succeed`() = runBlocking {
        backend = MockWebServer().apply { start() }
        gateway = MockWebServer().apply { start() }
        backend.enqueue(MockResponse().setResponseCode(200))
        gateway.enqueue(MockResponse().setResponseCode(200))

        assertTrue(service().isAvailable())
    }

    @Test
    fun `isAvailable is false when the backend-proxy is down even if the gateway is healthy`() = runBlocking {
        backend = MockWebServer().apply { start() }
        gateway = MockWebServer().apply { start() }
        backend.enqueue(MockResponse().setResponseCode(500))
        gateway.enqueue(MockResponse().setResponseCode(200))

        // This is the regression case: before the fix, isAvailable() only probed the gateway and
        // would have reported "available" here even though the backend-proxy (and therefore real
        // synthesis) is broken.
        assertFalse(service().isAvailable())
    }

    @Test
    fun `isAvailable is false when the gateway is down even if the backend-proxy is healthy`() = runBlocking {
        backend = MockWebServer().apply { start() }
        gateway = MockWebServer().apply { start() }
        backend.enqueue(MockResponse().setResponseCode(200))
        gateway.enqueue(MockResponse().setResponseCode(503))

        assertFalse(service().isAvailable())
    }

    // These three exercise handleErrorResponse() directly rather than through the full
    // synthesize()/authorize() flow: building the outgoing JSON request body elsewhere in this
    // class needs the real org.json implementation, which the plain-JVM unit test classpath
    // doesn't have (only a "not mocked" stub), so a full round-trip through MockWebServer isn't
    // reliable in this environment. handleErrorResponse() itself is pure and Android-agnostic.
    @Test
    fun `401 from the backend-proxy is reported as server misconfiguration, not a bad client key`() {
        backend = MockWebServer().apply { start() }
        gateway = MockWebServer().apply { start() }

        try {
            service().handleErrorResponse(401, """{"error":"unauthorized"}""")
            fail("expected TTSError.InvalidConfiguration")
        } catch (e: TTSError.InvalidConfiguration) {
            assertFalse("message should not claim the client sent a bad API key", e.reason.contains("Invalid API key"))
            assertTrue(e.reason.contains("misconfigured"))
        }
    }

    @Test
    fun `500 from the backend-proxy is reported as server misconfiguration`() {
        backend = MockWebServer().apply { start() }
        gateway = MockWebServer().apply { start() }

        try {
            service().handleErrorResponse(500, """{"error":"boom"}""")
            fail("expected TTSError.InvalidConfiguration")
        } catch (e: TTSError.InvalidConfiguration) {
            assertTrue(e.reason.contains("misconfigured"))
        }
    }

    @Test
    fun `404 from the backend-proxy gets a clear deployment-check message, not a generic error`() {
        backend = MockWebServer().apply { start() }
        gateway = MockWebServer().apply { start() }

        try {
            service().handleErrorResponse(404, "Not Found")
            fail("expected TTSError.ApiError")
        } catch (e: TTSError.ApiError) {
            assertEquals(404, e.code)
            assertTrue(
                "expected a hint to check deployment, got: ${e.errorMessage}",
                e.errorMessage.contains("deploy", ignoreCase = true) || e.errorMessage.contains("not found", ignoreCase = true)
            )
        }
    }
}
