package com.listenai.service.voice

import android.content.Context
import com.listenai.service.auth.GoogleAuthService
import com.listenai.service.auth.SignUpResult
import com.listenai.service.auth.SupabaseGoTrueClient
import com.listenai.service.auth.SupabaseSessionStore
import com.listenai.service.billing.RevenueCatManager
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

    /** Supabase email+password sign-in (the primary method). Failures carry user-facing text in `GoTrueException.message`. */
    suspend fun signInWithPassword(email: String, password: String): Result<Unit>

    /** Creates an account; on success either signs in or reports that email confirmation is required. */
    suspend fun signUp(email: String, password: String): Result<SignUpResult>

    /** Sends the password reset email. */
    suspend fun sendPasswordReset(email: String): Result<Unit>

    /** Ends the Supabase session and detaches the RevenueCat identity. No UI calls this yet. */
    suspend fun signOut()
}

/**
 * Keeps the RevenueCat app user id equal to the Supabase user UUID, so the backend's RevenueCat webhook
 * (POST /api/webhooks/revenuecat, which only accepts UUID app_user_ids) can attribute purchases to the account.
 */
interface BillingIdentity {
    fun logIn(userId: String)
    fun logOut()
}

/** No-op when RevenueCat is not configured (the standalone `voice` flavor never configures it). */
class RevenueCatBillingIdentity : BillingIdentity {
    override fun logIn(userId: String) {
        runCatching { RevenueCatManager.getInstance().setUserID(userId) }
    }

    override fun logOut() {
        runCatching { RevenueCatManager.getInstance().clearUserID() }
    }
}

/** Logs the id in at most once per id and never with anything that is not a UUID (webhook ignores those anyway). */
class BillingIdentitySync(private val identity: BillingIdentity) {
    private var lastUserId: String? = null

    @Synchronized
    fun onUser(userId: String?) {
        if (userId == null || !UUID_RE.matches(userId) || userId.equals(lastUserId, ignoreCase = true)) return
        lastUserId = userId
        identity.logIn(userId.lowercase())
    }

    @Synchronized
    fun onSignedOut() {
        lastUserId = null
        identity.logOut()
    }

    private companion object {
        val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    }
}

/**
 * Supabase session for cloning. Primary path: GoTrue email+password ([SupabaseGoTrueClient]); the legacy
 * Google Credential Manager -> backend `/api/auth/google` path is kept but no longer shown in the UI.
 * Either way the session lives in [SupabaseSessionStore] (AuthService: encrypted prefs, refreshed through
 * the backend's /api/auth/refresh).
 */
class SupabaseVoiceCloneAuth(
    // Lazy: AuthService opens EncryptedSharedPreferences (Keystore) on construction, which should
    // not happen on the app start path. Nothing is touched until cloning is actually used.
    googleAuth: Lazy<GoogleAuthService>,
    supabaseAuth: Lazy<SupabaseSessionStore>,
    billingIdentity: BillingIdentity = RevenueCatBillingIdentity(),
    private val goTrue: SupabaseGoTrueClient = SupabaseGoTrueClient()
) : VoiceCloneAuth {
    private val identitySync = BillingIdentitySync(billingIdentity)

    private val google by googleAuth
    private val supabase by supabaseAuth

    override val isSignedIn: StateFlow<Boolean> get() = supabase.isAuthenticated

    override suspend fun accessToken(): String? {
        val token = supabase.getAccessToken()
        // Covers a session restored from storage (no signIn call this process).
        if (token != null) identitySync.onUser(supabase.user.value?.id)
        return token
    }

    override suspend fun signIn(activityContext: Context): Result<Unit> {
        val googleResult = google.signIn(activityContext, withNonce = false)
        if (googleResult.isFailure) {
            return Result.failure(googleResult.exceptionOrNull() ?: IllegalStateException("Google sign-in failed"))
        }
        val idToken = google.getIdToken()
            ?: return Result.failure(IllegalStateException("Google sign-in returned no ID token"))
        return supabase.signInWithGoogle(idToken).onSuccess { identitySync.onUser(it.id) }.map { }
    }

    private suspend fun adopt(session: com.listenai.service.auth.GoTrueSession) {
        supabase.adoptSession(session)
        identitySync.onUser(session.userId)
    }

    override suspend fun signInWithPassword(email: String, password: String): Result<Unit> =
        goTrue.signInWithPassword(email, password).map { adopt(it) }

    override suspend fun signUp(email: String, password: String): Result<SignUpResult> =
        goTrue.signUp(email, password).onSuccess { if (it is SignUpResult.SignedIn) adopt(it.session) }

    override suspend fun sendPasswordReset(email: String): Result<Unit> = goTrue.recover(email)

    override suspend fun signOut() {
        supabase.signOut()
        identitySync.onSignedOut()
    }
}
