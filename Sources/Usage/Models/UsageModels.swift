import Foundation

// MARK: - Usage Period

/// Time period for usage tracking.
enum UsagePeriod: String, Codable, CaseIterable, Sendable {
    case daily
    case monthly
    case allTime

    var displayName: String {
        switch self {
        case .daily: return "Today"
        case .monthly: return "This Month"
        case .allTime: return "All Time"
        }
    }

    var shortName: String {
        switch self {
        case .daily: return "Daily"
        case .monthly: return "Monthly"
        case .allTime: return "Total"
        }
    }
}

// MARK: - Usage Tier

/// Subscription tier with different limits.
enum UsageTier: String, Codable, CaseIterable, Sendable {
    case free
    case basic
    case pro
    case unlimited

    var displayName: String {
        switch self {
        case .free: return "Free"
        case .basic: return "Basic"
        case .pro: return "Pro"
        case .unlimited: return "Unlimited"
        }
    }

    /// Daily character limit
    var dailyLimit: Int {
        switch self {
        case .free: return 10_000          // ~7 minutes of audio
        case .basic: return 50_000         // ~35 minutes
        case .pro: return 200_000          // ~2.5 hours
        case .unlimited: return Int.max
        }
    }

    /// Monthly character limit
    var monthlyLimit: Int {
        switch self {
        case .free: return 100_000         // ~70 minutes
        case .basic: return 500_000        // ~6 hours
        case .pro: return 2_000_000        // ~24 hours
        case .unlimited: return Int.max
        }
    }

    /// Soft limit percentage (warning threshold)
    var softLimitPercentage: Float {
        switch self {
        case .free: return 0.8      // Warn at 80%
        case .basic: return 0.85
        case .pro: return 0.9
        case .unlimited: return 1.0  // No warning
        }
    }

    /// Cost per 1000 characters (for display purposes)
    var costPer1000Chars: Float {
        switch self {
        case .free: return 0
        case .basic: return 0.015
        case .pro: return 0.012
        case .unlimited: return 0.01
        }
    }

    var badgeColor: String {
        switch self {
        case .free: return "#6B7280"
        case .basic: return "#3B82F6"
        case .pro: return "#8B5CF6"
        case .unlimited: return "#F59E0B"
        }
    }
}

// MARK: - Usage Record

/// A single usage record for tracking.
struct UsageRecord: Identifiable, Codable, Sendable {
    let id: UUID
    let timestamp: Date
    let characterCount: Int
    let provider: VoiceProvider
    let voiceID: String
    let articleID: UUID?
    let articleTitle: String?
    let wasSuccessful: Bool
    let errorMessage: String?

    init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        characterCount: Int,
        provider: VoiceProvider,
        voiceID: String,
        articleID: UUID? = nil,
        articleTitle: String? = nil,
        wasSuccessful: Bool = true,
        errorMessage: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.characterCount = characterCount
        self.provider = provider
        self.voiceID = voiceID
        self.articleID = articleID
        self.articleTitle = articleTitle
        self.wasSuccessful = wasSuccessful
        self.errorMessage = errorMessage
    }

    var formattedCharacterCount: String {
        formatCharacterCount(characterCount)
    }

    var formattedTimestamp: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: timestamp)
    }
}

// MARK: - Usage Summary

/// Summary of usage for a specific period.
struct UsageSummary: Codable, Sendable {
    let period: UsagePeriod
    let startDate: Date
    let endDate: Date
    let totalCharacters: Int
    let totalRequests: Int
    let successfulRequests: Int
    let failedRequests: Int
    let charactersByProvider: [VoiceProvider: Int]
    let limit: Int
    let tier: UsageTier

    var usagePercentage: Float {
        guard limit > 0, limit != Int.max else { return 0 }
        return Float(totalCharacters) / Float(limit)
    }

    var remainingCharacters: Int {
        guard limit != Int.max else { return Int.max }
        return max(0, limit - totalCharacters)
    }

    var isOverLimit: Bool {
        limit != Int.max && totalCharacters >= limit
    }

    var isAtSoftLimit: Bool {
        usagePercentage >= tier.softLimitPercentage
    }

    var formattedTotal: String {
        formatCharacterCount(totalCharacters)
    }

    var formattedLimit: String {
        guard limit != Int.max else { return "Unlimited" }
        return formatCharacterCount(limit)
    }

    var formattedRemaining: String {
        guard remainingCharacters != Int.max else { return "Unlimited" }
        return formatCharacterCount(remainingCharacters)
    }

