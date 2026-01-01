import Foundation
import Combine

// MARK: - Usage Tracker Service

/// Tracks cloud TTS usage for cost control and quota management.
@MainActor
final class UsageTrackerService: ObservableObject {

    // MARK: - Published State

    @Published private(set) var currentTier: UsageTier = .free
    @Published private(set) var dailyUsage: DailyUsage
    @Published private(set) var monthlyUsage: MonthlyUsage
    @Published private(set) var quota: UsageQuota
    @Published private(set) var showWarningBanner: Bool = false
    @Published private(set) var warningMessage: String?

    // MARK: - Properties

    private let dailyUsageKey = "ListenAI.DailyUsage"
    private let monthlyUsageKey = "ListenAI.MonthlyUsage"
    private let allTimeUsageKey = "ListenAI.AllTimeUsage"
    private let tierKey = "ListenAI.UsageTier"
    private let historyKey = "ListenAI.UsageHistory"

    private var allTimeCharacters: Int = 0
    private var allTimeRequests: Int = 0
    private var usageHistory: [UsageRecord] = []
    private let maxHistoryRecords = 1000

    // Callbacks
    var onQuotaExceeded: ((UsagePeriod) -> Void)?
    var onQuotaWarning: ((WarningLevel, UsagePeriod) -> Void)?
    var onUsageRecorded: ((UsageRecord) -> Void)?

    // MARK: - Singleton

    static let shared = UsageTrackerService()

    // MARK: - Computed Properties

    var canUseCloudVoices: Bool {
        quota.canUseCloud
    }

    var dailyRemaining: Int {
        quota.dailySummary.remainingCharacters
    }

    var monthlyRemaining: Int {
        quota.monthlySummary.remainingCharacters
    }

    var dailyPercentage: Float {
        quota.dailySummary.usagePercentage
    }

    var monthlyPercentage: Float {
        quota.monthlySummary.usagePercentage
    }

    // MARK: - Initialization

    private init() {
        let now = Date()
        self.dailyUsage = DailyUsage(date: now)
        self.monthlyUsage = MonthlyUsage(from: now)
        self.quota = UsageQuota(
            tier: .free,
            dailySummary: .empty(period: .daily, tier: .free),
            monthlySummary: .empty(period: .monthly, tier: .free)
        )

        loadState()
        checkAndResetPeriods()
        updateQuota()
    }

    // MARK: - Usage Recording

    /// Record a synthesis request.
    func recordUsage(
        characterCount: Int,
        provider: VoiceProvider,
        voiceID: String,
        articleID: UUID? = nil,
        articleTitle: String? = nil,
        wasSuccessful: Bool = true,
        errorMessage: String? = nil
    ) {
        // Only track cloud providers
        guard provider.isCloudBased else { return }

        let record = UsageRecord(
            characterCount: characterCount,
            provider: provider,
            voiceID: voiceID,
            articleID: articleID,
            articleTitle: articleTitle,
            wasSuccessful: wasSuccessful,
            errorMessage: errorMessage
        )

        // Check if we need to reset periods
        checkAndResetPeriods()

        // Add to daily usage
        dailyUsage.addRecord(record)

        // Add to monthly usage
        monthlyUsage.addRecord(record)

        // Update all-time counters
        allTimeCharacters += characterCount
        allTimeRequests += 1

        // Add to history
        usageHistory.insert(record, at: 0)
        if usageHistory.count > maxHistoryRecords {
            usageHistory = Array(usageHistory.prefix(maxHistoryRecords))
        }

        // Update quota
        updateQuota()

        // Check for warnings
        checkQuotaWarnings()

        // Save state
        saveState()

        // Notify
        onUsageRecorded?(record)
    }

    /// Pre-check if synthesis can proceed.
    func canSynthesize(characterCount: Int) -> Bool {
        let dailyAfter = dailyUsage.totalCharacters + characterCount
        let monthlyAfter = monthlyUsage.totalCharacters + characterCount

        return dailyAfter <= currentTier.dailyLimit &&
               monthlyAfter <= currentTier.monthlyLimit
    }

