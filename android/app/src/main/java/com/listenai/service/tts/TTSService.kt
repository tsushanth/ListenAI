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

    /**
     * Get or create the on-device TTS service
     */
    fun getOnDeviceService(context: android.content.Context): OnDeviceTTSService {
        return onDeviceService ?: OnDeviceTTSService(context).also {
            onDeviceService = it
        }
    }

    /**
     * Get or create the cloud TTS service
     */
    fun getCloudService(context: android.content.Context): CloudTTSService {
        return cloudService ?: CloudTTSService(context).also {
            cloudService = it
        }
    }

    /**
     * Get the appropriate service for a voice
     */
    fun getServiceForVoice(
        context: android.content.Context,
        voice: VoicePreset,
        preferCloud: Boolean = true
    ): TTSService {
        return when {
            voice.provider == VoiceProvider.ANDROID -> getOnDeviceService(context)
            voice.provider.isCloud && preferCloud -> getCloudService(context)
            else -> getOnDeviceService(context)
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
