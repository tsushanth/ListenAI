package com.listenai.service.voice

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Service for creating and managing cloned voices using Chatterbox TTS.
 * Voices are stored in Supabase Storage and can be used with the GPU TTS service.
 */
class VoiceCloningService private constructor(private val context: Context) {

    // MARK: - Types

    /**
     * Status of a voice cloning job
     */
    enum class CloningStatus {
        PENDING,
        PROCESSING,
        COMPLETED,
        FAILED
    }

    /**
     * Cloned voice metadata
     */
    data class ClonedVoice(
        val id: String,
        val name: String,
        val description: String? = null,
        val durationSec: Double? = null,
        val exaggeration: Double? = null,
        val isDefault: Boolean? = null,
        val usageCount: Int? = null,
        val createdAt: Date? = null,
        val audioUrl: String? = null
    ) {
        val isReady: Boolean
            get() = durationSec != null && durationSec > 0
    }

    /**
     * Result of creating a cloned voice
     */
    data class ClonedVoiceResult(
        val voiceId: String,
        val name: String,
        val status: CloningStatus,
        val createdAt: Date?,
        val previewUrl: String?
    )

    /**
     * Error types for voice cloning
     */
    sealed class VoiceCloningError : Exception() {
        object NotConfigured : VoiceCloningError() {
            override val message = "Voice cloning service is not configured"
        }

        data class AudioFileTooShort(val minimumSeconds: Int) : VoiceCloningError() {
            override val message = "Audio must be at least $minimumSeconds seconds long"
        }

        data class AudioFileTooLong(val maximumSeconds: Int) : VoiceCloningError() {
            override val message = "Audio must be no longer than $maximumSeconds seconds"
        }

        object InvalidAudioFormat : VoiceCloningError() {
            override val message = "Invalid audio format. Please use M4A, MP3, or WAV"
        }

        data class UploadFailed(val reason: String) : VoiceCloningError() {
            override val message = "Failed to upload audio: $reason"
        }

        data class CloningFailed(val reason: String) : VoiceCloningError() {
            override val message = "Voice cloning failed: $reason"
        }

        object VoiceNotFound : VoiceCloningError() {
            override val message = "Cloned voice not found"
        }

        data class NetworkError(val reason: String) : VoiceCloningError() {
            override val message = "Network error: $reason"
        }

        object Unauthorized : VoiceCloningError() {
            override val message = "Please sign in to use voice cloning"
        }
    }

    // MARK: - Configuration

    companion object {
        /** Minimum audio duration for cloning (in seconds) */
        const val MINIMUM_AUDIO_DURATION = 5.0

        /** Maximum audio duration for cloning (in seconds) */
        const val MAXIMUM_AUDIO_DURATION = 300.0 // 5 minutes

        /** Supported audio formats */
        val SUPPORTED_FORMATS = listOf("m4a", "mp3", "wav", "aac", "mp4", "3gp")

        /** Sample texts for users to read when recording voice samples */
        /**
         * Sample paragraphs for voice cloning recording.
         * These are designed to provide about 60+ seconds of reading at a natural pace (~90 words per minute).
         * Matches iOS VoiceCloningView sampleParagraphs.
         */
        val SAMPLE_PARAGRAPHS = listOf(
            "Welcome to ReadAloud. I'm recording my voice so the app can create a personalized voice clone that sounds just like me. This is an exciting feature that uses advanced artificial intelligence to capture the unique qualities of my voice.",

            "The technology behind voice cloning analyzes the patterns, tone, and rhythm of my speech. It learns how I pronounce different words, the natural pauses I make, and the emotional qualities that make my voice distinctive.",

            "Reading aloud has always been a wonderful way to enjoy content. Whether it's news articles, blog posts, research papers, or even emails, having them read in a familiar voice makes the experience so much more personal and engaging.",

            "I particularly enjoy listening to content during my morning commute, while exercising, or when my eyes need a rest from screens. The ability to have any text converted to natural-sounding speech has changed how I consume information.",

            "With my own voice clone, I can now listen to my favorite content as if I were reading it to myself. It's like having a personal narrator who speaks exactly how I would. This makes long documents feel less like a chore and more like a conversation.",

            "Thank you for letting me be part of this amazing technology. I'm looking forward to hearing my cloned voice bring articles and stories to life."
        )

        /**
         * Combined sample text for display (all paragraphs joined).
         */
        val SAMPLE_TEXTS = listOf(SAMPLE_PARAGRAPHS.joinToString("\n\n"))

        @Volatile
        private var instance: VoiceCloningService? = null

        fun getInstance(context: Context): VoiceCloningService {
            return instance ?: synchronized(this) {
                instance ?: VoiceCloningService(context.applicationContext).also { instance = it }
            }
        }
    }