    /// Estimate usage for content.
    func estimateUsage(characterCount: Int) -> UsageEstimate {
        let dailyAfter = dailyUsage.totalCharacters + characterCount
        let monthlyAfter = monthlyUsage.totalCharacters + characterCount

        let willExceedDaily = dailyAfter > currentTier.dailyLimit
        let willExceedMonthly = monthlyAfter > currentTier.monthlyLimit

        let remainingDaily = max(0, currentTier.dailyLimit - dailyAfter)
        let remainingMonthly = max(0, currentTier.monthlyLimit - monthlyAfter)

        // Estimate duration: ~150 words/minute, ~5 chars/word = 750 chars/minute
        let estimatedDuration = TimeInterval(characterCount) / 750.0 * 60.0

        let action: UsageEstimate.RecommendedAction
        if willExceedDaily || willExceedMonthly {
            if currentTier == .free {
                action = .upgrade
            } else if willExceedDaily {
                action = .waitForReset
            } else {
                action = .upgrade
            }
        } else if characterCount > 50_000 {
            action = .splitContent
        } else if dailyPercentage > 0.7 {
            action = .useOnDevice
        } else {
            action = .proceed
        }

        return UsageEstimate(
            characterCount: characterCount,
            willExceedDailyLimit: willExceedDaily,
            willExceedMonthlyLimit: willExceedMonthly,
            remainingAfterDaily: remainingDaily,
            remainingAfterMonthly: remainingMonthly,
            estimatedDuration: estimatedDuration,
            recommendedAction: action
        )
    }

    // MARK: - Tier Management

    /// Update the usage tier.
    func setTier(_ tier: UsageTier) {
        let oldTier = currentTier
        currentTier = tier
        updateQuota()
        saveTier()

        if oldTier != tier {
            // Tier changed, re-check warnings
            checkQuotaWarnings()
        }
    }

    // MARK: - Summaries

    /// Get daily usage summary.
    func getDailySummary() -> UsageSummary {
        let (start, end) = dateRange(for: .daily, from: Date())

        var charactersByProvider: [VoiceProvider: Int] = [:]
        for record in dailyUsage.records {
            charactersByProvider[record.provider, default: 0] += record.characterCount
        }

        return UsageSummary(
            period: .daily,
            startDate: start,
            endDate: end,
            totalCharacters: dailyUsage.totalCharacters,
            totalRequests: dailyUsage.totalRequests,
            successfulRequests: dailyUsage.successfulRequests,
            failedRequests: dailyUsage.totalRequests - dailyUsage.successfulRequests,
            charactersByProvider: charactersByProvider,
            limit: currentTier.dailyLimit,
            tier: currentTier
        )
    }

    /// Get monthly usage summary.
    func getMonthlySummary() -> UsageSummary {
        var charactersByProvider: [VoiceProvider: Int] = [:]
        for (_, daily) in monthlyUsage.dailyUsage {
            for record in daily.records {
                charactersByProvider[record.provider, default: 0] += record.characterCount
            }
        }

        let successfulRequests = monthlyUsage.dailyUsage.values.reduce(0) { $0 + $1.successfulRequests }

        return UsageSummary(
            period: .monthly,
            startDate: monthlyUsage.startDate,
            endDate: monthlyUsage.endDate,
            totalCharacters: monthlyUsage.totalCharacters,
            totalRequests: monthlyUsage.totalRequests,
            successfulRequests: successfulRequests,
            failedRequests: monthlyUsage.totalRequests - successfulRequests,
            charactersByProvider: charactersByProvider,
            limit: currentTier.monthlyLimit,
            tier: currentTier
        )
    }

