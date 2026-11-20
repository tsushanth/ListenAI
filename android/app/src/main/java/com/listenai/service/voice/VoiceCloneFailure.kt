package com.listenai.service.voice

import com.listenai.R
import com.listenai.ui.common.UiText
import org.json.JSONObject

/** What the UI should offer after a failure. */
enum class Recovery {
    /** Show the sign-in action. */
    SIGN_IN,

    /** Nothing about the inputs is wrong; the same request can simply be retried. */
    RETRY,

    /** Re-record the consent phrase with the SAME challenge (attempts remain). */
    RERECORD_CONSENT,

    /** Challenge is unusable (expired, used, attempts exhausted): request a new phrase and re-record. */
    NEW_CHALLENGE,

    /** The reference recording is the problem: record or pick a different one. */
    FIX_REFERENCE,

    /** Nothing the user can fix right now (limits, eligibility, service dark). */
    STOP
}

/**
 * User-facing result of mapping a [VoiceCloneException]. [message] is English text for logs and diagnostics;
 * the screen shows [text], which is turned into the user's language when it is displayed.
 */
data class VoiceCloneFailure(
    val code: String,
    val message: String,
    val recovery: Recovery,
    /** Only set for phrase_mismatch / speaker_mismatch. */
    val attemptsLeft: Int? = null,
    /** Individual reference problems for reference_rejected / consent_clip_rejected. */
    val problems: List<String> = emptyList(),
    /** What to show the user; defaults to [message] verbatim (text that came from a server or library). */
    val text: UiText = UiText.Raw(message)
)

object VoiceCloneErrors {

    const val UNAVAILABLE_MESSAGE = "Voice cloning is not available yet."

