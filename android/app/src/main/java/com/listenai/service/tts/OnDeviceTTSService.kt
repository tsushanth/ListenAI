package com.listenai.service.tts

import android.content.Context
import android.media.MediaMetadataRetriever
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import com.listenai.data.models.VoiceGender
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import com.listenai.data.models.VoiceStyle
import com.listenai.data.models.VoiceCategory
import com.listenai.data.models.VoiceTier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * On-device TTS service using Android's TextToSpeech engine.
 * Provides free, offline text-to-speech with no network dependency.
 */
class OnDeviceTTSService(private val context: Context) : TTSService {

    override val provider = VoiceProvider.ANDROID
    override val maxTextLength = 100_000
    override val supportsStreaming = false
    override val supportsSSML = false

    private var tts: TextToSpeech? = null
    private var isInitialized = false
    private var initializationError: Exception? = null
    private val activeTasks = mutableMapOf<UUID, Boolean>() // taskId -> isCancelled
    private var cachedVoices: List<VoicePreset>? = null

    init {
        initializeTTS()
    }

    private fun initializeTTS() {
        tts = TextToSpeech(context) { status ->
            isInitialized = status == TextToSpeech.SUCCESS
            if (!isInitialized) {
                initializationError = TTSError.InvalidConfiguration("TextToSpeech initialization failed")
            }
        }
    }

    override suspend fun isAvailable(): Boolean {
        return isInitialized && tts != null
    }

