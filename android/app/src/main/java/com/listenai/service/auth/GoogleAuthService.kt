package com.listenai.service.auth

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInAccount
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import com.listenai.data.models.Plan
import com.listenai.data.models.SubscriptionStatus
import com.listenai.data.models.UserProfile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.ServerSocket
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/**
 * Service for handling Google OAuth authentication.
 * Uses Credential Manager API for modern sign-in experience.
 */
class GoogleAuthService(private val context: Context) {

    companion object {
        private const val TAG = "GoogleAuthService"

        // OAuth configuration - Web Client ID for Android Credential Manager
        // Using the Web Client ID for Supabase Auth integration
        private const val WEB_CLIENT_ID = "517355381306-tdssnaf01h8nd69vd6rlu9l6chijmod6.apps.googleusercontent.com"

        // Android OAuth Client ID for GoogleSignIn API (requires SHA-1 registration)
        private const val ANDROID_CLIENT_ID = "517355381306-b9dkf392rcmna9vrspkc5fdavhgcb1l7.apps.googleusercontent.com"

        // iOS OAuth Client ID for Gmail OAuth flow (iOS clients support custom scheme URIs)
        private const val IOS_CLIENT_ID = "517355381306-iiuf6umqhie29ii0rnrd0shtb4e1ou5i.apps.googleusercontent.com"

        // Gmail scope for reading emails
        private const val GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify"

        // OAuth redirect URI for PKCE flow (using iOS client ID custom scheme)
        private const val OAUTH_REDIRECT_URI = "com.googleusercontent.apps.517355381306-iiuf6umqhie29ii0rnrd0shtb4e1ou5i:/oauth2redirect"

        // OAuth endpoints
        private const val OAUTH_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
        private const val OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

        // Preferences keys
        private const val PREFS_NAME = "listenai_auth_prefs"
        private const val KEY_CODE_VERIFIER = "pkce_code_verifier"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_EMAIL = "email"
        private const val KEY_DISPLAY_NAME = "display_name"
        private const val KEY_AVATAR_URL = "avatar_url"
        private const val KEY_ID_TOKEN = "id_token"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "gmail_refresh_token"
        private const val KEY_IS_AUTHENTICATED = "is_authenticated"

        // Request code for Gmail sign-in
        const val RC_GMAIL_SIGN_IN = 9002
    }

    // State
    private val _isAuthenticated = MutableStateFlow(false)
    val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()

    private val _userProfile = MutableStateFlow<UserProfile?>(null)
    val userProfile: StateFlow<UserProfile?> = _userProfile.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<GoogleAuthError?>(null)
    val error: StateFlow<GoogleAuthError?> = _error.asStateFlow()

    // Gmail connection state - observed by MailImportScreen
    private val _gmailConnected = MutableStateFlow(false)
    val gmailConnected: StateFlow<Boolean> = _gmailConnected.asStateFlow()

    // Credential manager
    private val credentialManager = CredentialManager.create(context)

    // Google Sign-In client for Gmail access
    private val googleSignInClient: GoogleSignInClient by lazy {
        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestIdToken(WEB_CLIENT_ID)  // Use Web client ID for server-side access
            .requestScopes(Scope(GMAIL_SCOPE))
            .build()
        GoogleSignIn.getClient(context, gso)
    }

    // Callback for Gmail sign-in result
    private var gmailSignInCallback: ((Result<String>) -> Unit)? = null

    // Encrypted preferences for secure storage
    private val encryptedPrefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    // HTTP client for backend communication
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private var baseUrl: String = "https://listenai-backend.fly.dev"

    init {
        loadStoredCredentials()
    }

    /**
     * Configure the backend URL
     */
    fun configure(baseUrl: String) {
        this.baseUrl = baseUrl
    }