    fun map(e: VoiceCloneException): VoiceCloneFailure {
        val d = e.details
        return when (e.code) {
            VoiceCloneException.CODE_SIGN_IN, "unauthenticated" ->
                failure(e, "Sign in to create or use a cloned voice.", Recovery.SIGN_IN, text = res(R.string.vc_err_sign_in))

            "email_unverified" ->
                failure(e, "Verify your email address, then try again. Voice cloning is only available to accounts with a verified email.", Recovery.STOP, text = res(R.string.vc_err_email_unverified))

            "payment_required" ->
                failure(e, "Voice cloning requires an active paid plan. Subscribe, then try again.", Recovery.STOP, text = res(R.string.vc_err_payment_required))

            "unavailable", "CLONING_UNAVAILABLE" ->
                failure(e, UNAVAILABLE_MESSAGE, Recovery.STOP, text = res(R.string.vc_err_unavailable))

            "service_unavailable", "asr_unavailable" ->
                failure(e, "Voice cloning is temporarily unavailable. Please try again in a few minutes.", Recovery.RETRY, text = res(R.string.vc_err_temporarily_unavailable))

            "reference_rejected" -> {
                val (problems, texts) = problemsFrom(d, REFERENCE_MESSAGES, REFERENCE_TEXTS)
                failure(
                    e,
                    "That recording can't be used. " + problems.joinToString(" ").ifEmpty { "Try a different recording." },
                    Recovery.FIX_REFERENCE,
                    problems = problems,
                    text = res(
                        R.string.vc_err_reference_rejected,
                        if (texts.isEmpty()) res(R.string.vc_err_reference_rejected_default) else UiText.Join(texts)
                    )
                )
            }

            "consent_clip_rejected" -> {
                val (problems, texts) = problemsFrom(d, CONSENT_CLIP_MESSAGES, CONSENT_CLIP_TEXTS)
                failure(
                    e,
                    "The consent recording can't be used. " + problems.joinToString(" ").ifEmpty { "Record the phrase again." },
                    Recovery.RERECORD_CONSENT,
                    problems = problems,
                    text = res(
                        R.string.vc_err_consent_clip_rejected,
                        if (texts.isEmpty()) res(R.string.vc_err_consent_clip_rejected_default) else UiText.Join(texts)
                    )
                )
            }

            "phrase_mismatch" -> {
                val left = attemptsLeft(d)
                if (left == null || left > 0) {
                    failure(
                        e,
                        "We couldn't match what you said to the phrase. Read it exactly as shown." + attemptsSuffix(left),
                        Recovery.RERECORD_CONSENT, attemptsLeft = left,
                        text = res(R.string.vc_err_phrase_mismatch, attemptsSuffixText(left))
                    )
                } else {
                    failure(e, "We couldn't match the phrase and you're out of attempts. Request a new phrase and try again.", Recovery.NEW_CHALLENGE, attemptsLeft = 0,
                        text = res(R.string.vc_err_phrase_mismatch_exhausted))
                }
            }

            "speaker_mismatch" -> {
                val left = attemptsLeft(d)
                if (left == null || left > 0) {
                    failure(
                        e,
                        "The voice in the consent recording doesn't match your reference recording. You can only clone your own voice. " +
                            "Record the phrase again in the same voice, in a quiet room." + attemptsSuffix(left),
                        Recovery.RERECORD_CONSENT, attemptsLeft = left,
                        text = res(R.string.vc_err_speaker_mismatch, attemptsSuffixText(left))
                    )
                } else {
                    failure(
                        e,
                        "The consent recording still doesn't match your reference recording and you're out of attempts. " +
                            "Request a new phrase, and use a reference recording of the same voice.",
                        Recovery.NEW_CHALLENGE, attemptsLeft = 0,
                        text = res(R.string.vc_err_speaker_mismatch_exhausted)
                    )
                }
            }

            "daily_limit" -> {
                val limit = d?.optInt("limit", 0)?.takeIf { it > 0 }
                failure(
                    e,
                    (if (limit != null) "You've reached the limit of $limit cloned voices per 24 hours. " else "You've reached today's voice cloning limit. ") +
                        "Try again tomorrow.",
                    Recovery.STOP,
                    text = if (limit != null) UiText.Plural(R.plurals.vc_err_daily_limit, limit) else res(R.string.vc_err_daily_limit_unknown)
                )
            }

            "creation_in_progress" ->
                failure(e, "A voice is already being created for your account. Wait a minute, then check your voices list.", Recovery.STOP, text = res(R.string.vc_err_creation_in_progress))

            "challenge_expired" ->
                failure(e, "The phrase expired. Request a new one and record it again.", Recovery.NEW_CHALLENGE, text = res(R.string.vc_err_challenge_expired))

            "challenge_used", "challenge_not_found" ->
                failure(e, "That phrase can no longer be used. Request a new one and record it again.", Recovery.NEW_CHALLENGE, text = res(R.string.vc_err_challenge_used))

            "challenge_attempts_exhausted" ->
                failure(e, "Too many failed attempts. Request a new phrase and try again.", Recovery.NEW_CHALLENGE, text = res(R.string.vc_err_challenge_exhausted))

            "rate_limited" ->
                failure(e, "Too many requests. Please wait a while and try again.", Recovery.STOP, text = res(R.string.vc_err_too_many_requests))

            "audio_required" ->
                failure(e, "Both a consent recording and a reference recording are required (WAV, FLAC, OGG, MP3, M4A or WebM).", Recovery.FIX_REFERENCE, text = res(R.string.vc_err_audio_required))

            "upload_error" ->
                failure(
                    e,
                    if (e.httpStatus == 413) "That file is too large (25 MB maximum). Use a shorter recording." else "The upload failed. Please try again.",
                    if (e.httpStatus == 413) Recovery.FIX_REFERENCE else Recovery.RETRY,
                    text = res(if (e.httpStatus == 413) R.string.vc_err_file_too_large else R.string.vc_err_upload_failed)
                )

            "unsupported_language" ->
                failure(e, "That language isn't supported for voice cloning. Choose a different language.", Recovery.RETRY, text = res(R.string.vc_err_unsupported_language))

            "validation" ->
                failure(e, "Something in the request was invalid. Check the voice name and try again.", Recovery.RETRY, text = res(R.string.vc_err_validation))

            "voice_not_found" ->
                failure(e, "That voice no longer exists.", Recovery.STOP, text = res(R.string.vc_err_voice_not_found))

            "voice_disabled" ->
                failure(e, "This voice has been disabled and can't be used.", Recovery.STOP, text = res(R.string.vc_err_voice_disabled))

            "voice_unavailable" ->
                failure(e, "This voice is being deleted and can't be used.", Recovery.STOP, text = res(R.string.vc_err_voice_deleting))

            "deletion_pending" ->
                failure(e, "The voice is already unusable, but deletion didn't finish. Tap delete again to retry.", Recovery.RETRY, text = res(R.string.vc_err_deletion_pending))

            VoiceCloneException.CODE_NETWORK ->
                failure(e, "Couldn't reach the server. Check your connection and try again.", Recovery.RETRY, text = res(R.string.vc_err_network))

            else -> when {
                e.httpStatus == 401 -> failure(e, "Sign in to create or use a cloned voice.", Recovery.SIGN_IN, text = res(R.string.vc_err_sign_in))
                e.httpStatus == 429 -> failure(e, "Too many requests. Please wait a while and try again.", Recovery.STOP, text = res(R.string.vc_err_too_many_requests))
                e.httpStatus in 500..599 -> failure(e, "The server had a problem. Please try again in a few minutes.", Recovery.RETRY, text = res(R.string.vc_err_server_problem))
                else -> failure(e, "Something went wrong (${e.code}). Please try again.", Recovery.RETRY, text = res(R.string.vc_err_generic, e.code))
            }
        }
    }

