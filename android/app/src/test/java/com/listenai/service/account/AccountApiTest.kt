package com.listenai.service.account

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** [AccountApi] against a fake server serving the shapes of backend/src/routes/account.ts. Nothing touches production. */
class AccountApiTest {

    private lateinit var server: MockWebServer
    private var token: String? = "tok-123"

    private fun api() = AccountApi(
        baseUrl = server.url("/").toString().trimEnd('/'),
        http = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build(),
        accessToken = { token }
    )

    @Before
    fun setUp() { server = MockWebServer().apply { start() } }

    @After
    fun tearDown() = server.shutdown()

    private fun failureOf(block: suspend () -> Any?): AccountDeletionException {
        try {
            runBlocking { block() }
        } catch (e: AccountDeletionException) {
            return e
        }
        fail("expected AccountDeletionException")
        throw AssertionError()
    }

    @Test
    fun `delete is an authenticated DELETE to api account without an acknowledgement by default`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"deleted":true,"subscriptions":{"stripe":false,"play":false},"voices_deleted":2}"""))
        val result = api().deleteAccount(acknowledgeActiveSubscription = false)
        assertEquals(DeleteAccountResult.Deleted(SubscriptionFlags(stripe = false, play = false)), result)
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/account", req.path)
        assertEquals("Bearer tok-123", req.getHeader("Authorization"))
        assertFalse(JSONObject(req.body.readUtf8()).has("acknowledge_active_subscription"))
    }

    @Test
    fun `the acknowledgement is sent as a JSON boolean true`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"deleted":true,"subscriptions":{"stripe":true,"play":true}}"""))
        val result = api().deleteAccount(acknowledgeActiveSubscription = true)
        assertEquals(DeleteAccountResult.Deleted(SubscriptionFlags(stripe = true, play = true)), result)
        assertTrue(JSONObject(server.takeRequest().body.readUtf8()).getBoolean("acknowledge_active_subscription"))
    }

    @Test
    fun `409 active_subscription is a result not an error and carries the flags`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"x","code":"active_subscription","subscriptions":{"stripe":true,"play":false}}"""))
        assertEquals(DeleteAccountResult.ActiveSubscription(SubscriptionFlags(stripe = true, play = false)), api().deleteAccount(false))
    }

    @Test
    fun `a 409 with another code is an error`() {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"something_else"}"""))
        assertEquals(AccountDeletionFailure.UNKNOWN, failureOf { api().deleteAccount(false) }.failure)
    }

    @Test
    fun `401 means sign in required`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Sign in required.","code":"unauthenticated"}"""))
        val e = failureOf { api().deleteAccount(false) }
        assertEquals(AccountDeletionFailure.SIGN_IN_REQUIRED, e.failure)
        assertEquals(401, e.httpStatus)
    }

    @Test
    fun `no token never reaches the network`() {
        token = null
        assertEquals(AccountDeletionFailure.SIGN_IN_REQUIRED, failureOf { api().deleteAccount(false) }.failure)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `5xx is a retryable server failure`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"code":"voice_service_unavailable"}"""))
        assertEquals(AccountDeletionFailure.SERVER, failureOf { api().deleteAccount(false) }.failure)
        server.enqueue(MockResponse().setResponseCode(500).setBody("not json"))
        assertEquals(AccountDeletionFailure.SERVER, failureOf { api().deleteAccount(false) }.failure)
    }

    @Test
    fun `a dropped connection is a network failure`() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertEquals(AccountDeletionFailure.NETWORK, failureOf { api().deleteAccount(false) }.failure)
    }

    @Test
    fun `a 200 without deleted=true is not trusted as success`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        assertEquals(AccountDeletionFailure.UNKNOWN, failureOf { api().deleteAccount(false) }.failure)
        server.enqueue(MockResponse().setResponseCode(200).setBody(""))
        assertEquals(AccountDeletionFailure.UNKNOWN, failureOf { api().deleteAccount(false) }.failure)
    }

    @Test
    fun `missing subscriptions object reads as none active`() {
        val r = AccountApi.parseResponse(200, """{"deleted":true}""") as DeleteAccountResult.Deleted
        assertFalse(r.subscriptions.any)
    }
}
