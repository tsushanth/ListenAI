package com.listenai.service.tts

import android.content.Context
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * TTS backend that talks to the realtime-tts platform (api.readaloudai.org) instead of
 * listenai-backend.fly.dev's Chatterbox/Kokoro job queue.
 *
 * This is a "shim", not a true streaming integration: the real gateway protocol is a
 * WebSocket that streams raw PCM16/24kHz chunks as they're synthesized (sub-second
 * time-to-first-byte on Piper), but this class waits for every chunk before returning,
 * builds one WAV file, and hands it back through the exact same synchronous
 * "file on disk" contract CloudTTSService already fulfills - so PlayerScreen,
 * AudioPlaybackService, and everything downstream of TTSService needs zero changes.
 * A follow-up that actually plays audio as it streams in (for the real latency win)
 * would replace this with a proper incremental-playback pipeline; that's future work,
 * not part of this migration.
 *
 * TEMPORARY: [API_KEY] below is a real, billing-enabled test key embedded directly in
 * the client for today's on-device test build. This is extractable by decompiling the
 * APK - fine for a personal test build on one device, NOT acceptable for any wider
 * release. Before this ships beyond a local test build, this needs to move behind
 * ReadAloudAI's own backend (which already exists and already holds provider credentials
 * server-side for the old Chatterbox path) so the app never sees a raw platform API key.
 *
 * Voice selection: for this first pass every built-in voice maps to a single default
 * Piper voice (DEFAULT_VOICE_ID below), not a real per-voice mapping - proving the
 * pipeline works end-to-end, not full voice parity. TODO: map VoicePreset -> a real
 * catalog voice id once this graduates past a test build.
 */
class RealtimeTTSService(private val context: Context) : TTSService {

    companion object {
        private const val TAG = "RealtimeTTSService"

        // TEMPORARY - see class doc. Minted 2026-09-21 as a dedicated, isolated test key
        // (label "android-app-realtime-tts-test"), not shared with any other client.
        private const val API_KEY = "rtts_85c9a002f770b3380814932f6a577f464574aaa81e774e2a"

        private const val GATEWAY_BASE_URL = "https://api.readaloudai.org"
        private const val DEFAULT_VOICE_ID = "custom:en-us-john"
        private const val SAMPLE_RATE = 24000
        private const val CHANNELS = 1
        private const val BITS_PER_SAMPLE = 16
    }

    override val provider = VoiceProvider.SELF_HOSTED
    override val maxTextLength = 5000
    override val supportsStreaming = false
    override val supportsSSML = false

    private val activeTasks = mutableMapOf<UUID, Boolean>()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    override suspend fun isAvailable(): Boolean {
        return try {
            withContext(Dispatchers.IO) {
                val request = Request.Builder().url("$GATEWAY_BASE_URL/health").get().build()
                httpClient.newCall(request).execute().use { it.isSuccessful }
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

        if (totalText.isEmpty()) throw TTSError.TextEmpty
        if (totalText.length > maxTextLength) throw TTSError.TextTooLong(totalText.length, maxTextLength)

        val taskId = UUID.randomUUID()
        val startTime = System.currentTimeMillis()
        activeTasks[taskId] = false

        try {
            onProgress(
                SynthesisProgress.INITIAL.copy(
                    statusMessage = "Authorizing...",
                    totalSections = sections.size,
                    totalCharacters = totalText.length
                )
            )

            val auth = authorize()

            onProgress(
                SynthesisProgress.INITIAL.copy(
                    overallProgress = 0.1f,
                    statusMessage = "Generating audio...",
                    totalSections = sections.size,
                    totalCharacters = totalText.length
                )
            )

            val pcm = synthesizeOverWebSocket(auth, totalText, options, taskId)

            onProgress(
                SynthesisProgress(
                    overallProgress = 1.0f,
                    currentSectionIndex = sections.size - 1,
                    sectionsCompleted = sections.size,
                    totalSections = sections.size,
                    estimatedTimeRemaining = 0.0,
                    statusMessage = "Complete",
                    charactersProcessed = totalText.length,
                    totalCharacters = totalText.length
                )
            )

            buildResult(pcm, sections, totalText, voice, startTime)
        } finally {
            activeTasks.remove(taskId)
        }
    }

    private data class AuthResponse(val token: String, val wsUrl: String)

    private fun authorize(): AuthResponse {
        val body = JSONObject().apply {
            put("key", API_KEY)
            put("engine", "piper")
        }
        val request = Request.Builder()
            .url("$GATEWAY_BASE_URL/tts/authorize")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .addHeader("Content-Type", "application/json")
            .build()

        httpClient.newCall(request).execute().use { response ->
            val responseBody = response.body?.string() ?: ""
            if (!response.isSuccessful) handleErrorResponse(response.code, responseBody)
            val json = JSONObject(responseBody)
            return AuthResponse(token = json.getString("token"), wsUrl = json.getString("url"))
        }
    }

    private suspend fun synthesizeOverWebSocket(
        auth: AuthResponse,
        text: String,
        options: SynthesisOptions,
        taskId: UUID
    ): ByteArray = suspendCancellableCoroutine { cont ->
        val pcmBuffer = ByteArrayOutputStream()
        val wsUrl = "${auth.wsUrl}?token=${auth.token}"
        val request = Request.Builder().url(wsUrl).build()

        var socket: WebSocket? = null
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val message = JSONObject().apply {
                    put("type", "synthesize")
                    put("text", text)
                    put("voice", DEFAULT_VOICE_ID)
                    put("speed", options.speed.toDouble())
                }
                webSocket.send(message.toString())
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (activeTasks[taskId] == true) {
                    webSocket.close(1000, "cancelled")
                    return
                }
                pcmBuffer.write(bytes.toByteArray())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "done" -> {
                            webSocket.close(1000, "done")
                            if (cont.isActive) cont.resume(pcmBuffer.toByteArray())
                        }
                        "error" -> {
                            webSocket.close(1000, "error")
                            if (cont.isActive) {
                                cont.resumeWithException(
                                    TTSError.ApiError("ReadAloud AI", 0, json.optString("message", "synthesis error"))
                                )
                            }
                        }
                    }
                } catch (e: Exception) {
                    if (cont.isActive) cont.resumeWithException(TTSError.AudioEncodingFailed(e.message ?: "bad control message"))
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (cont.isActive) cont.resumeWithException(TTSError.NetworkError(t.message ?: "websocket failure"))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // If we closed cleanly after "done"/"error" the continuation is already
                // resolved; this only matters if the socket closes unexpectedly first.
                if (cont.isActive) {
                    cont.resumeWithException(TTSError.NetworkError("connection closed before synthesis completed ($code $reason)"))
                }
            }
        }