    var estimatedMinutesRemaining: Int {
        guard remainingCharacters != Int.max else { return Int.max }
        // Assume ~150 words per minute, ~5 characters per word
        return remainingCharacters / 750
    }

    var successRate: Float {
        guard totalRequests > 0 else { return 1.0 }
        return Float(successfulRequests) / Float(totalRequests)
    }

    static func empty(period: UsagePeriod, tier: UsageTier) -> UsageSummary {
        let now = Date()
        let (start, end) = dateRange(for: period, from: now)

        return UsageSummary(
            period: period,
            startDate: start,
            endDate: end,
            totalCharacters: 0,
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: period == .daily ? tier.dailyLimit : tier.monthlyLimit,
            tier: tier
        )
    }
}

// MARK: - Usage Quota

/// Current quota status.
struct UsageQuota: Sendable {
    let tier: UsageTier
    let dailySummary: UsageSummary
    let monthlySummary: UsageSummary

    var canUseCloud: Bool {
        !dailySummary.isOverLimit && !monthlySummary.isOverLimit
    }

    var shouldShowWarning: Bool {
        dailySummary.isAtSoftLimit || monthlySummary.isAtSoftLimit
    }

    var warningMessage: String? {
        if dailySummary.isOverLimit {
            return "Daily limit reached. Cloud voices unavailable until tomorrow."
        }
        if monthlySummary.isOverLimit {
            return "Monthly limit reached. Upgrade for more cloud voice access."
        }
        if dailySummary.isAtSoftLimit {
            let remaining = dailySummary.remainingCharacters
            return "Approaching daily limit. \(formatCharacterCount(remaining)) remaining today."
        }
        if monthlySummary.isAtSoftLimit {
            let remaining = monthlySummary.remainingCharacters
            return "Approaching monthly limit. \(formatCharacterCount(remaining)) remaining this month."
        }
        return nil
    }

    var warningLevel: WarningLevel {
        if dailySummary.isOverLimit || monthlySummary.isOverLimit {
            return .critical
        }
        if dailySummary.usagePercentage > 0.95 || monthlySummary.usagePercentage > 0.95 {
            return .high
        }
        if dailySummary.isAtSoftLimit || monthlySummary.isAtSoftLimit {
            return .medium
        }
        return .none
    }

    var mostRestrictiveSummary: UsageSummary {
        if dailySummary.usagePercentage > monthlySummary.usagePercentage {
            return dailySummary
        }
        return monthlySummary
    }
}

// MARK: - Warning Level

enum WarningLevel: Int, Comparable, Sendable {
    case none = 0
    case low = 1
    case medium = 2
    case high = 3
    case critical = 4

    static func < (lhs: WarningLevel, rhs: WarningLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    var color: String {
        switch self {
        case .none: return "#10B981"     // Green
        case .low: return "#3B82F6"      // Blue
        case .medium: return "#F59E0B"   // Yellow
        case .high: return "#F97316"     // Orange
        case .critical: return "#EF4444" // Red
        }
    }

    var iconName: String {
        switch self {
        case .none: return "checkmark.circle.fill"
        case .low: return "info.circle.fill"
        case .medium: return "exclamationmark.triangle.fill"
        case .high: return "exclamationmark.triangle.fill"
        case .critical: return "xmark.octagon.fill"
        }
    }
}

// MARK: - Usage Event

/// Event types for usage tracking.
enum UsageEvent: Sendable {
    case synthesis(characterCount: Int, provider: VoiceProvider, voiceID: String, articleID: UUID?, articleTitle: String?)
    case synthesisError(characterCount: Int, provider: VoiceProvider, error: String)
    case quotaWarning(level: WarningLevel, period: UsagePeriod)
    case quotaReset(period: UsagePeriod)
    case tierChanged(from: UsageTier, to: UsageTier)
}

// MARK: - Daily Usage

/// Usage data for a specific day.
struct DailyUsage: Codable, Sendable {
    let date: Date
    var totalCharacters: Int
    var totalRequests: Int
    var successfulRequests: Int
    var records: [UsageRecord]

    var dateKey: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    init(date: Date = Date()) {
        self.date = Calendar.current.startOfDay(for: date)
        self.totalCharacters = 0
        self.totalRequests = 0
        self.successfulRequests = 0
        self.records = []
    }

    mutating func addRecord(_ record: UsageRecord) {
        records.append(record)
        totalCharacters += record.characterCount
        totalRequests += 1
        if record.wasSuccessful {
            successfulRequests += 1
        }
    }
}

// MARK: - Monthly Usage

/// Usage data for a specific month.
struct MonthlyUsage: Codable, Sendable {
    let year: Int
    let month: Int
    var totalCharacters: Int
    var totalRequests: Int
    var dailyUsage: [String: DailyUsage]

