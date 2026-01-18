package com.listenai.service.auth

import android.content.Context
import android.util.Log
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
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import com.listenai.data.models.Plan
import com.listenai.data.models.SubscriptionStatus
import com.listenai.data.models.UserProfile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Service for handling Google OAuth authentication.
 * Uses Credential Manager API for modern sign-in experience.
 */
class GoogleAuthService(private val context: Context) {

    companion object {
        private const val TAG = "GoogleAuthService"

        // OAuth configuration - same as iOS
        private const val WEB_CLIENT_ID = "517355381306-iiuf6umqhie29ii0rnrd0shtb4e1ou5i.apps.googleusercontent.com"

        // Preferences keys
        private const val PREFS_NAME = "listenai_auth_prefs"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_EMAIL = "email"
        private const val KEY_DISPLAY_NAME = "display_name"
        private const val KEY_AVATAR_URL = "avatar_url"
        private const val KEY_ID_TOKEN = "id_token"
        private const val KEY_IS_AUTHENTICATED = "is_authenticated"
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

    // Credential manager
    private val credentialManager = CredentialManager.create(context)

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

    private var baseUrl: String = "https://listenai-backend-517355381306.us-central1.run.app"

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
        val isAuth = encryptedPrefs.getBoolean(KEY_IS_AUTHENTICATED, false)

        if (isAuth) {
            val userId = encryptedPrefs.getString(KEY_USER_ID, null)
            val email = encryptedPrefs.getString(KEY_EMAIL, null)
            val displayName = encryptedPrefs.getString(KEY_DISPLAY_NAME, null)
            val avatarUrl = encryptedPrefs.getString(KEY_AVATAR_URL, null)

            if (userId != null && email != null) {
                _userProfile.value = UserProfile(
                    id = userId,
                    email = email,
                    displayName = displayName,
                    avatarUrl = avatarUrl
                )
                _isAuthenticated.value = true
                Log.d(TAG, "Loaded stored credentials for: $email")
            }
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
