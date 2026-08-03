package com.listenai.service.tts

import android.content.Context
import android.util.Log
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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
 * Uses self-hosted Kokoro TTS for all synthesis.
 *
 * Uses the job-based API (POST /api/tts/job + polling GET /api/tts/job/:id)
 * that the iOS app already uses in production — matches
 * ios/Sources/TTS/Services/{ListenAICloudService,TTSJobManager}.swift and
 * ios/Sources/TTS/Views/CloudTTSProgressView.swift. Previously this made a
 * single blocking POST /api/tts call that held one HTTP connection open for
 * the entire synthesis duration (up to 10 minutes) with zero visibility into
 * queue position or per-chunk progress — this is what "stuck at 30%" was:
 * indistinguishable "still waiting" whether queued behind other jobs or
 * mid-synthesis. Polling short-lived status requests instead gives real
 * queue_position/queue_depth/chunks_completed/percentage from the backend
 * (see backend/src/routes/tts.ts:823 GET /job/:jobId) and is far more
 * resilient to backgrounding than one long-lived connection.
 */
class CloudTTSService(private val context: Context) : TTSService {

    override val provider = VoiceProvider.SELF_HOSTED
    override val maxTextLength = 5000
    override val supportsStreaming = false
    override val supportsSSML = false

    private val activeTasks = mutableMapOf<UUID, Boolean>()

    // Individual poll requests are short — no need for the long readTimeout
    // the old single-blocking-call design required.
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // Backend URL - should be configured from settings
    private var baseUrl: String = "https://listenai-backend.fly.dev"

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

