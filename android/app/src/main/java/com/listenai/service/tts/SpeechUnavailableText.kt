package com.listenai.service.tts

import android.content.Context
import com.listenai.R
import com.listenai.service.LanguageDetector

/** The message for "no speech source worked", in the user's language instead of the English text inside the error. */
object SpeechUnavailableText {

    /** The string resource for [kind], or null for [TTSError.SpeechUnavailable.Kind.OTHER] (use the error's own text). */
    fun messageRes(kind: TTSError.SpeechUnavailable.Kind): Int? = when (kind) {
        TTSError.SpeechUnavailable.Kind.NO_VOICE_DATA -> R.string.lang_no_voice_message
        TTSError.SpeechUnavailable.Kind.NO_ENGINE -> R.string.speech_no_engine_message
        TTSError.SpeechUnavailable.Kind.OFFLINE -> R.string.speech_offline_message
        TTSError.SpeechUnavailable.Kind.BUSY -> R.string.speech_busy_message
        TTSError.SpeechUnavailable.Kind.OTHER -> null
    }

    fun resolve(context: Context, e: TTSError.SpeechUnavailable): String {
        val res = messageRes(e.kind) ?: return e.userMessage
        return if (e.kind == TTSError.SpeechUnavailable.Kind.NO_VOICE_DATA) {
            val lang = e.installVoiceLanguage
            context.getString(res, lang?.let { LanguageDetector.displayName(it) } ?: lang.orEmpty())
        } else {
            context.getString(res)
        }
    }
}
