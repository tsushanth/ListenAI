package com.listenai.service.usage

import android.content.Context
import android.content.SharedPreferences
import com.listenai.data.models.PremiumUsageSummary
import com.listenai.data.models.UsagePeriod
import com.listenai.data.models.UsageRecord
import com.listenai.data.models.UsageSummary
import com.listenai.data.models.UsageTier
import com.listenai.data.models.VoiceQuality
import com.listenai.data.repository.UsageRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.Calendar
import java.util.Date
import java.util.UUID

/**
 * Service for tracking TTS usage and enforcing quotas
 */
class UsageTrackerService(
    private val context: Context,
    private val usageRepository: UsageRepository
) {
    private val prefs: SharedPreferences = context.getSharedPreferences("usage_tracker", Context.MODE_PRIVATE)

    private val _currentTier = MutableStateFlow(UsageTier.FREE)
    val currentTier: StateFlow<UsageTier> = _currentTier

    private val _monthlySummary = MutableStateFlow<UsageSummary?>(null)
    val monthlySummary: StateFlow<UsageSummary?> = _monthlySummary

    // Premium usage tracking
    private val _premiumSamplesUsedToday = MutableStateFlow(0)
    val premiumSamplesUsedToday: StateFlow<Int> = _premiumSamplesUsedToday

    private val _premiumCharactersUsedToday = MutableStateFlow(0)
    val premiumCharactersUsedToday: StateFlow<Int> = _premiumCharactersUsedToday

    private val _standardSamplesUsedToday = MutableStateFlow(0)
    val standardSamplesUsedToday: StateFlow<Int> = _standardSamplesUsedToday

    private val _standardCharactersUsedToday = MutableStateFlow(0)
    val standardCharactersUsedToday: StateFlow<Int> = _standardCharactersUsedToday

    init {
        loadQualityTracking()
        checkAndResetQualityTracking()
    }

    /**
     * Daily premium sample limit based on tier
     */
    val dailyPremiumSampleLimit: Int
        get() = when (_currentTier.value) {
            UsageTier.FREE -> 3
            UsageTier.BASIC -> 30
            UsageTier.PRO -> 100
            UsageTier.UNLIMITED -> Int.MAX_VALUE
        }

    /**
     * Daily premium character limit based on tier
     */
    val dailyPremiumCharacterLimit: Int
        get() = when (_currentTier.value) {
            UsageTier.FREE -> 4_000       // ~5 minutes
            UsageTier.BASIC -> 50_000     // ~35 minutes
            UsageTier.PRO -> 200_000      // ~2.5 hours
            UsageTier.UNLIMITED -> Int.MAX_VALUE
        }

    /**
     * Track usage for a TTS synthesis request
     */
    suspend fun trackUsage(
        charactersUsed: Int,
        articleId: String?,
        articleTitle: String?,
        voiceId: String,
        provider: String
    ) {
        val record = UsageRecord(
            id = UUID.randomUUID().toString(),
            timestamp = System.currentTimeMillis(),
            characterCount = charactersUsed,
            provider = provider,
            voiceId = voiceId,
            articleId = articleId,
            articleTitle = articleTitle,
            isSuccess = true
        )

        usageRepository.insert(record)
        refreshUsage()
    }

    /**
     * Track premium quality usage (ElevenLabs)
     */
    suspend fun trackPremiumUsage(
        charactersUsed: Int,
        voiceId: String,
        articleId: String?,
        articleTitle: String?
    ) {
        checkAndResetQualityTracking()

        _premiumSamplesUsedToday.value += 1
        _premiumCharactersUsedToday.value += charactersUsed

        saveQualityTracking()

        trackUsage(
            charactersUsed = charactersUsed,
            articleId = articleId,
            articleTitle = articleTitle,
            voiceId = voiceId,
            provider = "elevenlabs"
        )
    }

    /**
     * Track standard quality usage (Kokoro)
     */
    suspend fun trackStandardUsage(
        charactersUsed: Int,
        voiceId: String,
        articleId: String?,
        articleTitle: String?
    ) {
        _standardSamplesUsedToday.value += 1
        _standardCharactersUsedToday.value += charactersUsed

        saveQualityTracking()

        trackUsage(
            charactersUsed = charactersUsed,
            articleId = articleId,
            articleTitle = articleTitle,
            voiceId = voiceId,
            provider = "selfhosted"
        )
    }

    /**
     * Check if user can use premium quality
     * Note: Always returns true - server handles all quota enforcement
     */
    fun canUsePremium(characterCount: Int): Boolean {
        // Server handles all quota enforcement
        // Client-side checks removed to avoid blocking when server allows
        return true
    }

    /**
     * Get remaining premium characters for today
     */
    fun getRemainingPremiumCharacters(): Int {
        checkAndResetQualityTracking()
        val limit = dailyPremiumCharacterLimit
        if (limit == Int.MAX_VALUE) return Int.MAX_VALUE
        return maxOf(0, limit - _premiumCharactersUsedToday.value)
    }

    /**
     * Get remaining premium samples for today
     */
    fun getRemainingPremiumSamples(): Int {
        checkAndResetQualityTracking()
        val limit = dailyPremiumSampleLimit
        if (limit == Int.MAX_VALUE) return Int.MAX_VALUE
        return maxOf(0, limit - _premiumSamplesUsedToday.value)
    }

    /**
     * Get premium usage summary
     */
    fun getPremiumUsageSummary(): PremiumUsageSummary {
        checkAndResetQualityTracking()
        return PremiumUsageSummary(
            samplesUsed = _premiumSamplesUsedToday.value,
            samplesLimit = dailyPremiumSampleLimit,
            charactersUsed = _premiumCharactersUsedToday.value,
            charactersLimit = dailyPremiumCharacterLimit,
            canUsePremium = canUsePremium(0),
            tier = _currentTier.value
        )
    }

    private fun saveQualityTracking() {
        val today = getTodayKey()
        prefs.edit().apply {
            putInt("premium_samples_$today", _premiumSamplesUsedToday.value)
            putInt("premium_chars_$today", _premiumCharactersUsedToday.value)
            putInt("standard_samples_$today", _standardSamplesUsedToday.value)
            putInt("standard_chars_$today", _standardCharactersUsedToday.value)
            putString("last_tracking_date", today)
            apply()
        }
    }

    private fun loadQualityTracking() {
        val today = getTodayKey()
        val lastDate = prefs.getString("last_tracking_date", "")

        if (lastDate == today) {
            _premiumSamplesUsedToday.value = prefs.getInt("premium_samples_$today", 0)
            _premiumCharactersUsedToday.value = prefs.getInt("premium_chars_$today", 0)
            _standardSamplesUsedToday.value = prefs.getInt("standard_samples_$today", 0)
            _standardCharactersUsedToday.value = prefs.getInt("standard_chars_$today", 0)
        } else {
            // Reset for new day
            _premiumSamplesUsedToday.value = 0
            _premiumCharactersUsedToday.value = 0
            _standardSamplesUsedToday.value = 0
            _standardCharactersUsedToday.value = 0
        }
    }

    private fun checkAndResetQualityTracking() {
        val today = getTodayKey()
        val lastDate = prefs.getString("last_tracking_date", "")

        if (lastDate != today) {
            _premiumSamplesUsedToday.value = 0
            _premiumCharactersUsedToday.value = 0
            _standardSamplesUsedToday.value = 0
            _standardCharactersUsedToday.value = 0
            saveQualityTracking()
        }
    }

    private fun getTodayKey(): String {
        val calendar = Calendar.getInstance()
        return "${calendar.get(Calendar.YEAR)}-${calendar.get(Calendar.DAY_OF_YEAR)}"
    }

    /**
     * Get usage summary for current period
     */
    suspend fun refreshUsage() {
        val (startDate, endDate) = getCurrentPeriodDates()

        val records = usageRepository.getRecordsInRange(startDate, endDate)
        val totalCharacters = records.sumOf { it.characterCount }
        val totalRequests = records.size
        val successfulRequests = records.count { it.isSuccess }
        val failedRequests = records.count { !it.isSuccess }

        val tier = _currentTier.value
        _monthlySummary.value = UsageSummary(
            period = UsagePeriod.MONTHLY,
            startDate = Date(startDate),
            endDate = Date(endDate),
            totalCharacters = totalCharacters,
            totalRequests = totalRequests,
            successfulRequests = successfulRequests,
            failedRequests = failedRequests,
            charactersByProvider = records.groupBy { it.provider }
                .mapValues { (_, records) -> records.sumOf { it.characterCount } },
            limit = tier.monthlyLimit
        )
    }

    /**
     * Check if the user has remaining quota
     * Note: Always returns true - server handles all quota enforcement
     */
    fun hasRemainingQuota(): Boolean {
        // Server handles all quota enforcement
        return true
    }

    /**
     * Get remaining characters in quota
     */
    fun getRemainingCharacters(): Int {
        val summary = _monthlySummary.value ?: return _currentTier.value.monthlyLimit
        return summary.remaining
    }

    /**
     * Get usage percentage
     */
    fun getUsagePercentage(): Float {
        val summary = _monthlySummary.value ?: return 0f
        return summary.usagePercentage
    }

    /**
     * Set tier based on subscription
     */
    fun setTier(tier: UsageTier) {
        _currentTier.value = tier
    }

    /**
     * Get usage records flow for the current period
     */
    fun getUsageRecordsFlow(): Flow<List<UsageRecord>> {
        val (startDate, endDate) = getCurrentPeriodDates()
        return usageRepository.getRecordsInRangeFlow(startDate, endDate)
    }

    private fun getCurrentPeriodDates(): Pair<Long, Long> {
        val calendar = Calendar.getInstance()

        // Start of current month
        calendar.set(Calendar.DAY_OF_MONTH, 1)
        calendar.set(Calendar.HOUR_OF_DAY, 0)
        calendar.set(Calendar.MINUTE, 0)
        calendar.set(Calendar.SECOND, 0)
        calendar.set(Calendar.MILLISECOND, 0)
        val startDate = calendar.timeInMillis

        // End of current month
        calendar.add(Calendar.MONTH, 1)
        calendar.add(Calendar.MILLISECOND, -1)
        val endDate = calendar.timeInMillis

        return Pair(startDate, endDate)
    }
}