    /// Get all-time statistics.
    func getStatistics() -> UsageStatistics {
        var providerCounts: [VoiceProvider: Int] = [:]
        var voiceCounts: [String: Int] = [:]
        var dailyCharacters: [String: Int] = [:]

        for record in usageHistory {
            providerCounts[record.provider, default: 0] += record.characterCount
            voiceCounts[record.voiceID, default: 0] += record.characterCount

            let dayFormatter = DateFormatter()
            dayFormatter.dateFormat = "yyyy-MM-dd"
            let dayKey = dayFormatter.string(from: record.timestamp)
            dailyCharacters[dayKey, default: 0] += record.characterCount
        }

        let mostUsedProvider = providerCounts.max(by: { $0.value < $1.value })?.key
        let mostUsedVoice = voiceCounts.max(by: { $0.value < $1.value })?.key
        let peakDay = dailyCharacters.max(by: { $0.value < $1.value })

        var peakDate: Date?
        if let peakDayKey = peakDay?.key {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            peakDate = formatter.date(from: peakDayKey)
        }

        let avgPerRequest = allTimeRequests > 0 ? allTimeCharacters / allTimeRequests : 0
        let dayCount = max(1, dailyCharacters.count)
        let avgPerDay = allTimeCharacters / dayCount

        return UsageStatistics(
            totalCharactersAllTime: allTimeCharacters,
            totalRequestsAllTime: allTimeRequests,
            averageCharactersPerRequest: avgPerRequest,
            averageCharactersPerDay: avgPerDay,
            mostUsedProvider: mostUsedProvider,
            mostUsedVoice: mostUsedVoice,
            peakUsageDay: peakDate,
            peakUsageCharacters: peakDay?.value ?? 0
        )
    }

    /// Get recent usage history.
    func getHistory(limit: Int = 50) -> [UsageRecord] {
        Array(usageHistory.prefix(limit))
    }

    // MARK: - Warning Management

    /// Dismiss the warning banner.
    func dismissWarning() {
        showWarningBanner = false
        warningMessage = nil
    }

    /// Force show warning if at limit.
    func checkAndShowWarning() {
        checkQuotaWarnings()
    }

    // MARK: - Reset

    /// Manually reset daily usage (for testing).
    func resetDailyUsage() {
        dailyUsage = DailyUsage(date: Date())
        updateQuota()
        saveState()
    }

    /// Manually reset monthly usage (for testing).
    func resetMonthlyUsage() {
        monthlyUsage = MonthlyUsage(from: Date())
        updateQuota()
        saveState()
    }

    /// Clear all usage history.
    func clearHistory() {
        usageHistory.removeAll()
        saveHistory()
    }

    // MARK: - Private Methods

    private func checkAndResetPeriods() {
        let now = Date()
        let calendar = Calendar.current

        // Check if daily needs reset
        if !calendar.isDateInToday(dailyUsage.date) {
            dailyUsage = DailyUsage(date: now)
            onQuotaWarning?(.none, .daily)
        }

        // Check if monthly needs reset
        let currentMonth = calendar.component(.month, from: now)
        let currentYear = calendar.component(.year, from: now)

        if monthlyUsage.month != currentMonth || monthlyUsage.year != currentYear {
            monthlyUsage = MonthlyUsage(year: currentYear, month: currentMonth)
            onQuotaWarning?(.none, .monthly)
        }
    }

    private func updateQuota() {
        quota = UsageQuota(
            tier: currentTier,
            dailySummary: getDailySummary(),
            monthlySummary: getMonthlySummary()
        )
    }

    private func checkQuotaWarnings() {
        let level = quota.warningLevel

        if level >= .medium {
            showWarningBanner = true
            warningMessage = quota.warningMessage
        } else {
            showWarningBanner = false
            warningMessage = nil
        }

        // Notify callbacks
        if quota.dailySummary.isOverLimit {
            onQuotaExceeded?(.daily)
        } else if quota.monthlySummary.isOverLimit {
            onQuotaExceeded?(.monthly)
        }

        if level >= .medium {
            let period: UsagePeriod = quota.dailySummary.usagePercentage > quota.monthlySummary.usagePercentage ? .daily : .monthly
            onQuotaWarning?(level, period)
        }
    }

    // MARK: - Persistence

    private func saveState() {
        saveDailyUsage()
        saveMonthlyUsage()
        saveAllTimeUsage()
        saveHistory()
    }

    private func loadState() {
        loadTier()
        loadDailyUsage()
        loadMonthlyUsage()
        loadAllTimeUsage()
        loadHistory()
    }

