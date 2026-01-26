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
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetAddress
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

    /**
     * Data class to track active cloned voice synthesis jobs.
     * This allows the UI to resume progress tracking after navigation.
     */
    data class ActiveClonedJob(
        val jobId: String,
        val voiceId: String,
        val text: String,
        val startTime: Long,
        var lastProgress: Float = 0f,
        var lastStatusMessage: String = "Processing..."
    )

    // Track active cloned voice synthesis jobs by voice ID
    private val activeClonedJobs = mutableMapOf<String, ActiveClonedJob>()

    // Custom DNS resolver that falls back to Google DNS if system DNS fails
    private val customDns = object : Dns {
        private val googleDns = listOf(
            InetAddress.getByName("8.8.8.8"),
            InetAddress.getByName("8.8.4.4")
        )

        override fun lookup(hostname: String): List<InetAddress> {
            return try {
                // Try system DNS first
                Dns.SYSTEM.lookup(hostname)
            } catch (e: Exception) {
                android.util.Log.w("SelfHostedTTS", "System DNS failed for $hostname, trying Google DNS")
                // Fallback to Google DNS
                try {
                    val addresses = mutableListOf<InetAddress>()
                    for (dns in googleDns) {
                        try {
                            val resolved = InetAddress.getAllByName(hostname)
                            addresses.addAll(resolved)
                            if (addresses.isNotEmpty()) break
                        } catch (e2: Exception) {
                            continue
                        }
                    }
                    if (addresses.isEmpty()) {
                        throw java.net.UnknownHostException("Unable to resolve $hostname")
                    }
                    addresses
                } catch (e2: Exception) {
                    android.util.Log.e("SelfHostedTTS", "Google DNS also failed for $hostname")
                    throw e
                }
            }
        }
    }

    private val httpClient = OkHttpClient.Builder()
        .dns(customDns)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)  // TTS can take time for long text
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // ListenAI backend URL - route through backend like iOS for quota tracking and reliability
    private var baseUrl: String = "https://listenai-backend-917362189743.us-central1.run.app"

    /**
     * Configure the backend URL
     */
    fun configure(baseUrl: String) {
        this.baseUrl = baseUrl
    }

    override suspend fun isAvailable(): Boolean {
        return try {
            withContext(Dispatchers.IO) {
                android.util.Log.d("SelfHostedTTS", "Checking availability at $baseUrl/api/health")
                val request = Request.Builder()
                    .url("$baseUrl/api/health")
                    .get()
                    .build()

                httpClient.newCall(request).execute().use { response ->
                    val available = response.isSuccessful
                    android.util.Log.d("SelfHostedTTS", "Health check result: $available (code=${response.code})")
                    available
                }
            }
        } catch (e: java.net.UnknownHostException) {
            android.util.Log.e("SelfHostedTTS", "Health check failed - DNS error: ${e.message}")
            false
        } catch (e: Exception) {
            android.util.Log.e("SelfHostedTTS", "Health check failed: ${e.javaClass.simpleName} - ${e.message}")
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
        consecutivePollFailures = 0  // Reset poll failure counter for new synthesis

        try {
            onProgress(SynthesisProgress.INITIAL.copy(
                statusMessage = "Connecting to TTS service...",
                totalSections = sections.size,
                totalCharacters = totalText.length
            ))

            // Get the Kokoro voice ID
            val voiceId = voice.kokoroVoiceId ?: voice.providerVoiceId

            // Build request body - match iOS ListenAICloudService format
            // Backend validates speed between 0.5 and 2.0
            val clampedSpeed = options.speed.coerceIn(0.5f, 2.0f)

            android.util.Log.d("SelfHostedTTS", "Synthesizing via job API: voiceId=$voiceId, speed=$clampedSpeed, textLength=${totalText.length}")

            // Use job-based API like iOS for proper progress tracking
            val optionsJson = JSONObject().apply {
                put("speed", clampedSpeed)
            }
            val requestBody = JSONObject().apply {
                put("text", totalText)
                put("voice_id", voiceId)
                put("options", optionsJson)
                put("purpose", "play")  // User pressed play
            }

            val request = Request.Builder()
                .url("$baseUrl/api/tts/job")  // Use job-based API endpoint like iOS
                .post(requestBody.toString().toRequestBody("application/json".toMediaType()))
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .addHeader("X-Debug-Bypass-Quota", "true")  // TODO: Remove for production
                .build()

            onProgress(SynthesisProgress.INITIAL.copy(
                overallProgress = 0.05f,
                statusMessage = "Starting synthesis...",
                totalSections = sections.size,
                totalCharacters = totalText.length
            ))

            android.util.Log.d("SelfHostedTTS", "Making request to $baseUrl/api/tts/job")

            val response = try {
                httpClient.newCall(request).execute()
            } catch (e: java.net.UnknownHostException) {
                android.util.Log.e("SelfHostedTTS", "DNS resolution failed: ${e.message}")
                throw TTSError.NetworkError("Unable to connect to TTS server. Please check your internet connection.")
            } catch (e: java.net.SocketTimeoutException) {
                android.util.Log.e("SelfHostedTTS", "Connection timeout: ${e.message}")
                throw TTSError.NetworkError("Connection timed out. The server might be busy.")
            } catch (e: java.io.IOException) {
                android.util.Log.e("SelfHostedTTS", "Network error: ${e.message}")
                throw TTSError.NetworkError("Network error: ${e.message}")
            }

            android.util.Log.d("SelfHostedTTS", "Job response code: ${response.code}")

            if (!response.isSuccessful) {
                val errorBody = response.body?.string() ?: "Unknown error"
                android.util.Log.e("SelfHostedTTS", "Error response: $errorBody")
                handleErrorResponse(response.code, errorBody, totalText.length)
            }

            // Parse job response
            val responseBody = response.body?.string() ?: throw TTSError.AudioEncodingFailed("Empty response")
            val jobResponse = JSONObject(responseBody)
            val jobId = jobResponse.getString("job_id")
            val initialStatus = jobResponse.getString("status")

            android.util.Log.d("SelfHostedTTS", "Job started: jobId=$jobId, status=$initialStatus")

            // If immediately ready, download audio
            if (initialStatus == "ready") {
                val audioUrl = jobResponse.optString("audio_url").takeIf { it.isNotEmpty() }
                if (audioUrl != null) {
                    return@withContext downloadAndSaveAudio(
                        audioUrl, jobId, sections, totalText, voice, startTime, onProgress
                    )
                }
            }

            // Poll for job status with real progress updates
            var pollCount = 0
            val maxPolls = 120  // 4 minutes max (2 sec intervals)
            val pollInterval = 2000L  // 2 seconds like iOS

            while (pollCount < maxPolls) {
                // Check for cancellation
                if (activeTasks[taskId] == true) {
                    throw TTSError.Cancelled
                }

                Thread.sleep(pollInterval)
                pollCount++

                // Poll with retry logic for transient network errors
                val statusResponse = pollJobStatusWithRetry(jobId)
                if (statusResponse == null) {
                    // Transient error - continue polling, don't fail yet
                    android.util.Log.w("SelfHostedTTS", "Transient poll error, continuing...")
                    continue
                }

                val status = statusResponse.getString("status")
                val progress = statusResponse.optJSONObject("progress")

                // Update progress from backend
                val percentage = progress?.optInt("percentage", 0) ?: 0
                val estimatedRemainingSec = progress?.optInt("estimated_remaining_sec")

                android.util.Log.d("SelfHostedTTS", "Job $jobId: status=$status, progress=$percentage%")

                onProgress(SynthesisProgress(
                    overallProgress = percentage / 100f,
                    currentSectionIndex = 0,
                    sectionsCompleted = 0,
                    totalSections = sections.size,
                    estimatedTimeRemaining = estimatedRemainingSec?.toDouble() ?: 0.0,
                    statusMessage = when (status) {
                        "queued" -> "In queue..."
                        "processing" -> "Synthesizing... $percentage%"
                        "partial_ready" -> "Almost ready... $percentage%"
                        else -> "Processing..."
                    },
                    charactersProcessed = (totalText.length * percentage / 100),
                    totalCharacters = totalText.length
                ))

                when (status) {
                    "ready" -> {
                        val audioUrl = statusResponse.optString("audio_url").takeIf { it.isNotEmpty() }
                            ?: throw TTSError.AudioEncodingFailed("No audio URL in ready response")
                        return@withContext downloadAndSaveAudio(
                            audioUrl, jobId, sections, totalText, voice, startTime, onProgress
                        )
                    }
                    "partial_ready" -> {
                        // Preview audio available - notify via callback (first time only)
                        val previewUrl = statusResponse.optString("preview_url").takeIf { it.isNotEmpty() }
                        val previewDurationSec = statusResponse.optDouble("preview_duration_sec", 0.0)
                        if (previewUrl != null && progress?.optInt("percentage", 0) ?: 0 > 0) {
                            android.util.Log.d("SelfHostedTTS", "Preview ready: $previewUrl (${previewDurationSec}s)")
                            // Notify progress with preview info for immediate playback
                            onProgress(SynthesisProgress(
                                overallProgress = percentage / 100f,
                                currentSectionIndex = 0,
                                sectionsCompleted = 0,
                                totalSections = sections.size,
                                estimatedTimeRemaining = estimatedRemainingSec?.toDouble() ?: 0.0,
                                statusMessage = "Preview ready",
                                charactersProcessed = (totalText.length * percentage / 100),
                                totalCharacters = totalText.length,
                                previewUrl = previewUrl,
                                previewDurationSec = previewDurationSec
                            ))
                        }
                        // Continue polling for full audio
                    }
                    "failed" -> {
                        val error = statusResponse.optJSONObject("error")
                        val errorMsg = error?.optString("message") ?: "Synthesis failed"
                        throw TTSError.NetworkError(errorMsg)
                    }
                    "canceled" -> {
                        throw TTSError.Cancelled
                    }
                }
            }

            throw TTSError.NetworkError("Synthesis timed out after ${maxPolls * pollInterval / 1000} seconds")

        } finally {
            activeTasks.remove(taskId)
        }
    }

    // Track consecutive poll failures for graceful degradation
    private var consecutivePollFailures = 0
    private val maxConsecutivePollFailures = 5

    /**
     * Poll job status with retry logic for transient network errors.
     * Returns null on transient errors (to continue polling), throws only on persistent failures.
     */
    private fun pollJobStatusWithRetry(jobId: String): JSONObject? {
        return try {
            val result = pollJobStatus(jobId)
            consecutivePollFailures = 0  // Reset on success
            result
        } catch (e: Exception) {
            consecutivePollFailures++
            android.util.Log.w("SelfHostedTTS", "Poll attempt failed ($consecutivePollFailures/$maxConsecutivePollFailures): ${e.message}")

            if (consecutivePollFailures >= maxConsecutivePollFailures) {
                // Too many consecutive failures - this is a real problem
                android.util.Log.e("SelfHostedTTS", "Too many consecutive poll failures, giving up")
                throw TTSError.NetworkError("Lost connection to server after multiple attempts")
            }

            // Transient error - return null to continue polling
            null
        }
    }

    /**
     * Poll job status from the backend
     */
    private fun pollJobStatus(jobId: String): JSONObject {
        val request = Request.Builder()
            .url("$baseUrl/api/tts/job/$jobId")
            .get()
            .addHeader("Accept", "application/json")
            .addHeader("X-Debug-Bypass-Quota", "true")  // TODO: Remove for production
            .build()

        val response = try {
            httpClient.newCall(request).execute()
        } catch (e: java.net.SocketTimeoutException) {
            android.util.Log.w("SelfHostedTTS", "Poll timeout: ${e.message}")
            throw e  // Let retry logic handle it
        } catch (e: java.io.IOException) {
            android.util.Log.w("SelfHostedTTS", "Poll network error: ${e.message}")
            throw e  // Let retry logic handle it
        }

        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: "Unknown error"
            android.util.Log.e("SelfHostedTTS", "Job status error: $errorBody")
            // 404 might mean job expired/not found - that's a real error
            if (response.code == 404) {
                throw TTSError.NetworkError("Job not found - it may have expired")
            }
            throw TTSError.NetworkError("Failed to check job status: ${response.code}")
        }

        val body = response.body?.string() ?: throw TTSError.AudioEncodingFailed("Empty status response")
        return JSONObject(body)
    }

    /**
     * Download audio from URL and save to local file
     */
    private fun downloadAndSaveAudio(
        audioUrl: String,
        jobId: String,
        sections: List<TextSection>,
        totalText: String,
        voice: VoicePreset,
        startTime: Long,
        onProgress: (SynthesisProgress) -> Unit
    ): SynthesisResult {
        onProgress(SynthesisProgress(
            overallProgress = 0.95f,
            currentSectionIndex = sections.size - 1,
            sectionsCompleted = sections.size,
            totalSections = sections.size,
            estimatedTimeRemaining = 0.0,
            statusMessage = "Downloading audio...",
            charactersProcessed = totalText.length,
            totalCharacters = totalText.length
        ))

        android.util.Log.d("SelfHostedTTS", "Downloading audio from: $audioUrl")

        val audioRequest = Request.Builder()
            .url(audioUrl)
            .get()
            .build()

        val audioResponse = httpClient.newCall(audioRequest).execute()

        if (!audioResponse.isSuccessful) {
            throw TTSError.NetworkError("Failed to download audio: ${audioResponse.code}")
        }

        val audioData = audioResponse.body?.bytes() ?: throw TTSError.AudioEncodingFailed("Empty audio response")
        android.util.Log.d("SelfHostedTTS", "Downloaded audio: ${audioData.size} bytes")

        val outputFile = File(context.cacheDir, "tts_${jobId}.mp3")
        outputFile.writeBytes(audioData)

        val endTime = System.currentTimeMillis()

        // Estimate duration from text length (approximately 150 words per minute)
        val wordCount = totalText.split("\\s+".toRegex()).size
        val duration = (wordCount / 150.0) * 60.0

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

        return SynthesisResult(
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
    }

    /**
     * Synthesize text using a cloned voice via job-based API with progress tracking.
     * Uses the /api/tts/job-cloned endpoint which supports real progress updates like iOS.
     *
     * @param text The text to synthesize
     * @param voiceId The cloned voice ID (UUID from cloned_voices table)
     * @param voiceUrl The URL to the reference audio file (from Supabase Storage)
     * @param speed Playback speed multiplier (0.5 - 2.0, default 1.0)
     * @param model Voice cloning model ("chatterbox" or "xtts", default "chatterbox")
     * @return SynthesisResult containing the audio file
     */
    suspend fun synthesizeCloned(
        text: String,
        voiceId: String,
        voiceUrl: String,
        speed: Float = 1.0f,
        model: String = "chatterbox",
        onProgress: (SynthesisProgress) -> Unit = {}
    ): SynthesisResult = withContext(Dispatchers.IO) {
        if (text.isEmpty()) {
            throw TTSError.TextEmpty
        }

        val taskId = UUID.randomUUID()
        val startTime = System.currentTimeMillis()
        activeTasks[taskId] = false
        consecutivePollFailures = 0

        try {
            onProgress(SynthesisProgress.INITIAL.copy(
                statusMessage = "Starting cloned voice synthesis...",
                totalCharacters = text.length
            ))

            // Build request body for job-based cloned voice synthesis
            val clampedSpeed = speed.coerceIn(0.5f, 2.0f)

            android.util.Log.d("SelfHostedTTS", "Synthesizing cloned voice via job API: voiceId=$voiceId, model=$model, speed=$clampedSpeed, textLength=${text.length}")

            val requestBody = JSONObject().apply {
                put("text", text)
                put("voice_id", voiceId)
                put("voice_url", voiceUrl)
                put("speed", clampedSpeed)
                put("model", model)
            }

            val request = Request.Builder()
                .url("$baseUrl/api/tts/job-cloned")  // Use job-based API for progress tracking
                .post(requestBody.toString().toRequestBody("application/json".toMediaType()))
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .addHeader("Authorization", "Bearer ")  // Empty token - backend defaults to pro user
                .addHeader("X-Debug-Bypass-Quota", "true")  // TODO: Remove for production
                .build()

            onProgress(SynthesisProgress.INITIAL.copy(
                overallProgress = 0.05f,
                statusMessage = "Connecting to cloned voice service...",
                totalCharacters = text.length
            ))

            android.util.Log.d("SelfHostedTTS", "Making request to $baseUrl/api/tts/job-cloned")

            val response = try {
                httpClient.newCall(request).execute()
            } catch (e: java.net.UnknownHostException) {
                android.util.Log.e("SelfHostedTTS", "DNS resolution failed: ${e.message}")
                throw TTSError.NetworkError("Unable to connect to TTS server. Please check your internet connection.")
            } catch (e: java.net.SocketTimeoutException) {
                android.util.Log.e("SelfHostedTTS", "Connection timeout: ${e.message}")
                throw TTSError.NetworkError("Connection timed out. Cloned voice synthesis can take longer.")
            } catch (e: java.io.IOException) {
                android.util.Log.e("SelfHostedTTS", "Network error: ${e.message}")
                throw TTSError.NetworkError("Network error: ${e.message}")
            }

            android.util.Log.d("SelfHostedTTS", "Cloned voice job response code: ${response.code}")

            if (!response.isSuccessful) {
                val errorBody = response.body?.string() ?: "Unknown error"
                android.util.Log.e("SelfHostedTTS", "Error response: $errorBody")
                handleErrorResponse(response.code, errorBody, text.length)
            }

            // Parse job response
            val responseBody = response.body?.string() ?: throw TTSError.AudioEncodingFailed("Empty response")
            val jobResponse = JSONObject(responseBody)
            val jobId = jobResponse.getString("job_id")
            val initialStatus = jobResponse.getString("status")

            android.util.Log.d("SelfHostedTTS", "Cloned voice job started: jobId=$jobId, status=$initialStatus")

            // Register this job for progress resumption
            activeClonedJobs[voiceId] = ActiveClonedJob(
                jobId = jobId,
                voiceId = voiceId,
                text = text,
                startTime = startTime
            )

            // If immediately ready (cache hit), download audio
            if (initialStatus == "ready") {
                activeClonedJobs.remove(voiceId)
                val audioUrl = jobResponse.optString("audio_url").takeIf { it.isNotEmpty() }
                if (audioUrl != null) {
                    return@withContext downloadAndSaveClonedAudio(
                        audioUrl, jobId, text, voiceId, startTime, onProgress
                    )
                }
            }

            // Poll for job status with real progress updates
            var pollCount = 0
            val maxPolls = 180  // 6 minutes max (2 sec intervals) - cloned voice takes longer
            val pollInterval = 2000L  // 2 seconds like iOS

            while (pollCount < maxPolls) {
                // Check for cancellation
                if (activeTasks[taskId] == true) {
                    throw TTSError.Cancelled
                }

                Thread.sleep(pollInterval)
                pollCount++

                // Poll with retry logic
                val statusResponse = pollJobStatusWithRetry(jobId)
                if (statusResponse == null) {
                    android.util.Log.w("SelfHostedTTS", "Transient poll error, continuing...")
                    continue
                }

                val status = statusResponse.getString("status")
                val progress = statusResponse.optJSONObject("progress")

                // Get progress from backend
                val percentage = progress?.optInt("percentage", 0) ?: 0
                val estimatedRemainingSec = progress?.optInt("estimated_remaining_sec")
                val chunksCompleted = progress?.optInt("chunks_completed", 0) ?: 0
                val chunksTotal = progress?.optInt("chunks_total", 1) ?: 1

                android.util.Log.d("SelfHostedTTS", "Cloned voice job $jobId: status=$status, progress=$percentage%, chunks=$chunksCompleted/$chunksTotal")

                // Calculate progress based on multiple signals:
                // 1. Backend percentage (most accurate when available)
                // 2. Chunks completed vs total (good intermediate progress)
                // 3. Poll count (last resort to show activity)
                val chunkProgress = if (chunksTotal > 0) chunksCompleted.toFloat() / chunksTotal else 0f
                val displayProgress = when {
                    percentage > 0 -> percentage / 100f
                    chunkProgress > 0 -> chunkProgress
                    pollCount > 0 -> minOf(0.05f + (pollCount * 0.005f), 0.15f)  // Slow creep to show activity
                    else -> 0.05f
                }
                val displayPercentage = (displayProgress * 100).toInt()

                val statusMsg = when {
                    status == "queued" -> "In queue..."
                    status == "partial_ready" -> "Almost ready... $displayPercentage%"
                    chunksCompleted > 0 -> "Synthesizing... $displayPercentage% (chunk $chunksCompleted/$chunksTotal)"
                    estimatedRemainingSec != null && estimatedRemainingSec > 0 -> {
                        val mins = estimatedRemainingSec / 60
                        val secs = estimatedRemainingSec % 60
                        if (mins > 0) "Synthesizing... ~${mins}m ${secs}s remaining"
                        else "Synthesizing... ~${secs}s remaining"
                    }
                    chunksTotal > 1 -> "Synthesizing chunk 1/$chunksTotal..."
                    else -> "Synthesizing... $displayPercentage%"
                }

                // Update cached progress for resume
                activeClonedJobs[voiceId]?.let {
                    it.lastProgress = displayProgress
                    it.lastStatusMessage = statusMsg
                }

                onProgress(SynthesisProgress(
                    overallProgress = displayProgress,
                    currentSectionIndex = 0,
                    sectionsCompleted = chunksCompleted,
                    totalSections = chunksTotal,
                    estimatedTimeRemaining = estimatedRemainingSec?.toDouble() ?: 0.0,
                    statusMessage = statusMsg,
                    charactersProcessed = (text.length * percentage / 100),
                    totalCharacters = text.length
                ))

                when (status) {
                    "ready" -> {
                        activeClonedJobs.remove(voiceId)
                        val audioUrl = statusResponse.optString("audio_url").takeIf { it.isNotEmpty() }
                            ?: throw TTSError.AudioEncodingFailed("No audio URL in ready response")
                        return@withContext downloadAndSaveClonedAudio(
                            audioUrl, jobId, text, voiceId, startTime, onProgress
                        )
                    }
                    "failed" -> {
                        activeClonedJobs.remove(voiceId)
                        val error = statusResponse.optJSONObject("error")
                        val errorMsg = error?.optString("message") ?: "Cloned voice synthesis failed"
                        throw TTSError.NetworkError(errorMsg)
                    }
                    "canceled" -> {
                        activeClonedJobs.remove(voiceId)
                        throw TTSError.Cancelled
                    }
                }
            }

            activeClonedJobs.remove(voiceId)
            throw TTSError.NetworkError("Cloned voice synthesis timed out after ${maxPolls * pollInterval / 1000} seconds")

        } finally {
            activeTasks.remove(taskId)
        }
    }

    /**
     * Download cloned voice audio from URL and save to local file
     */
    private fun downloadAndSaveClonedAudio(
        audioUrl: String,
        jobId: String,
        text: String,
        voiceId: String,
        startTime: Long,
        onProgress: (SynthesisProgress) -> Unit
    ): SynthesisResult {
        onProgress(SynthesisProgress(
            overallProgress = 0.95f,
            currentSectionIndex = 0,
            sectionsCompleted = 0,
            totalSections = 1,
            estimatedTimeRemaining = 0.0,
            statusMessage = "Downloading audio...",
            charactersProcessed = text.length,
            totalCharacters = text.length
        ))

        android.util.Log.d("SelfHostedTTS", "Downloading cloned voice audio from: $audioUrl")

        val audioRequest = Request.Builder()
            .url(audioUrl)
            .get()
            .build()

        val audioResponse = httpClient.newCall(audioRequest).execute()

        if (!audioResponse.isSuccessful) {
            throw TTSError.NetworkError("Failed to download audio: ${audioResponse.code}")
        }

        val audioData = audioResponse.body?.bytes() ?: throw TTSError.AudioEncodingFailed("Empty audio response")
        android.util.Log.d("SelfHostedTTS", "Downloaded cloned voice audio: ${audioData.size} bytes")

        val outputFile = File(context.cacheDir, "tts_cloned_${jobId}.wav")
        outputFile.writeBytes(audioData)

        val endTime = System.currentTimeMillis()

        // Estimate duration from text length
        val wordCount = text.split("\\s+".toRegex()).size
        val duration = (wordCount / 150.0) * 60.0

        onProgress(SynthesisProgress(
            overallProgress = 1.0f,
            currentSectionIndex = 0,
            sectionsCompleted = 1,
            totalSections = 1,
            statusMessage = "Complete",
            totalCharacters = text.length,
            charactersProcessed = text.length
        ))

        return SynthesisResult(
            audioFile = outputFile,
            duration = duration,
            sectionTimestamps = emptyList(),
            wordTimestamps = null,
            fileSizeBytes = outputFile.length(),
            cost = SynthesisCost(
                charactersUsed = text.length,
                costUSD = 0.0,
                quotaUsed = 0,
                provider = "ListenAI (Chatterbox)"
            ),
            metadata = SynthesisMetadata(
                voiceId = voiceId,
                voiceName = "Cloned Voice",
                provider = "ListenAI",
                startedAt = startTime,
                completedAt = endTime,
                inputCharacterCount = text.length,
                outputSampleRate = 24000
            )
        )
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
            val audioBase64 = chunkResult.optString("audio_base64").takeIf { it.isNotEmpty() }
            if (audioBase64 != null) {
                val audioData = android.util.Base64.decode(audioBase64, android.util.Base64.DEFAULT)
                onChunkReady(audioData, i, totalChunks)
            }
        }
    }

    private fun handleErrorResponse(code: Int, body: String, requiredChars: Int = 0) {
        val json = try {
            JSONObject(body)
        } catch (e: Exception) {
            null
        }

        val message = json?.optString("message")
            ?: json?.optString("detail")
            ?: json?.optString("error")
            ?: body

        when (code) {
            400 -> throw TTSError.InvalidConfiguration(message)
            402 -> {
                // Quota exceeded - parse the details
                val details = json?.optJSONObject("details")
                val dailyLimit = details?.optInt("daily_limit", 4000) ?: 4000
                val dailyUsed = details?.optInt("daily_used", 0) ?: 0
                val remaining = (dailyLimit - dailyUsed).coerceAtLeast(0)
                throw TTSError.QuotaExceeded(remaining, requiredChars)
            }
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
        // Return built-in voices with proper Kokoro IDs (matching iOS)
        // These voices have correct gender, style, and avatar emojis
        android.util.Log.d("SelfHostedTTS", "Returning built-in voices (${VoicePreset.builtInVoices.size} voices)")
        return VoicePreset.builtInVoices
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

    /**
     * Get active cloned voice job for a specific voice ID.
     * Returns null if no active job exists for this voice.
     */
    fun getActiveClonedJob(voiceId: String): ActiveClonedJob? {
        return activeClonedJobs[voiceId]
    }

    /**
     * Resume tracking an active cloned voice synthesis job.
     * This is used when the UI returns to the screen and needs to resume progress tracking.
     *
     * @param voiceId The voice ID to resume tracking for
     * @param onProgress Progress callback for updates
     * @return The synthesis result if the job completes, null if cancelled or no active job
     */
    suspend fun resumeClonedJobTracking(
        voiceId: String,
        onProgress: (SynthesisProgress) -> Unit
    ): SynthesisResult? = withContext(Dispatchers.IO) {
        val activeJob = activeClonedJobs[voiceId] ?: return@withContext null

        android.util.Log.d("SelfHostedTTS", "Resuming job tracking for voice $voiceId, jobId=${activeJob.jobId}")

        val taskId = UUID.randomUUID()
        activeTasks[taskId] = false
        consecutivePollFailures = 0

        try {
            // Emit last known progress immediately
            onProgress(SynthesisProgress(
                overallProgress = activeJob.lastProgress,
                currentSectionIndex = 0,
                sectionsCompleted = 0,
                totalSections = 1,
                statusMessage = activeJob.lastStatusMessage,
                charactersProcessed = (activeJob.text.length * activeJob.lastProgress).toInt(),
                totalCharacters = activeJob.text.length
            ))

            // Continue polling for job status
            var pollCount = 0
            val maxPolls = 180
            val pollInterval = 2000L

            while (pollCount < maxPolls) {
                if (activeTasks[taskId] == true) {
                    throw TTSError.Cancelled
                }

                Thread.sleep(pollInterval)
                pollCount++

                val statusResponse = pollJobStatusWithRetry(activeJob.jobId)
                if (statusResponse == null) {
                    continue
                }

                val status = statusResponse.getString("status")
                val progress = statusResponse.optJSONObject("progress")

                val percentage = progress?.optInt("percentage", 0) ?: 0
                val estimatedRemainingSec = progress?.optInt("estimated_remaining_sec")
                val chunksCompleted = progress?.optInt("chunks_completed", 0) ?: 0
                val chunksTotal = progress?.optInt("chunks_total", 1) ?: 1

                val chunkProgress = if (chunksTotal > 0) chunksCompleted.toFloat() / chunksTotal else 0f
                val displayProgress = when {
                    percentage > 0 -> percentage / 100f
                    chunkProgress > 0 -> chunkProgress
                    pollCount > 0 -> minOf(activeJob.lastProgress + (pollCount * 0.005f), 0.15f)
                    else -> activeJob.lastProgress
                }
                val displayPercentage = (displayProgress * 100).toInt()

                val statusMsg = when {
                    status == "queued" -> "In queue..."
                    status == "partial_ready" -> "Almost ready... $displayPercentage%"
                    chunksCompleted > 0 -> "Synthesizing... $displayPercentage% (chunk $chunksCompleted/$chunksTotal)"
                    estimatedRemainingSec != null && estimatedRemainingSec > 0 -> {
                        val mins = estimatedRemainingSec / 60
                        val secs = estimatedRemainingSec % 60
                        if (mins > 0) "Synthesizing... ~${mins}m ${secs}s remaining"
                        else "Synthesizing... ~${secs}s remaining"
                    }
                    chunksTotal > 1 -> "Synthesizing chunk 1/$chunksTotal..."
                    else -> "Synthesizing... $displayPercentage%"
                }

                // Update cached progress
                activeJob.lastProgress = displayProgress
                activeJob.lastStatusMessage = statusMsg

                onProgress(SynthesisProgress(
                    overallProgress = displayProgress,
                    currentSectionIndex = 0,
                    sectionsCompleted = chunksCompleted,
                    totalSections = chunksTotal,
                    estimatedTimeRemaining = estimatedRemainingSec?.toDouble() ?: 0.0,
                    statusMessage = statusMsg,
                    charactersProcessed = (activeJob.text.length * percentage / 100),
                    totalCharacters = activeJob.text.length
                ))

                when (status) {
                    "ready" -> {
                        val audioUrl = statusResponse.optString("audio_url").takeIf { it.isNotEmpty() }
                            ?: throw TTSError.AudioEncodingFailed("No audio URL in ready response")
                        activeClonedJobs.remove(voiceId)
                        return@withContext downloadAndSaveClonedAudio(
                            audioUrl, activeJob.jobId, activeJob.text, voiceId, activeJob.startTime, onProgress
                        )
                    }
                    "failed" -> {
                        activeClonedJobs.remove(voiceId)
                        val error = statusResponse.optJSONObject("error")
                        val errorMsg = error?.optString("message") ?: "Cloned voice synthesis failed"
                        throw TTSError.NetworkError(errorMsg)
                    }
                    "canceled" -> {
                        activeClonedJobs.remove(voiceId)
                        throw TTSError.Cancelled
                    }
                }
            }

            activeClonedJobs.remove(voiceId)
            throw TTSError.NetworkError("Cloned voice synthesis timed out")

        } finally {
            activeTasks.remove(taskId)
        }
    }

    /**
     * Cancel tracking for a cloned voice job (but don't cancel the job itself).
     * Used when user navigates away or starts a new preview.
     */
    fun stopTrackingClonedJob(voiceId: String) {
        // Keep the job in the map so we can resume later
        // Just stop the current tracking coroutine
        android.util.Log.d("SelfHostedTTS", "Stopped tracking cloned job for voice $voiceId (job still active)")
    }

    /**
     * Clear a cloned voice job from tracking (used when job completes or fails).
     */
    fun clearClonedJob(voiceId: String) {
        activeClonedJobs.remove(voiceId)
        android.util.Log.d("SelfHostedTTS", "Cleared cloned job tracking for voice $voiceId")
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
