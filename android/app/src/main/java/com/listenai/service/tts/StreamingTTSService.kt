package com.listenai.service.tts

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Streaming TTS Service for progressive audio playback.
 * Receives audio chunks as they're synthesized and plays them immediately.
 */
class StreamingTTSService(
    private val context: Context,
    private val baseUrl: String = "https://listenai-backend-917362189743.us-central1.run.app"
) {
    companion object {
        private const val TAG = "StreamingTTS"
    }

    // State
    private val _isStreaming = MutableStateFlow(false)
    val isStreaming: StateFlow<Boolean> = _isStreaming.asStateFlow()

    private val _chunksReceived = MutableStateFlow(0)
    val chunksReceived: StateFlow<Int> = _chunksReceived.asStateFlow()

    private val _totalChunks = MutableStateFlow(0)
    val totalChunks: StateFlow<Int> = _totalChunks.asStateFlow()

    private val _progress = MutableStateFlow(0f)
    val progress: StateFlow<Float> = _progress.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    // HTTP client with long timeout for streaming
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.MINUTES)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // JSON parser
    private val json = Json { ignoreUnknownKeys = true }

    // ExoPlayer for playback
    private var player: ExoPlayer? = null
    private val tempFiles = mutableListOf<File>()

    /**
     * Stream synthesis from the backend and play audio chunks as they arrive.
     */
    suspend fun streamSynthesis(
        text: String,
        voicePresetId: String,
        speed: Float = 1.0f,
        authToken: String? = null
    ) {
        // Reset state
        _isStreaming.value = true
        _chunksReceived.value = 0
        _totalChunks.value = 0
        _progress.value = 0f
        _error.value = null

        // Clean up previous temp files
        cleanupTempFiles()

        // Initialize player
        withContext(Dispatchers.Main) {
            player?.release()
            player = ExoPlayer.Builder(context).build()
        }

        try {
            withContext(Dispatchers.IO) {
                performStreamRequest(text, voicePresetId, speed, authToken)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Streaming failed", e)
            _error.value = e.message ?: "Streaming failed"
        } finally {
            _isStreaming.value = false
        }
    }

    private suspend fun performStreamRequest(
        text: String,
        voicePresetId: String,
        speed: Float,
        authToken: String?
    ) {
        // Build request body
        val requestBody = """
            {
                "text": ${json.encodeToString(kotlinx.serialization.serializer<String>(), text)},
                "voice_preset_id": "$voicePresetId",
                "options": {
                    "speed": $speed
                }
            }
        """.trimIndent()

        val requestBuilder = Request.Builder()
            .url("$baseUrl/api/tts/stream")
            .post(requestBody.toRequestBody("application/json".toMediaType()))
            .header("Accept", "application/x-ndjson")

        // Add auth token if available
        authToken?.let {
            requestBuilder.header("Authorization", "Bearer $it")
        }

        val request = requestBuilder.build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw Exception("HTTP ${response.code}: ${response.message}")
            }

            // Get total chunks from header
            response.header("X-Total-Chunks")?.toIntOrNull()?.let {
                _totalChunks.value = it
            }

            // Process NDJSON stream line by line
            response.body?.source()?.let { source ->
                while (!source.exhausted()) {
                    val line = source.readUtf8Line() ?: break
                    if (line.isNotBlank()) {
                        processChunk(line)
                    }
                }
            }
        }

        Log.i(TAG, "Streaming completed: ${_chunksReceived.value} chunks")
    }

    private suspend fun processChunk(line: String) {
        try {
            val chunk = json.decodeFromString<TTSStreamChunk>(line)

            // Update state
            _chunksReceived.value = chunk.index + 1
            if (chunk.total > 0) {
                _totalChunks.value = chunk.total
                _progress.value = (chunk.index + 1).toFloat() / chunk.total
            }

            // Check for error
            chunk.error?.let {
                _error.value = it
                return
            }

            // Decode base64 audio and save to temp file
            val audioData = Base64.decode(chunk.audio, Base64.DEFAULT)
            val tempFile = File.createTempFile("chunk_${chunk.index}_", ".wav", context.cacheDir)
            tempFile.writeBytes(audioData)
            tempFiles.add(tempFile)

            // Add to player on main thread
            withContext(Dispatchers.Main) {
                player?.let { exoPlayer ->
                    val mediaItem = MediaItem.fromUri(tempFile.toURI().toString())
                    exoPlayer.addMediaItem(mediaItem)

                    // Start playback on first chunk
                    if (chunk.index == 0) {
                        exoPlayer.prepare()
                        exoPlayer.play()
                    }
                }
            }

            Log.d(TAG, "Chunk ${chunk.index + 1}/${chunk.total} processed, duration: ${chunk.duration_ms}ms")

        } catch (e: Exception) {
            Log.e(TAG, "Failed to process chunk: $line", e)
        }
    }

    /**
     * Cancel ongoing stream and release resources
     */
    fun cancel() {
        _isStreaming.value = false
        player?.release()
        player = null
        cleanupTempFiles()
    }

    /**
     * Clean up temporary audio files
     */
    private fun cleanupTempFiles() {
        tempFiles.forEach { file ->
            try {
                file.delete()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to delete temp file: ${file.name}")
            }
        }
        tempFiles.clear()
    }

    /**
     * Release all resources
     */
    fun release() {
        cancel()
    }

    /**
     * Get the current player for external control
     */
    fun getPlayer(): Player? = player
}

/**
 * Chunk response from streaming TTS endpoint
 */
@Serializable
data class TTSStreamChunk(
    val index: Int,
    val total: Int,
    val audio: String,
    val duration_ms: Int,
    val synthesis_time_ms: Int? = null,
    val final: Boolean = false,
    val error: String? = null
)