        // A queued+processing job can span several minutes end-to-end even
        // though each individual poll request is short; keep the process
        // exempt from backgrounding/freeze kills for the whole job.
        SynthesisForegroundGuard.acquire(context)
        try {
            onProgress(SynthesisProgress.INITIAL.copy(
                statusMessage = "Submitting request...",
                totalSections = sections.size,
                totalCharacters = totalText.length
            ))

            val jobId = submitJob(totalText, voice, options)?.let { startResponse ->
                // Cache hit or fast-lane path returned audio/preview immediately.
                if (startResponse.status == "ready" && startResponse.audioUrl != null) {
                    return@withContext downloadAndBuildResult(
                        audioUrl = startResponse.audioUrl,
                        sections = sections,
                        totalText = totalText,
                        voice = voice,
                        startTime = startTime,
                        onProgress = onProgress,
                    )
                }
                startResponse.jobId
            } ?: throw TTSError.AudioEncodingFailed("No job ID returned")

            pollUntilComplete(jobId, taskId, sections, totalText, voice, startTime, onProgress)
        } finally {
            activeTasks.remove(taskId)
            SynthesisForegroundGuard.release(context)
        }
    }

    private data class JobStartResponse(val status: String, val jobId: String, val audioUrl: String?)

    private fun submitJob(text: String, voice: VoicePreset, options: SynthesisOptions): JobStartResponse {
        val requestBody = JSONObject().apply {
            put("text", text)
            put("voice_id", voice.providerVoiceId)
            put("options", JSONObject().apply { put("speed", options.speed) })
            put("purpose", "play")
        }

        val request = Request.Builder()
            .url("$baseUrl/api/tts/job")
            .post(requestBody.toString().toRequestBody("application/json".toMediaType()))
            .addHeader("Content-Type", "application/json")
            .addHeader("Authorization", "Bearer ") // Empty token - backend defaults to pro user
            .build()

        httpClient.newCall(request).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                handleErrorResponse(response.code, body)
            }
            val json = JSONObject(body)
            return JobStartResponse(
                status = json.getString("status"),
                jobId = json.getString("job_id"),
                audioUrl = if (json.has("audio_url")) json.getString("audio_url") else null,
            )
        }
    }

    /**
     * Poll interval matches iOS's "fast" cadence (see TTSJobManager.swift:79,
     * fastPollingIntervalMs=850) simplified to a fixed 1s — no need for the
     * jitter iOS adds to avoid a thundering herd since Android's poll volume
     * is negligible by comparison.
     */
    private suspend fun pollUntilComplete(
        jobId: String,
        taskId: UUID,
        sections: List<TextSection>,
        totalText: String,
        voice: VoicePreset,
        startTime: Long,
        onProgress: (SynthesisProgress) -> Unit,
    ): SynthesisResult {
        val maxPollingDurationMs = 600_000L // 10 minutes, matches iOS TTSJobManager.swift:88
        val pollStart = System.currentTimeMillis()

        while (true) {
            if (activeTasks[taskId] == true) {
                cancelJob(jobId)
                throw TTSError.Cancelled
            }
            if (System.currentTimeMillis() - pollStart > maxPollingDurationMs) {
                throw TTSError.ApiError(provider.displayName, 0, "Audio generation timed out after 10 minutes")
            }

            val request = Request.Builder()
                .url("$baseUrl/api/tts/job/$jobId")
                .get()
                .addHeader("Authorization", "Bearer ")
                .build()

            val statusJson = httpClient.newCall(request).execute().use { response ->
                val body = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    handleErrorResponse(response.code, body)
                }
                JSONObject(body)
            }

            val status = statusJson.getString("status")
            val progress = statusJson.optJSONObject("progress")

            when (status) {
                "ready" -> {
                    val audioUrl = if (statusJson.has("audio_url")) statusJson.getString("audio_url") else null
                        ?: throw TTSError.AudioEncodingFailed("Job ready but no audio_url")
                    return downloadAndBuildResult(audioUrl, sections, totalText, voice, startTime, onProgress)
                }
                "failed" -> {
                    val error = statusJson.optJSONObject("error")
                    val message = error?.optString("message") ?: "Synthesis failed"
                    throw TTSError.ApiError(provider.displayName, 0, message)
                }
                "canceled" -> {
                    throw TTSError.Cancelled
                }
                else -> {
                    // "queued" or "partial_ready" or "processing"
                    onProgress(mapToSynthesisProgress(status, progress, statusJson, sections, totalText))
                }
            }

            delay(1000)
        }
    }

    private fun mapToSynthesisProgress(
        status: String,
        progress: JSONObject?,
        statusJson: JSONObject,
        sections: List<TextSection>,
        totalText: String,
    ): SynthesisProgress {
        val percentage = progress?.optInt("percentage", 0) ?: 0
        val chunksTotal = progress?.optInt("chunks_total", 0)?.takeIf { it > 0 }
        val chunksCompleted = progress?.optInt("chunks_completed", 0) ?: 0
        val estimatedRemaining = progress?.optInt("estimated_remaining_sec", -1)?.takeIf { it >= 0 }
        val queueDepth = statusJson.optInt("queue_depth", -1).takeIf { it >= 0 }
        val queuePosition = statusJson.optInt("queue_position", -1).takeIf { it >= 0 }

        val statusMessage = when (status) {
            "queued" -> if (queuePosition != null) {
                "Waiting in queue — ${ordinal(queuePosition)} in line" +
                    (queueDepth?.takeIf { it > queuePosition }?.let { " • $it jobs queued" } ?: "")
            } else {
                "Waiting in queue..."
            }
            "partial_ready" -> "Streaming preview..."
            else -> "Generating audio..."
        }

        return SynthesisProgress(
            overallProgress = percentage / 100f,
            currentSectionIndex = chunksCompleted.coerceAtMost((chunksTotal ?: sections.size) - 1).coerceAtLeast(0),
            sectionsCompleted = chunksCompleted,
            totalSections = chunksTotal ?: sections.size,
            estimatedTimeRemaining = estimatedRemaining?.toDouble(),
            statusMessage = statusMessage,
            charactersProcessed = (totalText.length * (percentage / 100.0)).toInt(),
            totalCharacters = totalText.length,
            previewUrl = if (statusJson.has("preview_url")) statusJson.getString("preview_url") else null,
            previewDurationSec = statusJson.optDouble("preview_duration_sec", Double.NaN).takeIf { !it.isNaN() },
            jobStatus = status,
            queueDepth = queueDepth,
            queuePosition = queuePosition,
        )
    }

    private fun ordinal(n: Int): String {
        if (n % 100 in 11..13) return "${n}th"
        return when (n % 10) {
            1 -> "${n}st"
            2 -> "${n}nd"
            3 -> "${n}rd"
            else -> "${n}th"
        }
    }

    private fun cancelJob(jobId: String) {
        try {
            val request = Request.Builder()
                .url("$baseUrl/api/tts/job/$jobId/cancel")
                .post("".toRequestBody(null))
                .addHeader("Authorization", "Bearer ")
                .build()
            httpClient.newCall(request).execute().close()
        } catch (e: Exception) {
            Log.w("CloudTTSService", "Failed to cancel job $jobId on server", e)
        }
    }

    private fun downloadAndBuildResult(
        audioUrl: String,
        sections: List<TextSection>,
        totalText: String,
        voice: VoicePreset,
        startTime: Long,
        onProgress: (SynthesisProgress) -> Unit,
    ): SynthesisResult {
        onProgress(SynthesisProgress.INITIAL.copy(
            overallProgress = 0.95f,
            statusMessage = "Downloading audio...",
            totalSections = sections.size,
            totalCharacters = totalText.length,
        ))

        val audioRequest = Request.Builder().url(audioUrl).get().build()
        val audioData = httpClient.newCall(audioRequest).execute().use { response ->
            if (!response.isSuccessful) throw TTSError.AudioEncodingFailed("Failed to download audio: ${response.code}")
            response.body?.bytes() ?: throw TTSError.AudioEncodingFailed("Empty audio response")
        }

        val outputFile = File(context.cacheDir, "tts_${UUID.randomUUID()}.mp3")
        outputFile.writeBytes(audioData)

        val endTime = System.currentTimeMillis()
        val duration = (audioData.size * 8.0) / (128 * 1000) // ~128kbps MP3 estimate
        val sectionTimestamps = buildSectionTimestamps(sections, duration)

        onProgress(SynthesisProgress(
            overallProgress = 1.0f,
            currentSectionIndex = sections.size - 1,
            sectionsCompleted = sections.size,
            totalSections = sections.size,
            estimatedTimeRemaining = 0.0,
            statusMessage = "Complete",
            charactersProcessed = totalText.length,
            totalCharacters = totalText.length,
        ))

        return SynthesisResult(
            audioFile = outputFile,
            duration = duration,
            sectionTimestamps = sectionTimestamps,
            wordTimestamps = null,
            fileSizeBytes = outputFile.length(),
            cost = SynthesisCost(
                charactersUsed = totalText.length,
                costUSD = 0.0,
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
            code == 404 -> {
                throw TTSError.ApiError(provider.displayName, code, "Job API not available for this account")
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