        socket = httpClient.newWebSocket(request, listener)
        cont.invokeOnCancellation { socket.close(1000, "task cancelled") }
    }

    private fun buildResult(
        pcm: ByteArray,
        sections: List<TextSection>,
        totalText: String,
        voice: VoicePreset,
        startTime: Long
    ): SynthesisResult {
        val wavBytes = pcmToWav(pcm, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE)
        val outputFile = File(context.cacheDir, "tts_${UUID.randomUUID()}.wav")
        outputFile.writeBytes(wavBytes)

        val endTime = System.currentTimeMillis()
        val bytesPerSecond = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)
        val duration = pcm.size.toDouble() / bytesPerSecond
        val sectionTimestamps = buildSectionTimestamps(sections, duration)

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
                provider = "ReadAloud AI (realtime-tts)"
            ),
            metadata = SynthesisMetadata(
                voiceId = voice.id,
                voiceName = voice.name,
                provider = "ReadAloud AI (realtime-tts)",
                startedAt = startTime,
                completedAt = endTime,
                inputCharacterCount = totalText.length,
                outputSampleRate = SAMPLE_RATE
            )
        )
    }

    private fun buildSectionTimestamps(sections: List<TextSection>, totalDuration: Double): List<SectionTimestamp> {
        val totalChars = sections.sumOf { it.text.length }.coerceAtLeast(1)
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

    /** Wraps raw PCM16LE mono bytes in a standard 44-byte RIFF/WAVE header. */
    private fun pcmToWav(pcm: ByteArray, sampleRate: Int, channels: Int, bitsPerSample: Int): ByteArray {
        val byteRate = sampleRate * channels * (bitsPerSample / 8)
        val blockAlign = channels * (bitsPerSample / 8)
        val header = ByteArrayOutputStream(44)

        fun writeString(s: String) = header.write(s.toByteArray(Charsets.US_ASCII))
        fun writeIntLE(v: Int) {
            header.write(v and 0xff)
            header.write((v shr 8) and 0xff)
            header.write((v shr 16) and 0xff)
            header.write((v shr 24) and 0xff)
        }
        fun writeShortLE(v: Int) {
            header.write(v and 0xff)
            header.write((v shr 8) and 0xff)
        }

        writeString("RIFF")
        writeIntLE(36 + pcm.size)
        writeString("WAVE")
        writeString("fmt ")
        writeIntLE(16)
        writeShortLE(1) // PCM
        writeShortLE(channels)
        writeIntLE(sampleRate)
        writeIntLE(byteRate)
        writeShortLE(blockAlign)
        writeShortLE(bitsPerSample)
        writeString("data")
        writeIntLE(pcm.size)

        val out = ByteArrayOutputStream(44 + pcm.size)
        out.write(header.toByteArray())
        out.write(pcm)
        return out.toByteArray()
    }

    private fun handleErrorResponse(code: Int, body: String) {
        val message = try {
            JSONObject(body).optString("error", body)
        } catch (e: Exception) {
            body
        }
        when (code) {
            401 -> throw TTSError.InvalidConfiguration("Invalid API key")
            402 -> throw TTSError.QuotaExceeded(0, 0)
            429 -> throw TTSError.RateLimited(60.0)
            else -> throw TTSError.ApiError("ReadAloud AI (realtime-tts)", code, message)
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
        return VoicePreset.builtInVoices
    }

    override suspend fun downloadVoice(voice: VoicePreset) {
        // Cloud voices don't need download
    }

    override fun estimate(text: String, voice: VoicePreset): SynthesisEstimate {
        val wordCount = text.split("\\s+".toRegex()).size
        val estimatedDuration = (wordCount / 150.0) * 60.0
        // Piper's warm time-to-first-audio is ~250ms and synthesis runs well faster
        // than real-time, so processing time is dominated by network RTT, not compute.
        val estimatedProcessingTime = estimatedDuration * 0.15

        return SynthesisEstimate(
            estimatedDuration = estimatedDuration,
            estimatedProcessingTime = estimatedProcessingTime,
            characterCount = text.length,
            estimatedCostUSD = 0.0,
            quotaImpact = null
        )
    }
}
