package com.listenai.service.tts

import android.content.Context
import com.listenai.R

/**
 * The text of a [TTSError] in the user's language. [TTSError.message] stays English (logs, matching in
 * callers); anything shown on screen goes through here.
 */
object TTSErrorText {

    /** The localized text of [e], or its own [Throwable.message] when it is not a [TTSError] with a translated text. */
    fun resolve(context: Context, e: Throwable): String? = when (e) {
        is TTSError.SpeechUnavailable -> SpeechUnavailableText.resolve(context, e)
        is TTSError.VoiceNotAvailable -> context.getString(R.string.tts_err_voice_not_available, e.voiceName)
        is TTSError.VoiceDownloadRequired -> context.getString(R.string.tts_err_voice_download_required, e.voiceName)
        is TTSError.TextTooLong -> context.getString(R.string.tts_err_text_too_long, e.characterCount, e.limit)
        is TTSError.TextEmpty -> context.getString(R.string.tts_err_text_empty)
        is TTSError.QuotaExceeded ->
            context.resources.getQuantityString(R.plurals.tts_err_quota_exceeded, e.remaining, e.remaining, e.required)
        is TTSError.NetworkError -> context.getString(R.string.tts_err_network, e.underlying)
        is TTSError.ApiError -> context.getString(R.string.tts_err_api, e.provider, e.code, e.errorMessage)
        is TTSError.RateLimited -> {
            val seconds = e.retryAfterSeconds.toInt()
            context.resources.getQuantityString(R.plurals.tts_err_rate_limited, seconds, seconds)
        }
        is TTSError.AudioEncodingFailed -> context.getString(R.string.tts_err_audio_encoding, e.reason)
        is TTSError.Cancelled -> context.getString(R.string.tts_err_cancelled)
        is TTSError.SubscriptionRequired -> context.getString(R.string.tts_err_subscription_required, e.tier)
        is TTSError.InvalidConfiguration -> context.getString(R.string.tts_err_invalid_configuration, e.reason)
        is TTSError.SynthesisTimeout -> context.getString(R.string.tts_err_timeout)
        is TTSError.UnsupportedLanguage -> context.getString(R.string.tts_err_unsupported_language, e.language)
        else -> e.message
    }
}
