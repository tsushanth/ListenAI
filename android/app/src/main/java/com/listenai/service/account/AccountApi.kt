package com.listenai.service.account

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/** Which paid plans the backend says are still active on the account. Deleting the account cancels none of them. */
data class SubscriptionFlags(val stripe: Boolean, val play: Boolean) {
    val any: Boolean get() = stripe || play
}

sealed class DeleteAccountResult {
    /** Account and server-side data are gone (also the reply when a retry finds nothing left). */
    data class Deleted(val subscriptions: SubscriptionFlags) : DeleteAccountResult()

    /** Nothing was deleted: an active subscription must be acknowledged first (HTTP 409 `active_subscription`). */
    data class ActiveSubscription(val subscriptions: SubscriptionFlags) : DeleteAccountResult()
}

enum class AccountDeletionFailure {
    /** No usable session (HTTP 401, or no token). The account may already be gone. */
    SIGN_IN_REQUIRED,

    /** Offline / timeout. Safe to retry. */
    NETWORK,

    /** Server could not finish (5xx). Nothing is lost: the sign-in still works and a retry continues. */
    SERVER,

    /** Anything else (4xx other than 401/409, unreadable reply). */
    UNKNOWN
}

class AccountDeletionException(val failure: AccountDeletionFailure, val httpStatus: Int = 0, message: String? = null, cause: Throwable? = null) :
    Exception(message ?: failure.name, cause)

/** What the view model needs; implemented by [AccountApi]. */
interface AccountDeletionClient {
    /** @throws AccountDeletionException */
    suspend fun deleteAccount(acknowledgeActiveSubscription: Boolean): DeleteAccountResult
}

/**
 * `DELETE /api/account` (backend/src/routes/account.ts). Authenticated with the user's Supabase access token; the
 * backend takes the account from the token only. Contract: see the header comment of that route.
 */
class AccountApi(
    baseUrl: String,
    private val http: OkHttpClient,
    private val accessToken: suspend () -> String?
) : AccountDeletionClient {

    private val baseUrl = baseUrl.trimEnd('/')

    override suspend fun deleteAccount(acknowledgeActiveSubscription: Boolean): DeleteAccountResult {
        val token = accessToken()?.takeIf { it.isNotBlank() }
            ?: throw AccountDeletionException(AccountDeletionFailure.SIGN_IN_REQUIRED, 401, "Sign in required.")
        val body = JSONObject().apply {
            if (acknowledgeActiveSubscription) put("acknowledge_active_subscription", true)
        }.toString().toRequestBody(JSON)
        val request = Request.Builder()
            .url("$baseUrl/api/account")
            .delete(body)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Accept", "application/json")
            .build()
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { response ->
                    val text = try { response.body?.string().orEmpty() } catch (e: IOException) { "" }
                    parseResponse(response.code, text)
                }
            } catch (e: IOException) {
                throw AccountDeletionException(AccountDeletionFailure.NETWORK, 0, e.message, e)
            }
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        /** Pure: maps an HTTP status and body to a result or an [AccountDeletionException]. */
        fun parseResponse(status: Int, body: String): DeleteAccountResult {
            val json = try { JSONObject(body) } catch (e: Exception) { null }
            return when {
                status in 200..299 -> {
                    if (json?.optBoolean("deleted", false) != true) {
                        throw AccountDeletionException(AccountDeletionFailure.UNKNOWN, status, "Unexpected reply")
                    }
                    DeleteAccountResult.Deleted(flagsOf(json))
                }
                status == 409 && json?.optString("code") == "active_subscription" ->
                    DeleteAccountResult.ActiveSubscription(flagsOf(json))
                status == 401 -> throw AccountDeletionException(AccountDeletionFailure.SIGN_IN_REQUIRED, status)
                status >= 500 -> throw AccountDeletionException(AccountDeletionFailure.SERVER, status, json?.optString("code"))
                else -> throw AccountDeletionException(AccountDeletionFailure.UNKNOWN, status, json?.optString("code"))
            }
        }

        private fun flagsOf(json: JSONObject?): SubscriptionFlags {
            val s = json?.optJSONObject("subscriptions")
            return SubscriptionFlags(stripe = s?.optBoolean("stripe", false) == true, play = s?.optBoolean("play", false) == true)
        }
    }
}
