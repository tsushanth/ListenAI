package com.listenai.service.auth

import android.content.Context
import android.provider.Settings
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Authentication service for Supabase Auth via backend.
 * Handles Google Sign-In token exchange and session management.
 */
class AuthService(private val context: Context) : SupabaseSessionStore {

    companion object {
        private const val TAG = "AuthService"

        // Preferences
        private const val PREFS_NAME = "listenai_auth_service_prefs"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_EXPIRES_AT = "expires_at"
        private const val KEY_USER_JSON = "user_json"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PKCE_VERIFIER = "pkce_verifier"
    }

    // State
    private val _isAuthenticated = MutableStateFlow(false)
    override val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()

    private val _user = MutableStateFlow<AuthUser?>(null)
    override val user: StateFlow<AuthUser?> = _user.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<AuthError?>(null)
    val error: StateFlow<AuthError?> = _error.asStateFlow()

    // Configuration
    private var backendUrl: String = "https://listenai-backend.fly.dev"

    // HTTP client
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()


    // Encrypted preferences
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

    init {
        loadStoredSession()
    }

    /**
     * Configure the backend URL
     */
    fun configure(backendUrl: String) {
        this.backendUrl = backendUrl
    }

    /**
     * Get the device ID for anonymous identification
     */
    fun getDeviceId(): String {
        var deviceId = encryptedPrefs.getString(KEY_DEVICE_ID, null)
        if (deviceId == null) {
            // Try to use Android ID, fall back to UUID
            deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
                ?: UUID.randomUUID().toString()
            encryptedPrefs.edit().putString(KEY_DEVICE_ID, deviceId).apply()
        }
        return deviceId
    }

    /**
     * Get the current user ID, or device ID if not authenticated
     */
    fun getCurrentUserId(): String {
        return user.value?.id ?: getDeviceId()
    }

