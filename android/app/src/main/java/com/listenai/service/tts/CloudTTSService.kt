package com.listenai.service.tts

import android.content.Context
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Cloud TTS service that connects to the ListenAI backend for synthesis.
 * Uses self-hosted Kokoro TTS (GPU-accelerated) for all synthesis.
 */
class CloudTTSService(private val context: Context) : TTSService {

    override val provider = VoiceProvider.SELF_HOSTED
    override val maxTextLength = 5000
    override val supportsStreaming = false
    override val supportsSSML = false

    private val activeTasks = mutableMapOf<UUID, Boolean>()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // Backend URL - should be configured from settings
    private var baseUrl: String = "https://listenai-backend-917362189743.us-central1.run.app"

    fun configure(baseUrl: String) {
        this.baseUrl = baseUrl
    }

    override suspend fun isAvailable(): Boolean {
        return try {
            withContext(Dispatchers.IO) {
                val request = Request.Builder()
                    .url("$baseUrl/health")
                    .get()
                    .build()

                httpClient.newCall(request).execute().use { response ->
                    response.isSuccessful
                }
            }
        } catch (e: Exception) {
            false
        }
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
        val totalText = sections.joinToString(" ") { it.text }

        if (totalText.isEmpty()) {
            throw TTSError.TextEmpty
        }
        if (totalText.length > maxTextLength) {
            throw TTSError.TextTooLong(totalText.length, maxTextLength)
        }

        val taskId = UUID.randomUUID()
        val startTime = System.currentTimeMillis()
        activeTasks[taskId] = false

        try {
            onProgress(SynthesisProgress.INITIAL.copy(
                statusMessage = "Connecting to cloud service...",
                totalSections = sections.size,
                totalCharacters = totalText.length
            ))

            // Build request body - always use selfhosted (Kokoro) provider
            val requestBody = JSONObject().apply {
                put("text", totalText)
                put("voice_id", voice.providerVoiceId)
                put("provider", "selfhosted")
                put("model_id", "kokoro")
                put("speed", options.speed)
                put("pitch", options.pitch)
            }

            val request = Request.Builder()
                .url("$baseUrl/api/tts")
                .post(requestBody.toString().toRequestBody("application/json".toMediaType()))
                .addHeader("Content-Type", "application/json")
                .build()

            onProgress(SynthesisProgress.INITIAL.copy(
                overallProgress = 0.3f,
                statusMessage = "Synthesizing audio...",
                totalSections = sections.size,
                totalCharacters = totalText.length
            ))

            val response = httpClient.newCall(request).execute()

            if (!response.isSuccessful) {
                val errorBody = response.body?.string() ?: "Unknown error"
                handleErrorResponse(response.code, errorBody)
            }

            // Check for cancellation
            if (activeTasks[taskId] == true) {
                throw TTSError.Cancelled
            }

            onProgress(SynthesisProgress.INITIAL.copy(
                overallProgress = 0.8f,
                statusMessage = "Processing audio...",
                totalSections = sections.size,
                totalCharacters = totalText.length
            ))

            // Save audio data to file
            val audioData = response.body?.bytes() ?: throw TTSError.AudioEncodingFailed("Empty response")
            val outputFile = File(context.cacheDir, "tts_${UUID.randomUUID()}.mp3")
            outputFile.writeBytes(audioData)

            val endTime = System.currentTimeMillis()

            // Estimate duration from file size (~128kbps for MP3)
            val duration = (audioData.size * 8.0) / (128 * 1000)

            // Build section timestamps (estimated)
            val sectionTimestamps = buildSectionTimestamps(sections, duration)

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
                audioFile = outputFile,
                duration = duration,
                sectionTimestamps = sectionTimestamps,
                wordTimestamps = null,
                fileSizeBytes = outputFile.length(),
                cost = SynthesisCost(
                    charactersUsed = totalText.length,
                    costUSD = 0.0,  // Self-hosted is free
                    quotaUsed = totalText.length,
                    provider = "ReadAloud AI"
                ),
                metadata = SynthesisMetadata(
                    voiceId = voice.id,
                    voiceName = voice.name,
                    provider = "ReadAloud AI",
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

    private fun handleErrorResponse(code: Int, body: String) {
        val message = try {
            JSONObject(body).optString("error", body)
        } catch (e: Exception) {
            body
        }

        val lowerMessage = message.lowercase()

        when {
            code == 429 || lowerMessage.contains("rate") || lowerMessage.contains("limit") -> {
                throw TTSError.RateLimited(60.0)
            }
            code == 401 -> {
                if (lowerMessage.contains("rate") || lowerMessage.contains("limit")) {
                    throw TTSError.RateLimited(60.0)
                }
                throw TTSError.InvalidConfiguration("Invalid API key")
            }
            code == 402 || lowerMessage.contains("quota") || lowerMessage.contains("exceeded") -> {
                throw TTSError.QuotaExceeded(0, 0)
            }
            code == 403 -> {
                throw TTSError.SubscriptionRequired("premium")
            }
            else -> {
                throw TTSError.ApiError(provider.displayName, code, message)
            }
        }
    }

    private fun buildSectionTimestamps(sections: List<TextSection>, totalDuration: Double): List<SectionTimestamp> {
        val totalChars = sections.sumOf { it.text.length }
        var currentTime = 0.0

        return sections.map { section ->
            val sectionDuration = (section.text.length.toDouble() / totalChars) * totalDuration
            val timestamp = SectionTimestamp(
                sectionIndex = section.index,
                startTime = currentTime,
                endTime = currentTime + sectionDuration
            )
            currentTime += sectionDuration + section.type.pauseAfterSeconds
            timestamp
        }
    }

    override fun synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ): Flow<AudioChunk> = flow {
        throw TTSError.InvalidConfiguration("Streaming not yet supported")
    }

    override suspend fun cancelSynthesis(taskId: UUID) {
        activeTasks[taskId] = true
    }

    override suspend fun cancelAllSynthesis() {
        activeTasks.keys.forEach { activeTasks[it] = true }
    }

    override suspend fun isVoiceAvailable(voice: VoicePreset): Boolean {
        return voice.provider == VoiceProvider.SELF_HOSTED
    }

    override suspend fun availableVoices(): List<VoicePreset> {
        // Return all built-in Kokoro voices
        return VoicePreset.builtInVoices
    }

    override suspend fun downloadVoice(voice: VoicePreset) {
        // Cloud voices don't need download
    }

    override fun estimate(text: String, voice: VoicePreset): SynthesisEstimate {
        val wordCount = text.split("\\s+".toRegex()).size
        val estimatedDuration = (wordCount / 150.0) * 60.0
        val estimatedProcessingTime = estimatedDuration * 0.5

        return SynthesisEstimate(
            estimatedDuration = estimatedDuration,
            estimatedProcessingTime = estimatedProcessingTime,
            characterCount = text.length,
            estimatedCostUSD = 0.0,  // Self-hosted is free
            quotaImpact = null
        )
    }
}