    /**
     * Sign in with Google using Credential Manager
     */
    suspend fun signIn(activityContext: Context): Result<UserProfile> {
        _isLoading.value = true
        _error.value = null

        return try {
            // Generate nonce for security
            val nonce = generateNonce()

            // Build Google ID option
            val googleIdOption = GetGoogleIdOption.Builder()
                .setFilterByAuthorizedAccounts(false)
                .setServerClientId(WEB_CLIENT_ID)
                .setAutoSelectEnabled(true)
                .setNonce(nonce)
                .build()

            // Build credential request
            val request = GetCredentialRequest.Builder()
                .addCredentialOption(googleIdOption)
                .build()

            // Get credentials
            val result = credentialManager.getCredential(
                request = request,
                context = activityContext
            )

            handleSignInResult(result)
        } catch (e: GetCredentialCancellationException) {
            Log.d(TAG, "Sign-in cancelled by user")
            _error.value = GoogleAuthError.UserCancelled
            Result.failure(e)
        } catch (e: NoCredentialException) {
            Log.e(TAG, "No credentials available", e)
            _error.value = GoogleAuthError.NoCredentials
            Result.failure(e)
        } catch (e: GetCredentialException) {
            Log.e(TAG, "Sign-in failed", e)
            _error.value = GoogleAuthError.AuthenticationFailed(e.message ?: "Unknown error")
            Result.failure(e)
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error during sign-in", e)
            _error.value = GoogleAuthError.AuthenticationFailed(e.message ?: "Unknown error")
            Result.failure(e)
        } finally {
            _isLoading.value = false
        }
    }

    private suspend fun handleSignInResult(result: GetCredentialResponse): Result<UserProfile> {
        val credential = result.credential

        return when (credential) {
            is CustomCredential -> {
                if (credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    try {
                        val googleIdTokenCredential = GoogleIdTokenCredential.createFrom(credential.data)
                        processGoogleCredential(googleIdTokenCredential)
                    } catch (e: GoogleIdTokenParsingException) {
                        Log.e(TAG, "Failed to parse Google ID token", e)
                        _error.value = GoogleAuthError.TokenParsingFailed
                        Result.failure(e)
                    }
                } else {
                    Log.e(TAG, "Unexpected credential type: ${credential.type}")
                    _error.value = GoogleAuthError.UnexpectedCredentialType
                    Result.failure(IllegalStateException("Unexpected credential type"))
                }
            }
            else -> {
                Log.e(TAG, "Unexpected credential class: ${credential.javaClass.name}")
                _error.value = GoogleAuthError.UnexpectedCredentialType
                Result.failure(IllegalStateException("Unexpected credential class"))
            }
        }
    }

    private fun processGoogleCredential(credential: GoogleIdTokenCredential): Result<UserProfile> {
        val idToken = credential.idToken
        val userId = credential.id
        val email = credential.id // Google ID is the email
        val displayName = credential.displayName
        val avatarUrl = credential.profilePictureUri?.toString()

        Log.d(TAG, "Successfully signed in as: $email")

        // Store credentials securely
        encryptedPrefs.edit().apply {
            putString(KEY_USER_ID, userId)
            putString(KEY_EMAIL, email)
            putString(KEY_DISPLAY_NAME, displayName)
            putString(KEY_AVATAR_URL, avatarUrl)
            putString(KEY_ID_TOKEN, idToken)
            putBoolean(KEY_IS_AUTHENTICATED, true)
            apply()
        }

        // Create user profile
        val profile = UserProfile(
            id = userId,
            email = email,
            displayName = displayName,
            avatarUrl = avatarUrl,
            plan = Plan.FREE, // Will be synced with backend
            subscriptionStatus = SubscriptionStatus.NONE
        )

        _userProfile.value = profile
        _isAuthenticated.value = true

        return Result.success(profile)
    }

    /**
     * Sign out and clear stored credentials
     */
    suspend fun signOut() {
        try {
            // Clear credential state
            credentialManager.clearCredentialState(ClearCredentialStateRequest())

            // Clear stored preferences
            encryptedPrefs.edit().clear().apply()

            // Reset state
            _isAuthenticated.value = false
            _userProfile.value = null
            _error.value = null

            Log.d(TAG, "Successfully signed out")
        } catch (e: Exception) {
            Log.e(TAG, "Error during sign out", e)
        }
    }

