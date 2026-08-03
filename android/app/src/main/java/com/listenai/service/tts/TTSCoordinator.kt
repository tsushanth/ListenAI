package com.listenai.service.tts

import android.content.Context
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import com.listenai.data.models.VoiceQuality
import com.listenai.service.usage.UsageTrackerService
import com.listenai.service.voice.VoiceCloningService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext

/**
 * Coordinates TTS synthesis using self-hosted Kokoro TTS (GPU-accelerated).
 * All voices use the same high-quality backend for unlimited usage.
 */
class TTSCoordinator(
    private val context: Context,
    private val usageTracker: UsageTrackerService
) {
    // Quality preference (now single quality level)
    private val _selectedQuality = MutableStateFlow(VoiceQuality.STANDARD)
    val selectedQuality: StateFlow<VoiceQuality> = _selectedQuality

    // Default settings
    var defaultSpeed: Float = 1.0f
    var defaultPitch: Float = 1.0f

    // Services - using self-hosted Kokoro TTS
    private val selfHostedService by lazy { SelfHostedTTSService.getInstance(context) }

    /**
     * Set the preferred quality level (kept for API compatibility)
     */
    fun setQuality(quality: VoiceQuality) {
        _selectedQuality.value = quality
    }

    /**
     * Synthesize text using Kokoro TTS
     */
    suspend fun synthesize(
        text: String,
        voice: VoicePreset,
        quality: VoiceQuality = _selectedQuality.value,
        options: SynthesisOptions = SynthesisOptions.DEFAULT,
        forceOnDevice: Boolean = false,
        onProgress: (SynthesisProgress) -> Unit = {}
    ): SynthesisResult = withContext(Dispatchers.IO) {
        // Apply default settings
        val adjustedOptions = options.copy(
            speed = if (options.speed == SynthesisOptions.DEFAULT.speed) defaultSpeed else options.speed,
            pitch = if (options.pitch == SynthesisOptions.DEFAULT.pitch) defaultPitch else options.pitch
        )

        // All synthesis uses self-hosted Kokoro
        synthesizeWithKokoro(text, voice, adjustedOptions, forceOnDevice, onProgress)
    }

    /**
     * Synthesize using Kokoro TTS (GPU-accelerated, unlimited)
     * Routes cloned voices to the dedicated Chatterbox endpoint.
     */
    private suspend fun synthesizeWithKokoro(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        forceOnDevice: Boolean = false,
        onProgress: (SynthesisProgress) -> Unit
    ): SynthesisResult {
        // Check if this is a cloned voice (ID starts with "cloned_" or uses Chatterbox model)
        val isClonedVoice = voice.id.startsWith("cloned_") || voice.providerModelId == "chatterbox"

        android.util.Log.d("TTSCoordinator", "Synthesizing: voice=${voice.name}, voiceId=${voice.providerVoiceId}, isCloned=$isClonedVoice, textLength=${text.length}")

        // Route cloned voices to the dedicated cloned voice synthesis endpoint
        if (isClonedVoice) {
            val voiceId = voice.providerVoiceId

            if (voiceId.isNullOrEmpty()) {
                android.util.Log.e("TTSCoordinator", "Cloned voice missing voiceId: voiceId=$voiceId")
                throw TTSError.InvalidConfiguration("Cloned voice configuration is incomplete")
            }

            // Fetch fresh cloned voice details from server (like iOS does)
            // This ensures we have the correct audio URL
            val voiceCloningService = VoiceCloningService.getInstance(context)
            val clonedVoices = try {
                voiceCloningService.listClonedVoices()
            } catch (e: Exception) {
                android.util.Log.e("TTSCoordinator", "Failed to fetch cloned voices: ${e.message}")
                emptyList()
            }

            val clonedVoice = clonedVoices.find { it.id == voiceId }
            val voiceUrl = clonedVoice?.audioUrl ?: voice.sampleAudioUrl

            if (voiceUrl.isNullOrEmpty()) {
                android.util.Log.e("TTSCoordinator", "Cloned voice missing voiceUrl: voiceId=$voiceId, clonedVoice=$clonedVoice")
                throw TTSError.InvalidConfiguration("Cloned voice audio URL not found")
            }

            android.util.Log.d("TTSCoordinator", "Using cloned voice synthesis: voiceId=$voiceId, voiceUrl=$voiceUrl")

            val result = selfHostedService.synthesizeCloned(
                text = text,
                voiceId = voiceId,
                voiceUrl = voiceUrl,
                speed = options.speed,
                onProgress = onProgress
            )

            // Track usage
            usageTracker.trackStandardUsage(
                charactersUsed = text.length,
                voiceId = voiceId,
                articleId = null,
                articleTitle = null
            )

            return result
        }

        // For built-in voices, use Kokoro
        val voiceId = voice.kokoroVoiceId ?: voice.getVoiceIdForQuality(VoiceQuality.STANDARD)

        android.util.Log.d("TTSCoordinator", "Using Kokoro synthesis: voiceId=$voiceId")

        val synthVoice = voice.copy(
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = voiceId
        )

        val section = TextSection(
            index = 0,
            type = SectionType.PARAGRAPH,
            text = text,
            characterRange = 0 until text.length
        )

        // Route through TTSServiceFactory so the on-device Kokoro path is
        // honored when the user opted in AND the ONNX session is loaded.
        // The factory transparently falls back to the cloud worker if not.
        // forceOnDevice bypasses that automatic routing — used by the
        // "queue is busy, use offline AI" CTA (see CloudTTSProgressCard)
        // when the user explicitly chooses to skip a busy cloud queue.
        val service = if (forceOnDevice) {
            TTSServiceFactory.getKokoroOnDeviceService(context)
        } else {
            TTSServiceFactory.getServiceForVoice(context, synthVoice)
        }
        android.util.Log.d(
            "TTSCoordinator",
            "Picked service=${service::class.java.simpleName} for voiceId=$voiceId"
        )

        val result = service.synthesize(
            sections = listOf(section),
            voice = synthVoice,
            options = options,
            onProgress = onProgress
        )

        // Track usage (no quota impact - unlimited)
        usageTracker.trackStandardUsage(
            charactersUsed = text.length,
            voiceId = voiceId,
            articleId = null,
            articleTitle = null
        )

        return result
    }

    /**
     * Synthesize long text with progressive chunking
     */
    suspend fun synthesizeLong(
        text: String,
        voice: VoicePreset,
        quality: VoiceQuality = _selectedQuality.value,
        onChunkReady: suspend (audioData: ByteArray, chunkIndex: Int, totalChunks: Int) -> Unit
    ) {
        selfHostedService.synthesizeLong(
            text = text,
            voice = voice,
            speed = defaultSpeed,
            onChunkReady = onChunkReady
        )

        // Track usage
        usageTracker.trackStandardUsage(
            charactersUsed = text.length,
            voiceId = voice.kokoroVoiceId ?: voice.providerVoiceId,
            articleId = null,
            articleTitle = null
        )
    }

    /**
     * Estimate synthesis before processing
     */
    fun estimate(
        text: String,
        voice: VoicePreset,
        quality: VoiceQuality = _selectedQuality.value
    ): SynthesisEstimate {
        return selfHostedService.estimate(text, voice)
    }

    /**
     * Get available voices
     */
    suspend fun getAvailableVoices(quality: VoiceQuality = _selectedQuality.value): List<VoicePreset> {
        return selfHostedService.availableVoices()
    }

    /**
     * Check if synthesis is available
     */
    suspend fun isQualityAvailable(quality: VoiceQuality): Boolean {
        return selfHostedService.isAvailable()
    }

    /**
     * Preview a voice with sample text
     */
    suspend fun previewVoice(
        voice: VoicePreset,
        quality: VoiceQuality,
        sampleText: String = voice.sampleText
    ): SynthesisResult {
        return synthesize(
            text = sampleText,
            voice = voice,
            quality = quality,
            options = SynthesisOptions.DEFAULT.copy(speed = defaultSpeed)
        )
    }

    companion object {
        @Volatile
        private var instance: TTSCoordinator? = null

        fun getInstance(context: Context, usageTracker: UsageTrackerService): TTSCoordinator {
            return instance ?: synchronized(this) {
                instance ?: TTSCoordinator(context.applicationContext, usageTracker).also { instance = it }
            }
        }
    }
}
