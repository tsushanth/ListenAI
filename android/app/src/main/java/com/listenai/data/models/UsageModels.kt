package com.listenai.data.models

import androidx.room.Entity
import androidx.room.PrimaryKey
import java.util.Date
import java.util.UUID

/**
 * Usage period type
 */
enum class UsagePeriod {
    DAILY,
    MONTHLY,
    ALL_TIME
}

/**
 * Usage tier/plan
 */
enum class UsageTier {
    FREE,
    BASIC,
    PRO,
    UNLIMITED;

    val dailyLimit: Int
        get() = when (this) {
            FREE -> 4_000          // ~5 minutes
            BASIC -> 50_000        // ~35 minutes
            PRO -> 200_000         // ~2.5 hours
            UNLIMITED -> Int.MAX_VALUE
        }

    val monthlyLimit: Int
        get() = when (this) {
            FREE -> 25_000          // ~30 minutes per month
            BASIC -> 500_000        // ~6 hours
            PRO -> 2_000_000        // ~24 hours
            UNLIMITED -> Int.MAX_VALUE
        }

    val displayName: String
        get() = when (this) {
            FREE -> "Free"
            BASIC -> "Basic"
            PRO -> "Pro"
            UNLIMITED -> "Unlimited"
        }

    val badgeColor: String
        get() = when (this) {
            FREE -> "#6B7280"     // Gray
            BASIC -> "#3B82F6"    // Blue
            PRO -> "#8B5CF6"      // Purple
            UNLIMITED -> "#F59E0B" // Amber
        }

    val softLimitPercentage: Float
        get() = when (this) {
            FREE -> 0.8f      // Warn at 80%
            BASIC -> 0.85f
            PRO -> 0.9f
            UNLIMITED -> 1.0f  // No warning
        }
}

/**
 * Warning level for quota usage
 */
enum class WarningLevel {
    NONE,
    LOW,      // 80% used
    MEDIUM,   // 90% used
    HIGH,     // 95% used
    CRITICAL  // 100% used
}

/**
 * Individual usage record
 */
@Entity(tableName = "usage_records")
data class UsageRecord(
    @PrimaryKey
    val id: String = UUID.randomUUID().toString(),
    val timestamp: Long = System.currentTimeMillis(),
    val characterCount: Int,
    val provider: String,
    val voiceId: String?,
    val articleId: String?,
    val articleTitle: String?,
    val isSuccess: Boolean = true,
    val errorMessage: String? = null
)

/**
 * Usage summary for a period
 */
data class UsageSummary(
    val period: UsagePeriod,
    val startDate: Date,
    val endDate: Date,
    val totalCharacters: Int,
    val totalRequests: Int,
    val successfulRequests: Int,
    val failedRequests: Int,
    val charactersByProvider: Map<String, Int> = emptyMap(),
    val limit: Int
) {
    val remaining: Int
        get() = maxOf(0, limit - totalCharacters)

    val usagePercentage: Float
        get() = if (limit > 0) totalCharacters.toFloat() / limit else 0f

    val warningLevel: WarningLevel
        get() = when {
            usagePercentage >= 1.0f -> WarningLevel.CRITICAL
            usagePercentage >= 0.95f -> WarningLevel.HIGH
            usagePercentage >= 0.90f -> WarningLevel.MEDIUM
            usagePercentage >= 0.80f -> WarningLevel.LOW
            else -> WarningLevel.NONE
        }
}

/**
 * Complete usage quota info
 */
data class UsageQuota(
    val tier: UsageTier,
    val dailySummary: UsageSummary,
    val monthlySummary: UsageSummary
) {
    val hasCloudAccess: Boolean
        get() = tier != UsageTier.FREE || monthlySummary.remaining > 0

    val warningLevel: WarningLevel
        get() = maxOf(dailySummary.warningLevel, monthlySummary.warningLevel)

    val warningMessage: String?
        get() = when (warningLevel) {
            WarningLevel.CRITICAL -> "You've reached your usage limit. Upgrade or wait for reset."
            WarningLevel.HIGH -> "Almost at your limit! Consider upgrading."
            WarningLevel.MEDIUM -> "You're using a lot of characters today."
            WarningLevel.LOW -> "You're approaching your usage limit."
            WarningLevel.NONE -> null
        }
}

/**
 * Usage estimate for a synthesis request
 */
data class UsageEstimate(
    val characterCount: Int,
    val willExceedDaily: Boolean,
    val willExceedMonthly: Boolean,
    val remainingDaily: Int,
    val remainingMonthly: Int,
    val estimatedDuration: Long
) {
    val canProceed: Boolean
        get() = !willExceedDaily && !willExceedMonthly

    val recommendedAction: String?
        get() = when {
            willExceedMonthly -> "This would exceed your monthly limit. Upgrade or wait."
            willExceedDaily -> "This would exceed your daily limit. Try again tomorrow."
            else -> null
        }
}

// Comparable extension for WarningLevel
private fun maxOf(a: WarningLevel, b: WarningLevel): WarningLevel {
    return if (a.ordinal > b.ordinal) a else b
}

/**
 * Summary of premium quality usage for the day (kept for API compatibility)
 */
data class PremiumUsageSummary(
    val samplesUsed: Int,
    val samplesLimit: Int,
    val charactersUsed: Int,
    val charactersLimit: Int,
    val canUsePremium: Boolean,
    val tier: UsageTier
) {
    val samplesRemaining: Int
        get() = if (samplesLimit == Int.MAX_VALUE) Int.MAX_VALUE else maxOf(0, samplesLimit - samplesUsed)

    val charactersRemaining: Int
        get() = if (charactersLimit == Int.MAX_VALUE) Int.MAX_VALUE else maxOf(0, charactersLimit - charactersUsed)

    val usagePercentage: Float
        get() = if (samplesLimit == Int.MAX_VALUE || samplesLimit == 0) 0f else samplesUsed.toFloat() / samplesLimit

    val isExhausted: Boolean
        get() = !canUsePremium

    val formattedSamplesRemaining: String
        get() = if (samplesRemaining == Int.MAX_VALUE) "Unlimited" else "$samplesRemaining of $samplesLimit"

    val formattedCharactersRemaining: String
        get() = if (charactersRemaining == Int.MAX_VALUE) "Unlimited" else formatCharacterCount(charactersRemaining)

    val statusMessage: String
        get() = when {
            tier == UsageTier.UNLIMITED -> "Unlimited premium quality"
            isExhausted -> "Premium samples used for today. Resets at midnight."
            samplesRemaining == 1 -> "1 premium sample left today"
            else -> "$samplesRemaining premium samples left today"
        }

    private fun formatCharacterCount(count: Int): String {
        return when {
            count >= 1_000_000 -> String.format("%.1fM", count / 1_000_000f)
            count >= 1_000 -> String.format("%.1fK", count / 1_000f)
            else -> count.toString()
        }
    }
}