    private func saveTier() {
        UserDefaults.standard.set(currentTier.rawValue, forKey: tierKey)
    }

    private func loadTier() {
        if let raw = UserDefaults.standard.string(forKey: tierKey),
           let tier = UsageTier(rawValue: raw) {
            currentTier = tier
        }
    }

    private func saveDailyUsage() {
        do {
            let data = try JSONEncoder().encode(dailyUsage)
            UserDefaults.standard.set(data, forKey: dailyUsageKey)
        } catch {
            print("Failed to save daily usage: \(error)")
        }
    }

    private func loadDailyUsage() {
        guard let data = UserDefaults.standard.data(forKey: dailyUsageKey) else { return }

        do {
            let loaded = try JSONDecoder().decode(DailyUsage.self, from: data)
            // Check if it's still today
            if Calendar.current.isDateInToday(loaded.date) {
                dailyUsage = loaded
            }
        } catch {
            print("Failed to load daily usage: \(error)")
        }
    }

    private func saveMonthlyUsage() {
        do {
            let data = try JSONEncoder().encode(monthlyUsage)
            UserDefaults.standard.set(data, forKey: monthlyUsageKey)
        } catch {
            print("Failed to save monthly usage: \(error)")
        }
    }

    private func loadMonthlyUsage() {
        guard let data = UserDefaults.standard.data(forKey: monthlyUsageKey) else { return }

        do {
            let loaded = try JSONDecoder().decode(MonthlyUsage.self, from: data)
            // Check if it's still this month
            let now = Date()
            let components = Calendar.current.dateComponents([.year, .month], from: now)
            if loaded.year == components.year && loaded.month == components.month {
                monthlyUsage = loaded
            }
        } catch {
            print("Failed to load monthly usage: \(error)")
        }
    }

    private func saveAllTimeUsage() {
        UserDefaults.standard.set(allTimeCharacters, forKey: "\(allTimeUsageKey).characters")
        UserDefaults.standard.set(allTimeRequests, forKey: "\(allTimeUsageKey).requests")
    }

    private func loadAllTimeUsage() {
        allTimeCharacters = UserDefaults.standard.integer(forKey: "\(allTimeUsageKey).characters")
        allTimeRequests = UserDefaults.standard.integer(forKey: "\(allTimeUsageKey).requests")
    }

    private func saveHistory() {
        do {
            let data = try JSONEncoder().encode(usageHistory)
            UserDefaults.standard.set(data, forKey: historyKey)
        } catch {
            print("Failed to save history: \(error)")
        }
    }

    private func loadHistory() {
        guard let data = UserDefaults.standard.data(forKey: historyKey) else { return }

        do {
            usageHistory = try JSONDecoder().decode([UsageRecord].self, from: data)
        } catch {
            print("Failed to load history: \(error)")
            usageHistory = []
        }
    }
}

// MARK: - Usage Tracker Extensions

extension UsageTrackerService {

    /// Quick check for remaining quota display.
    var remainingDisplay: String {
        let daily = dailyRemaining
        let monthly = monthlyRemaining

        if daily == Int.max && monthly == Int.max {
            return "Unlimited"
        }

        let mostRestrictive = min(daily, monthly)
        return formatCharacterCount(mostRestrictive) + " remaining"
    }

    /// Get progress for display (0.0 - 1.0).
    var usageProgress: Float {
        max(dailyPercentage, monthlyPercentage)
    }

    /// Estimated minutes of audio remaining.
    var estimatedMinutesRemaining: Int {
        let chars = min(dailyRemaining, monthlyRemaining)
        guard chars != Int.max else { return Int.max }
        return chars / 750 // ~750 chars per minute of audio
    }

    /// Format remaining as time.
    var remainingTimeDisplay: String {
        let minutes = estimatedMinutesRemaining
        guard minutes != Int.max else { return "Unlimited" }

        if minutes < 60 {
            return "\(minutes) min"
        } else {
            let hours = minutes / 60
            let mins = minutes % 60
            return "\(hours) hr \(mins) min"
        }
    }
}
