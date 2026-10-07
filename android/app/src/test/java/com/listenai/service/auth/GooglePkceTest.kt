package com.listenai.service.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotEquals
import org.junit.Test

class GooglePkceTest {

    @Test
    fun `S256 challenge matches the RFC 7636 appendix B vector`() {
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            Pkce.challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        )
    }

    @Test
    fun `generated verifiers are 43 to 128 unreserved characters and differ every time`() {
        val a = Pkce.generateVerifier()
        val b = Pkce.generateVerifier()
        assertNotEquals(a, b)
        for (v in listOf(a, b)) {
            assertTrue(v.length in 43..128)
            assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(v))
        }
    }

    @Test
    fun `authorize url carries provider, encoded redirect and S256 challenge`() {
        val url = GoogleBrowserAuth.authorizeUrl("https://proj.supabase.co/", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        assertEquals(
            "https://proj.supabase.co/auth/v1/authorize?provider=google" +
                "&redirect_to=com.listenai.auth%3A%2F%2Fcallback" +
                "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256",
            url
        )
        assertEquals("com.listenai.auth://callback", GoogleBrowserAuth.REDIRECT_URL)
    }

    @Test
    fun `callback with a code parses, including percent-encoded values`() {
        assertEquals(OAuthCallback.Code("abc-123"), OAuthCallback.parse("com.listenai.auth://callback?code=abc-123"))
        assertEquals(OAuthCallback.Code("a b+c"), OAuthCallback.parse("com.listenai.auth://callback?code=a%20b%2Bc&state=x"))
    }

    @Test
    fun `callback error is reported and access_denied counts as denied`() {
        val e = OAuthCallback.parse("com.listenai.auth://callback?error=access_denied&error_code=x&error_description=User+denied+access") as OAuthCallback.Error
        assertTrue(e.denied)
        assertEquals("User denied access", e.description)
        val f = OAuthCallback.parse("com.listenai.auth://callback#error=server_error&error_description=boom") as OAuthCallback.Error
        assertFalse(f.denied)
        // error wins over a code
        assertTrue(OAuthCallback.parse("com.listenai.auth://callback?code=c&error=access_denied") is OAuthCallback.Error)
    }

    @Test
    fun `fragment tokens are recognised defensively and an empty callback is Missing`() {
        val t = OAuthCallback.parse("com.listenai.auth://callback#access_token=at&refresh_token=rt&expires_in=3600") as OAuthCallback.Tokens
        assertEquals("at", t.accessToken); assertEquals("rt", t.refreshToken); assertEquals(3600L, t.expiresIn)
        assertEquals(OAuthCallback.Missing, OAuthCallback.parse("com.listenai.auth://callback"))
        assertEquals(OAuthCallback.Missing, OAuthCallback.parse("com.listenai.auth://callback?code="))
        assertEquals(OAuthCallback.Missing, OAuthCallback.parse("not a uri %%"))
    }

    @Test
    fun `only our scheme and host are accepted as callbacks`() {
        assertTrue(GoogleBrowserAuth.isCallback("com.listenai.auth://callback?code=1"))
        assertFalse(GoogleBrowserAuth.isCallback("com.listenai.auth://other?code=1"))
        assertFalse(GoogleBrowserAuth.isCallback("https://evil.example/callback?code=1"))
        assertFalse(GoogleBrowserAuth.isCallback(null))
        assertFalse(GoogleAuthCallbacks.deliver("com.googleusercontent.apps.1-x:/oauth?code=1"))
    }
}
