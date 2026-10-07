package com.listenai.service.voice

import com.listenai.service.auth.AuthUser
import com.listenai.service.auth.GoTrueSession
import com.listenai.service.auth.GoogleAuthService
import com.listenai.service.auth.SignUpResult
import com.listenai.service.auth.SupabaseGoTrueClient
import com.listenai.service.auth.SupabaseSessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import com.listenai.service.auth.GoTrueErrorKind
import com.listenai.service.auth.GoTrueException
import com.listenai.service.auth.GoogleSignInErrorKind
import com.listenai.service.auth.GoogleSignInException
import com.listenai.service.auth.Pkce
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** SupabaseVoiceCloneAuth with a fake session store, a fake RevenueCat identity and a fake GoTrue server. */
class SupabaseVoiceCloneAuthTest {

    private class FakeStore : SupabaseSessionStore {
        val authed = MutableStateFlow(false)
        val userFlow = MutableStateFlow<AuthUser?>(null)
        var token: String? = null
        var signOuts = 0
        var verifier: String? = null
        override fun savePkceVerifier(verifier: String) { this.verifier = verifier }
        override fun takePkceVerifier(): String? = verifier.also { verifier = null }
        override val isAuthenticated: StateFlow<Boolean> get() = authed
        override val user: StateFlow<AuthUser?> get() = userFlow
        override suspend fun getAccessToken() = token
        override suspend fun adoptSession(session: GoTrueSession): AuthUser {
            token = session.accessToken
            val u = AuthUser(session.userId, session.email, null, null, session.createdAt)
            userFlow.value = u; authed.value = true
            return u
        }
        override suspend fun signInWithGoogle(idToken: String, accessToken: String?) = Result.failure<AuthUser>(UnsupportedOperationException())
        override suspend fun signOut() { signOuts++; token = null; userFlow.value = null; authed.value = false }
    }

    private class FakeIdentity : BillingIdentity {
        val calls = mutableListOf<String>()
        override fun logIn(userId: String) { calls += "in:$userId" }
        override fun logOut() { calls += "out" }
    }

    private lateinit var server: MockWebServer
    private val store = FakeStore()
    private val identity = FakeIdentity()
    private val uid = "11111111-2222-3333-4444-555555555555"

    private fun auth() = SupabaseVoiceCloneAuth(
        googleAuth = lazy<GoogleAuthService> { error("Google must not be touched by email sign-in") },
        supabaseAuth = lazy { store },
        billingIdentity = identity,
        goTrue = SupabaseGoTrueClient(server.url("/").toString().trimEnd('/'), "anon", OkHttpClient())
    )