    // MARK: - Properties

    // Default backend URL - same as iOS and SelfHostedTTSService
    private var baseUrl: String? = "https://listenai-backend.fly.dev"
    private val clonedVoicesKey = "com.listenai.clonedVoices"

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    private val dateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    // MARK: - Configuration

    /**
     * Configure the voice cloning service with backend URL.
     */
    fun configure(baseUrl: String) {
        this.baseUrl = baseUrl.trimEnd('/')
    }

    /**
     * Check if the service is configured
     */
    val isConfigured: Boolean
        get() = baseUrl != null

    // MARK: - Public Methods

    /**
     * Create an instant voice clone from an audio sample.
     *
     * Flow:
     * 1. Create voice record in backend, get signed upload URL
     * 2. Upload audio directly to Supabase Storage
     * 3. Confirm upload with audio metadata
     */
    suspend fun createInstantClone(
        name: String,
        audioSampleUri: Uri,
        description: String? = null,
        exaggeration: Double = 0.5
    ): ClonedVoiceResult = withContext(Dispatchers.IO) {
        if (!isConfigured) {
            throw VoiceCloningError.NotConfigured
        }

        // Validate audio file
        val (durationSec, fileSizeBytes) = validateAudioFile(audioSampleUri)

        // Read audio data
        val audioData = context.contentResolver.openInputStream(audioSampleUri)?.use { it.readBytes() }
            ?: throw VoiceCloningError.UploadFailed("Cannot read audio file")

        // Step 1: Create voice record and get upload URL
        val createResponse = createVoiceRecord(name, description, exaggeration)

        // Step 2: Upload audio to Supabase Storage
        uploadAudioToStorage(audioData, createResponse.uploadUrl)

        // Step 3: Confirm upload with metadata
        val voice = confirmVoiceUpload(createResponse.id, durationSec, fileSizeBytes)

        // Save to local cache
        saveClonedVoiceLocally(voice)

        ClonedVoiceResult(
            voiceId = voice.id,
            name = voice.name,
            status = CloningStatus.COMPLETED,
            createdAt = voice.createdAt,
            previewUrl = voice.audioUrl
        )
    }

    /**
     * List all cloned voices for the current user.
     * Fetches from backend and updates local cache.
     */
    suspend fun listClonedVoices(forceRefresh: Boolean = false): List<ClonedVoice> = withContext(Dispatchers.IO) {
        if (!isConfigured) {
            return@withContext loadClonedVoicesFromLocal()
        }

        if (!forceRefresh) {
            val cached = loadClonedVoicesFromLocal()
            if (cached.isNotEmpty()) {
                // Refresh in background - don't wait for it
                kotlinx.coroutines.GlobalScope.launch(Dispatchers.IO) {
                    try { fetchAndCacheVoices() } catch (e: Exception) { /* ignore */ }
                }
                return@withContext cached
            }
        }

        fetchAndCacheVoices()
    }

