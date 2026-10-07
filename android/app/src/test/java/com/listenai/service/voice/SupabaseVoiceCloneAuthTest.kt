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
import org.junit.Before
import org.junit.Test

/** SupabaseVoiceCloneAuth with a fake session store, a fake RevenueCat identity and a fake GoTrue server. */
class SupabaseVoiceCloneAuthTest {

    private class FakeStore : SupabaseSessionStore {
        val authed = MutableStateFlow(false)
        val userFlow = MutableStateFlow<AuthUser?>(null)
        var token: String? = null
        var signOuts = 0
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
}