    private fun res(@androidx.annotation.StringRes id: Int, vararg args: Any) = UiText.Res(id, args.toList())

    private fun failure(
        e: VoiceCloneException,
        message: String,
        recovery: Recovery,
        attemptsLeft: Int? = null,
        problems: List<String> = emptyList(),
        text: UiText = UiText.Raw(message)
    ) = VoiceCloneFailure(e.code, message, recovery, attemptsLeft, problems, text)

    private fun attemptsLeft(d: JSONObject?): Int? =
        if (d != null && d.has("attemptsLeft")) d.optInt("attemptsLeft") else null

    private fun attemptsSuffix(left: Int?): String = when (left) {
        null -> ""
        1 -> " You have 1 attempt left."
        else -> " You have $left attempts left."
    }

    private fun attemptsSuffixText(left: Int?): UiText =
        if (left == null) UiText.Raw("") else UiText.Plural(R.plurals.vc_attempts_left, left)

    /**
     * details.failures is `[{code, message}]` from the backend; some builds may send plain strings.
     * Returns the English lines and, in the same order, what to show; a code missing from [texts] shows the server's own wording.
     */
    private fun problemsFrom(d: JSONObject?, table: Map<String, String>, texts: Map<String, Int>): Pair<List<String>, List<UiText>> {
        val arr = d?.optJSONArray("failures") ?: return emptyList<String>() to emptyList()
        val out = ArrayList<String>()
        val shown = ArrayList<UiText>()
        for (i in 0 until arr.length()) {
            val item = arr.opt(i)
            val code: String?
            val serverMsg: String?
            if (item is JSONObject) {
                code = item.optString("code").takeIf { it.isNotEmpty() }
                serverMsg = item.optString("message").takeIf { it.isNotEmpty() }
            } else {
                code = item?.toString()
                serverMsg = null
            }
            val text = (code?.let { table[it] }) ?: serverMsg ?: code ?: continue
            if (text !in out) {
                out += text
                val resId = code?.let { texts[it] }
                shown += if (resId != null) UiText.Res(resId) else UiText.Raw(text)
            }
        }
        return out to shown
    }

    /** One line per documented `details.failures[].code` for the reference gate. */
    val REFERENCE_MESSAGES: Map<String, String> = mapOf(
        "too_short" to "It's too short. Record at least 8 seconds of continuous speech (30 to 60 seconds works best).",
        "too_long" to "It's too long. Use at most 2 minutes.",
        "not_enough_speech" to "Less than half of it is speech. Talk continuously with few pauses.",
        "too_noisy" to "There's too much background noise. Record in a quiet room close to the microphone.",
        "clipped" to "It's distorted. Move the microphone further away or speak more softly, then record again.",
        "multiple_speakers" to "It seems to contain more than one voice. Use a recording of only the voice you're cloning.",
        "music_detected" to "Music or background audio was detected. Use a clean recording of speech only."
    )

    private val REFERENCE_TEXTS: Map<String, Int> = mapOf(
        "too_short" to R.string.vc_ref_too_short,
        "too_long" to R.string.vc_ref_too_long,
        "not_enough_speech" to R.string.vc_ref_not_enough_speech,
        "too_noisy" to R.string.vc_ref_too_noisy,
        "clipped" to R.string.vc_ref_clipped,
        "multiple_speakers" to R.string.vc_ref_multiple_speakers,
        "music_detected" to R.string.vc_ref_music_detected
    )

    val CONSENT_CLIP_MESSAGES: Map<String, String> = mapOf(
        "too_short" to "It's too short. Read the whole phrase.",
        "too_long" to "It's too long. Read only the phrase.",
        "music_detected" to "Music or background audio was detected. Record in a quiet place."
    )

    private val CONSENT_CLIP_TEXTS: Map<String, Int> = mapOf(
        "too_short" to R.string.vc_consent_too_short,
        "too_long" to R.string.vc_consent_too_long,
        "music_detected" to R.string.vc_consent_music_detected
    )
}
