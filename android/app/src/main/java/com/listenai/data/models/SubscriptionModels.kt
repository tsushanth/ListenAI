package com.listenai.data.models

import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * User subscription plans with associated limits and features.
 */
enum class Plan(val displayName: String) {
    FREE("Free"),
    PRO("Pro"),
    UNLIMITED("Unlimited");

    val shortDescription: String
        get() = when (this) {
            FREE -> "Basic access to cloud voices"
            PRO -> "Full access with higher limits"
            UNLIMITED -> "Unlimited cloud voice usage"
        }

    val badgeColor: Long
        get() = when (this) {
            FREE -> 0xFF6B7280      // Gray
            PRO -> 0xFF8B5CF6       // Purple
            UNLIMITED -> 0xFFF59E0B // Amber
        }

    val iconName: String
        get() = when (this) {
            FREE -> "person"
            PRO -> "star"
            UNLIMITED -> "crown"
        }

    // Limits
    val monthlyCharacterLimit: Int
        get() = when (this) {
            FREE -> 25_000          // 25K chars (~30 min audio total per month)
            PRO -> 1_000_000        // 1M chars (~12 hours audio)
            UNLIMITED -> Int.MAX_VALUE
        }

    val dailyCharacterLimit: Int
        get() = when (this) {
            FREE -> 4_000           // 4K chars (~5 min per day)
            PRO -> 100_000          // 100K chars (~70 min)
            UNLIMITED -> Int.MAX_VALUE
        }

    val maxArticleLength: Int
        get() = when (this) {
            FREE -> 10_000
            PRO -> 50_000
            UNLIMITED -> Int.MAX_VALUE
        }

    val maxSavedArticles: Int
        get() = when (this) {
            FREE -> 10
            PRO -> 100
            UNLIMITED -> Int.MAX_VALUE
        }

    val hasPremiumVoiceAccess: Boolean
        get() = this != FREE

    val hasCharacterVoiceAccess: Boolean
        get() = this != FREE

    val hasAPIAccess: Boolean
        get() = this != FREE

    val synthesisPriority: Int
        get() = when (this) {
            FREE -> 1
            PRO -> 5
            UNLIMITED -> 10
        }

    val formattedMonthlyLimit: String
        get() = if (monthlyCharacterLimit == Int.MAX_VALUE) {
            "Unlimited"
        } else {
            formatCharacterCount(monthlyCharacterLimit)
        }

    val formattedDailyLimit: String
        get() = if (dailyCharacterLimit == Int.MAX_VALUE) {
            "Unlimited"
        } else {
            formatCharacterCount(dailyCharacterLimit)
        }

    fun hasAccess(requiredPlan: Plan): Boolean {
        val planOrder = listOf(FREE, PRO, UNLIMITED)
        return planOrder.indexOf(this) >= planOrder.indexOf(requiredPlan)
    }

    companion object {
        fun fromString(value: String): Plan {
            return entries.find { it.name.equals(value, ignoreCase = true) } ?: FREE
        }

        fun minimumPlanFor(feature: PlanFeature): Plan {
            return when (feature) {
                PlanFeature.BASIC_VOICES, PlanFeature.ON_DEVICE_TTS -> FREE
                PlanFeature.PREMIUM_VOICES, PlanFeature.CHARACTER_VOICES,
                PlanFeature.EXTENDED_ARTICLES, PlanFeature.API_ACCESS -> PRO
                PlanFeature.UNLIMITED_USAGE -> UNLIMITED
            }
        }
    }
}

/**
 * Features that require specific plans
 */
enum class PlanFeature(val displayName: String, val description: String) {
    BASIC_VOICES("Cloud Voices", "Access to high-quality cloud voices"),
    PREMIUM_VOICES("Premium Voices", "Access to all premium AI voices"),
    CHARACTER_VOICES("Character Voices", "Fun character voices like Santa and celebrities"),
    ON_DEVICE_TTS("On-Device TTS", "Offline text-to-speech using system voices"),
    EXTENDED_ARTICLES("Extended Articles", "Import and listen to longer articles"),
    API_ACCESS("API Access", "Programmatic access to TTS via API"),
    UNLIMITED_USAGE("Unlimited Usage", "No monthly character limits")
}

/**
 * Current subscription status
 */
enum class SubscriptionStatus(val displayName: String) {
    ACTIVE("Active"),
    TRIALING("Trial"),
    PAST_DUE("Past Due"),
    CANCELED("Canceled"),
    EXPIRED("Expired"),
    NONE("None");

