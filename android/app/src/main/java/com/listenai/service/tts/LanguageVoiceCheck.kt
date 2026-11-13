package com.listenai.service.tts

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import com.listenai.R
import com.listenai.service.FirebaseAnalyticsHelper
import com.listenai.service.LanguageDetector
import com.listenai.service.tts.chain.CloudVoicePolicy
import com.listenai.service.tts.chain.LanguageVoiceState
import com.listenai.service.tts.chain.TtsChainProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.Locale

/** What to do right after an import, given what the phone can speak. */
object LanguageVoiceCheck {

    /** A language other than English is read by the phone's engine, so English never needs a warning. */
    fun needsCheck(language: String?): Boolean {
        val code = language?.let { LanguageChoice.normalize(it) }
        return !code.isNullOrBlank() && code != LanguageDetector.DEFAULT
    }

    /** Only a language the phone cannot speak right now is worth a warning. */
    fun shouldWarn(state: LanguageVoiceState): Boolean = state != LanguageVoiceState.USABLE

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Called when an import finishes with the detected [language]. Looks at the phone's voices off the main thread,
     * never delaying the move to the reader, and shows a one-line notice if the language cannot be spoken yet.
     */
    fun afterImport(context: Context, language: String?) {
        if (!needsCheck(language)) return
        val app = context.applicationContext
        val code = LanguageChoice.normalize(language!!)
        scope.launch {
            val state = runCatching { TtsChainProvider.get(app).system.voiceState(code) }.getOrNull() ?: return@launch
            if (shouldWarn(state)) {
                runCatching {
                    FirebaseAnalyticsHelper.logLangNoVoice(code, state == LanguageVoiceState.LISTED_UNUSABLE, Locale.getDefault().language)
                }
                // The ReadAloud API has a voice for it (Spanish): reading will work online, so no warning.
                val cloud = runCatching { CloudVoicePolicy.voiceFor(code, TtsChainProvider.get(app).catalog.voices()) }.getOrNull()
                if (cloud != null) return@launch
                val name = LanguageDetector.displayName(code) ?: code
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(app, app.getString(R.string.lang_no_voice_import_notice, name), Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