    /**
     * Get the stored ID token for backend authentication
     */
    fun getIdToken(): String? {
        return encryptedPrefs.getString(KEY_ID_TOKEN, null)
    }

    /**
     * Get the stored access token for Gmail API
     */
    fun getAccessToken(): String? {
        return encryptedPrefs.getString(KEY_ACCESS_TOKEN, null)
    }

    /**
     * Get the sign-in intent for Gmail access (requires activity result handling)
     */
    fun getGmailSignInIntent(): Intent {
        return googleSignInClient.signInIntent
    }

    /**
     * Handle Gmail sign-in result from activity
     */
    suspend fun handleGmailSignInResult(data: Intent?): Result<String> = withContext(Dispatchers.IO) {
        try {
            val task = GoogleSignIn.getSignedInAccountFromIntent(data)
            val account = task.getResult(ApiException::class.java)

            if (account != null) {
                // Get access token using the account
                val accessToken = getAccessTokenFromAccount(account)
                if (accessToken != null) {
                    // Store the access token
                    encryptedPrefs.edit().apply {
                        putString(KEY_ACCESS_TOKEN, accessToken)
                        putString(KEY_USER_ID, account.id)
                        putString(KEY_EMAIL, account.email)
                        putString(KEY_DISPLAY_NAME, account.displayName)
                        putString(KEY_AVATAR_URL, account.photoUrl?.toString())
                        putString(KEY_ID_TOKEN, account.idToken)
                        putBoolean(KEY_IS_AUTHENTICATED, true)
                        apply()
                    }

                    // Update state
                    _userProfile.value = UserProfile(
                        id = account.id ?: "",
                        email = account.email ?: "",
                        displayName = account.displayName,
                        avatarUrl = account.photoUrl?.toString()
                    )
                    _isAuthenticated.value = true

                    _gmailConnected.value = true
                    Log.d(TAG, "Gmail sign-in successful for: ${account.email}")
                    Result.success(accessToken)
                } else {
                    Log.e(TAG, "Failed to get access token")
                    Result.failure(IllegalStateException("Failed to get access token"))
                }
            } else {
                Log.e(TAG, "Account is null")
                Result.failure(IllegalStateException("Account is null"))
            }
        } catch (e: ApiException) {
            Log.e(TAG, "Gmail sign-in failed: ${e.statusCode}", e)
            _error.value = GoogleAuthError.AuthenticationFailed("Sign-in failed: ${e.statusCode}")
            Result.failure(e)
        }
    }

    /**
     * Get OAuth access token from signed-in account
     */
    private fun getAccessTokenFromAccount(account: GoogleSignInAccount): String? {
        return try {
            val scope = "oauth2:$GMAIL_SCOPE"
            com.google.android.gms.auth.GoogleAuthUtil.getToken(
                context,
                account.account!!,
                scope
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get access token", e)
            null
        }
    }

    /**
     * Check if we have Gmail access (valid access token)
     */
    fun hasGmailAccess(): Boolean {
        return getAccessToken() != null
    }

    /**
     * Refresh the Gmail access token using the stored OAuth refresh_token.
     *
     * Previously this looked up GoogleSignIn.getLastSignedInAccount(context)
     * and used GoogleAuthUtil.getToken() — the *legacy* GoogleSignIn SDK's
     * account-based token fetch. But Gmail auth actually happens via
     * startGmailOAuthFlow()'s PKCE + Chrome Custom Tab flow, which never
     * calls the GoogleSignIn SDK at all, so getLastSignedInAccount() always
     * returned null for these users — every refresh attempt silently
     * failed, and once the ~1hr access token expired, Gmail import was
     * permanently broken until a full manual re-authorization. Fixed by
     * using the actual OAuth2 refresh_token grant against the same token
     * endpoint the initial exchange uses.
     */
    suspend fun refreshGmailToken(): String? = withContext(Dispatchers.IO) {
        val refreshToken = encryptedPrefs.getString(KEY_REFRESH_TOKEN, null)
        if (refreshToken == null) {
            Log.w(TAG, "No refresh token stored — user must re-authorize Gmail access")
            return@withContext null
        }

        try {
            val requestBody = FormBody.Builder()
                .add("client_id", IOS_CLIENT_ID)
                .add("refresh_token", refreshToken)
                .add("grant_type", "refresh_token")
                .build()

            val request = Request.Builder()
                .url(OAUTH_TOKEN_ENDPOINT)
                .post(requestBody)
                .build()

            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) {
                val errorBody = response.body?.string() ?: "Unknown error"
                Log.e(TAG, "Refresh token grant failed (${response.code}): $errorBody")
                // A refresh token can itself be revoked/expired (e.g. user
                // revoked access in their Google Account settings) — clear
                // it so we don't keep retrying a dead token, and surface
                // that re-authorization is required.
                if (response.code == 400 || response.code == 401) {
                    encryptedPrefs.edit().remove(KEY_REFRESH_TOKEN).apply()
                }
                return@withContext null
            }

            val json = JSONObject(response.body!!.string())
            val newAccessToken = json.getString("access_token")
            encryptedPrefs.edit().putString(KEY_ACCESS_TOKEN, newAccessToken).apply()
            Log.d(TAG, "Successfully refreshed Gmail access token")
            newAccessToken
        } catch (e: Exception) {
            Log.e(TAG, "Failed to refresh token", e)
            null
        }
    }