    val isActive: Boolean
        get() = this == ACTIVE || this == TRIALING

    val statusColor: Long
        get() = when (this) {
            ACTIVE -> 0xFF10B981     // Green
            TRIALING -> 0xFF3B82F6   // Blue
            PAST_DUE -> 0xFFF59E0B   // Amber
            CANCELED, EXPIRED -> 0xFFEF4444 // Red
            NONE -> 0xFF6B7280       // Gray
        }

    companion object {
        fun fromString(value: String): SubscriptionStatus {
            return entries.find { it.name.equals(value, ignoreCase = true) } ?: NONE
        }
    }
}

/**
 * User profile with subscription information
 */
data class UserProfile(
    val id: String,
    val email: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val plan: Plan = Plan.FREE,
    val subscriptionStatus: SubscriptionStatus = SubscriptionStatus.NONE,
    val subscriptionExpiresAt: Instant? = null,
    val createdAt: Instant = Instant.now(),
    val updatedAt: Instant = Instant.now()
) {
    val effectivePlan: Plan
        get() = if (subscriptionStatus.isActive) plan else Plan.FREE

    val isSubscribed: Boolean
        get() = plan != Plan.FREE && subscriptionStatus.isActive

    val daysUntilExpiration: Int?
        get() = subscriptionExpiresAt?.let {
            ChronoUnit.DAYS.between(Instant.now(), it).toInt()
        }

    val isExpiringSoon: Boolean
        get() = daysUntilExpiration?.let { it in 1..7 } ?: false

    fun canAccess(feature: PlanFeature): Boolean {
        val requiredPlan = Plan.minimumPlanFor(feature)
        return effectivePlan.hasAccess(requiredPlan)
    }

    fun canAccessVoice(tier: VoiceTier): Boolean {
        return when (tier) {
            VoiceTier.FREE -> true
            VoiceTier.PREMIUM -> effectivePlan.hasPremiumVoiceAccess
            VoiceTier.ENTERPRISE -> effectivePlan.hasCharacterVoiceAccess
        }
    }

    companion object {
        val ANONYMOUS = UserProfile(
            id = "anonymous",
            plan = Plan.FREE,
            subscriptionStatus = SubscriptionStatus.NONE
        )
    }
}

/**
 * Response from backend /usage/full endpoint
 */
data class FullUsageResponse(
    val subscription: SubscriptionInfo,
    val usage: UsageDetails,
    val estimatedMinutesRemaining: Int
) {
    data class SubscriptionInfo(
        val tier: String,
        val status: String,
        val currentPeriodEnd: String?
    )

    data class UsageDetails(
        val daily: QuotaInfo,
        val monthly: QuotaInfo
    )

    data class QuotaInfo(
        val used: Int,
        val limit: Int,
        val remaining: Int,
        val percentage: Double,
        val resetsAt: String
    )

    val planEnum: Plan
        get() = Plan.fromString(subscription.tier)

    val statusEnum: SubscriptionStatus
        get() = SubscriptionStatus.fromString(subscription.status)

    val expiresAtInstant: Instant?
        get() = subscription.currentPeriodEnd?.let {
            try {
                Instant.parse(it)
            } catch (e: Exception) {
                null
            }
        }

    val monthlyCharUsed: Int
        get() = usage.monthly.used

    val monthlyCharLimit: Int
        get() = usage.monthly.limit

    val dailyCharUsed: Int
        get() = usage.daily.used

    val dailyCharLimit: Int
        get() = usage.daily.limit
}

/**
 * Response from subscription sync endpoint
 */
data class SubscriptionSyncResponse(
    val success: Boolean,
    val subscription: SyncedSubscription,
    val limits: SyncedLimits
) {
    data class SyncedSubscription(
        val tier: String,
        val status: String,
        val expiresAt: String?
    )

    data class SyncedLimits(
        val daily: Int,
        val monthly: Int
    )

    val planEnum: Plan
        get() = Plan.fromString(subscription.tier)

    val statusEnum: SubscriptionStatus
        get() = SubscriptionStatus.fromString(subscription.status)
}

/**
 * Helper function to format character counts
 */
private fun formatCharacterCount(count: Int): String {
    return when {
        count >= 1_000_000 -> "${count / 1_000_000}M"
        count >= 1_000 -> "${count / 1_000}K"
        else -> count.toString()
    }
}