    /**
     * Exchange Google ID token with backend for Supabase session
     */
    override suspend fun signInWithGoogle(idToken: String, accessToken: String?): Result<AuthUser> =
        withContext(Dispatchers.IO) {
            _isLoading.value = true
            _error.value = null

            try {
                val requestBody = JSONObject().apply {
                    put("id_token", idToken)
                    if (accessToken != null) {
                        put("access_token", accessToken)
                    }
                }.toString()

                val request = Request.Builder()
                    .url("$backendUrl/api/auth/google")
                    .post(requestBody.toRequestBody("application/json".toMediaType()))
                    .addHeader("X-Device-ID", getDeviceId())
                    .build()

                val response = httpClient.newCall(request).execute()

                if (response.isSuccessful) {
                    val body = response.body?.string()
                    if (body != null) {
                        val jsonResponse = JSONObject(body)
                        val userJson = jsonResponse.getJSONObject("user")
                        val sessionJson = jsonResponse.getJSONObject("session")

                        val authUser = AuthUser(
                            id = userJson.getString("id"),
                            email = userJson.optString("email", null),
                            displayName = userJson.optString("display_name", null),
                            avatarUrl = userJson.optString("avatar_url", null),
                            createdAt = userJson.optString("created_at", null)
                        )

                        // Save session
                        encryptedPrefs.edit().apply {
                            putString(KEY_ACCESS_TOKEN, sessionJson.getString("access_token"))
                            putString(KEY_REFRESH_TOKEN, sessionJson.getString("refresh_token"))
                            putLong(KEY_EXPIRES_AT, sessionJson.getLong("expires_at"))
                            putString(KEY_USER_JSON, userJson.toString())
                            apply()
                        }

                        _user.value = authUser
                        _isAuthenticated.value = true

                        Log.d(TAG, "Google sign-in successful for: ${authUser.email}")
                        Result.success(authUser)
                    } else {
                        _error.value = AuthError.ServerError("Empty response")
                        Result.failure(Exception("Empty response"))
                    }
                } else {
                    val errorBody = response.body?.string()
                    val errorMessage = try {
                        JSONObject(errorBody ?: "").optString("message", "Authentication failed")
                    } catch (e: Exception) {
                        "Authentication failed"
                    }
                    _error.value = AuthError.ServerError(errorMessage)
                    Result.failure(Exception(errorMessage))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Google sign-in failed", e)
                _error.value = AuthError.NetworkError(e.message ?: "Network error")
                Result.failure(e)
            } finally {
                _isLoading.value = false
            }
        }

    /**
     * Persist a session obtained directly from Supabase GoTrue (email+password) exactly like a
     * backend-issued one: same encrypted prefs, so [getAccessToken] refreshes it via /api/auth/refresh
     * (which calls supabase.auth.refreshSession and works for any Supabase refresh token).
     */
    override suspend fun adoptSession(session: GoTrueSession): AuthUser = withContext(Dispatchers.IO) {
        val userJson = JSONObject().apply {
            put("id", session.userId)
            put("email", session.email ?: JSONObject.NULL)
            session.createdAt?.let { put("created_at", it) }
        }
        encryptedPrefs.edit().apply {
            putString(KEY_ACCESS_TOKEN, session.accessToken)
            putString(KEY_REFRESH_TOKEN, session.refreshToken)
            putLong(KEY_EXPIRES_AT, session.expiresAt)
            putString(KEY_USER_JSON, userJson.toString())
            apply()
        }
        val authUser = AuthUser(
            id = session.userId,
            email = session.email,
            displayName = null,
            avatarUrl = null,
            createdAt = session.createdAt
        )
        _user.value = authUser
        _isAuthenticated.value = true
        _error.value = null
        authUser
    }

    @Synchronized
    override fun savePkceVerifier(verifier: String) {
        // commit(): must be on disk before the browser opens, the app may be killed while it is in front.
        encryptedPrefs.edit().putString(KEY_PKCE_VERIFIER, verifier).commit()
    }

    @Synchronized
    override fun takePkceVerifier(): String? {
        val v = encryptedPrefs.getString(KEY_PKCE_VERIFIER, null)
        if (v != null) encryptedPrefs.edit().remove(KEY_PKCE_VERIFIER).commit()
        return v
    }

    /**
     * Link the current device to the authenticated user
     */
    suspend fun linkDevice(): Result<Unit> = withContext(Dispatchers.IO) {
        if (!_isAuthenticated.value) {
            return@withContext Result.failure(Exception("Not authenticated"))
        }

        val accessToken = encryptedPrefs.getString(KEY_ACCESS_TOKEN, null)
            ?: return@withContext Result.failure(Exception("No access token"))

        try {
            val requestBody = JSONObject().apply {
                put("device_id", getDeviceId())
            }.toString()

            val request = Request.Builder()
                .url("$backendUrl/api/auth/link-device")
                .post(requestBody.toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer $accessToken")
                .addHeader("X-Device-ID", getDeviceId())
                .build()

            val response = httpClient.newCall(request).execute()

            if (response.isSuccessful) {
                Log.d(TAG, "Device linked successfully")
                Result.success(Unit)
            } else {
                Log.w(TAG, "Device link failed: ${response.code}")
                Result.failure(Exception("Device link failed"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Device link failed", e)
            Result.failure(e)
        }
    }

    /**
     * Get a valid access token, refreshing if needed
     */
    override suspend fun getAccessToken(): String? = withContext(Dispatchers.IO) {
        if (!_isAuthenticated.value) return@withContext null

        val expiresAt = encryptedPrefs.getLong(KEY_EXPIRES_AT, 0)
        val now = System.currentTimeMillis() / 1000

        // Refresh if token expires in less than 5 minutes
        if (now > expiresAt - 300) {
            refreshSession()
        }

        encryptedPrefs.getString(KEY_ACCESS_TOKEN, null)
    }

    /**
     * Refresh the session using the refresh token
     */
    private suspend fun refreshSession(): Boolean = withContext(Dispatchers.IO) {
        val refreshToken = encryptedPrefs.getString(KEY_REFRESH_TOKEN, null)
            ?: return@withContext false

        try {
            val requestBody = JSONObject().apply {
                put("refresh_token", refreshToken)
            }.toString()

            val request = Request.Builder()
                .url("$backendUrl/api/auth/refresh")
                .post(requestBody.toRequestBody("application/json".toMediaType()))
                .build()

            val response = httpClient.newCall(request).execute()

            if (response.isSuccessful) {
                val body = response.body?.string()
                if (body != null) {
                    val jsonResponse = JSONObject(body)
                    encryptedPrefs.edit().apply {
                        putString(KEY_ACCESS_TOKEN, jsonResponse.getString("access_token"))
                        putString(KEY_REFRESH_TOKEN, jsonResponse.getString("refresh_token"))
                        putLong(KEY_EXPIRES_AT, jsonResponse.getLong("expires_at"))
                        apply()
                    }
                    Log.d(TAG, "Session refreshed")
                    return@withContext true
                }
            } else {
                // Refresh failed, clear session
                Log.w(TAG, "Session refresh failed: ${response.code}")
                clearSession()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Session refresh failed", e)
            clearSession()
        }

        false
    }

    /**
     * Sign out and clear the session
     */
    override suspend fun signOut(): Unit = withContext(Dispatchers.IO) {
        val accessToken = encryptedPrefs.getString(KEY_ACCESS_TOKEN, null)
        if (accessToken != null) {
            try {
                val request = Request.Builder()
                    .url("$backendUrl/api/auth/sign-out")
                    .post("{}".toRequestBody("application/json".toMediaType()))
                    .addHeader("Authorization", "Bearer $accessToken")
                    .addHeader("X-Device-ID", getDeviceId())
                    .build()

                httpClient.newCall(request).execute()
            } catch (e: Exception) {
                Log.w(TAG, "Sign out request failed (non-critical)", e)
            }
        }

        clearSession()
        Log.d(TAG, "Signed out")
    }

    /**
     * Clear stored session data
     */
    private fun clearSession() {
        encryptedPrefs.edit().apply {
            remove(KEY_ACCESS_TOKEN)
            remove(KEY_REFRESH_TOKEN)
            remove(KEY_EXPIRES_AT)
            remove(KEY_USER_JSON)
            apply()
        }

        _isAuthenticated.value = false
        _user.value = null
        _error.value = null
    }

    /**
     * Load stored session on startup
     */
    private fun loadStoredSession() {
        val accessToken = encryptedPrefs.getString(KEY_ACCESS_TOKEN, null)
        val userJson = encryptedPrefs.getString(KEY_USER_JSON, null)

        if (accessToken != null && userJson != null) {
            try {
                val jsonObj = JSONObject(userJson)
                _user.value = AuthUser(
                    id = jsonObj.getString("id"),
                    email = jsonObj.optString("email", null),
                    displayName = jsonObj.optString("display_name", null),
                    avatarUrl = jsonObj.optString("avatar_url", null),
                    createdAt = jsonObj.optString("created_at", null)
                )
                _isAuthenticated.value = true
                Log.d(TAG, "Loaded stored session for: ${_user.value?.email}")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load stored session", e)
                clearSession()
            }
        }
    }
}

/** The slice of [AuthService] the voice cloning auth needs; a seam so it can be faked in JVM tests. */
interface SupabaseSessionStore {
    val isAuthenticated: StateFlow<Boolean>
    val user: StateFlow<AuthUser?>
    suspend fun getAccessToken(): String?
    suspend fun adoptSession(session: GoTrueSession): AuthUser

    /** Persists the PKCE code_verifier of the browser sign-in that is in flight (survives process death). */
    fun savePkceVerifier(verifier: String)

    /** Atomically returns and deletes the pending verifier; null when no flow is pending (or already consumed). */
    fun takePkceVerifier(): String?
    suspend fun signInWithGoogle(idToken: String, accessToken: String? = null): Result<AuthUser>
    suspend fun signOut()
}

/**
 * Authenticated user data
 */
data class AuthUser(
    val id: String,
    val email: String?,
    val displayName: String?,
    val avatarUrl: String?,
    val createdAt: String?
)

/**
 * Authentication errors
 */
sealed class AuthError(val message: String) {
    object UserCancelled : AuthError("Sign-in was cancelled")
    object NotAuthenticated : AuthError("Not signed in")
    object SessionExpired : AuthError("Session expired. Please sign in again.")
    data class ServerError(val detail: String) : AuthError("Server error: $detail")
    data class NetworkError(val detail: String) : AuthError("Network error: $detail")
}
