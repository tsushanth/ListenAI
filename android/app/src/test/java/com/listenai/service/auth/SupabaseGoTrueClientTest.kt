package com.listenai.service.auth

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket

/** GoTrue client against a fake server. Nothing here touches the real Supabase project. */
class SupabaseGoTrueClientTest {

    private lateinit var server: MockWebServer
    private val uid = "11111111-2222-3333-4444-555555555555"

    private fun client() = SupabaseGoTrueClient(
        baseUrl = server.url("/").toString().trimEnd('/'),
        anonKey = "anon-test-key",
        http = OkHttpClient(),
        nowSeconds = { 1_000L }
    )

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() = server.shutdown()

    private fun sessionBody(confirmed: String? = "2026-10-01T00:00:00Z") = """
        {"access_token":"acc","token_type":"bearer","expires_in":3600,"expires_at":9999999,"refresh_token":"ref",
         "user":{"id":"$uid","email":"a@b.co","email_confirmed_at":${if (confirmed == null) "null" else "\"$confirmed\""},"created_at":"2026-10-01T00:00:00Z"}}
    """.trimIndent()

    private fun failure(r: Result<*>): GoTrueException = r.exceptionOrNull() as GoTrueException

    @Test
    fun `password grant posts to token endpoint with apikey and maps the session`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(sessionBody()))
        val s = client().signInWithPassword("  a@b.co ", "pw123456").getOrThrow()

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/auth/v1/token?grant_type=password", req.path)
        assertEquals("anon-test-key", req.getHeader("apikey"))
        val sent = JSONObject(req.body.readUtf8())
        assertEquals("a@b.co", sent.getString("email"))
        assertEquals("pw123456", sent.getString("password"))
        assertEquals("acc", s.accessToken)
        assertEquals("ref", s.refreshToken)
        assertEquals(1_000L + 3600, s.expiresAt)
        assertEquals(uid, s.userId)
        assertEquals("a@b.co", s.email)
        assertEquals("2026-10-01T00:00:00Z", s.emailConfirmedAt)
    }

    @Test
    fun `null email_confirmed_at is surfaced as null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(sessionBody(confirmed = null)))
        assertNull(client().signInWithPassword("a@b.co", "x").getOrThrow().emailConfirmedAt)
    }

    @Test
    fun `invalid credentials`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}"""))
        val e = failure(client().signInWithPassword("a@b.co", "bad"))
        assertEquals(GoTrueErrorKind.INVALID_CREDENTIALS, e.kind)
        assertEquals(SupabaseGoTrueClient.MSG_INVALID_CREDENTIALS, e.message)
    }

    @Test
    fun `legacy invalid login body without error_code still maps`() {
        val e = SupabaseGoTrueClient.mapError(400, """{"error":"invalid_grant","error_description":"Invalid login credentials"}""")
        assertEquals(GoTrueErrorKind.INVALID_CREDENTIALS, e.kind)
    }

    @Test
    fun `email not confirmed tells the user to check their email`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"code":400,"error_code":"email_not_confirmed","msg":"Email not confirmed"}"""))
        val e = failure(client().signInWithPassword("a@b.co", "pw"))
        assertEquals(GoTrueErrorKind.EMAIL_NOT_CONFIRMED, e.kind)
        assertTrue(e.message!!.contains("Check your email"))
    }

    @Test
    fun `signup with confirmation required returns the bare user`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":"$uid","email":"new@b.co","identities":[{"id":"x"}],"confirmation_sent_at":"2026-10-07T00:00:00Z"}"""))
        val r = client().signUp("new@b.co", "longenough1").getOrThrow()

        val req = server.takeRequest()
        assertEquals("/auth/v1/signup", req.path)
        assertEquals("anon-test-key", req.getHeader("apikey"))
        assertEquals("new@b.co", JSONObject(req.body.readUtf8()).getString("email"))
        assertEquals(SignUpResult.ConfirmationRequired("new@b.co"), r)
    }

    @Test
    fun `signup with auto confirm returns a session`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(sessionBody()))
        val r = client().signUp("a@b.co", "longenough1").getOrThrow()
        assertTrue(r is SignUpResult.SignedIn)
        assertEquals("acc", (r as SignUpResult.SignedIn).session.accessToken)
    }

    @Test
    fun `signup for an existing confirmed address (empty identities) is user_already_exists`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":"$uid","email":"a@b.co","identities":[]}"""))
        assertEquals(GoTrueErrorKind.USER_ALREADY_EXISTS, failure(client().signUp("a@b.co", "longenough1")).kind)
    }

    @Test
    fun `signup user_already_exists error code`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(422).setBody("""{"code":422,"error_code":"user_already_exists","msg":"User already registered"}"""))
        assertEquals(GoTrueErrorKind.USER_ALREADY_EXISTS, failure(client().signUp("a@b.co", "longenough1")).kind)
    }

    @Test
    fun `weak password shows the servers reason`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(422).setBody(
                """{"code":422,"error_code":"weak_password","msg":"Password should be at least 8 characters.","weak_password":{"reasons":["length"]}}"""
            )
        )
        val e = failure(client().signUp("a@b.co", "short"))
        assertEquals(GoTrueErrorKind.WEAK_PASSWORD, e.kind)
        assertEquals("Password should be at least 8 characters.", e.message)
    }

    @Test
    fun `weak password falls back to the reasons array`() {
        val e = SupabaseGoTrueClient.mapError(422, """{"error_code":"weak_password","weak_password":{"reasons":["pwned"]}}""")
        assertEquals("pwned", e.message)
    }

    @Test
    fun `rate limits`() {
        assertEquals(GoTrueErrorKind.RATE_LIMITED, SupabaseGoTrueClient.mapError(429, """{"code":429,"error_code":"over_request_rate_limit","msg":"Request rate limit reached"}""").kind)
        assertEquals(GoTrueErrorKind.RATE_LIMITED, SupabaseGoTrueClient.mapError(429, """{"error_code":"over_email_send_rate_limit","msg":"x"}""").kind)
        assertEquals(GoTrueErrorKind.RATE_LIMITED, SupabaseGoTrueClient.mapError(429, "").kind)
    }

    @Test
    fun `unknown and unparseable errors become a generic server message`() {
        assertEquals(GoTrueErrorKind.SERVER, SupabaseGoTrueClient.mapError(500, "<html>boom</html>").kind)
        val e = SupabaseGoTrueClient.mapError(503, """{"msg":"internal detail that must not leak"}""")
        assertEquals(GoTrueErrorKind.SERVER, e.kind)
        assertEquals(SupabaseGoTrueClient.SERVER_MESSAGE, e.message)
    }

    @Test
    fun `recover posts the email and succeeds on empty 200`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client().recover(" a@b.co ").getOrThrow()
        val req = server.takeRequest()
        assertEquals("/auth/v1/recover", req.path)
        assertEquals("anon-test-key", req.getHeader("apikey"))
        assertEquals("a@b.co", JSONObject(req.body.readUtf8()).getString("email"))
    }

    @Test
    fun `recover rate limit`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"code":429,"error_code":"over_email_send_rate_limit","msg":"email rate limit exceeded"}"""))
        assertEquals(GoTrueErrorKind.RATE_LIMITED, failure(client().recover("a@b.co")).kind)
    }

    @Test
    fun `success with a malformed body is a server error not a crash`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"nope":true}"""))
        assertEquals(GoTrueErrorKind.SERVER, failure(client().signInWithPassword("a@b.co", "pw")).kind)
    }

    @Test
    fun `network failure is mapped`() = runBlocking {
        val port = ServerSocket(0).use { it.localPort } // closed again: connection refused
        val c = SupabaseGoTrueClient(baseUrl = "http://127.0.0.1:$port", anonKey = "k", http = OkHttpClient())
        val e = failure(c.signInWithPassword("a@b.co", "pw"))
        assertEquals(GoTrueErrorKind.NETWORK, e.kind)
        assertEquals(SupabaseGoTrueClient.MSG_NETWORK, e.message)
    }
}
