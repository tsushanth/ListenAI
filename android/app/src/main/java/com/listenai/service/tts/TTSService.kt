package com.listenai.service.tts

import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import kotlinx.coroutines.flow.Flow
import java.util.UUID

/**
 * Interface for text-to-speech synthesis services.
 * Implementations can use on-device synthesis (Android TTS) or cloud-based APIs.
 */
interface TTSService {

    /** The voice provider this service uses */
    val provider: VoiceProvider

    /** Whether the service is currently available */
    suspend fun isAvailable(): Boolean

    /** Maximum text length supported per synthesis request */
    val maxTextLength: Int

    /** Whether the service supports streaming synthesis */
    val supportsStreaming: Boolean

    /** Whether the service supports SSML input */
    val supportsSSML: Boolean

    /**
     * Synthesize text to an audio file
     */
    suspend fun synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions = SynthesisOptions.DEFAULT
    ): SynthesisResult

    /**
     * Synthesize multiple sections with progress reporting
     */
    suspend fun synthesize(
        sections: List<TextSection>,
        voice: VoicePreset,
        options: SynthesisOptions = SynthesisOptions.DEFAULT,
        onProgress: (SynthesisProgress) -> Unit = {}
    ): SynthesisResult

    /**
     * Stream synthesis for real-time playback during generation
     */
    fun synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions = SynthesisOptions.DEFAULT
    ): Flow<AudioChunk>

    /**
     * Cancel an ongoing synthesis task
     */
    suspend fun cancelSynthesis(taskId: UUID)

    /**
     * Cancel all ongoing synthesis tasks
     */
    suspend fun cancelAllSynthesis()

    /**
     * Check if a voice is available for use
     */
    suspend fun isVoiceAvailable(voice: VoicePreset): Boolean

    /**
     * Get all available voices from this provider
     */
    suspend fun availableVoices(): List<VoicePreset>

    /**
     * Download a voice if it requires download
     */
    suspend fun downloadVoice(voice: VoicePreset)

    /**
     * Estimate synthesis cost and duration before processing
     */
    fun estimate(text: String, voice: VoicePreset): SynthesisEstimate
}

/**
 * Factory for creating TTS service instances
 */
object TTSServiceFactory {

    private var onDeviceService: OnDeviceTTSService? = null
    private var cloudService: CloudTTSService? = null
    private var realtimeTTSService: RealtimeTTSService? = null
    private var kokoroOnDeviceService: KokoroOnDeviceService? = null

    // TEMPORARY test-build switch: true routes the normal (non-cloned) cloud reading
    // path through RealtimeTTSService (api.readaloudai.org) instead of CloudTTSService
    // (listenai-backend.fly.dev). See RealtimeTTSService's class doc for what this
    // migration does and doesn't cover yet (single default voice, embedded test key).
    const val USE_REALTIME_TTS_FOR_TESTING = true

    /**
     * Get or create the on-device TTS service
     */
    fun getOnDeviceService(context: android.content.Context): OnDeviceTTSService {
        return onDeviceService ?: OnDeviceTTSService(context).also {
            onDeviceService = it
        }
    }

    /**
     * Get or create the cloud TTS service (listenai-backend.fly.dev / Chatterbox-Kokoro).
     */
    fun getCloudService(context: android.content.Context): CloudTTSService {
        return cloudService ?: CloudTTSService(context).also {
            cloudService = it
        }
    }

    /**
     * Get or create the realtime-tts platform TTS service (api.readaloudai.org).
     */
    fun getRealtimeTTSService(context: android.content.Context): RealtimeTTSService {
        return realtimeTTSService ?: RealtimeTTSService(context).also {
            realtimeTTSService = it
        }
    }

    /**
     * Get or create the on-device Kokoro service (ONNX Runtime).
     */
    fun getKokoroOnDeviceService(context: android.content.Context): KokoroOnDeviceService {
        return kokoroOnDeviceService ?: KokoroOnDeviceService(context).also {
            kokoroOnDeviceService = it
        }
    }

    /**
     * Get the appropriate service for a voice.
     *
     * For Kokoro voices (`VoiceProvider.SELF_HOSTED`), the routing now
     * consults the user's onboarding pick:
     *   - If they opted into on-device Kokoro **and** the model is on
     *     disk, route to [KokoroOnDeviceService].
     *   - Otherwise, route to the cloud (existing `listenai-tts-worker`).
     *
     * This makes the onboarding picker honest: if the user picked
     * on-device but the model hasn't finished downloading yet, the cloud
     * worker keeps serving audio in the interim — no broken state.
     */
    fun getServiceForVoice(
        context: android.content.Context,
        voice: VoicePreset,
        preferCloud: Boolean = true
    ): TTSService {
        // Honor explicit on-device routing for any voice tagged Kokoro
        // when the model is ready.
        if (voice.provider == VoiceProvider.KOKORO_ON_DEVICE ||
            (voice.provider == VoiceProvider.SELF_HOSTED &&
                shouldUseOnDeviceKokoro(context))) {
            val svc = getKokoroOnDeviceService(context)
            val onDisk = KokoroModelDownloader.getInstance(context).isModelOnDisk()
            val ready = svc.isInferenceReady()
            android.util.Log.i(
                "TTSServiceFactory",
                "getServiceForVoice: voice=${voice.providerVoiceId} provider=${voice.provider} onDisk=$onDisk ready=$ready"
            )
            // Block the on-device path until the inference engine is wired
            // up *and* the model is on disk. Until then, fall through to
            // cloud — the user's picker preference is preserved, just the
            // delivery uses cloud as the silent fallback.
            if (onDisk && ready) {
                android.util.Log.i("TTSServiceFactory", "Routing to on-device Kokoro")
                return svc
            } else {
                android.util.Log.i(
                    "TTSServiceFactory",
                    "On-device gate failed → falling back to cloud (onDisk=$onDisk, ready=$ready)"
                )
            }
        }
        return when {
            voice.provider == VoiceProvider.ANDROID -> getOnDeviceService(context)
            voice.provider.isCloud && preferCloud -> {
                if (USE_REALTIME_TTS_FOR_TESTING) getRealtimeTTSService(context) else getCloudService(context)
            }
            else -> getOnDeviceService(context)
        }
    }

    private fun shouldUseOnDeviceKokoro(context: android.content.Context): Boolean {
        return try {
            com.listenai.service.settings.SettingsManager.getInstance(context)
                .useOfflineKokoro.value
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Cleanup resources
     */
    fun shutdown() {
        onDeviceService?.shutdown()
        onDeviceService = null
        cloudService = null
    }
}
