import Foundation
import Combine

// MARK: - Cloud Usage ViewModel

/// ViewModel for displaying cloud usage quota from the ListenAI backend.
/// Fetches usage data from the Cloud Run backend and exposes it for SwiftUI views.
@MainActor
final class UsageViewModel: ObservableObject {

    // MARK: - Published State

    /// Current month's characters used
    @Published private(set) var charUsed: Int = 0

    /// Current month's character limit
    @Published private(set) var charLimit: Int = 0

    /// Whether data is currently loading
    @Published private(set) var isLoading: Bool = false

    /// Error message if fetch failed
    @Published private(set) var errorMessage: String?

    /// Whether the quota has been exceeded
    @Published private(set) var isQuotaExceeded: Bool = false

    /// Current month string (YYYY-MM format)
    @Published private(set) var currentMonth: String = ""

    /// Whether to show the warning banner (>80% usage)
    @Published private(set) var showWarningBanner: Bool = false

    /// Whether to show the upgrade prompt
    @Published var showUpgradePrompt: Bool = false

    // MARK: - Computed Properties

    /// Remaining characters this month
    var remainingChars: Int {
        max(0, charLimit - charUsed)
    }

    /// Usage percentage (0.0 to 1.0)
    var usagePercentage: Double {
        guard charLimit > 0 else { return 0 }
        return Double(charUsed) / Double(charLimit)
    }

    /// Usage percentage as integer (0-100)
    var usagePercentageInt: Int {
        Int(usagePercentage * 100)
    }

    /// Whether user is near their limit (>80%)
    var isNearLimit: Bool {
        usagePercentage >= 0.8
    }

    /// Formatted usage string like "123K of 500K characters used this month"
    var formattedUsageString: String {
        let usedFormatted = formatCharCount(charUsed)
        let limitFormatted = formatCharCount(charLimit)
        return "\(usedFormatted) of \(limitFormatted) characters used this month"
    }

    /// Compact usage string like "123K / 500K"
    var compactUsageString: String {
        let usedFormatted = formatCharCount(charUsed)
        let limitFormatted = formatCharCount(charLimit)
        return "\(usedFormatted) / \(limitFormatted)"
    }

    /// Remaining characters formatted
    var formattedRemainingString: String {
        let remaining = formatCharCount(remainingChars)
        return "\(remaining) remaining"
    }

    /// Estimated audio minutes remaining (based on ~750 chars/minute)
    var estimatedMinutesRemaining: Int {
        remainingChars / 750
    }

    /// Warning level based on usage
    var warningLevel: WarningLevel {
        if isQuotaExceeded {
            return .critical
        } else if usagePercentage >= 0.95 {
            return .high
        } else if usagePercentage >= 0.8 {
            return .medium
        } else {
            return .none
        }
    }

    /// Warning message for display
    var warningMessage: String? {
        switch warningLevel {
        case .critical:
            return "Quota exceeded. Upgrade your plan to continue using cloud voices."
        case .high:
            return "Almost at limit. \(formatCharCount(remainingChars)) remaining this month."
        case .medium:
            return "Approaching limit. \(formatCharCount(remainingChars)) remaining this month."
        default:
            return nil
        }
    }

    // MARK: - Private Properties

    private var refreshTask: Task<Void, Never>?
    private let refreshInterval: TimeInterval = 60 // Auto-refresh every 60 seconds

    // MARK: - Initialization

    init() {
        // Load cached data if available
        loadCachedUsage()
    }

    // MARK: - Public Methods

    /// Fetch usage data from the cloud backend.
    func fetchUsage() async {
        guard let cloudService = TTSServiceFactory.listenAICloudService else {
            errorMessage = "Cloud service not configured"
            return
        }

        isLoading = true
        errorMessage = nil

        do {
            let usage = try await cloudService.fetchUsage()
            updateFromUsageInfo(usage)
            cacheUsage(usage)
        } catch let error as ListenAICloudError {
            handleCloudError(error)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    /// Refresh usage data (convenience method).
    func refresh() async {
        await fetchUsage()
    }

    /// Start auto-refreshing usage data.
    func startAutoRefresh() {
        stopAutoRefresh()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetchUsage()
                try? await Task.sleep(nanoseconds: UInt64(self?.refreshInterval ?? 60) * 1_000_000_000)
            }
        }
    }

