package com.listenai.systemtts

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.SynthesisCallback
import android.speech.tts.SynthesisRequest
import android.speech.tts.TextToSpeech
import android.speech.tts.TextToSpeechService
import android.speech.tts.Voice
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.listenai.data.models.VoicePreset
import com.listenai.service.tts.ChatterboxModelDownloader
import com.listenai.service.tts.ChatterboxOnDeviceService
import com.listenai.service.tts.KokoroModelDownloader
import com.listenai.service.tts.KokoroOnDeviceService
import com.listenai.service.tts.SynthesisOptions
import com.listenai.service.tts.TTSServiceFactory
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.FileInputStream
import java.io.IOException
import java.util.Locale

/**
 * System-level TTS engine for ReadAloud AI.
 *
 * Registered with the Android framework — selected via
 * `Settings → Accessibility → Text-to-speech output`. Once chosen, the
 * voices defined in [VoiceCatalog] become available to every app on the
 * device that uses Android's `TextToSpeech` API (TalkBack, Maps, Kindle…).
 *
 * ## Milestones
 *   M1 ✅ — service discoverable; silent output
 *   M2 ✅ — real audio via [TTSCoordinator]; voice catalog wired
 *   M3 ⏳ — on-device Kokoro for <100ms TalkBack latency (long pole)
 *   M4 ⏳ — in-Settings voice catalog UX + voice-pack purchases (RevenueCat)
 *   M5 ⏳ — multi-locale once Kokoro multilingual is production-ready
 */
class ReadAloudTTSService : TextToSpeechService() {

    private val tag = "ReadAloudTTSService"

    /**
     * Texts ≤ this many characters that miss the prebuilt label cache
     * route through Piper (live VITS, ~600-800 ms on Pixel 9 Pro)
     * instead of Kokoro (~2-3 s). Longer texts stay on Kokoro because
     * Piper's per-token cost dominates above a sentence-length input
     * and Kokoro's streaming/chunking gets competitive there.
     */
    private val PIPER_MAX_CHARS = 80

    /**
     * Hard rule: this engine is **on-device only**. TalkBack / Maps / Kindle
     * hit it constantly — cloud round-trip latency makes the device feel broken
     * and forces the system reader to talk to the network all day.
     *
     * Synthesis routes directly to [com.listenai.service.tts.KokoroOnDeviceService]
     * via [TTSServiceFactory.getKokoroOnDeviceService]. We never fall back to
     * cloud — if the model isn't on disk, the synthesis returns an error and
     * the caller falls through to its default TTS engine.
     */
    private val onDevice
        get() = TTSServiceFactory.getKokoroOnDeviceService(applicationContext)

    private val chatterbox
        get() = ChatterboxOnDeviceService.getInstance(applicationContext)

    @Volatile
    private var currentLocale: Locale = Locale.US

    @Volatile
    private var stopRequested: Boolean = false

    /**
     * Tracks whether we've already kicked off a model download this service
     * lifecycle. Without this every TalkBack call would re-call
     * `startIfPossible()`, which is harmless (WorkManager dedupes) but would
     * spam the log + re-post the user-facing notification every couple of
     * seconds. Reset on `onCreate` (new lifecycle = new chance to notify).
     */
    @Volatile
    private var downloadKickedThisLifecycle: Boolean = false

