package com.listenai.service.tts

import android.content.Context
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import com.listenai.data.models.VoiceQuality
import com.listenai.service.usage.UsageTrackerService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * Coordinates TTS synthesis across different quality levels.
 * Routes to Kokoro (standard) or ElevenLabs (premium) based on selected quality.
 */
class TTSCoordinator(
    private val context: Context,
    private val usageTracker: UsageTrackerService
) {
    // Quality preference
    private val _selectedQuality = MutableStateFlow(VoiceQuality.STANDARD)
    val selectedQuality: StateFlow<VoiceQuality> = _selectedQuality

    // Default settings
    var defaultSpeed: Float = 1.0f
    var defaultPitch: Float = 1.0f

    // Services
    private val selfHostedService by lazy { SelfHostedTTSService.getInstance(context) }
    private val cloudService by lazy { CloudTTSService(context) }

    /**
     * Set the preferred quality level
     */
    fun setQuality(quality: VoiceQuality) {
        _selectedQuality.value = quality
    }

    /**
     * Synthesize text with the selected quality
     */
    suspend fun synthesize(
        text: String,
        voice: VoicePreset,
        quality: VoiceQuality = _selectedQuality.value,
        options: SynthesisOptions = SynthesisOptions.DEFAULT,
        onProgress: (SynthesisProgress) -> Unit = {}
    ): SynthesisResult = withContext(Dispatchers.IO) {
        // Apply default settings
        val adjustedOptions = options.copy(
            speed = if (options.speed == SynthesisOptions.DEFAULT.speed) defaultSpeed else options.speed,
            pitch = if (options.pitch == SynthesisOptions.DEFAULT.pitch) defaultPitch else options.pitch
        )

        when (quality) {
            VoiceQuality.STANDARD -> synthesizeStandard(text, voice, adjustedOptions, onProgress)
            VoiceQuality.PREMIUM -> synthesizePremium(text, voice, adjustedOptions, onProgress)
        }
    }

    /**
     * Synthesize using standard quality (Kokoro)
     */
    private suspend fun synthesizeStandard(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        onProgress: (SynthesisProgress) -> Unit
    ): SynthesisResult {
        // Get the Kokoro voice ID for this voice
        val kokoroVoice = voice.copy(
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = voice.kokoroVoiceId ?: voice.getVoiceIdForQuality(VoiceQuality.STANDARD)
        )

        val section = TextSection(
            index = 0,
            type = SectionType.PARAGRAPH,
            text = text,
            characterRange = 0 until text.length
        )

        val result = selfHostedService.synthesize(
            sections = listOf(section),
            voice = kokoroVoice,
            options = options,
            onProgress = onProgress
        )

        // Track standard usage (no quota impact)
        usageTracker.trackStandardUsage(
            charactersUsed = text.length,
            voiceId = kokoroVoice.providerVoiceId,
            articleId = null,
            articleTitle = null
        )

        return result
    }

    /**
     * Synthesize using premium quality (ElevenLabs)
     * Note: Server handles all quota enforcement - client no longer checks quota
     */
    private suspend fun synthesizePremium(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        onProgress: (SynthesisProgress) -> Unit
    ): SynthesisResult {
        // Server handles all quota enforcement - just proceed with synthesis
        val result = cloudService.synthesize(
            sections = listOf(
                TextSection(
                    index = 0,
                    type = SectionType.PARAGRAPH,
                    text = text,
                    characterRange = 0 until text.length
                )
            ),
            voice = voice,
            options = options,
            onProgress = onProgress
        )

        // Track premium usage for analytics (not for blocking)
        usageTracker.trackPremiumUsage(
            charactersUsed = text.length,
            voiceId = voice.providerVoiceId,
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
        when (quality) {
            VoiceQuality.STANDARD -> {
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
            VoiceQuality.PREMIUM -> {
                // For premium, synthesize as single request
                val result = synthesizePremium(
                    text = text,
                    voice = voice,
                    options = SynthesisOptions.DEFAULT.copy(speed = defaultSpeed),
                    onProgress = {}
                )

                // Return as single chunk
                val audioData = result.audioFile.readBytes()
                onChunkReady(audioData, 0, 1)
            }
        }
    }

    /**
     * Estimate synthesis before processing
     * Note: Server handles quota enforcement - estimates are for display only
     */
    fun estimate(
        text: String,
        voice: VoicePreset,
        quality: VoiceQuality = _selectedQuality.value
    ): SynthesisEstimate {
        return when (quality) {
            VoiceQuality.STANDARD -> selfHostedService.estimate(text, voice)
            VoiceQuality.PREMIUM -> {
                val cloudEstimate = cloudService.estimate(text, voice)
                // Server handles quota - always report as allowed
                cloudEstimate.copy(
                    quotaImpact = QuotaImpact(
                        charactersToUse = text.length,
                        remainingAfter = Int.MAX_VALUE,
                        willExceedQuota = false  // Server handles enforcement
                    )
                )
            }
        }
    }

    /**
     * Get available voices for the current quality level
     */
    suspend fun getAvailableVoices(quality: VoiceQuality = _selectedQuality.value): List<VoicePreset> {
        return when (quality) {
            VoiceQuality.STANDARD -> selfHostedService.availableVoices()
            VoiceQuality.PREMIUM -> cloudService.availableVoices()
        }
    }

    /**
     * Check if a quality level is available
     * Note: Server handles quota enforcement - just check if service is reachable
     */
    suspend fun isQualityAvailable(quality: VoiceQuality): Boolean {
        return when (quality) {
            VoiceQuality.STANDARD -> selfHostedService.isAvailable()
            VoiceQuality.PREMIUM -> cloudService.isAvailable()  // Server handles quota
        }
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