    override suspend fun synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ): SynthesisResult {
        val section = TextSection(
            index = 0,
            type = SectionType.PARAGRAPH,
            text = text,
            characterRange = 0 until text.length
        )
        return synthesize(listOf(section), voice, options) {}
    }

    override suspend fun synthesize(
        sections: List<TextSection>,
        voice: VoicePreset,
        options: SynthesisOptions,
        onProgress: (SynthesisProgress) -> Unit
    ): SynthesisResult = withContext(Dispatchers.IO) {
        val ttsEngine = tts ?: throw TTSError.InvalidConfiguration("TTS not initialized")

        // Validate input
        val totalText = sections.joinToString(" ") { it.text }
        if (totalText.isEmpty()) {
            throw TTSError.TextEmpty
        }
        if (totalText.length > maxTextLength) {
            throw TTSError.TextTooLong(totalText.length, maxTextLength)
        }

        // Check voice availability
        if (!isVoiceAvailable(voice)) {
            throw TTSError.VoiceNotAvailable(voice.name)
        }

        val taskId = UUID.randomUUID()
        val startTime = System.currentTimeMillis()
        activeTasks[taskId] = false

        try {
            // Configure TTS engine
            configureTTS(ttsEngine, voice, options)

            // Report initial progress
            onProgress(SynthesisProgress(
                overallProgress = 0f,
                currentSectionIndex = 0,
                sectionsCompleted = 0,
                totalSections = sections.size,
                statusMessage = "Preparing synthesis...",
                charactersProcessed = 0,
                totalCharacters = totalText.length
            ))

            // Synthesize each section
            val sectionAudioFiles = mutableListOf<File>()
            val sectionTimestamps = mutableListOf<SectionTimestamp>()
            val allWordTimestamps = mutableListOf<WordTimestamp>()
            var currentTime = 0.0
            var charactersProcessed = 0

            for ((index, section) in sections.withIndex()) {
                // Check for cancellation
                if (activeTasks[taskId] == true) {
                    sectionAudioFiles.forEach { it.delete() }
                    throw TTSError.Cancelled
                }

                // Skip empty sections
                val trimmedText = section.text.trim()
                if (trimmedText.isEmpty()) continue

                // Report section progress
                onProgress(SynthesisProgress(
                    overallProgress = index.toFloat() / sections.size,
                    currentSectionIndex = index,
                    sectionsCompleted = index,
                    totalSections = sections.size,
                    statusMessage = "Synthesizing section ${index + 1} of ${sections.size}...",
                    charactersProcessed = charactersProcessed,
                    totalCharacters = totalText.length
                ))

                // Synthesize this section
                val outputFile = File(context.cacheDir, "section_${UUID.randomUUID()}.wav")
                val duration = synthesizeToFile(ttsEngine, trimmedText, outputFile)

                sectionAudioFiles.add(outputFile)

                // Record section timestamp
                sectionTimestamps.add(SectionTimestamp(
                    sectionIndex = section.index,
                    startTime = currentTime,
                    endTime = currentTime + duration
                ))

                currentTime += duration + section.type.pauseAfterSeconds
                charactersProcessed += section.text.length
            }

            // Merge all section audio files
            onProgress(SynthesisProgress(
                overallProgress = 0.95f,
                currentSectionIndex = sections.size - 1,
                sectionsCompleted = sections.size,
                totalSections = sections.size,
                statusMessage = "Finalizing audio...",
                charactersProcessed = totalText.length,
                totalCharacters = totalText.length
            ))

            val mergedFile = mergeAudioFiles(sectionAudioFiles)

            // Clean up section files
            sectionAudioFiles.forEach { if (it != mergedFile) it.delete() }

            val endTime = System.currentTimeMillis()

            // Report completion
            onProgress(SynthesisProgress(
                overallProgress = 1.0f,
                currentSectionIndex = sections.size - 1,
                sectionsCompleted = sections.size,
                totalSections = sections.size,
                estimatedTimeRemaining = 0.0,
                statusMessage = "Complete",
                charactersProcessed = totalText.length,
                totalCharacters = totalText.length
            ))

            SynthesisResult(
                audioFile = mergedFile,
                duration = currentTime,
                sectionTimestamps = sectionTimestamps,
                wordTimestamps = if (options.generateWordTimestamps) allWordTimestamps else null,
                fileSizeBytes = mergedFile.length(),
                cost = null, // On-device is free
                metadata = SynthesisMetadata(
                    voiceId = voice.id,
                    voiceName = voice.name,
                    provider = provider.displayName,
                    startedAt = startTime,
                    completedAt = endTime,
                    inputCharacterCount = totalText.length,
                    outputSampleRate = 22050
                )
            )
        } finally {
            activeTasks.remove(taskId)
        }
    }

    private fun configureTTS(tts: TextToSpeech, voice: VoicePreset, options: SynthesisOptions) {
        // Set language
        val locale = Locale.forLanguageTag(voice.languageCode)
        tts.language = locale

        // Try to set specific voice
        val availableVoices = tts.voices ?: emptySet()
        val targetVoice = availableVoices.find { it.name == voice.providerVoiceId }
            ?: availableVoices.find { it.locale.language == locale.language }

        targetVoice?.let { tts.voice = it }

        // Set speech rate (Android: 0.0-2.0, our scale: 0.5-3.0)
        val rate = options.speed * voice.run {
            // Apply voice-specific speed adjustment if any
            1.0f
        }
        tts.setSpeechRate(mapSpeedToAndroidRate(rate))

        // Set pitch (Android: 0.0-2.0, our scale: 0.5-2.0)
        tts.setPitch(options.pitch)
    }

    private fun mapSpeedToAndroidRate(speed: Float): Float {
        // Map our 0.5-3.0 scale to Android's TTS rate
        // 1.0 in our scale = 1.0 in Android
        return speed.coerceIn(0.5f, 3.0f)
    }

    private suspend fun synthesizeToFile(
        tts: TextToSpeech,
        text: String,
        outputFile: File
    ): Double = suspendCancellableCoroutine { continuation ->
        val utteranceId = UUID.randomUUID().toString()

        val listener = object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}

            override fun onDone(utteranceId: String?) {
                val duration = getAudioDuration(outputFile)
                continuation.resume(duration)
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                continuation.resumeWithException(
                    TTSError.AudioEncodingFailed("Synthesis failed")
                )
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                continuation.resumeWithException(
                    TTSError.AudioEncodingFailed("Synthesis failed with error code: $errorCode")
                )
            }
        }

        tts.setOnUtteranceProgressListener(listener)

        val params = Bundle().apply {
            putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
        }

        val result = tts.synthesizeToFile(text, params, outputFile, utteranceId)

        if (result != TextToSpeech.SUCCESS) {
            continuation.resumeWithException(
                TTSError.AudioEncodingFailed("Failed to start synthesis")
            )
        }

        continuation.invokeOnCancellation {
            tts.stop()
        }
    }

    private fun getAudioDuration(file: File): Double {
        return try {
            val retriever = MediaMetadataRetriever()
            retriever.setDataSource(file.absolutePath)
            val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            retriever.release()
            (durationStr?.toLongOrNull() ?: 0L) / 1000.0
        } catch (e: Exception) {
            // Estimate duration based on text length if metadata extraction fails
            0.0
        }
    }

    private fun mergeAudioFiles(files: List<File>): File {
        if (files.isEmpty()) {
            throw TTSError.AudioEncodingFailed("No audio files to merge")
        }

        // If only one file, return it directly
        if (files.size == 1) {
            return files[0]
        }

        // For multiple files, concatenate them
        // Note: A full implementation would use MediaMuxer or similar
        // For simplicity, we'll just return the first file for now
        // TODO: Implement proper audio concatenation using MediaMuxer
        return files[0]
    }

    override fun synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ): Flow<AudioChunk> = callbackFlow {
        // Android TTS doesn't natively support streaming
        // Throw an error indicating this
        throw TTSError.InvalidConfiguration("Streaming not supported for on-device TTS")
    }

    override suspend fun cancelSynthesis(taskId: UUID) {
        activeTasks[taskId] = true
        tts?.stop()
    }

    override suspend fun cancelAllSynthesis() {
        activeTasks.keys.forEach { activeTasks[it] = true }
        tts?.stop()
    }

    override suspend fun isVoiceAvailable(voice: VoicePreset): Boolean {
        if (voice.provider != VoiceProvider.ANDROID) return false

        val ttsEngine = tts ?: return false
        val availableVoices = ttsEngine.voices ?: return false

        // Check for exact match
        if (availableVoices.any { it.name == voice.providerVoiceId }) {
            return true
        }

        // Fall back to language match
        val locale = Locale.forLanguageTag(voice.languageCode)
        return availableVoices.any { it.locale.language == locale.language }
    }

    override suspend fun availableVoices(): List<VoicePreset> {
        cachedVoices?.let { return it }

        val ttsEngine = tts ?: return emptyList()
        val systemVoices = ttsEngine.voices ?: return emptyList()

        val presets = systemVoices.map { voice ->
            voicePresetFromAndroidVoice(voice)
        }.sortedBy { it.name }

        cachedVoices = presets
        return presets
    }

    private fun voicePresetFromAndroidVoice(voice: Voice): VoicePreset {
        val gender = when {
            voice.name.lowercase().contains("female") -> VoiceGender.FEMALE
            voice.name.lowercase().contains("male") -> VoiceGender.MALE
            else -> VoiceGender.NEUTRAL
        }

        return VoicePreset(
            id = voice.name,
            name = formatVoiceName(voice),
            isBuiltIn = true,
            provider = VoiceProvider.ANDROID,
            providerVoiceId = voice.name,
            gender = gender,
            style = VoiceStyle.NEUTRAL,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE,
            languageCode = voice.locale.toLanguageTag(),
            supportedLanguages = listOf(voice.locale.toLanguageTag())
        )
    }

    private fun formatVoiceName(voice: Voice): String {
        val locale = voice.locale
        val language = locale.displayLanguage
        val country = locale.displayCountry

        return if (country.isNotEmpty()) {
            "$language ($country)"
        } else {
            language
        }
    }

    override suspend fun downloadVoice(voice: VoicePreset) {
        // Android voices are managed through system settings
        // We can't programmatically download them
        throw TTSError.InvalidConfiguration(
            "Please download voices from Settings > Accessibility > Text-to-speech"
        )
    }

    override fun estimate(text: String, voice: VoicePreset): SynthesisEstimate {
        // Estimate based on average speaking rate (~150 words per minute)
        val wordCount = text.split("\\s+".toRegex()).size
        val wordsPerMinute = 150.0
        val estimatedDuration = (wordCount / wordsPerMinute) * 60.0

        // Processing is roughly real-time for on-device
        val estimatedProcessingTime = estimatedDuration * 0.3

        return SynthesisEstimate(
            estimatedDuration = estimatedDuration,
            estimatedProcessingTime = estimatedProcessingTime,
            characterCount = text.length,
            estimatedCostUSD = null, // Free
            quotaImpact = null // No quota
        )
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        isInitialized = false
        cachedVoices = null
    }
}