    /**
     * Main-thread handler used to hop `startIfPossible()` calls onto the
     * UI looper — the downloader chains into `LiveData.observeForever`
     * which `assertMainThread()`s. `onSynthesizeText` runs on Android's
     * TTS SynthThread, so calling the downloader directly from there
     * crashes the entire service.
     */
    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Scope for fire-and-forget background work tied to the service lifetime.
     * Cancelled in [onDestroy] so warmup / refresh coroutines don't outlive
     * the service. SupervisorJob means one failure doesn't poison siblings.
     */
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onCreate() {
        super.onCreate()
        Log.i(tag, "ReadAloudTTSService created — voice catalog has ${VoiceCatalog.presets().size} built-in voices")
        onLoadLanguage("eng", "USA", "")
        // Kick off a background refresh of the user's cloned voices so they
        // appear in onGetVoices() after the backend round-trip completes.
        // Fire-and-forget — first onGetVoices() may not include clones yet.
        VoiceCatalog.refreshClonedVoices(applicationContext)
        // Pre-warm the on-device Kokoro session so the first user-triggered
        // synthesis — especially the first TalkBack call after a user picks
        // ReadAloud as the system TTS engine — doesn't pay the cold-start
        // cost of model load + G2P lexicon parse (typically 500-3000 ms).
        warmupKokoroInBackground()
        // Notification channel must exist before we ever post to it.
        ensureDownloadNotificationChannel()
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    /**
     * Asynchronously warm the Kokoro ONNX session + G2P lexicon so the
     * first user-visible synthesis hits a hot pipeline. Skips silently if
     * the model file isn't on disk yet (the user hasn't completed the
     * voice-model download); the next service start after download will
     * warm correctly.
     */
    private fun warmupKokoroInBackground() {
        serviceScope.launch {
            try {
                if (!KokoroModelDownloader.getInstance(applicationContext).isModelOnDisk()) {
                    Log.i(tag, "warmupKokoro: skipping — model not on disk yet")
                    return@launch
                }
                val t0 = System.currentTimeMillis()
                val ok = onDevice.isAvailable()
                Log.i(tag, "warmupKokoro: isAvailable=$ok in ${System.currentTimeMillis() - t0}ms")
            } catch (e: Exception) {
                Log.w(tag, "warmupKokoro: non-fatal — ${e.message}")
            }
        }
    }

    /**
     * Ensure the notification channel used by [notifyDownloadStarted] exists.
     * Idempotent: ``createNotificationChannel`` is a no-op for already-created
     * channels with the same id. API 26+ only (matches the app's minSdk).
     */
    private fun ensureDownloadNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            DOWNLOAD_CHANNEL_ID,
            "ReadAloud voice model download",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Notifies when ReadAloud begins downloading a TTS voice model in the background."
        }
        mgr.createNotificationChannel(channel)
    }

    /**
     * Post a one-shot notification telling the user the voice model has
     * started downloading. Suppressed silently if the user has revoked the
     * POST_NOTIFICATIONS permission on Android 13+ — a missing notification
     * is strictly better UX than a permission prompt mid-TalkBack.
     *
     * The notification taps through to the main ReadAloud app via the
     * package's launch intent.
     */
    private fun notifyDownloadStarted(isClonedVoice: Boolean) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val granted = ContextCompat.checkSelfPermission(
                    this, android.Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    Log.i(tag, "notifyDownloadStarted: POST_NOTIFICATIONS not granted — suppressing")
                    return
                }
            }
            val openApp = packageManager.getLaunchIntentForPackage(packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            val pi = if (openApp != null) {
                PendingIntent.getActivity(
                    this, 0, openApp,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            } else null

            val title = if (isClonedVoice) {
                "ReadAloud is downloading the voice cloning model"
            } else {
                "ReadAloud is downloading its voice model"
            }
            val body = "Downloading ~250 MB in the background. " +
                "Once it's ready your phone will speak with ReadAloud's voices."

            val notif = NotificationCompat.Builder(this, DOWNLOAD_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(true)
                .also { if (pi != null) it.setContentIntent(pi) }
                .build()

            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            mgr?.notify(DOWNLOAD_NOTIFICATION_ID, notif)
            Log.i(tag, "notifyDownloadStarted: posted (isCloned=$isClonedVoice)")
        } catch (e: Exception) {
            Log.w(tag, "notifyDownloadStarted: failed (non-fatal) — ${e.message}")
        }
    }

    // -------------------------------------------------------------------------
    // Locale support
    // -------------------------------------------------------------------------

    override fun onIsLanguageAvailable(lang: String?, country: String?, variant: String?): Int {
        // Android passes ISO-3 codes ("eng", "USA"). VoiceCatalog stores ISO-2 ("en", "US").
        val iso2Lang = iso3ToIso2(lang) ?: return TextToSpeech.LANG_NOT_SUPPORTED
        val iso2Country = iso3ToIso2Country(country) ?: ""
        return when {
            VoiceCatalog.languageCountrySupported(iso2Lang, iso2Country) -> TextToSpeech.LANG_COUNTRY_AVAILABLE
            VoiceCatalog.languageSupported(iso2Lang) -> TextToSpeech.LANG_AVAILABLE
            else -> TextToSpeech.LANG_NOT_SUPPORTED
        }
    }

    override fun onGetLanguage(): Array<String> {
        return arrayOf(
            currentLocale.isO3Language,
            currentLocale.isO3Country,
            currentLocale.variant ?: ""
        )
    }

    override fun onLoadLanguage(lang: String?, country: String?, variant: String?): Int {
        val available = onIsLanguageAvailable(lang, country, variant)
        if (available >= TextToSpeech.LANG_AVAILABLE) {
            val iso2Lang = iso3ToIso2(lang) ?: "en"
            val iso2Country = iso3ToIso2Country(country) ?: "US"
            currentLocale = Locale(iso2Lang, iso2Country)
            Log.i(tag, "Loaded language: $currentLocale")
        }
        return available
    }

    // -------------------------------------------------------------------------
    // Voices
    // -------------------------------------------------------------------------

    override fun onGetVoices(): MutableList<Voice> = VoiceCatalog.systemVoices()

    override fun onIsValidVoiceName(voiceName: String?): Int {
        return if (VoiceCatalog.isValid(voiceName)) TextToSpeech.SUCCESS else TextToSpeech.ERROR
    }

    override fun onLoadVoice(voiceName: String?): Int {
        // No upfront model load required — Kokoro voices share weights; cloud is stateless.
        return if (VoiceCatalog.isValid(voiceName)) TextToSpeech.SUCCESS else TextToSpeech.ERROR
    }

    override fun onGetDefaultVoiceNameFor(lang: String?, country: String?, variant: String?): String {
        val iso2Lang = iso3ToIso2(lang) ?: "en"
        val iso2Country = iso3ToIso2Country(country) ?: "US"
        // Respect the user's selection from TTSEngineSettingsActivity (or any
        // other in-app voice picker, since SettingsManager.selectedVoiceId
        // is the single source of truth). If the user has never picked a
        // voice, or their pick has been removed from the catalog, fall back
        // to the locale-specific default.
        val pref = com.listenai.service.settings.SettingsManager
            .getInstance(applicationContext).selectedVoiceId.value
            ?.takeIf { it.isNotBlank() }
        // When the user hasn't picked a voice yet, default to bella —
        // it's the preset whose providerVoiceId is af_heart, which is
        // also the voice the pre-rendered TalkBack label cache was
        // rendered in. Returning a different default (like rachel,
        // which maps to af_nicole and isn't bundled) means cache hits
        // get gated off for everyone who hasn't explicitly chosen
        // a voice. Bella is bundled, sounds the same as the cache,
        // and gives unset users the full fast-path benefit.
        // dorothy is the preset whose providerVoiceId is af_heart — same
        // voice the bundled TalkBack cache was rendered in. bella maps
        // to af_bella (different voice) so picking bella as the default
        // would gate off the entire bundled cache for unset users.
        return com.listenai.systemtts.VoiceCatalog.voiceNameForPresetId(pref ?: "dorothy")
            ?: VoiceCatalog.defaultVoiceName(iso2Lang, iso2Country, variant)
    }

    // -------------------------------------------------------------------------
    // Stop handling — break out of streaming loops cleanly.
    // -------------------------------------------------------------------------

    override fun onStop() {
        stopRequested = true
        Log.i(tag, "onStop()")
    }

    // -------------------------------------------------------------------------
    // The core: synthesis. Routes to the existing TTSCoordinator and streams
    // PCM back to the framework as it's produced.
    //
    // The Android TTS framework calls onSynthesizeText on a dedicated worker
    // thread, so runBlocking{} is the appropriate bridge to a suspending
    // coordinator call.
    // -------------------------------------------------------------------------

    override fun onSynthesizeText(request: SynthesisRequest?, callback: SynthesisCallback?) {
        if (request == null || callback == null) return
        stopRequested = false

        val text = request.charSequenceText?.toString().orEmpty()
        if (text.isBlank()) {
            callback.error()
            return
        }

        // Resolve voice FIRST so the fast-path gates can honor it. The
        // cache + Piper fast paths are both single-voice (af_heart for
        // cache, amy for Piper); if the user picked anything else we
        // MUST skip them or they hear the wrong voice. Same for rate:
        // the cache PCM is pre-rendered at 1.0x, and Piper's length_scale
        // is wired below, so cache hits require rate==100.
        val voiceName = request.voiceName ?: VoiceCatalog.defaultVoiceName(
            iso3ToIso2(request.language), iso3ToIso2Country(request.country), null
        )
        val preset = VoiceCatalog.resolvePreset(voiceName)
        if (preset == null) {
            Log.w(tag, "Unknown voice requested: $voiceName")
            callback.error()
            return
        }
        Log.i(tag, "voiceResolved request.voiceName='${request.voiceName}' fallback='$voiceName' preset=${preset.id} providerVoiceId=${preset.providerVoiceId}")

        val isClonedVoice = preset.id.startsWith("cloned_") || preset.providerModelId == "chatterbox"
        val voiceKey = preset.providerVoiceId ?: "af_heart"
        val isDefaultVoice = !isClonedVoice && voiceKey == "af_heart"
        val isDefaultRate = request.speechRate == 100

        // Voice cache routing strategy:
        //   1. Per-voice cache (filesDir/voice_cache/<voiceKey>/) — populated
        //      lazily by every Kokoro live synth completion. Hits give the
        //      user their chosen voice at near-zero latency. Built up over
        //      real TalkBack usage; first call for a new label is always
        //      a live miss that seeds the cache for next time.
        //   2. Bundled af_heart cache — only valid for the default voice
        //      at default rate. Otherwise serving it would play af_heart
        //      audio when the user asked for Josh.
        //   3. Piper live (amy-only) — only valid for the default voice.
        //   4. Kokoro live with the user's voice — the always-correct slow
        //      path, plus the lazy cache writer.
        if (isDefaultRate && !isClonedVoice) {
            val perVoiceStart = System.currentTimeMillis()
            val perVoice = try {
                PerVoiceCache.getInstance(applicationContext).lookup(text, voiceKey)
            } catch (t: Throwable) {
                Log.w(tag, "per-voice cache lookup threw (non-fatal): ${t.message}")
                null
            }
            if (perVoice != null) {
                Log.i(tag, "T_PER_VOICE_HIT text='${text.take(40)}' voice=$voiceKey lookup_ms=${System.currentTimeMillis() - perVoiceStart}")
                servePcmDirect(perVoice.pcm, perVoice.sampleRate, callback)
                return
            }
        }

        val canUseBundledCache = isDefaultVoice && isDefaultRate
        if (canUseBundledCache) {
            val cacheStartMs = System.currentTimeMillis()
            val cached = try {
                TalkbackLabelCache.getInstance(applicationContext).lookup(text)
            } catch (t: Throwable) {
                Log.w(tag, "cache lookup threw (non-fatal): ${t.message}")
                null
            }
            if (cached != null) {
                Log.i(tag, "T_CACHE_HIT text='${text.take(40)}' lookup_ms=${System.currentTimeMillis() - cacheStartMs} audio_ms=${cached.audioMs}")
                servePcmFromCache(cached, callback)
                return
            }
        }

        if (isDefaultVoice && text.length <= PIPER_MAX_CHARS) {
            val piperStart = System.currentTimeMillis()
            val pcm = try {
                PiperLiveSynth.synthesize(applicationContext, text, request.speechRate / 100f)
            } catch (t: Throwable) {
                Log.w(tag, "Piper synth threw (non-fatal): ${t.message}")
                ShortArray(0)
            }
            if (pcm.isNotEmpty()) {
                Log.i(tag, "T_PIPER_DONE text='${text.take(40)}' dt=${System.currentTimeMillis() - piperStart}ms samples=${pcm.size} rate=${request.speechRate}")
                servePcmDirect(pcm, PiperLiveSynth.sampleRate(), callback)
                return
            }
            Log.i(tag, "Piper returned empty PCM — falling through to Kokoro")
        }

        // Pick the right on-device path for this voice.
        //   Built-in voice → Kokoro
        //   Cloned voice   → Chatterbox (once downloaded; rejected otherwise)
        val (service, modelReady, kind) = if (isClonedVoice) {
            val ready = ChatterboxModelDownloader.getInstance(applicationContext).isReady()
            Triple<com.listenai.service.tts.TTSService, Boolean, String>(chatterbox, ready, "chatterbox")
        } else {
            val ready = KokoroModelDownloader.getInstance(applicationContext).isModelOnDisk()
            Triple<com.listenai.service.tts.TTSService, Boolean, String>(onDevice, ready, "kokoro")
        }

        if (!modelReady) {
            // Auto-trigger the model download in the background so a user who
            // simply selected ReadAloud as their system TTS engine ends up
            // working without having to also open the app + manually start a
            // download. The first few TalkBack / Maps / Kindle calls will
            // still error (we have nothing to speak yet) — but the model will
            // download, and subsequent calls will succeed once it lands.
            //
            // KokoroModelDownloader / ChatterboxModelDownloader both use
            // WorkManager with ExistingWorkPolicy.KEEP, so re-invoking from
            // every onSynthesizeText is safe and idempotent — the WorkManager
            // queue does the deduping for us.
            if (!downloadKickedThisLifecycle) {
                downloadKickedThisLifecycle = true
                if (isClonedVoice) {
                    Log.w(tag, "Chatterbox engine not on disk — kicking off background download. Subsequent calls will retry until ready.")
                } else {
                    Log.w(tag, "Kokoro voice model not on disk — kicking off background download. Subsequent calls will retry until ready.")
                }
                // Both downloaders chain into LiveData.observeForever(), which
                // requires the main thread. onSynthesizeText runs on the TTS
                // SynthThread, so hop onto the UI looper before invoking.
                // Notification posting is thread-safe so we batch it here too.
                mainHandler.post {
                    try {
                        if (isClonedVoice) {
                            ChatterboxModelDownloader.getInstance(applicationContext).startIfPossible()
                        } else {
                            KokoroModelDownloader.getInstance(applicationContext).startIfPossible()
                        }
                        notifyDownloadStarted(isClonedVoice)
                    } catch (e: Exception) {
                        Log.e(tag, "auto-download start failed (non-fatal) — ${e.message}", e)
                    }
                }
            }
            callback.error()
            return
        }

        Log.d(tag, "Synthesize on-device: kind=$kind voice=${preset.name} chars=${text.length}")

        runBlocking {
            try {
                val opts = SynthesisOptions.DEFAULT.copy(
                    speed = request.speechRate / 100f,    // Android rate is 100 = normal
                    pitch = request.pitch / 100f          // Android pitch is 100 = normal
                )
                if (service is KokoroOnDeviceService) {
                    streamKokoroChunksToCallback(service, text, preset, opts, callback)
                } else {
                    // Cloned voices still go through cloud round-trip + WAV file
                    // — keep the existing path until on-device Chatterbox lands.
                    val result = service.synthesize(text = text, voice = preset, options = opts)
                    streamWavToCallback(result.audioFile, callback)
                }
            } catch (e: NotImplementedError) {
                // Chatterbox inference still has TODOs (M2.6-5, M2.6-6).
                // Surface as a clean error so the caller falls through to
                // its default engine instead of hanging.
                Log.w(tag, "Synthesis path not yet wired ($kind): ${e.message}")
                callback.error()
            } catch (e: Exception) {
                Log.e(tag, "On-device synthesis failed ($kind)", e)
                callback.error()
            }
        }
    }

    /**
     * Streams freshly-synthesized 16-bit LE PCM (e.g. from Piper) to
     * the SynthesisCallback. Same plumbing as servePcmFromCache but
     * takes a ShortArray + sample rate directly instead of a cache
     * Hit. Used for the cache-miss-short-text Piper path.
     */
    private fun servePcmDirect(pcm: ShortArray, sampleRate: Int, callback: SynthesisCallback) {
        val rc = callback.start(sampleRate, AudioFormat.ENCODING_PCM_16BIT, 1)
        if (rc != TextToSpeech.SUCCESS) {
            Log.w(tag, "servePcmDirect: callback.start returned $rc")
            return
        }
        val maxBuf = callback.maxBufferSize.coerceAtLeast(2)
        // ShortArray → ByteArray (16-bit LE)
        val bytes = ByteArray(pcm.size * 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm)
        var offset = 0
        while (offset < bytes.size) {
            if (stopRequested) return
            val len = minOf(maxBuf, bytes.size - offset)
            val pushRc = callback.audioAvailable(bytes, offset, len)
            if (pushRc != TextToSpeech.SUCCESS) {
                Log.w(tag, "servePcmDirect: audioAvailable returned $pushRc")
                return
            }
            offset += len
        }
        callback.done()
    }

    /**
     * Cache-hit fast path: pre-rendered PCM straight to AudioTrack via
     * the SynthesisCallback. No model load, no inference, no chunking —
     * the only work is one assets read + one or two buffered writes.
     * Measured cost on Pixel 9 Pro: <100ms from onSynthesizeText entry
     * to first sample at the speaker, vs 1.9s for live Kokoro synthesis
     * of an equivalent short label.
     */
    private fun servePcmFromCache(hit: TalkbackLabelCache.Hit, callback: SynthesisCallback) {
        val audioFormat = when (hit.bitsPerSample) {
            16 -> AudioFormat.ENCODING_PCM_16BIT
            8 -> AudioFormat.ENCODING_PCM_8BIT
            else -> {
                Log.w(tag, "unsupported bitsPerSample=${hit.bitsPerSample} in cache hit — falling back to error")
                callback.error()
                return
            }
        }
        val rc = callback.start(hit.sampleRate, audioFormat, hit.channels)
        if (rc != TextToSpeech.SUCCESS) {
            Log.w(tag, "servePcmFromCache: callback.start returned $rc")
            return
        }
        val maxBuf = callback.maxBufferSize.coerceAtLeast(2)
        var offset = 0
        val pushStart = System.currentTimeMillis()
        Log.i(tag, "T_CACHE_PUSH_START=$pushStart bytes=${hit.pcm.size} max_buf=$maxBuf")
        while (offset < hit.pcm.size) {
            if (stopRequested) {
                Log.i(tag, "servePcmFromCache: stop requested mid-stream")
                return
            }
            val len = minOf(maxBuf, hit.pcm.size - offset)
            val pushRc = callback.audioAvailable(hit.pcm, offset, len)
            if (pushRc != TextToSpeech.SUCCESS) {
                Log.w(tag, "servePcmFromCache: audioAvailable returned $pushRc — abort")
                return
            }
            if (offset == 0) {
                Log.i(tag, "T_CACHE_FIRST_PUSH=${System.currentTimeMillis()} dt_from_push_start=${System.currentTimeMillis() - pushStart}ms")
            }
            offset += len
        }
        callback.done()
        Log.i(tag, "T_CACHE_DONE=${System.currentTimeMillis()} dt_from_push_start=${System.currentTimeMillis() - pushStart}ms")
    }

    /**
     * Built-in voice fast path: synth chunk-by-chunk and push each chunk's
     * PCM frames straight to [SynthesisCallback.audioAvailable] as soon as
     * the chunk completes. No WAV file ever lands on disk, and for
     * multi-chunk text TalkBack starts speaking the first chunk while the
     * second is still synthesizing.
     *
     * 24 kHz mono signed 16-bit LE PCM — Kokoro's native output format.
     */
    private suspend fun streamKokoroChunksToCallback(
        service: KokoroOnDeviceService,
        text: String,
        preset: VoicePreset,
        opts: SynthesisOptions,
        callback: SynthesisCallback,
    ) {
        val startRc = callback.start(
            24_000,
            AudioFormat.ENCODING_PCM_16BIT,
            /* channelCount = */ 1,
        )
        if (startRc != TextToSpeech.SUCCESS) {
            Log.w(tag, "streamKokoroChunksToCallback: callback.start returned $startRc — abort")
            return
        }
        val maxBuf = callback.maxBufferSize.coerceAtLeast(2)
        val svcEntryMs = System.currentTimeMillis()
        Log.i(tag, "T_SVC_ENTRY=$svcEntryMs chars=${text.length}")

        // Producer / consumer decoupling. The previous implementation pushed
        // each chunk's PCM through `callback.audioAvailable` inline, which
        // blocks until AudioTrack accepts the bytes (~chunk-audio-length).
        // That serialized chunk N+1 inference behind chunk N playback —
        // 2026-06-22 spectrogram showed 3.3-3.8s silence gaps between
        // chunks. Now: producer (the synthesizeChunkedPcm callback) enqueues
        // each chunk's bytes and returns immediately, freeing the synth
        // thread to start the next chunk; consumer (a dedicated thread)
        // drains the queue into AudioTrack at the framework's pace.
        // Bounded at 8 chunks so a slow consumer eventually backpressures
        // the producer rather than ballooning RAM on book-length input.
        val queue = LinkedBlockingQueue<ByteArray>(8)
        val sentinel = ByteArray(0)
        val pushedSomething = AtomicBoolean(false)
        val consumerAborted = AtomicBoolean(false)

        val consumer = thread(name = "ReadAloudTTS-AudioPush", start = true) {
            try {
                while (true) {
                    val bytes = queue.take()
                    if (bytes === sentinel) return@thread
                    if (stopRequested) {
                        consumerAborted.set(true)
                        return@thread
                    }
                    var offset = 0
                    while (offset < bytes.size) {
                        val len = minOf(maxBuf, bytes.size - offset)
                        val rc = callback.audioAvailable(bytes, offset, len)
                        if (rc != TextToSpeech.SUCCESS) {
                            Log.w(tag, "audioAvailable() returned $rc — abort streaming")
                            consumerAborted.set(true)
                            return@thread
                        }
                        offset += len
                    }
                    if (pushedSomething.compareAndSet(false, true)) {
                        Log.i(tag, "T_FIRST_AUDIO_PUSH=${System.currentTimeMillis()} dt_from_entry=${System.currentTimeMillis() - svcEntryMs}ms")
                    }
                }
            } catch (ie: InterruptedException) {
                consumerAborted.set(true)
            }
        }

        // Also accumulate the PCM so we can write it to the per-voice
        // cache once synthesis completes successfully. Only worth doing
        // for default-rate, sub-PIPER_MAX_CHARS utterances — TalkBack
        // labels, basically. Full paragraphs would balloon disk and
        // aren't repeated verbatim like UI labels are.
        val voiceKey = preset.providerVoiceId ?: "af_heart"
        val cacheableForPerVoice = opts.speed == 1.0f &&
                !preset.id.startsWith("cloned_") &&
                text.length <= PIPER_MAX_CHARS
        val accum = if (cacheableForPerVoice) ArrayList<ShortArray>(4) else null
        var accumSampleRate = 0

        val completed = service.synthesizeChunkedPcm(text, preset, opts) { pcm, sr ->
            if (stopRequested || consumerAborted.get()) return@synthesizeChunkedPcm false
            // ShortArray (signed 16-bit LE PCM) → ByteArray for audioAvailable.
            val bytes = ByteArray(pcm.size * 2)
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm)
            try {
                queue.put(bytes)   // backpressures if consumer falls 8 chunks behind
            } catch (ie: InterruptedException) {
                return@synthesizeChunkedPcm false
            }
            // Snapshot the chunk for per-voice caching. ShortArray is mutable
            // but synthesizeChunkedPcm doesn't reuse it across callbacks, so
            // capturing the reference is safe.
            if (accum != null) {
                accum.add(pcm)
                accumSampleRate = sr
            }
            true
        }
        // Signal end-of-stream to consumer, then wait for it to drain.
        try { queue.put(sentinel) } catch (ie: InterruptedException) { /* shutting down */ }
        consumer.join()

        if (completed && pushedSomething.get() && !consumerAborted.get()) {
            callback.done()
            // Best-effort: persist this synthesis to the per-voice cache so
            // the next request for the same label hits disk instead of
            // running Kokoro again. Fire-and-forget on a background thread —
            // disk write shouldn't block the synth-thread returning.
            if (accum != null && accumSampleRate > 0 && accum.isNotEmpty()) {
                val totalSamples = accum.sumOf { it.size }
                val merged = ShortArray(totalSamples)
                var off = 0
                for (chunk in accum) {
                    System.arraycopy(chunk, 0, merged, off, chunk.size)
                    off += chunk.size
                }
                val srToWrite = accumSampleRate
                val voiceToWrite = voiceKey
                val textToWrite = text
                serviceScope.launch {
                    try {
                        PerVoiceCache.getInstance(applicationContext)
                            .store(textToWrite, voiceToWrite, merged, srToWrite)
                    } catch (t: Throwable) {
                        Log.w(tag, "per-voice cache store threw (non-fatal): ${t.message}")
                    }
                }
            }
        } else if (!pushedSomething.get()) {
            // synthesis returned no audio (e.g. all chunks empty after tokenization)
            Log.w(tag, "streamKokoroChunksToCallback: no PCM produced — signalling error")
            callback.error()
        }
        // If cancelled mid-stream (completed=false but pushedSomething=true),
        // the framework already has partial audio — we deliberately skip
        // callback.done() so AudioTrack stops cleanly rather than playing
        // remnant bytes after a stop request.
    }

    /**
     * Reads a PCM WAV file and streams the audio data to [callback] via
     * [SynthesisCallback.audioAvailable]. Parses the `fmt ` chunk to discover
     * sample rate and channel count, then locates the `data` chunk and
     * forwards its bytes in chunks no larger than [SynthesisCallback.getMaxBufferSize].
     *
     * Skips any non-`fmt `/non-`data` chunks (LIST, INFO, etc.) emitted by
     * ffmpeg or other encoders.
     */
    private fun streamWavToCallback(file: java.io.File, callback: SynthesisCallback) {
        FileInputStream(file).use { fis ->
            // RIFF header: "RIFF" <size:4> "WAVE"
            val riff = ByteArray(12)
            if (fis.read(riff) < 12) {
                Log.w(tag, "WAV: short read on RIFF header")
                callback.error()
                return
            }
            if (String(riff, 0, 4) != "RIFF" || String(riff, 8, 4) != "WAVE") {
                Log.w(tag, "WAV: not a RIFF/WAVE file")
                callback.error()
                return
            }

            var sampleRate = 0
            var channels = 0

            // Walk chunks until we find fmt + data.
            while (true) {
                val chunkHead = ByteArray(8)
                if (fis.read(chunkHead) < 8) {
                    Log.w(tag, "WAV: ran out of chunks before data")
                    callback.error()
                    return
                }
                val chunkId = String(chunkHead, 0, 4)
                val chunkSize = readLEInt(chunkHead, 4)

                when (chunkId) {
                    "fmt " -> {
                        val fmt = ByteArray(chunkSize)
                        if (fis.read(fmt) < chunkSize) {
                            callback.error()
                            return
                        }
                        // fmt layout (PCM): 2B audioFormat | 2B channels | 4B sampleRate ...
                        channels = readLEShort(fmt, 2)
                        sampleRate = readLEInt(fmt, 4)
                        Log.d(tag, "WAV fmt: rate=$sampleRate channels=$channels")
                    }
                    "data" -> {
                        if (sampleRate == 0 || channels == 0) {
                            Log.w(tag, "WAV: data before fmt — aborting")
                            callback.error()
                            return
                        }
                        if (callback.start(sampleRate, AudioFormat.ENCODING_PCM_16BIT, channels)
                            != TextToSpeech.SUCCESS
                        ) {
                            Log.w(tag, "callback.start() rejected ${sampleRate}Hz / ${channels}ch")
                            return
                        }
                        forwardPcm(fis, chunkSize.toLong() and 0xFFFFFFFFL, callback)
                        callback.done()
                        return
                    }
                    else -> {
                        // Unknown chunk (LIST, INFO, fact, etc.) — skip.
                        val skipped = fis.skip(chunkSize.toLong())
                        if (skipped < chunkSize) {
                            callback.error()
                            return
                        }
                    }
                }
            }
        }
    }

    /** Streams [remaining] bytes from [fis] into [callback] in chunks. */
    private fun forwardPcm(fis: FileInputStream, remaining: Long, callback: SynthesisCallback) {
        val chunkSize = callback.maxBufferSize.coerceAtMost(8192).coerceAtLeast(512)
        val buffer = ByteArray(chunkSize)
        var left = remaining
        while (left > 0 && !stopRequested) {
            val toRead = minOf(buffer.size.toLong(), left).toInt()
            val read = fis.read(buffer, 0, toRead)
            if (read <= 0) break
            val result = callback.audioAvailable(buffer, 0, read)
            if (result != TextToSpeech.SUCCESS) {
                Log.w(tag, "audioAvailable() returned $result — abort")
                return
            }
            left -= read
        }
    }

    // -------------------------------------------------------------------------
    // Little-endian byte helpers
    // -------------------------------------------------------------------------

    private fun readLEInt(b: ByteArray, off: Int): Int {
        return (b[off].toInt() and 0xff) or
            ((b[off + 1].toInt() and 0xff) shl 8) or
            ((b[off + 2].toInt() and 0xff) shl 16) or
            ((b[off + 3].toInt() and 0xff) shl 24)
    }

    private fun readLEShort(b: ByteArray, off: Int): Int {
        return (b[off].toInt() and 0xff) or
            ((b[off + 1].toInt() and 0xff) shl 8)
    }

    // -------------------------------------------------------------------------
    // ISO-3 → ISO-2 mapping. Android's TTS API uses ISO-3 ("eng", "USA"); the
    // rest of the app uses ISO-2 ("en", "US"). Keep the mapping narrow until
    // M5 expands the supported set.
    // -------------------------------------------------------------------------

    private fun iso3ToIso2(iso3: String?): String? {
        return when (iso3?.lowercase()) {
            "eng" -> "en"
            "spa" -> "es"
            "fra" -> "fr"
            "deu", "ger" -> "de"
            "ita" -> "it"
            "por" -> "pt"
            "jpn" -> "ja"
            "kor" -> "ko"
            "zho", "chi" -> "zh"
            "hin" -> "hi"
            "ara" -> "ar"
            "rus" -> "ru"
            null -> null
            else -> null
        }
    }

    private fun iso3ToIso2Country(iso3: String?): String? {
        return when (iso3?.uppercase()) {
            "USA" -> "US"
            "GBR" -> "GB"
            "ESP" -> "ES"
            "MEX" -> "MX"
            "FRA" -> "FR"
            "DEU" -> "DE"
            "ITA" -> "IT"
            "BRA" -> "BR"
            "PRT" -> "PT"
            "JPN" -> "JP"
            "KOR" -> "KR"
            "CHN" -> "CN"
            "IND" -> "IN"
            "ARE", "SAU" -> "AE"
            "RUS" -> "RU"
            null -> null
            else -> iso3
        }
    }

    companion object {
        private const val DOWNLOAD_CHANNEL_ID = "readaloud_tts_model_download"
        // 0x52 0x41 0x54 = "RAT" (ReadAloud TTS). Pick anything unique within
        // the app's notification ID namespace — KokoroDownloadWorker uses
        // NOTIFICATION_ID inside its own foreground service notification, so
        // they don't collide.
        private const val DOWNLOAD_NOTIFICATION_ID = 0x52415401
    }
}
