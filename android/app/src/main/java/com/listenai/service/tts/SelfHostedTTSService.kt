package com.listenai.service.tts

import android.content.Context
import com.listenai.data.models.VoiceGender
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import com.listenai.data.models.VoiceQuality
import com.listenai.data.models.VoiceStyle
import com.listenai.data.models.VoiceCategory
import com.listenai.data.models.VoiceTier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Self-hosted TTS service using Kokoro/XTTS backend.
 * Provides standard quality voices that are fast and unlimited.
 */
class SelfHostedTTSService(private val context: Context) : TTSService {

    override val provider = VoiceProvider.SELF_HOSTED
    override val maxTextLength = 50_000
    override val supportsStreaming = false
    override val supportsSSML = false

    private val activeTasks = mutableMapOf<UUID, Boolean>()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)  // TTS can take time for long text
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // Self-hosted TTS backend URL
    private var baseUrl: String = "https://readaloud-tts-917362189743.us-central1.run.app"

    /**
     * Configure the backend URL
     */
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
                statusMessage = "Connecting to TTS service...",
                totalSections = sections.size,
                totalCharacters = totalText.length
            ))

            // Get the Kokoro voice ID
            val voiceId = voice.kokoroVoiceId ?: voice.providerVoiceId

            // Build request body
            val requestBody = JSONObject().apply {
                put("text", totalText)
                put("voice_id", voiceId)
                put("speed", options.speed)
                put("model", "kokoro")
                put("language", "en")
            }

            val request = Request.Builder()
                .url("$baseUrl/synthesize")
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

            // Save audio data to file (response is WAV audio)
            val audioData = response.body?.bytes() ?: throw TTSError.AudioEncodingFailed("Empty response")
            val outputFile = File(context.cacheDir, "tts_${UUID.randomUUID()}.wav")
            outputFile.writeBytes(audioData)

            val endTime = System.currentTimeMillis()

            // Estimate duration from WAV file (44100 Hz, 16-bit, mono = 88200 bytes/second)
            val duration = (audioData.size - 44).toDouble() / 88200.0

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
                    quotaUsed = 0,  // No quota for self-hosted
                    provider = "ListenAI (Kokoro)"
                ),
                metadata = SynthesisMetadata(
                    voiceId = voice.id,
                    voiceName = voice.name,
                    provider = "ListenAI",
                    startedAt = startTime,
                    completedAt = endTime,
                    inputCharacterCount = totalText.length,
                    outputSampleRate = 24000
                )
            )
        } finally {
            activeTasks.remove(taskId)
        }
    }

    /**
     * Synthesize long text with chunking for progressive playback
     */
    suspend fun synthesizeLong(
        text: String,
        voice: VoicePreset,
        speed: Float = 1.0f,
        onChunkReady: suspend (audioData: ByteArray, chunkIndex: Int, totalChunks: Int) -> Unit
    ) = withContext(Dispatchers.IO) {
        val voiceId = voice.kokoroVoiceId ?: voice.providerVoiceId

        val requestBody = JSONObject().apply {
            put("text", text)
            put("voice_id", voiceId)
            put("speed", speed)
            put("model", "kokoro")
            put("language", "en")
            put("max_chunk_chars", 250)
        }

        val request = Request.Builder()
            .url("$baseUrl/synthesize-long")
            .post(requestBody.toString().toRequestBody("application/json".toMediaType()))
            .addHeader("Content-Type", "application/json")
            .build()

        val response = httpClient.newCall(request).execute()

        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: "Unknown error"
            handleErrorResponse(response.code, errorBody)
        }

        val responseBody = response.body?.string() ?: throw TTSError.AudioEncodingFailed("Empty response")
        val json = JSONObject(responseBody)

        val totalChunks = json.getInt("total_chunks")
        val results = json.getJSONArray("results")

        for (i in 0 until results.length()) {
            val chunkResult = results.getJSONObject(i)
            val audioBase64 = chunkResult.optString("audio_base64", null)
            if (audioBase64 != null) {
                val audioData = android.util.Base64.decode(audioBase64, android.util.Base64.DEFAULT)
                onChunkReady(audioData, i, totalChunks)
            }
        }
    }

    private fun handleErrorResponse(code: Int, body: String) {
        val message = try {
            JSONObject(body).optString("detail") ?: JSONObject(body).optString("error") ?: body
        } catch (e: Exception) {
            body
        }

        when (code) {
            400 -> throw TTSError.InvalidConfiguration(message)
            429 -> throw TTSError.RateLimited(60.0)
            500, 502, 503, 504 -> throw TTSError.ApiError(provider.displayName, code, "Service temporarily unavailable")
            else -> throw TTSError.ApiError(provider.displayName, code, message)
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
        throw TTSError.InvalidConfiguration("Streaming not yet supported for self-hosted TTS")
    }

    override suspend fun cancelSynthesis(taskId: UUID) {
        activeTasks[taskId] = true
    }

    override suspend fun cancelAllSynthesis() {
        activeTasks.keys.forEach { activeTasks[it] = true }
    }

    override suspend fun isVoiceAvailable(voice: VoicePreset): Boolean {
        return voice.provider == VoiceProvider.SELF_HOSTED || voice.kokoroVoiceId != null
    }

    override suspend fun availableVoices(): List<VoicePreset> {
        return try {
            withContext(Dispatchers.IO) {
                val request = Request.Builder()
                    .url("$baseUrl/voices")
                    .get()
                    .build()

                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    return@withContext getDefaultVoices()
                }

                val responseBody = response.body?.string() ?: return@withContext getDefaultVoices()
                val json = JSONObject(responseBody)
                val voicesArray = json.getJSONArray("voices")

                val voices = mutableListOf<VoicePreset>()
                for (i in 0 until voicesArray.length()) {
                    val voiceJson = voicesArray.getJSONObject(i)
                    voices.add(
                        VoicePreset(
                            id = voiceJson.getString("id"),
                            name = voiceJson.getString("name"),
                            isBuiltIn = true,
                            provider = VoiceProvider.SELF_HOSTED,
                            providerVoiceId = voiceJson.getString("id"),
                            kokoroVoiceId = voiceJson.getString("id"),
                            quality = VoiceQuality.STANDARD,
                            gender = parseGender(voiceJson.optString("gender", "neutral")),
                            style = VoiceStyle.NEUTRAL,
                            category = VoiceCategory.NARRATOR,
                            tier = VoiceTier.FREE,
                            languageCode = voiceJson.optString("language", "en")
                        )
                    )
                }
                voices
            }
        } catch (e: Exception) {
            getDefaultVoices()
        }
    }

    private fun parseGender(gender: String): VoiceGender {
        return when (gender.lowercase()) {
            "male" -> VoiceGender.MALE
            "female" -> VoiceGender.FEMALE
            else -> VoiceGender.NEUTRAL
        }
    }

    private fun getDefaultVoices(): List<VoicePreset> {
        return listOf(
            VoicePreset(
                id = "af_nicole",
                name = "Nicole",
                isBuiltIn = true,
                provider = VoiceProvider.SELF_HOSTED,
                providerVoiceId = "af_nicole",
                kokoroVoiceId = "af_nicole",
                quality = VoiceQuality.STANDARD,
                gender = VoiceGender.FEMALE,
                style = VoiceStyle.CONVERSATIONAL,
                category = VoiceCategory.NARRATOR,
                tier = VoiceTier.FREE
            ),
            VoicePreset(
                id = "am_adam",
                name = "Adam",
                isBuiltIn = true,
                provider = VoiceProvider.SELF_HOSTED,
                providerVoiceId = "am_adam",
                kokoroVoiceId = "am_adam",
                quality = VoiceQuality.STANDARD,
                gender = VoiceGender.MALE,
                style = VoiceStyle.NARRATIVE,
                category = VoiceCategory.NARRATOR,
                tier = VoiceTier.FREE
            ),
            VoicePreset(
                id = "af_sarah",
                name = "Sarah",
                isBuiltIn = true,
                provider = VoiceProvider.SELF_HOSTED,
                providerVoiceId = "af_sarah",
                kokoroVoiceId = "af_sarah",
                quality = VoiceQuality.STANDARD,
                gender = VoiceGender.FEMALE,
                style = VoiceStyle.CALM,
                category = VoiceCategory.EDUCATOR,
                tier = VoiceTier.FREE
            ),
            VoicePreset(
                id = "af_sky",
                name = "Sky",
                isBuiltIn = true,
                provider = VoiceProvider.SELF_HOSTED,
                providerVoiceId = "af_sky",
                kokoroVoiceId = "af_sky",
                quality = VoiceQuality.STANDARD,
                gender = VoiceGender.FEMALE,
                style = VoiceStyle.NARRATIVE,
                category = VoiceCategory.AUDIOBOOK,
                tier = VoiceTier.FREE
            ),
            VoicePreset(
                id = "am_michael",
                name = "Michael",
                isBuiltIn = true,
                provider = VoiceProvider.SELF_HOSTED,
                providerVoiceId = "am_michael",
                kokoroVoiceId = "am_michael",
                quality = VoiceQuality.STANDARD,
                gender = VoiceGender.MALE,
                style = VoiceStyle.NEWS,
                category = VoiceCategory.NEWS,
                tier = VoiceTier.FREE
            )
        )
    }

    override suspend fun downloadVoice(voice: VoicePreset) {
        // Self-hosted voices don't need download
    }

    override fun estimate(text: String, voice: VoicePreset): SynthesisEstimate {
        val wordCount = text.split("\\s+".toRegex()).size
        val estimatedDuration = (wordCount / 150.0) * 60.0
        // Kokoro is fast - approximately 0.1x realtime
        val estimatedProcessingTime = estimatedDuration * 0.1

        return SynthesisEstimate(
            estimatedDuration = estimatedDuration,
            estimatedProcessingTime = estimatedProcessingTime,
            characterCount = text.length,
            estimatedCostUSD = 0.0,  // Self-hosted is free
            quotaImpact = null       // No quota impact
        )
    }

    companion object {
        @Volatile
        private var instance: SelfHostedTTSService? = null

        fun getInstance(context: Context): SelfHostedTTSService {
            return instance ?: synchronized(this) {
                instance ?: SelfHostedTTSService(context.applicationContext).also { instance = it }
            }
        }
    }
}