    var monthKey: String {
        String(format: "%04d-%02d", year, month)
    }

    var startDate: Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = 1
        return Calendar.current.date(from: components) ?? Date()
    }

    var endDate: Date {
        var components = DateComponents()
        components.year = year
        components.month = month + 1
        components.day = 0
        return Calendar.current.date(from: components) ?? Date()
    }

    init(year: Int, month: Int) {
        self.year = year
        self.month = month
        self.totalCharacters = 0
        self.totalRequests = 0
        self.dailyUsage = [:]
    }

    init(from date: Date = Date()) {
        let components = Calendar.current.dateComponents([.year, .month], from: date)
        self.year = components.year ?? 2024
        self.month = components.month ?? 1
        self.totalCharacters = 0
        self.totalRequests = 0
        self.dailyUsage = [:]
    }

    mutating func addRecord(_ record: UsageRecord) {
        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "yyyy-MM-dd"
        let dayKey = dayFormatter.string(from: record.timestamp)

        if dailyUsage[dayKey] == nil {
            dailyUsage[dayKey] = DailyUsage(date: record.timestamp)
        }

        dailyUsage[dayKey]?.addRecord(record)
        totalCharacters += record.characterCount
        totalRequests += 1
    }
}

// MARK: - Usage Statistics

/// Detailed usage statistics.
struct UsageStatistics: Sendable {
    let totalCharactersAllTime: Int
    let totalRequestsAllTime: Int
    let averageCharactersPerRequest: Int
    let averageCharactersPerDay: Int
    let mostUsedProvider: VoiceProvider?
    let mostUsedVoice: String?
    let peakUsageDay: Date?
    let peakUsageCharacters: Int

    var formattedTotalCharacters: String {
        formatCharacterCount(totalCharactersAllTime)
    }

    var estimatedCost: Float {
        // Rough estimate based on typical cloud TTS pricing
        return Float(totalCharactersAllTime) / 1000 * 0.015
    }

    var formattedEstimatedCost: String {
        String(format: "$%.2f", estimatedCost)
    }
}

// MARK: - Estimation

/// Estimation for upcoming synthesis.
struct UsageEstimate: Sendable {
    let characterCount: Int
    let willExceedDailyLimit: Bool
    let willExceedMonthlyLimit: Bool
    let remainingAfterDaily: Int
    let remainingAfterMonthly: Int
    let estimatedDuration: TimeInterval
    let recommendedAction: RecommendedAction

    enum RecommendedAction: Sendable {
        case proceed
        case useOnDevice
        case splitContent
        case waitForReset
        case upgrade

        var message: String {
            switch self {
            case .proceed:
                return "You have enough quota for this content."
            case .useOnDevice:
                return "Consider using on-device voice to save quota."
            case .splitContent:
                return "This content is large. Consider splitting into parts."
            case .waitForReset:
                return "Wait for your quota to reset, or upgrade your plan."
            case .upgrade:
                return "Upgrade your plan for more cloud voice access."
            }
        }
    }

    var canProceed: Bool {
        !willExceedDailyLimit && !willExceedMonthlyLimit
    }

    var formattedCharacterCount: String {
        formatCharacterCount(characterCount)
    }

    var formattedDuration: String {
        let minutes = Int(estimatedDuration / 60)
        if minutes < 1 {
            return "< 1 min"
        } else if minutes < 60 {
            return "\(minutes) min"
        } else {
            let hours = minutes / 60
            let mins = minutes % 60
            return "\(hours) hr \(mins) min"
        }
    }
}

// MARK: - Helper Functions

/// Format character count for display.
func formatCharacterCount(_ count: Int) -> String {
    if count >= 1_000_000 {
        return String(format: "%.1fM", Float(count) / 1_000_000)
    } else if count >= 1_000 {
        return String(format: "%.1fK", Float(count) / 1_000)
    } else {
        return "\(count)"
    }
}

/// Get date range for a usage period.
func dateRange(for period: UsagePeriod, from date: Date) -> (start: Date, end: Date) {
    let calendar = Calendar.current

    switch period {
    case .daily:
        let start = calendar.startOfDay(for: date)
        let end = calendar.date(byAdding: .day, value: 1, to: start)!
        return (start, end)

    case .monthly:
        let components = calendar.dateComponents([.year, .month], from: date)
        let start = calendar.date(from: components)!
        let end = calendar.date(byAdding: .month, value: 1, to: start)!
        return (start, end)

    case .allTime:
        return (Date.distantPast, Date.distantFuture)
    }
}
