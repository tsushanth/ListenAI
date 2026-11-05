package com.listenai.service.tts.chain

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume

/**
 * The phone's own TextToSpeech engine, chosen explicitly (see [TtsEnginePicker]): never the system default, which
 * may be ReadAloud's own engine and would send this request straight back into the API path.
 *
 * Before speaking it checks that the engine can really speak the language now: `isLanguageAvailable`, and that the
 * default voice for it is installed and (when we are offline) does not need the network.
 */
class SystemTtsSource(
    context: Context,
    private val isOnline: () -> Boolean,
    /** Test/benchmark hook: use this engine package if it is installed, instead of the preference order. */
    private val forcedEngine: String? = null,
) : TtsSource {

    private val app = context.applicationContext
    override val id = SourceId.SYSTEM

    private val lock = Mutex()
    private var engine: TextToSpeech? = null
    private var enginePackage: String? = null

    /** Packages that declare a TextToSpeechService. Needs the TTS_SERVICE `<queries>` entry in the manifest. */
    fun installedEngines(): List<String> {
        val pm = app.packageManager
        val intent = Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE)
        @Suppress("DEPRECATION")
        return pm.queryIntentServices(intent, 0).mapNotNull { it.serviceInfo?.packageName }.distinct()
    }

    fun chosenEngine(): String? {
        val installed = installedEngines()
        if (forcedEngine != null && forcedEngine in installed && !forcedEngine.startsWith("com.listenai")) return forcedEngine
        return TtsEnginePicker.pick(installed, app.packageName)
    }

    private suspend fun ensureEngine(): TextToSpeech? {
        engine?.let { return it }
        val pkg = chosenEngine() ?: return null
        val tts = withTimeoutOrNull(INIT_TIMEOUT_MS) {
            suspendCancellableCoroutine<TextToSpeech?> { cont ->
                var created: TextToSpeech? = null
                created = TextToSpeech(app, { status ->
                    if (cont.isActive) cont.resume(if (status == TextToSpeech.SUCCESS) created else null)
                }, pkg)
                cont.invokeOnCancellation { created?.shutdown() }
            }
        }
        if (tts != null) { engine = tts; enginePackage = pkg }
        return tts
    }

    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = lock.withLock {
        val tts = ensureEngine() ?: return FallbackReason.ENGINE_MISSING
        val locale = localeFor(request.language)
        val avail = tts.isLanguageAvailable(locale)
        if (avail < TextToSpeech.LANG_AVAILABLE) return FallbackReason.LANGUAGE_MISSING
        // The language can be "available" yet its voice not installed, or installed only as a network voice.
        val voices = try { tts.voices } catch (e: Exception) { null }
        val forLang = voices?.filter { it.locale.language == locale.language }
        if (forLang != null && forLang.isNotEmpty()) {
            val usable = forLang.any { v ->
                !v.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) &&
                    (!v.isNetworkConnectionRequired || isOnline())
            }
            if (!usable) return FallbackReason.LANGUAGE_MISSING
        }
        null
    }

    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk = lock.withLock {
        val tts = ensureEngine() ?: throw SourceFailure(FallbackReason.ENGINE_MISSING)
        val locale = localeFor(request.language)
        tts.language = locale
        tts.setSpeechRate(request.speed.coerceIn(0.25f, 4f))
        val file = File.createTempFile("sys_tts_", ".wav", app.cacheDir)
        val utt = UUID.randomUUID().toString()
        val done = CompletableDeferred<Boolean>()
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { if (utteranceId == utt) done.complete(true) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { if (utteranceId == utt) done.complete(false) }
            override fun onError(utteranceId: String?, errorCode: Int) { if (utteranceId == utt) done.complete(false) }
        })
        try {
            val rc = tts.synthesizeToFile(text, Bundle(), file, utt)
            if (rc != TextToSpeech.SUCCESS) throw SourceFailure(FallbackReason.ENGINE_MISSING, message = "synthesizeToFile rc=$rc")
            val ok = try { done.await() } catch (e: kotlinx.coroutines.CancellationException) { tts.stop(); throw e }
            if (!ok) throw SourceFailure(FallbackReason.LANGUAGE_MISSING, message = "engine reported an error")
            val pcm = Pcm.parseWav(file.readBytes()) ?: throw SourceFailure(FallbackReason.SERVER_ERROR, message = "engine wrote no PCM16 WAV")
            if (pcm.pcm.isEmpty()) throw SourceFailure(FallbackReason.SERVER_ERROR, message = "engine wrote no audio")
            pcm
        } finally {
            file.delete()
        }
    }

    fun release() {
        engine?.shutdown(); engine = null; enginePackage = null
    }

    /** Intent that asks the chosen engine to download voice data for [language]; null if there is no engine. */
    fun installVoiceDataIntent(): Intent? {
        val pkg = chosenEngine() ?: return null
        return Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    companion object {
        private const val INIT_TIMEOUT_MS = 5_000L
        private const val TAG = "SystemTtsSource"

        fun localeFor(language: String): Locale = Locale.forLanguageTag(language.replace('_', '-')).let {
            if (it.language == "en" && it.country.isEmpty()) Locale.US else it
        }
    }
}
