package com.listenai.service.marketplace

import android.content.Context
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Service for interacting with the voice marketplace API.
 * Allows users to share voices, browse community voices, rate, and report.
 */
class VoiceMarketplaceService private constructor(private val context: Context) {

    // MARK: - Types

    /**
     * Shared voice from the marketplace
     */
    data class SharedVoice(
        val id: String,
        val displayName: String,
        val description: String?,
        val tags: List<String>,
        val previewAudioUrl: String?,
        val previewDurationSec: Double?,
        val usageCount: Int,
        val avgRating: Double,
        val ratingCount: Int,
        val ownerUserId: String,
        val createdAt: Date?,
        val isOwn: Boolean
    )

    /**
     * User's own shared voice with status info
     */
    data class MySharedVoice(
        val id: String,
        val displayName: String,
        val description: String?,
        val tags: List<String>,
        val status: String,
        val usageCount: Int,
        val avgRating: Double,
        val ratingCount: Int,
        val createdAt: Date?,
        val revokedAt: Date?,
        val revokedReason: String?
    )

    /**
     * Rewards summary
     */
    data class RewardsSummary(
        val pendingMinutes: Double,
        val pendingCount: Int,
        val creditedTotalMinutes: Double
    )

    /**
     * Reward history entry
     */
    data class RewardHistoryEntry(
        val id: String,
        val sharedVoiceId: String,
        val voiceName: String,
        val charactersGenerated: Int,
        val secondsGenerated: Double,
        val rewardMinutes: Double,
        val credited: Boolean,
        val creditedAt: Date?,
        val createdAt: Date?
    )

    /**
     * Sort options for marketplace
     */
    enum class SortOption(val value: String, val displayName: String) {
        POPULAR("popular", "Most Popular"),
        NEWEST("newest", "Newest"),
        RATING("rating", "Top Rated")
    }

    /**
     * Report reason
     */
    enum class ReportReason(val value: String, val displayName: String) {
        NOT_THEIR_VOICE("not_their_voice", "Not Their Voice"),
        CELEBRITY("celebrity", "Celebrity Impersonation"),
        PUBLIC_FIGURE("public_figure", "Public Figure"),
        OFFENSIVE("offensive", "Offensive Content"),
        COPYRIGHT("copyright", "Copyright Violation"),
        OTHER("other", "Other")
    }

    /**
     * Marketplace errors
     */
    sealed class MarketplaceError : Exception() {
        object NotConfigured : MarketplaceError() {
            override val message = "Marketplace service is not configured"
        }
        data class NetworkError(val reason: String) : MarketplaceError() {
            override val message = "Network error: $reason"
        }
        object Unauthorized : MarketplaceError() {
            override val message = "Please sign in to access the marketplace"
        }
        object NotFound : MarketplaceError() {
            override val message = "Voice not found"
        }
        object AlreadyShared : MarketplaceError() {
            override val message = "This voice is already shared"
        }
        data class ValidationError(val reason: String) : MarketplaceError() {
            override val message = reason
        }
    }

    // MARK: - Companion

    companion object {
        @Volatile
        private var instance: VoiceMarketplaceService? = null

        fun getInstance(context: Context): VoiceMarketplaceService {
            return instance ?: synchronized(this) {
                instance ?: VoiceMarketplaceService(context.applicationContext).also { instance = it }
            }
        }
    }

    // MARK: - Properties

    private var baseUrl: String? = "https://listenai-backend-917362189743.us-central1.run.app"

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val dateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    // MARK: - Configuration

    fun configure(baseUrl: String) {
        this.baseUrl = baseUrl.trimEnd('/')
    }

    val isConfigured: Boolean
        get() = baseUrl != null

    // MARK: - Browse Marketplace

    /**
     * Browse shared voices in the marketplace
     */
    suspend fun browse(
        tags: List<String>? = null,
        search: String? = null,
        sort: SortOption = SortOption.POPULAR,
        limit: Int = 20,
        offset: Int = 0
    ): List<SharedVoice> = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val queryParams = mutableListOf(
            "sort=${sort.value}",
            "limit=$limit",
            "offset=$offset"
        )
        tags?.takeIf { it.isNotEmpty() }?.let {
            queryParams.add("tags=${it.joinToString(",")}")
        }
        search?.takeIf { it.isNotEmpty() }?.let {
            queryParams.add("search=$it")
        }

