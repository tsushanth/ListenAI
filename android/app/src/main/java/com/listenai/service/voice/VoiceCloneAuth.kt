package com.listenai.service.voice

import android.content.Context
import com.listenai.service.auth.AuthService
import com.listenai.service.auth.GoogleAuthService
import kotlinx.coroutines.flow.StateFlow

/**
 * Source of the Supabase access token the voice cloning API requires.
 *
 * The app had no user-facing sign-in that produced a Supabase session (GoogleAuthService only
 * keeps a Google ID token; the Supabase-exchanging AuthService was never wired in). This
 * abstraction hides that: the cloning client only ever asks for [accessToken]; [signIn] is
 * offered by the UI when no session exists.
 */
interface VoiceCloneAuth {
    val isSignedIn: StateFlow<Boolean>

    /** A non-expired Supabase access token, or null when signed out. */
    suspend fun accessToken(): String?

    /** Interactive sign-in. [activityContext] must be an Activity (Credential Manager UI). */
    suspend fun signIn(activityContext: Context): Result<Unit>
}

/**
 * Google Credential Manager -> backend `/api/auth/google` -> Supabase session
 * ([AuthService] stores and refreshes the session in encrypted prefs).
 */
class SupabaseVoiceCloneAuth(
    // Lazy: AuthService opens EncryptedSharedPreferences (Keystore) on construction, which should
    // not happen on the app start path. Nothing is touched until cloning is actually used.
    googleAuth: Lazy<GoogleAuthService>,
    supabaseAuth: Lazy<AuthService>
) : VoiceCloneAuth {

    private val google by googleAuth
    private val supabase by supabaseAuth

    override val isSignedIn: StateFlow<Boolean> get() = supabase.isAuthenticated

    override suspend fun accessToken(): String? = supabase.getAccessToken()

    override suspend fun signIn(activityContext: Context): Result<Unit> {
        val googleResult = google.signIn(activityContext, withNonce = false)
        if (googleResult.isFailure) {
            return Result.failure(googleResult.exceptionOrNull() ?: IllegalStateException("Google sign-in failed"))
        }
        val idToken = google.getIdToken()
            ?: return Result.failure(IllegalStateException("Google sign-in returned no ID token"))
        return supabase.signInWithGoogle(idToken).map { }
    }
}
