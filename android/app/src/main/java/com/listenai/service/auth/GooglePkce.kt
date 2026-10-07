package com.listenai.service.auth

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** RFC 7636 helpers for the Supabase browser OAuth (PKCE) sign-in. */
object Pkce {
    /** Random 32 bytes, base64url without padding: 43 characters (RFC 7636 allows 43 to 128). */
    fun generateVerifier(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /** S256: BASE64URL-ENCODE(SHA256(ASCII(verifier))) without padding. */
    fun challengeFor(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }
}

object GoogleBrowserAuth {
    /**
     * Where Supabase sends the browser after Google sign-in. Must be listed in Supabase >
     * Authentication > URL Configuration > Redirect URLs, and matches the intent-filter in AndroidManifest.xml.
     */
    const val REDIRECT_URL = "com.listenai.auth://callback"
    const val REDIRECT_SCHEME = "com.listenai.auth"
    const val REDIRECT_HOST = "callback"

    const val TIMEOUT_MS = 3 * 60 * 1000L

    const val MSG_CANCELLED = "Google sign-in was cancelled."
    const val MSG_TIMEOUT = "Google sign-in timed out. Try again."
    const val MSG_FAILED = "Google sign-in didn't complete. Try again."

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    fun authorizeUrl(supabaseUrl: String, challenge: String, redirect: String = REDIRECT_URL): String =
        supabaseUrl.trimEnd('/') + "/auth/v1/authorize?provider=google" +
            "&redirect_to=" + enc(redirect) +
            "&code_challenge=" + enc(challenge) +
            "&code_challenge_method=S256"

    /** True for a URL that belongs to our redirect (scheme + host), so unrelated deep links are never delivered. */
    fun isCallback(url: String?): Boolean {
        if (url == null) return false
        val uri = try { URI(url) } catch (_: Exception) { return false }
        return uri.scheme.equals(REDIRECT_SCHEME, true) && uri.host.equals(REDIRECT_HOST, true)
    }
}

sealed class OAuthCallback {
    data class Code(val code: String) : OAuthCallback()

    /** The provider/Supabase reported an error (error=access_denied when the user backs out of Google). */
    data class Error(val error: String, val description: String?) : OAuthCallback() {
        val denied: Boolean get() = error == "access_denied"
    }

    /** Implicit-flow style `#access_token=...`; handled defensively, only if a code is not present. */
    data class Tokens(val accessToken: String, val refreshToken: String, val expiresIn: Long?) : OAuthCallback()

    object Missing : OAuthCallback()

    companion object {
        fun parse(url: String): OAuthCallback {
            val uri = try { URI(url) } catch (_: Exception) { return Missing }
            val query = params(uri.rawQuery)
            val fragment = params(uri.rawFragment)
            val error = query["error"] ?: fragment["error"]
            if (!error.isNullOrBlank()) {
                return Error(error, query["error_description"] ?: fragment["error_description"])
            }
            val code = query["code"]
            if (!code.isNullOrBlank()) return Code(code)
            val access = fragment["access_token"]
            val refresh = fragment["refresh_token"]
            if (!access.isNullOrBlank() && !refresh.isNullOrBlank()) {
                return Tokens(access, refresh, fragment["expires_in"]?.toLongOrNull())
            }
            return Missing
        }

        private fun params(raw: String?): Map<String, String> {
            if (raw.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (pair in raw.split('&')) {
                if (pair.isEmpty()) continue
                val i = pair.indexOf('=')
                val k = if (i < 0) pair else pair.substring(0, i)
                val v = if (i < 0) "" else pair.substring(i + 1)
                try {
                    out.putIfAbsent(URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8"))
                } catch (_: IllegalArgumentException) {
                }
            }
            return out
        }
    }
}

enum class GoogleSignInErrorKind { CANCELLED, TIMEOUT, FAILED }

/** [message] is user-facing text. Network failures from the token exchange surface as [GoTrueException] instead. */
class GoogleSignInException(val kind: GoogleSignInErrorKind, message: String) : Exception(message)

/**
 * Process-wide channel between MainActivity (receives the deep link) and the sign-in waiting for it.
 * replay=1 so a callback delivered a moment before the waiter subscribes is not lost; the replay cache
 * is cleared when a new flow starts, and a stale callback is harmless anyway because it can only be
 * exchanged against a pending verifier, which is consumed at most once.
 */
object GoogleAuthCallbacks {
    private val flow = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val callbacks: SharedFlow<String> get() = flow

    /** Returns whether [url] was one of ours and was delivered. */
    fun deliver(url: String): Boolean {
        if (!GoogleBrowserAuth.isCallback(url)) return false
        return flow.tryEmit(url)
    }

    fun reset() = flow.resetReplayCache()
}
