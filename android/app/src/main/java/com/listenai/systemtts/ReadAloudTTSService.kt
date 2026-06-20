package com.listenai.systemtts

import android.media.AudioFormat
import android.speech.tts.SynthesisCallback
import android.speech.tts.SynthesisRequest
import android.speech.tts.TextToSpeech
import android.speech.tts.TextToSpeechService
import android.speech.tts.Voice
import android.util.Log
import com.listenai.data.models.VoicePreset
import com.listenai.service.tts.ChatterboxModelDownloader
import com.listenai.service.tts.ChatterboxOnDeviceService
import com.listenai.service.tts.KokoroModelDownloader
import com.listenai.service.tts.SynthesisOptions
import com.listenai.service.tts.TTSServiceFactory
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
        return VoiceCatalog.defaultVoiceName(iso2Lang, iso2Country, variant)
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

        val voiceName = request.voiceName ?: VoiceCatalog.defaultVoiceName(
            iso3ToIso2(request.language), iso3ToIso2Country(request.country), null
        )
        val preset = VoiceCatalog.resolvePreset(voiceName)
        if (preset == null) {
            Log.w(tag, "Unknown voice requested: $voiceName")
            callback.error()
            return
        }

        val isClonedVoice = preset.id.startsWith("cloned_") || preset.providerModelId == "chatterbox"

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
            if (isClonedVoice) {
                Log.w(tag, "Refusing cloned voice — Chatterbox engine not on disk. Open ReadAloud → TTS settings → Enable cloned voices system-wide.")
            } else {
                Log.w(tag, "Refusing — Kokoro voice model not on disk. Open ReadAloud → TTS settings → Download voice model.")
            }
            callback.error()
            return
        }

        Log.d(tag, "Synthesize on-device: kind=$kind voice=${preset.name} chars=${text.length}")

        runBlocking {
            try {
                val result = service.synthesize(
                    text = text,
                    voice = preset,
                    options = SynthesisOptions.DEFAULT.copy(
                        speed = request.speechRate / 100f,    // Android rate is 100 = normal
                        pitch = request.pitch / 100f          // Android pitch is 100 = normal
                    )
                )
                streamWavToCallback(result.audioFile, callback)
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
}