    private val callbacks = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 1)
    private val opened = mutableListOf<String>()

    private fun browserAuth(timeoutMs: Long = 5_000, open: (String) -> Unit = {}) = SupabaseVoiceCloneAuth(
        googleAuth = lazy<GoogleAuthService> { error("Credential Manager must not be used") },
        supabaseAuth = lazy { store },
        billingIdentity = identity,
        goTrue = SupabaseGoTrueClient(server.url("/").toString().trimEnd('/'), "anon", OkHttpClient()),
        supabaseUrl = "https://proj.supabase.co",
        callbacks = callbacks,
        resetCallbacks = { callbacks.resetReplayCache() },
        browserTimeoutMs = timeoutMs,
        openBrowser = { _, url -> opened += url; open(url) }
    )

    private fun challengeOf(url: String) = Regex("code_challenge=([^&]+)").find(url)!!.groupValues[1]

    private fun session(email: String = "a@b.co") =
        """{"access_token":"acc","expires_in":3600,"refresh_token":"ref","user":{"id":"$uid","email":"$email","email_confirmed_at":"2026-10-01T00:00:00Z"}}"""

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() = server.shutdown()

    @Test
    fun `password sign-in stores the session, serves the access token and logs RevenueCat in with the user id`() = runBlocking {
        server.enqueue(MockResponse().setBody(session()))
        val a = auth()
        a.signInWithPassword("a@b.co", "pw").getOrThrow()

        assertTrue(a.isSignedIn.value)
        assertEquals("acc", a.accessToken())
        assertEquals(listOf("in:$uid"), identity.calls) // accessToken() afterwards does not log in twice
    }

    @Test
    fun `failed password sign-in leaves everything untouched`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error_code":"invalid_credentials","msg":"Invalid login credentials"}"""))
        val a = auth()
        assertTrue(a.signInWithPassword("a@b.co", "bad").isFailure)
        assertFalse(a.isSignedIn.value)
        assertNull(a.accessToken())
        assertEquals(emptyList<String>(), identity.calls)
    }

    @Test
    fun `signup with an immediate session signs in and logs RevenueCat in`() = runBlocking {
        server.enqueue(MockResponse().setBody(session()))
        val r = auth().signUp("a@b.co", "longenough1").getOrThrow()
        assertTrue(r is SignUpResult.SignedIn)
        assertEquals(listOf("in:$uid"), identity.calls)
        assertTrue(store.authed.value)
    }

    @Test
    fun `signup needing confirmation does not sign in or touch RevenueCat`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"id":"$uid","email":"a@b.co","identities":[{"id":"x"}]}"""))
        val r = auth().signUp("a@b.co", "longenough1").getOrThrow()
        assertTrue(r is SignUpResult.ConfirmationRequired)
        assertFalse(store.authed.value)
        assertEquals(emptyList<String>(), identity.calls)
    }

    @Test
    fun `password reset sends recover and does not sign in`() = runBlocking {
        server.enqueue(MockResponse().setBody("{}"))
        auth().sendPasswordReset("a@b.co").getOrThrow()
        assertEquals("/auth/v1/recover", server.takeRequest().path)
        assertEquals(emptyList<String>(), identity.calls)
    }

    @Test
    fun `a session restored from storage logs RevenueCat in when the token is requested`() = runBlocking {
        store.token = "stored"; store.authed.value = true
        store.userFlow.value = AuthUser(uid, "a@b.co", null, null, null)
        assertEquals("stored", auth().accessToken())
        assertEquals(listOf("in:$uid"), identity.calls)
    }

    @Test
    fun `sign out clears the session and logs RevenueCat out`() = runBlocking {
        server.enqueue(MockResponse().setBody(session()))
        val a = auth()
        a.signInWithPassword("a@b.co", "pw").getOrThrow()
        a.signOut()
        assertEquals(1, store.signOuts)
        assertFalse(a.isSignedIn.value)
        assertNull(a.accessToken())
        assertEquals(listOf("in:$uid", "out"), identity.calls)
    }

    // ---- browser (PKCE) Google sign-in ----------------------------------------------------

    @Test
    fun `browser sign-in opens the authorize url, exchanges the code with the stored verifier and adopts the session`() = runBlocking {
        server.enqueue(MockResponse().setBody(session("g@b.co")))
        var verifierWhileOpen: String? = null
        val a = browserAuth(open = { verifierWhileOpen = store.verifier; callbacks.tryEmit("com.listenai.auth://callback?code=abc123") })
        a.signInWithGoogleBrowser(FakeContext.get()).getOrThrow()

        // Authorize URL: provider, encoded redirect, S256 challenge of the persisted verifier.
        val url = opened.single()
        assertTrue(url.startsWith("https://proj.supabase.co/auth/v1/authorize?provider=google&redirect_to=com.listenai.auth%3A%2F%2Fcallback&code_challenge="))
        assertTrue(url.endsWith("&code_challenge_method=S256"))
        assertNotNull(verifierWhileOpen)
        assertEquals(Pkce.challengeFor(verifierWhileOpen!!), challengeOf(url))

        // Exchange request shape.
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/auth/v1/token?grant_type=pkce", req.path)
        assertEquals("anon", req.getHeader("apikey"))
        val body = JSONObject(req.body.readUtf8())
        assertEquals("abc123", body.getString("auth_code"))
        assertEquals(verifierWhileOpen, body.getString("code_verifier"))

        // Same adoption path as password sign-in, verifier deleted, RevenueCat identity set.
        assertTrue(a.isSignedIn.value)
        assertEquals("acc", store.token)
        assertEquals(listOf("in:$uid"), identity.calls)
        assertNull(store.verifier)
    }

    @Test
    fun `access_denied maps to cancelled, makes no exchange and clears the verifier`() = runBlocking {
        val a = browserAuth(open = { callbacks.tryEmit("com.listenai.auth://callback?error=access_denied&error_description=User+denied") })
        val e = a.signInWithGoogleBrowser(FakeContext.get()).exceptionOrNull() as GoogleSignInException
        assertEquals(GoogleSignInErrorKind.CANCELLED, e.kind)
        assertEquals(0, server.requestCount)
        assertNull(store.verifier)
        assertFalse(a.isSignedIn.value)
    }

    @Test
    fun `other provider errors and a callback without a code map to the generic failure`() = runBlocking {
        for (cb in listOf("com.listenai.auth://callback?error=server_error", "com.listenai.auth://callback")) {
            val a = browserAuth(open = { callbacks.tryEmit(cb) })
            val e = a.signInWithGoogleBrowser(FakeContext.get()).exceptionOrNull() as GoogleSignInException
            assertEquals(GoogleSignInErrorKind.FAILED, e.kind)
            assertEquals("Google sign-in didn't complete. Try again.", e.message)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `no callback within the timeout fails with timeout and clears the verifier`() = runBlocking {
        val a = browserAuth(timeoutMs = 50)
        val e = a.signInWithGoogleBrowser(FakeContext.get()).exceptionOrNull() as GoogleSignInException
        assertEquals(GoogleSignInErrorKind.TIMEOUT, e.kind)
        assertNull(store.verifier)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `exchange rejected by Supabase maps to the generic failure, a network error stays a network error`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error_code":"flow_state_not_found","msg":"x"}"""))
        val a = browserAuth(open = { callbacks.tryEmit("com.listenai.auth://callback?code=c1") })
        val e = a.signInWithGoogleBrowser(FakeContext.get()).exceptionOrNull() as GoogleSignInException
        assertEquals(GoogleSignInErrorKind.FAILED, e.kind)
        assertNull(store.verifier)
        assertFalse(a.isSignedIn.value)

        server.shutdown() // connection refused
        val b = browserAuth(open = { callbacks.tryEmit("com.listenai.auth://callback?code=c2") })
        val n = b.signInWithGoogleBrowser(FakeContext.get()).exceptionOrNull() as GoTrueException
        assertEquals(GoTrueErrorKind.NETWORK, n.kind)
        server = MockWebServer().apply { start() } // so tearDown has something to stop
    }

    @Test
    fun `cancelling the waiting coroutine drops the pending verifier`() = runBlocking {
        val a = browserAuth(timeoutMs = 60_000)
        val job = launch(Dispatchers.Default) { a.signInWithGoogleBrowser(FakeContext.get()) }
        withTimeout(5_000) { while (opened.isEmpty()) delay(10) }
        assertNotNull(store.verifier)
        job.cancelAndJoin()
        assertNull(store.verifier)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `a replayed callback is exchanged at most once`() = runBlocking {
        server.enqueue(MockResponse().setBody(session()))
        val a = browserAuth(open = { callbacks.tryEmit("com.listenai.auth://callback?code=once") })
        a.signInWithGoogleBrowser(FakeContext.get()).getOrThrow()
        assertEquals(1, server.requestCount)
        // Same deep link again with no flow pending: a new waiter must not complete from the stale replay,
        // and even if it did the verifier is gone. Starting a flow resets the replay cache.
        val b = browserAuth(timeoutMs = 50)
        val e = b.signInWithGoogleBrowser(FakeContext.get()).exceptionOrNull() as GoogleSignInException
        assertEquals(GoogleSignInErrorKind.TIMEOUT, e.kind)
        assertEquals(1, server.requestCount)
    }
}

/** The browser launcher is faked, so the Context is never used; an uninitialised ContextWrapper avoids needing Mockito/Robolectric. */
private object FakeContext {
    fun get(): android.content.Context {
        val unsafeClass = Class.forName("sun.misc.Unsafe")
        val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        return unsafeClass.getMethod("allocateInstance", Class::class.java)
            .invoke(unsafe, android.content.ContextWrapper::class.java) as android.content.Context
    }
}