    /// Stop auto-refreshing usage data.
    func stopAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    /// Clear the cached usage data.
    func clearCache() {
        UserDefaults.standard.removeObject(forKey: "ReadAloudAI.CloudUsage")
    }

    /// Handle a quota exceeded error from synthesis.
    /// - Parameter error: The cloud error that occurred
    func handleQuotaExceededError(_ error: ListenAICloudError) {
        if case .quotaExceeded(let used, let limit) = error {
            charUsed = used
            charLimit = limit
            isQuotaExceeded = true
            // Only show upgrade prompt if not already premium
            if !StoreKitManager.shared.isPremium {
                showUpgradePrompt = true
            }
        }
    }

    /// Dismiss the warning banner.
    func dismissWarning() {
        showWarningBanner = false
    }

    // MARK: - Private Methods

    private func updateFromUsageInfo(_ usage: UsageInfo) {
        charUsed = usage.charUsed
        charLimit = usage.charLimit
        currentMonth = usage.currentMonth
        isQuotaExceeded = usage.isQuotaExceeded

        // Show warning banner if >80% used
        showWarningBanner = isNearLimit && !isQuotaExceeded
    }

    private func handleCloudError(_ error: ListenAICloudError) {
        switch error {
        case .quotaExceeded(let used, let limit):
            charUsed = used
            charLimit = limit
            isQuotaExceeded = true
            // Only show upgrade prompt if not already premium
            if !StoreKitManager.shared.isPremium {
                showUpgradePrompt = true
            }
            errorMessage = nil
        case .unauthorized:
            errorMessage = "Please sign in to view usage."
        case .noAuthToken:
            errorMessage = "Please sign in to view usage."
        default:
            errorMessage = error.localizedDescription
        }
    }

    private func formatCharCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.0fK", Double(count) / 1_000)
        } else {
            return "\(count)"
        }
    }

    // MARK: - Persistence

    private func cacheUsage(_ usage: UsageInfo) {
        let cached = CachedUsage(
            charUsed: usage.charUsed,
            charLimit: usage.charLimit,
            currentMonth: usage.currentMonth,
            cachedAt: Date()
        )
        if let data = try? JSONEncoder().encode(cached) {
            UserDefaults.standard.set(data, forKey: "ReadAloudAI.CloudUsage")
        }
    }

    private func loadCachedUsage() {
        guard let data = UserDefaults.standard.data(forKey: "ReadAloudAI.CloudUsage"),
              let cached = try? JSONDecoder().decode(CachedUsage.self, from: data) else {
            return
        }

        // Only use cache if it's from the current month and less than 5 minutes old
        let now = Date()
        let currentMonthStr = ISO8601DateFormatter().string(from: now).prefix(7)

        if cached.currentMonth == String(currentMonthStr),
           now.timeIntervalSince(cached.cachedAt) < 300 {
            charUsed = cached.charUsed
            charLimit = cached.charLimit
            currentMonth = cached.currentMonth
            isQuotaExceeded = cached.charUsed >= cached.charLimit
            showWarningBanner = usagePercentage >= 0.8 && !isQuotaExceeded
        }
    }
}

// MARK: - Cached Usage

private struct CachedUsage: Codable {
    let charUsed: Int
    let charLimit: Int
    let currentMonth: String
    let cachedAt: Date
}

// MARK: - Usage View Model Extensions

extension UsageViewModel {

    /// User-friendly error message for quota exceeded.
    static let quotaExceededMessage = "You've reached your monthly character limit. Upgrade your plan or wait until next month to continue using cloud voices."

    /// User-friendly message for near limit warning.
    var nearLimitMessage: String {
        "You're using \(usagePercentageInt)% of your monthly quota. Consider upgrading for more characters."
    }

    /// Check if synthesis is allowed for a given character count.
    func canSynthesize(characterCount: Int) -> Bool {
        return (charUsed + characterCount) <= charLimit
    }

    /// Get remaining characters after a synthesis.
    func remainingAfterSynthesis(characterCount: Int) -> Int {
        max(0, charLimit - charUsed - characterCount)
    }
}