        val endpoint = "/api/marketplace?${queryParams.joinToString("&")}"
        val request = createRequest(endpoint, "GET")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw MarketplaceError.NetworkError("Empty response")
                val json = JSONObject(body)
                val voicesArray = json.getJSONArray("voices")
                (0 until voicesArray.length()).map { i ->
                    parseSharedVoice(voicesArray.getJSONObject(i))
                }
            }
            401 -> throw MarketplaceError.Unauthorized
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    /**
     * Get details for a single shared voice
     */
    suspend fun getVoice(id: String): SharedVoice = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val request = createRequest("/api/marketplace/$id", "GET")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw MarketplaceError.NetworkError("Empty response")
                parseSharedVoice(JSONObject(body))
            }
            404 -> throw MarketplaceError.NotFound
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    // MARK: - Share Voice

    /**
     * Share a cloned voice to the marketplace
     */
    suspend fun shareVoice(
        clonedVoiceId: String,
        displayName: String,
        description: String?,
        tags: List<String>,
        attestation: String
    ): String = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val body = JSONObject().apply {
            put("cloned_voice_id", clonedVoiceId)
            put("display_name", displayName)
            put("tags", JSONArray(tags))
            put("owner_attestation", attestation)
            put("terms_accepted", true)
            description?.takeIf { it.isNotEmpty() }?.let { put("description", it) }
        }

        val request = createRequest("/api/marketplace/share", "POST")
            .newBuilder()
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()

        when (response.code) {
            201 -> {
                val responseBody = response.body?.string() ?: throw MarketplaceError.NetworkError("Empty response")
                JSONObject(responseBody).getString("id")
            }
            400 -> {
                val errorBody = response.body?.string()
                val errorMsg = try {
                    JSONObject(errorBody ?: "").optString("error", "Validation failed")
                } catch (e: Exception) { "Validation failed" }
                if (errorMsg.contains("already shared", ignoreCase = true)) {
                    throw MarketplaceError.AlreadyShared
                }
                throw MarketplaceError.ValidationError(errorMsg)
            }
            401 -> throw MarketplaceError.Unauthorized
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    /**
     * Revoke (unshare) a voice from the marketplace
     */
    suspend fun revokeVoice(id: String): Unit = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val request = createRequest("/api/marketplace/$id", "DELETE")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            204 -> { /* Success */ }
            404 -> throw MarketplaceError.NotFound
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    // MARK: - Rate Voice

    /**
     * Rate a shared voice
     */
    suspend fun rateVoice(id: String, rating: Int, review: String?): Unit = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val body = JSONObject().apply {
            put("rating", rating)
            review?.takeIf { it.isNotEmpty() }?.let { put("review", it) }
        }

        val request = createRequest("/api/marketplace/$id/rate", "POST")
            .newBuilder()
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()

        if (response.code != 200) {
            throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    // MARK: - Report Voice

    /**
     * Report a shared voice
     */
    suspend fun reportVoice(id: String, reason: ReportReason, description: String): Unit = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val body = JSONObject().apply {
            put("reason", reason.value)
            put("description", description)
        }

        val request = createRequest("/api/marketplace/$id/report", "POST")
            .newBuilder()
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()

        when (response.code) {
            201 -> { /* Success */ }
            400 -> {
                val errorBody = response.body?.string()
                val errorMsg = try {
                    JSONObject(errorBody ?: "").optString("error", "Report failed")
                } catch (e: Exception) { "Report failed" }
                throw MarketplaceError.ValidationError(errorMsg)
            }
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    // MARK: - My Shares

    /**
     * Get user's shared voices
     */
    suspend fun getMyShares(): List<MySharedVoice> = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val request = createRequest("/api/marketplace/my/shares", "GET")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw MarketplaceError.NetworkError("Empty response")
                val json = JSONObject(body)
                val sharesArray = json.getJSONArray("shares")
                (0 until sharesArray.length()).map { i ->
                    parseMySharedVoice(sharesArray.getJSONObject(i))
                }
            }
            401 -> throw MarketplaceError.Unauthorized
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    // MARK: - Rewards

    /**
     * Get rewards summary
     */
    suspend fun getRewardsSummary(): RewardsSummary = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val request = createRequest("/api/marketplace/my/rewards", "GET")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw MarketplaceError.NetworkError("Empty response")
                val json = JSONObject(body)
                val pending = json.getJSONObject("pending")
                val credited = json.getJSONObject("credited")
                RewardsSummary(
                    pendingMinutes = pending.optDouble("minutes", 0.0),
                    pendingCount = pending.optInt("count", 0),
                    creditedTotalMinutes = credited.optDouble("total_minutes", 0.0)
                )
            }
            401 -> throw MarketplaceError.Unauthorized
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    /**
     * Credit pending rewards
     */
    suspend fun creditRewards(): Double = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val request = createRequest("/api/marketplace/my/rewards/credit", "POST")
            .newBuilder()
            .post("".toRequestBody(null))
            .build()

        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw MarketplaceError.NetworkError("Empty response")
                JSONObject(body).optDouble("credited_minutes", 0.0)
            }
            401 -> throw MarketplaceError.Unauthorized
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    /**
     * Get reward history
     */
    suspend fun getRewardHistory(limit: Int = 50, offset: Int = 0): List<RewardHistoryEntry> = withContext(Dispatchers.IO) {
        if (!isConfigured) throw MarketplaceError.NotConfigured

        val request = createRequest("/api/marketplace/my/rewards/history?limit=$limit&offset=$offset", "GET")
        val response = httpClient.newCall(request).execute()

        when (response.code) {
            200 -> {
                val body = response.body?.string() ?: throw MarketplaceError.NetworkError("Empty response")
                val json = JSONObject(body)
                val historyArray = json.getJSONArray("history")
                (0 until historyArray.length()).map { i ->
                    parseRewardHistoryEntry(historyArray.getJSONObject(i))
                }
            }
            401 -> throw MarketplaceError.Unauthorized
            else -> throw MarketplaceError.NetworkError("Status ${response.code}")
        }
    }

    // MARK: - Private Helpers

    private fun getDeviceId(): String {
        val prefs = context.getSharedPreferences("voice_marketplace", Context.MODE_PRIVATE)
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

    private fun parseDate(dateString: String?): Date? {
        return dateString?.takeIf { it.isNotEmpty() }?.let {
            try { dateFormat.parse(it) } catch (e: Exception) { null }
        }
    }

    private fun parseSharedVoice(json: JSONObject): SharedVoice {
        val tagsArray = json.optJSONArray("tags")
        val tags = if (tagsArray != null) {
            (0 until tagsArray.length()).map { tagsArray.getString(it) }
        } else emptyList()

        return SharedVoice(
            id = json.getString("id"),
            displayName = json.getString("display_name"),
            description = json.optString("description").takeIf { it.isNotEmpty() },
            tags = tags,
            previewAudioUrl = json.optString("preview_audio_url").takeIf { it.isNotEmpty() },
            previewDurationSec = json.optDouble("preview_duration_sec").takeIf { !it.isNaN() },
            usageCount = json.optInt("usage_count", 0),
            avgRating = json.optDouble("avg_rating", 0.0),
            ratingCount = json.optInt("rating_count", 0),
            ownerUserId = json.optString("owner_user_id", ""),
            createdAt = parseDate(json.optString("created_at")),
            isOwn = json.optBoolean("is_own", false)
        )
    }

    private fun parseMySharedVoice(json: JSONObject): MySharedVoice {
        val tagsArray = json.optJSONArray("tags")
        val tags = if (tagsArray != null) {
            (0 until tagsArray.length()).map { tagsArray.getString(it) }
        } else emptyList()

        return MySharedVoice(
            id = json.getString("id"),
            displayName = json.getString("display_name"),
            description = json.optString("description").takeIf { it.isNotEmpty() },
            tags = tags,
            status = json.optString("status", "active"),
            usageCount = json.optInt("usage_count", 0),
            avgRating = json.optDouble("avg_rating", 0.0),
            ratingCount = json.optInt("rating_count", 0),
            createdAt = parseDate(json.optString("created_at")),
            revokedAt = parseDate(json.optString("revoked_at")),
            revokedReason = json.optString("revoked_reason").takeIf { it.isNotEmpty() }
        )
    }

    private fun parseRewardHistoryEntry(json: JSONObject): RewardHistoryEntry {
        return RewardHistoryEntry(
            id = json.getString("id"),
            sharedVoiceId = json.getString("shared_voice_id"),
            voiceName = json.optString("voice_name", "Unknown"),
            charactersGenerated = json.optInt("characters_generated", 0),
            secondsGenerated = json.optDouble("seconds_generated", 0.0),
            rewardMinutes = json.optDouble("reward_minutes", 0.0),
            credited = json.optBoolean("credited", false),
            creditedAt = parseDate(json.optString("credited_at")),
            createdAt = parseDate(json.optString("created_at"))
        )
    }
}
