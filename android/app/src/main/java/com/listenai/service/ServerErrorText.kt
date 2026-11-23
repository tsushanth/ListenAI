package com.listenai.service

import android.content.Context
import androidx.annotation.StringRes
import com.listenai.R
import org.json.JSONObject

/**
 * Turns a server error into text in the user's language.
 *
 * Our backend sends every error body as `{ error, message, code }`: `message` is English (kept for older app
 * versions), `code` is a stable lower_snake_case code. The app translates the code. The server's English
 * [message] is only shown for a code this app version does not know yet, so a new server code degrades to
 * readable English instead of nothing.
 */
object ServerErrorText {

    /** What the app needs from an error response. [code] is lower-cased; null when the body had none. */
    data class ServerError(
        val httpStatus: Int,
        val code: String?,
        /** English text from the server, for logs and as the fallback for an unknown [code]. */
        val message: String?,
        val details: JSONObject?
    )

    /** Parses an error body; tolerant of empty, non-JSON and old-style bodies (`{error: "English text"}` only). */
    fun parse(httpStatus: Int, body: String?): ServerError {
        val json = try { if (body.isNullOrBlank()) null else JSONObject(body) } catch (_: Exception) { null }
        val code = json?.optString("code")?.trim()?.takeIf { it.isNotEmpty() }?.lowercase()
        // Old bodies carry the English text in `error`; newer ones carry a category like VALIDATION_ERROR there.
        val error = json?.optString("error")?.takeIf { it.isNotBlank() && !CATEGORY.matches(it) }
        val message = json?.optString("message")?.takeIf { it.isNotBlank() }
            ?: json?.optString("detail")?.takeIf { it.isNotBlank() }
            ?: error
        return ServerError(httpStatus, code ?: codeFromStatus(httpStatus), message, json?.optJSONObject("details"))
    }

    /** An older server sends no code: the HTTP status still says what kind of failure it was. */
    private fun codeFromStatus(status: Int): String? = when {
        status == 401 -> "unauthenticated"
        status == 408 || status == 504 -> "timeout"
        status == 429 -> "rate_limited"
        status in 500..599 -> "service_unavailable"
        else -> null
    }

    private val CATEGORY = Regex("[A-Z0-9_]+")

    /** The string resource for a server [code], or null when this app version does not know it. */
    @StringRes
    fun resFor(code: String?): Int? = when (code?.lowercase()) {
        "invalid_request", "invalid_json", "invalid_voice_id", "job_id_required", "device_id_required" -> R.string.srv_err_invalid_request
        "text_too_long" -> R.string.srv_err_text_too_long
        "unauthenticated", "token_expired", "token_invalid" -> R.string.srv_err_sign_in
        "forbidden" -> R.string.srv_err_forbidden
        "tier_required" -> R.string.srv_err_tier_required
        "not_owner" -> R.string.srv_err_not_owner
        "not_found", "job_not_found" -> R.string.srv_err_not_found
        "shared_voice_not_found", "voice_not_found" -> R.string.marketplace_err_not_found
        "quota_daily_exceeded" -> R.string.srv_err_quota_daily
        "quota_monthly_exceeded" -> R.string.srv_err_quota_monthly
        "quota_exceeded", "payment_required" -> R.string.srv_err_quota
        "rate_limited" -> R.string.srv_err_rate_limited
        "voice_already_shared" -> R.string.marketplace_err_already_shared
        "voice_already_revoked" -> R.string.srv_err_voice_already_revoked
        "cannot_report_own_voice" -> R.string.srv_err_cannot_report_own
        "already_reported" -> R.string.srv_err_already_reported
        "cannot_rate_own_voice" -> R.string.srv_err_cannot_rate_own
        "cloning_unavailable" -> R.string.srv_err_cloning_unavailable
        "provider_error", "service_unavailable" -> R.string.srv_err_service_unavailable
        "timeout" -> R.string.srv_err_timeout
        "internal_error" -> R.string.srv_err_internal
        // Codes the TTS job record carries (error.code on a failed job).
        "synthesis_failed", "generation_failed", "stuck_job" -> R.string.srv_err_synthesis_failed
        "payload_too_large" -> R.string.srv_err_too_large
        else -> null
    }

    /**
     * The text to show: the translated text for a known [code], else the server's own [message], else [fallback].
     */
    fun resolve(context: Context, code: String?, message: String?, @StringRes fallback: Int = R.string.srv_err_generic): String {
        resFor(code)?.let { return context.getString(it) }
        return message?.takeIf { it.isNotBlank() } ?: context.getString(fallback)
    }

    fun resolve(context: Context, e: ServerError, @StringRes fallback: Int = R.string.srv_err_generic): String =
        resolve(context, e.code, e.message, fallback)
}
