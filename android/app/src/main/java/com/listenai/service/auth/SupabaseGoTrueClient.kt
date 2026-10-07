package com.listenai.service.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A Supabase (GoTrue) session as returned by the password grant / signup endpoints. */
data class GoTrueSession(
    val accessToken: String,
    val refreshToken: String,
    /** Epoch seconds. */
    val expiresAt: Long,
    val userId: String,
    val email: String?,
    val emailConfirmedAt: String?,
    val createdAt: String? = null
)

sealed class SignUpResult {
    /** Email confirmation is off (or auto-confirmed): a session came back immediately. */
    data class SignedIn(val session: GoTrueSession) : SignUpResult()

    /** The user was created but must click the emailed link before signing in. */
    data class ConfirmationRequired(val email: String) : SignUpResult()
}

enum class GoTrueErrorKind {
    INVALID_CREDENTIALS,
    EMAIL_NOT_CONFIRMED,
    USER_ALREADY_EXISTS,
    WEAK_PASSWORD,
    RATE_LIMITED,
    INVALID_INPUT,
    NETWORK,
    SERVER
}

/** [message] is complete, user-facing English text meant to be shown verbatim. */
class GoTrueException(val kind: GoTrueErrorKind, message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Minimal Supabase GoTrue REST client (password grant, signup, recover).
 * Token refresh deliberately stays on the existing backend path ([AuthService]), see there.
 */
class SupabaseGoTrueClient(
    private val baseUrl: String = SupabaseConfig.SUPABASE_URL,
    private val anonKey: String = SupabaseConfig.SUPABASE_ANON_KEY,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build(),
    private val nowSeconds: () -> Long = { System.currentTimeMillis() / 1000 }
) {
    private val json = "application/json".toMediaType()

    suspend fun signInWithPassword(email: String, password: String): Result<GoTrueSession> =
        call("/auth/v1/token?grant_type=password", JSONObject().put("email", email.trim()).put("password", password)) { body ->
            parseSession(JSONObject(body)) ?: throw GoTrueException(GoTrueErrorKind.SERVER, SERVER_MESSAGE)
        }

    suspend fun signUp(email: String, password: String): Result<SignUpResult> {
        val trimmed = email.trim()
        return call("/auth/v1/signup", JSONObject().put("email", trimmed).put("password", password)) { body ->
            val obj = JSONObject(body)
            val session = parseSession(obj)
            when {
                session != null -> SignUpResult.SignedIn(session)
                // With confirmation on, GoTrue answers 200 with the bare user. For an address that is already
                // registered it returns an obfuscated user with no identities instead of an error.
                obj.optJSONArray("identities")?.length() == 0 ->
                    throw GoTrueException(GoTrueErrorKind.USER_ALREADY_EXISTS, MSG_ALREADY_EXISTS)
                else -> SignUpResult.ConfirmationRequired(obj.optString("email").ifBlank { trimmed })
            }
        }
    }

    /** Sends the password reset email (GoTrue answers 200 whether or not the address exists). */
    suspend fun recover(email: String): Result<Unit> =
        call("/auth/v1/recover", JSONObject().put("email", email.trim())) { }

    private suspend fun <T> call(path: String, payload: JSONObject, parse: (String) -> T): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                val request = Request.Builder()
                    .url(baseUrl.trimEnd('/') + path)
                    .addHeader("apikey", anonKey)
                    .post(payload.toString().toRequestBody(json))
                    .build()
                http.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    if (response.isSuccessful) Result.success(parse(body)) else Result.failure(mapError(response.code, body))
                }
            } catch (e: GoTrueException) {
                Result.failure(e)
            } catch (e: IOException) {
                Result.failure(GoTrueException(GoTrueErrorKind.NETWORK, MSG_NETWORK, e))
            } catch (e: org.json.JSONException) {
                Result.failure(GoTrueException(GoTrueErrorKind.SERVER, SERVER_MESSAGE, e))
            }
        }

    private fun parseSession(o: JSONObject): GoTrueSession? {
        val access = o.optString("access_token")
        val refresh = o.optString("refresh_token")
        val user = o.optJSONObject("user")
        if (access.isBlank() || refresh.isBlank() || user == null || user.optString("id").isBlank()) return null
        val expiresAt = if (o.has("expires_in")) nowSeconds() + o.optLong("expires_in", 3600)
        else o.optLong("expires_at", nowSeconds() + 3600)
        return GoTrueSession(
            accessToken = access,
            refreshToken = refresh,
            expiresAt = expiresAt,
            userId = user.getString("id"),
            email = user.optString("email").ifBlank { null },
            emailConfirmedAt = user.optString("email_confirmed_at").ifBlank { null }.takeUnless { it == "null" },
            createdAt = user.optString("created_at").ifBlank { null }
        )
    }

    companion object {
        const val MSG_NETWORK = "Couldn't reach the server. Check your connection and try again."
        const val MSG_INVALID_CREDENTIALS = "That email or password is incorrect."
        const val MSG_NOT_CONFIRMED = "Check your email to verify your address, then sign in."
        const val MSG_ALREADY_EXISTS = "An account with this email already exists. Sign in instead, or reset your password."
        const val MSG_RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again."
        const val MSG_WEAK_PASSWORD = "That password is too weak. Choose a longer or less common one."
        const val SERVER_MESSAGE = "Sign-in is temporarily unavailable. Please try again."

        /** Maps a GoTrue error response (new `error_code`/`msg` and legacy `error`/`error_description` shapes). */
        fun mapError(httpStatus: Int, body: String): GoTrueException {
            val o = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
            val code = o.optString("error_code").ifBlank { o.optString("error") }
            val detail = o.optString("msg").ifBlank { o.optString("error_description") }.ifBlank { o.optString("message") }
            return when {
                code == "invalid_credentials" || (httpStatus == 400 && detail.equals("Invalid login credentials", true)) ->
                    GoTrueException(GoTrueErrorKind.INVALID_CREDENTIALS, MSG_INVALID_CREDENTIALS)
                code == "email_not_confirmed" || detail.equals("Email not confirmed", true) ->
                    GoTrueException(GoTrueErrorKind.EMAIL_NOT_CONFIRMED, MSG_NOT_CONFIRMED)
                code == "user_already_exists" || code == "email_exists" || detail.contains("already registered", true) ->
                    GoTrueException(GoTrueErrorKind.USER_ALREADY_EXISTS, MSG_ALREADY_EXISTS)
                code == "weak_password" -> {
                    val reasons = o.optJSONObject("weak_password")?.optJSONArray("reasons")
                    val reasonText = reasons?.let { arr -> (0 until arr.length()).joinToString(" ") { arr.optString(it) } }.orEmpty()
                    // The server's own reason is the most precise text available.
                    GoTrueException(GoTrueErrorKind.WEAK_PASSWORD, detail.ifBlank { reasonText.ifBlank { MSG_WEAK_PASSWORD } })
                }
                httpStatus == 429 || code == "over_request_rate_limit" || code == "over_email_send_rate_limit" ->
                    GoTrueException(GoTrueErrorKind.RATE_LIMITED, MSG_RATE_LIMITED)
                code == "validation_failed" || code == "email_address_invalid" || httpStatus == 422 ->
                    GoTrueException(GoTrueErrorKind.INVALID_INPUT, detail.ifBlank { "Enter a valid email address and password." })
                else -> GoTrueException(GoTrueErrorKind.SERVER, SERVER_MESSAGE)
            }
        }
    }
}
