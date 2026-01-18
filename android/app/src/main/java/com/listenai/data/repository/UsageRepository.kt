package com.listenai.data.repository

import com.listenai.data.local.UsageDao
import com.listenai.data.models.*
import kotlinx.coroutines.flow.Flow
import java.util.*

class UsageRepository(
    private val usageDao: UsageDao
) {
    val allRecords: Flow<List<UsageRecord>> = usageDao.getAllRecords()

    suspend fun recordUsage(
        characterCount: Int,
        provider: String,
        voiceId: String?,
        articleId: String?,
        articleTitle: String?,
        isSuccess: Boolean = true,
        errorMessage: String? = null
    ) {
        val record = UsageRecord(
            characterCount = characterCount,
            provider = provider,
            voiceId = voiceId,
            articleId = articleId,
            articleTitle = articleTitle,
            isSuccess = isSuccess,
            errorMessage = errorMessage
        )
        usageDao.insertRecord(record)
    }

    suspend fun getDailySummary(tier: UsageTier): UsageSummary {
        val calendar = Calendar.getInstance()
        calendar.set(Calendar.HOUR_OF_DAY, 0)
        calendar.set(Calendar.MINUTE, 0)
        calendar.set(Calendar.SECOND, 0)
        calendar.set(Calendar.MILLISECOND, 0)
        val startOfDay = calendar.timeInMillis

        calendar.add(Calendar.DAY_OF_MONTH, 1)
        val endOfDay = calendar.timeInMillis

        return getSummaryForRange(UsagePeriod.DAILY, startOfDay, endOfDay, tier.dailyLimit)
    }

    suspend fun getMonthlySummary(tier: UsageTier): UsageSummary {
        val calendar = Calendar.getInstance()
        calendar.set(Calendar.DAY_OF_MONTH, 1)
        calendar.set(Calendar.HOUR_OF_DAY, 0)
        calendar.set(Calendar.MINUTE, 0)
        calendar.set(Calendar.SECOND, 0)
        calendar.set(Calendar.MILLISECOND, 0)
        val startOfMonth = calendar.timeInMillis

        calendar.add(Calendar.MONTH, 1)
        val endOfMonth = calendar.timeInMillis

        return getSummaryForRange(UsagePeriod.MONTHLY, startOfMonth, endOfMonth, tier.monthlyLimit)
    }

    private suspend fun getSummaryForRange(
        period: UsagePeriod,
        startTime: Long,
        endTime: Long,
        limit: Int
    ): UsageSummary {
        val totalCharacters = usageDao.getTotalCharactersInRange(startTime, endTime) ?: 0
        val totalRequests = usageDao.getRequestCountInRange(startTime, endTime)
        val successfulRequests = usageDao.getSuccessfulRequestCountInRange(startTime, endTime)
        val providerUsage = usageDao.getCharactersByProviderInRange(startTime, endTime)

        return UsageSummary(
            period = period,
            startDate = Date(startTime),
            endDate = Date(endTime),
            totalCharacters = totalCharacters,
            totalRequests = totalRequests,
            successfulRequests = successfulRequests,
            failedRequests = totalRequests - successfulRequests,
            charactersByProvider = providerUsage.associate { it.provider to it.total },
            limit = limit
        )
    }

    suspend fun getUsageQuota(tier: UsageTier): UsageQuota {
        return UsageQuota(
            tier = tier,
            dailySummary = getDailySummary(tier),
            monthlySummary = getMonthlySummary(tier)
        )
    }

    suspend fun estimateUsage(characterCount: Int, tier: UsageTier): UsageEstimate {
        val dailySummary = getDailySummary(tier)
        val monthlySummary = getMonthlySummary(tier)

        val remainingDaily = dailySummary.remaining
        val remainingMonthly = monthlySummary.remaining

        // Estimate duration: ~150 words per minute, ~5 characters per word
        val estimatedDuration = (characterCount / 5 / 150.0 * 60 * 1000).toLong()

        return UsageEstimate(
            characterCount = characterCount,
            willExceedDaily = characterCount > remainingDaily,
            willExceedMonthly = characterCount > remainingMonthly,
            remainingDaily = remainingDaily,
            remainingMonthly = remainingMonthly,
            estimatedDuration = estimatedDuration
        )
    }

    suspend fun getRecentRecords(limit: Int = 20): List<UsageRecord> {
        return usageDao.getRecentRecords(limit)
    }

    suspend fun getTotalCharactersAllTime(): Int {
        return usageDao.getTotalCharactersAllTime() ?: 0
    }

    suspend fun getTotalRequestsAllTime(): Int {
        return usageDao.getTotalRequestsAllTime()
    }

    suspend fun cleanupOldRecords(daysToKeep: Int = 90) {
        val calendar = Calendar.getInstance()
        calendar.add(Calendar.DAY_OF_MONTH, -daysToKeep)
        usageDao.deleteRecordsBefore(calendar.timeInMillis)
    }

    suspend fun insert(record: UsageRecord) {
        usageDao.insertRecord(record)
    }

    suspend fun getRecordsInRange(startTime: Long, endTime: Long): List<UsageRecord> {
        return usageDao.getRecordsInRange(startTime, endTime)
    }

    fun getRecordsInRangeFlow(startTime: Long, endTime: Long): Flow<List<UsageRecord>> {
        return usageDao.getRecordsInRangeFlow(startTime, endTime)
    }
}