    /**
     * Sync subscription status with backend
     */
    suspend fun syncSubscription(): Result<UserProfile> {
        val idToken = getIdToken() ?: return Result.failure(
            IllegalStateException("Not authenticated")
        )

        return try {
            val requestBody = JSONObject().apply {
                put("id_token", idToken)
                put("platform", "android")
            }.toString()

            val request = Request.Builder()
                .url("$baseUrl/api/auth/sync")
                .post(requestBody.toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer $idToken")
                .build()

            val response = httpClient.newCall(request).execute()

            if (response.isSuccessful) {
                val body = response.body?.string()
                if (body != null) {
                    val json = JSONObject(body)
                    val subscription = json.optJSONObject("subscription")

                    val currentProfile = _userProfile.value ?: return Result.failure(
                        IllegalStateException("No user profile")
                    )

                    val updatedProfile = currentProfile.copy(
                        plan = Plan.fromString(subscription?.optString("tier") ?: "free"),
                        subscriptionStatus = SubscriptionStatus.fromString(
                            subscription?.optString("status") ?: "none"
                        ),
                        subscriptionExpiresAt = subscription?.optString("expires_at")?.let {
                            try { Instant.parse(it) } catch (e: Exception) { null }
                        },
                        updatedAt = Instant.now()
                    )

                    _userProfile.value = updatedProfile
                    Result.success(updatedProfile)
                } else {
                    Result.failure(IllegalStateException("Empty response body"))
                }
            } else {
                Result.failure(IllegalStateException("Sync failed: ${response.code}"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to sync subscription", e)
            Result.failure(e)
        }
    }

    /**
     * Load stored credentials on startup
     */
    private fun loadStoredCredentials() {
        android.util.Log.i("ListenAI-Auth", "loadStoredCredentials called")
        val isAuth = encryptedPrefs.getBoolean(KEY_IS_AUTHENTICATED, false)
        android.util.Log.i("ListenAI-Auth", "isAuth from prefs: $isAuth")

        if (isAuth) {
            val userId = encryptedPrefs.getString(KEY_USER_ID, null)
            val email = encryptedPrefs.getString(KEY_EMAIL, null)
            val displayName = encryptedPrefs.getString(KEY_DISPLAY_NAME, null)
            val avatarUrl = encryptedPrefs.getString(KEY_AVATAR_URL, null)
            val accessToken = encryptedPrefs.getString(KEY_ACCESS_TOKEN, null)

            android.util.Log.i("ListenAI-Auth", "userId: $userId, email: $email, hasAccessToken: ${accessToken != null}")
            if (userId != null && email != null) {
                _userProfile.value = UserProfile(
                    id = userId,
                    email = email,
                    displayName = displayName,
                    avatarUrl = avatarUrl
                )
                _isAuthenticated.value = true
                _gmailConnected.value = accessToken != null
                android.util.Log.i("ListenAI-Auth", "Loaded stored credentials for: $email, hasAccessToken: ${accessToken != null}")
            }
        } else {
            android.util.Log.i("ListenAI-Auth", "No stored credentials found")
        }
    }

    /**
     * Generate a cryptographic nonce for security
     */
    private fun generateNonce(): String {
        val rawNonce = UUID.randomUUID().toString()
        val bytes = rawNonce.toByteArray()
        val md = MessageDigest.getInstance("SHA-256")
        val digest = md.digest(bytes)
        return digest.fold("") { str, it -> str + "%02x".format(it) }
    }

    /**
     * Start Gmail OAuth flow using PKCE with Chrome Custom Tab
     * Returns immediately after launching the browser - the redirect will be handled by MainActivity
     */
    suspend fun startGmailOAuthFlow(activity: Activity): Result<Unit> {
        return try {
            // Generate PKCE code verifier and challenge
            val codeVerifier = generateCodeVerifier()
            val codeChallenge = generateCodeChallenge(codeVerifier)

            // Store code verifier for later use in handleOAuthRedirect
            encryptedPrefs.edit().putString(KEY_CODE_VERIFIER, codeVerifier).apply()

            // Build authorization URL
            val authUrl = buildAuthorizationUrl(codeChallenge)

            // Launch Chrome Custom Tab
            withContext(Dispatchers.Main) {
                val customTabsIntent = androidx.browser.customtabs.CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .build()

                customTabsIntent.launchUrl(activity, android.net.Uri.parse(authUrl))
                Log.d(TAG, "Launched Gmail OAuth flow with PKCE")
            }

            Result.success(Unit)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Gmail OAuth flow", e)
            _error.value = GoogleAuthError.AuthenticationFailed(e.message ?: "Failed to start OAuth")
            Result.failure(e)
        }
    }

    /**
     * Handle OAuth redirect and exchange authorization code for access token
     */
    suspend fun handleOAuthRedirect(data: android.net.Uri): Result<String> = withContext(Dispatchers.IO) {
        try {
            // Extract authorization code from redirect
            val code = data.getQueryParameter("code")
            if (code == null) {
                val error = data.getQueryParameter("error") ?: "Unknown error"
                Log.e(TAG, "OAuth redirect error: $error")
                return@withContext Result.failure(IllegalStateException("OAuth error: $error"))
            }

            // Retrieve stored code verifier
            val codeVerifier = encryptedPrefs.getString(KEY_CODE_VERIFIER, null)
            if (codeVerifier == null) {
                Log.e(TAG, "Code verifier not found")
                return@withContext Result.failure(IllegalStateException("Code verifier not found"))
            }

            // Exchange authorization code for access + refresh token
            val tokens = exchangeCodeForToken(code, codeVerifier)

            // Clear code verifier
            encryptedPrefs.edit().remove(KEY_CODE_VERIFIER).apply()

            // Store access token, and refresh token if Google returned one
            // (it should, given access_type=offline + prompt=consent on the
            // authorization request — but Google only returns a refresh
            // token on the *first* consent for a given client+scope, so
            // don't overwrite an existing one with null on a later re-auth).
            encryptedPrefs.edit().apply {
                putString(KEY_ACCESS_TOKEN, tokens.accessToken)
                if (tokens.refreshToken != null) {
                    putString(KEY_REFRESH_TOKEN, tokens.refreshToken)
                }
                apply()
            }

            // Mark Gmail as connected (gmail.modify scope only — no userinfo access)
            withContext(Dispatchers.Main) {
                _gmailConnected.value = true
            }

            Log.d(TAG, "Successfully exchanged code for access token (refresh token present: ${tokens.refreshToken != null})")
            Result.success(tokens.accessToken)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to handle OAuth redirect", e)
            _error.value = GoogleAuthError.AuthenticationFailed(e.message ?: "Token exchange failed")
            Result.failure(e)
        }
    }

    /**
     * Generate PKCE code verifier (random 128-character string)
     */
    private fun generateCodeVerifier(): String {
        val random = java.security.SecureRandom()
        val bytes = ByteArray(96) // 96 bytes = 128 characters in base64
        random.nextBytes(bytes)
        return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
    }

    /**
     * Generate PKCE code challenge (SHA256 hash of code verifier)
     */
    private fun generateCodeChallenge(codeVerifier: String): String {
        val bytes = codeVerifier.toByteArray(Charsets.US_ASCII)
        val md = MessageDigest.getInstance("SHA-256")
        val digest = md.digest(bytes)
        return android.util.Base64.encodeToString(digest, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
    }

    /**
     * Build OAuth authorization URL with PKCE parameters
     */
    private fun buildAuthorizationUrl(codeChallenge: String): String {
        val url = android.net.Uri.parse(OAUTH_AUTHORIZATION_ENDPOINT).buildUpon()
            .appendQueryParameter("client_id", IOS_CLIENT_ID)
            .appendQueryParameter("redirect_uri", OAUTH_REDIRECT_URI)
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("scope", GMAIL_SCOPE)
            .appendQueryParameter("code_challenge", codeChallenge)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("access_type", "offline")
            .appendQueryParameter("prompt", "consent")
            .build()
            .toString()

        Log.d(TAG, "Authorization URL: $url")
        Log.d(TAG, "Redirect URI: $OAUTH_REDIRECT_URI")
        return url
    }

    /**
     * Exchange authorization code for an access token + refresh token.
     *
     * Was previously discarding the refresh_token entirely (only
     * `access_token` was read from the response) even though the
     * authorization request already asks for `access_type=offline` to get
     * one. Without it, refreshGmailToken() had no way to renew a token
     * once Google's ~1hr access token expiry hit — Gmail import broke for
     * every user after about an hour with no way to recover short of a
     * full manual re-authorization.
     */
    private suspend fun exchangeCodeForToken(code: String, codeVerifier: String): TokenResponse = withContext(Dispatchers.IO) {
        val requestBody = FormBody.Builder()
            .add("client_id", IOS_CLIENT_ID)
            .add("code", code)
            .add("code_verifier", codeVerifier)
            .add("grant_type", "authorization_code")
            .add("redirect_uri", OAUTH_REDIRECT_URI)
            .build()

        val request = Request.Builder()
            .url(OAUTH_TOKEN_ENDPOINT)
            .post(requestBody)
            .build()

        val response = httpClient.newCall(request).execute()
        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: "Unknown error"
            throw IllegalStateException("Token exchange failed: $errorBody")
        }

        val json = JSONObject(response.body!!.string())
        TokenResponse(
            accessToken = json.getString("access_token"),
            refreshToken = if (json.has("refresh_token")) json.getString("refresh_token") else null,
        )
    }

    private data class TokenResponse(val accessToken: String, val refreshToken: String?)

    /**
     * Fetch user info from Google API
     */
    private suspend fun fetchUserInfo(accessToken: String): UserInfo? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("https://www.googleapis.com/oauth2/v2/userinfo")
                .addHeader("Authorization", "Bearer $accessToken")
                .build()

            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) return@withContext null

            val json = JSONObject(response.body!!.string())
            UserInfo(
                id = json.getString("id"),
                email = json.getString("email"),
                name = json.optString("name"),
                picture = json.optString("picture")
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch user info", e)
            null
        }
    }

    private data class UserInfo(
        val id: String,
        val email: String,
        val name: String?,
        val picture: String?
    )
}

/**
 * Google authentication errors
 */
sealed class GoogleAuthError(val message: String) {
    object UserCancelled : GoogleAuthError("Sign-in was cancelled")
    object NoCredentials : GoogleAuthError("No Google accounts available on device")
    object TokenParsingFailed : GoogleAuthError("Failed to parse authentication token")
    object UnexpectedCredentialType : GoogleAuthError("Unexpected credential type received")
    data class AuthenticationFailed(val detail: String) : GoogleAuthError("Authentication failed: $detail")
    object NotAuthenticated : GoogleAuthError("Not signed in with Google")
    object SyncFailed : GoogleAuthError("Failed to sync with server")
}