    /**
     * Delete a cloned voice.
     */
    suspend fun deleteClonedVoice(voiceId: String): Unit = withContext(Dispatchers.IO) {
        if (!isConfigured) {
            throw VoiceCloningError.NotConfigured
        }

        val request = createRequest("/api/cloned-voices/$voiceId", "DELETE")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200, 204 -> {
                removeClonedVoiceLocally(voiceId)
            }
            401 -> throw VoiceCloningError.Unauthorized
            404 -> throw VoiceCloningError.VoiceNotFound
            else -> {
                val errorBody = response.body?.string()
                throw VoiceCloningError.CloningFailed(errorBody ?: "Status code: ${response.code}")
            }
        }
    }

    /**
     * Update a cloned voice (name, description, exaggeration, or set as default)
     */
    suspend fun updateClonedVoice(
        voiceId: String,
        name: String? = null,
        description: String? = null,
        exaggeration: Double? = null,
        isDefault: Boolean? = null
    ): ClonedVoice = withContext(Dispatchers.IO) {
        if (!isConfigured) {
            throw VoiceCloningError.NotConfigured
        }

        val updates = JSONObject().apply {
            name?.let { put("name", it) }
            description?.let { put("description", it) }
            exaggeration?.let { put("exaggeration", it) }
            isDefault?.let { put("is_default", it) }
        }

        val request = createRequest("/api/cloned-voices/$voiceId", "PATCH")
            .newBuilder()
            .addHeader("Content-Type", "application/json")
            .patch(updates.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw VoiceCloningError.NetworkError("Empty response")
                val voice = parseClonedVoice(JSONObject(body))
                updateClonedVoiceLocally(voice)
                voice
            }
            401 -> throw VoiceCloningError.Unauthorized
            404 -> throw VoiceCloningError.VoiceNotFound
            else -> throw VoiceCloningError.NetworkError("Status code: ${response.code}")
        }
    }

    /**
     * Get a random sample text for voice recording.
     */
    fun getRandomSampleText(): String {
        return SAMPLE_TEXTS.random()
    }

    /**
     * Download preview audio for a cloned voice to cache.
     * Returns the local file path.
     */
    suspend fun downloadPreviewAudio(voiceId: String): File = withContext(Dispatchers.IO) {
        if (!isConfigured) {
            throw VoiceCloningError.NotConfigured
        }

        // Get the voice details with audio URL
        val request = createRequest("/api/cloned-voices/$voiceId", "GET")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw VoiceCloningError.NetworkError("Empty response")
                val voice = parseClonedVoice(JSONObject(body))

                val audioUrl = voice.audioUrl ?: throw VoiceCloningError.VoiceNotFound

                // Download audio to cache
                val audioRequest = Request.Builder()
                    .url(audioUrl)
                    .get()
                    .build()

                val audioResponse = httpClient.newCall(audioRequest).execute()
                if (!audioResponse.isSuccessful) {
                    throw VoiceCloningError.NetworkError("Failed to download audio")
                }

                val audioData = audioResponse.body?.bytes() ?: throw VoiceCloningError.NetworkError("Empty audio")

                val cacheFile = File(context.cacheDir, "preview_${voiceId}_${System.currentTimeMillis()}.wav")
                cacheFile.writeBytes(audioData)
                cacheFile
            }
            401 -> throw VoiceCloningError.Unauthorized
            404 -> throw VoiceCloningError.VoiceNotFound
            else -> throw VoiceCloningError.NetworkError("Status code: ${response.code}")
        }
    }

    // MARK: - Private Methods - API Calls

    private data class CreateVoiceResponse(
        val id: String,
        val name: String,
        val uploadUrl: String,
        val expiresAt: String
    )

    private suspend fun createVoiceRecord(
        name: String,
        description: String?,
        exaggeration: Double
    ): CreateVoiceResponse = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("name", name)
            put("exaggeration", exaggeration)
            description?.let { put("description", it) }
        }

        val request = createRequest("/api/cloned-voices", "POST")
            .newBuilder()
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200, 201 -> {
                val responseBody = response.body?.string() ?: throw VoiceCloningError.NetworkError("Empty response")
                val json = JSONObject(responseBody)
                CreateVoiceResponse(
                    id = json.getString("id"),
                    name = json.getString("name"),
                    uploadUrl = json.getString("upload_url"),
                    expiresAt = json.getString("expires_at")
                )
            }
            401 -> throw VoiceCloningError.Unauthorized
            else -> {
                val errorBody = response.body?.string()
                val errorMsg = try {
                    JSONObject(errorBody ?: "").optString("error", "Unknown error")
                } catch (e: Exception) {
                    "Status code: ${response.code}"
                }
                throw VoiceCloningError.CloningFailed(errorMsg)
            }
        }
    }

    private suspend fun uploadAudioToStorage(audioData: ByteArray, uploadUrl: String): Unit = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(uploadUrl)
            .put(audioData.toRequestBody("audio/wav".toMediaType()))
            .addHeader("Content-Type", "audio/wav")
            .build()

        val response = httpClient.newCall(request).execute()

        if (!response.isSuccessful) {
            throw VoiceCloningError.UploadFailed("Status code: ${response.code}")
        }
    }

    private suspend fun confirmVoiceUpload(
        voiceId: String,
        durationSec: Double,
        fileSizeBytes: Int
    ): ClonedVoice = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("duration_sec", durationSec)
            put("file_size_bytes", fileSizeBytes)
        }

        val request = createRequest("/api/cloned-voices/$voiceId/confirm", "POST")
            .newBuilder()
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val responseBody = response.body?.string() ?: throw VoiceCloningError.NetworkError("Empty response")
                parseClonedVoice(JSONObject(responseBody))
            }
            401 -> throw VoiceCloningError.Unauthorized
            else -> throw VoiceCloningError.UploadFailed("Status code: ${response.code}")
        }
    }

    private suspend fun fetchAndCacheVoices(): List<ClonedVoice> = withContext(Dispatchers.IO) {
        val request = createRequest("/api/cloned-voices?include_audio_urls=true", "GET")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw VoiceCloningError.NetworkError("Empty response")
                val json = JSONObject(body)
                val voicesArray = json.getJSONArray("voices")
                val voices = (0 until voicesArray.length()).map { i ->
                    parseClonedVoice(voicesArray.getJSONObject(i))
                }
                saveClonedVoicesToLocal(voices)
                voices
            }
            401 -> throw VoiceCloningError.Unauthorized
            else -> throw VoiceCloningError.NetworkError("Status code: ${response.code}")
        }
    }

    // MARK: - Private Methods - Validation

    private fun validateAudioFile(uri: Uri): Pair<Double, Int> {
        // Check file extension
        val mimeType = context.contentResolver.getType(uri)
        val isValidFormat = SUPPORTED_FORMATS.any { format ->
            mimeType?.contains(format, ignoreCase = true) == true ||
            uri.path?.endsWith(".$format", ignoreCase = true) == true
        }

        if (!isValidFormat && mimeType != null) {
            android.util.Log.w("VoiceCloningService", "Mime type: $mimeType, path: ${uri.path}")
            // Still allow if mime type looks like audio
            if (!mimeType.startsWith("audio/")) {
                throw VoiceCloningError.InvalidAudioFormat
            }
        }

        // Get file size
        val fileSizeBytes = context.contentResolver.openInputStream(uri)?.use {
            it.available()
        } ?: 0

        // Get audio duration
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            val durationMs = durationStr?.toLongOrNull() ?: 0L
            val durationSeconds = durationMs / 1000.0

            if (durationSeconds < MINIMUM_AUDIO_DURATION) {
                throw VoiceCloningError.AudioFileTooShort(MINIMUM_AUDIO_DURATION.toInt())
            }

            if (durationSeconds > MAXIMUM_AUDIO_DURATION) {
                throw VoiceCloningError.AudioFileTooLong(MAXIMUM_AUDIO_DURATION.toInt())
            }

            Pair(durationSeconds, fileSizeBytes)
        } finally {
            retriever.release()
        }
    }

    // MARK: - Local Storage

    private fun loadClonedVoicesFromLocal(): List<ClonedVoice> {
        val prefs = context.getSharedPreferences("voice_cloning", Context.MODE_PRIVATE)
        val json = prefs.getString(clonedVoicesKey, null) ?: return emptyList()

        return try {
            val array = JSONArray(json)
            (0 until array.length()).map { i ->
                parseClonedVoice(array.getJSONObject(i))
            }
        } catch (e: Exception) {
            android.util.Log.e("VoiceCloningService", "Failed to load cloned voices", e)
            emptyList()
        }
    }

    private fun saveClonedVoicesToLocal(voices: List<ClonedVoice>) {
        val prefs = context.getSharedPreferences("voice_cloning", Context.MODE_PRIVATE)
        val array = JSONArray()
        voices.forEach { voice ->
            array.put(voiceToJson(voice))
        }
        prefs.edit().putString(clonedVoicesKey, array.toString()).apply()
    }

    private fun saveClonedVoiceLocally(voice: ClonedVoice) {
        val voices = loadClonedVoicesFromLocal().toMutableList()
        voices.removeAll { it.id == voice.id }
        voices.add(0, voice)
        saveClonedVoicesToLocal(voices)
    }

    private fun updateClonedVoiceLocally(voice: ClonedVoice) {
        val voices = loadClonedVoicesFromLocal().toMutableList()
        val index = voices.indexOfFirst { it.id == voice.id }
        if (index >= 0) {
            voices[index] = voice
        } else {
            voices.add(0, voice)
        }
        saveClonedVoicesToLocal(voices)
    }

    private fun removeClonedVoiceLocally(voiceId: String) {
        val voices = loadClonedVoicesFromLocal().toMutableList()
        voices.removeAll { it.id == voiceId }
        saveClonedVoicesToLocal(voices)
    }

    // MARK: - Network Helpers

    private fun getDeviceId(): String {
        val prefs = context.getSharedPreferences("voice_cloning", Context.MODE_PRIVATE)
        val cached = prefs.getString("device_id", null)
        if (cached != null) return cached

        val deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?: java.util.UUID.randomUUID().toString()

        prefs.edit().putString("device_id", deviceId).apply()
        return deviceId
    }

    private fun createRequest(endpoint: String, method: String): Request {
        val url = "$baseUrl$endpoint"
        return Request.Builder()
            .url(url)
            .method(method, if (method == "GET" || method == "DELETE") null else "".toRequestBody(null))
            .addHeader("X-Device-ID", getDeviceId())
            .build()
    }

    // MARK: - JSON Parsing

    private fun parseClonedVoice(json: JSONObject): ClonedVoice {
        return ClonedVoice(
            id = json.getString("id"),
            name = json.getString("name"),
            description = json.optString("description").takeIf { it.isNotEmpty() && it != "null" },
            durationSec = json.optDouble("duration_sec").takeIf { !it.isNaN() },
            exaggeration = json.optDouble("exaggeration").takeIf { !it.isNaN() },
            isDefault = json.optBoolean("is_default"),
            usageCount = json.optInt("usage_count"),
            createdAt = json.optString("created_at").takeIf { it.isNotEmpty() && it != "null" }?.let {
                try { dateFormat.parse(it) } catch (e: Exception) { null }
            },
            audioUrl = json.optString("audio_url").takeIf { it.isNotEmpty() && it != "null" }
        )
    }

    private fun voiceToJson(voice: ClonedVoice): JSONObject {
        return JSONObject().apply {
            put("id", voice.id)
            put("name", voice.name)
            voice.description?.let { put("description", it) }
            voice.durationSec?.let { put("duration_sec", it) }
            voice.exaggeration?.let { put("exaggeration", it) }
            voice.isDefault?.let { put("is_default", it) }
            voice.usageCount?.let { put("usage_count", it) }
            voice.createdAt?.let { put("created_at", dateFormat.format(it)) }
            voice.audioUrl?.let { put("audio_url", it) }
        }
    }
}
