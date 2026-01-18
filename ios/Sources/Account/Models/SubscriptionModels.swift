import Foundation

// MARK: - Subscription Plan

/// User subscription plans with associated limits and features.
enum Plan: String, Codable, CaseIterable, Sendable {
    case free
    case pro
    case unlimited

    // MARK: - Display Properties

    var displayName: String {
        switch self {
        case .free: return "Free"
        case .pro: return "Pro"
        case .unlimited: return "Unlimited"
        }
    }

    var shortDescription: String {
        switch self {
        case .free: return "Basic access to cloud voices"
        case .pro: return "Full access with higher limits"
        case .unlimited: return "Unlimited cloud voice usage"
        }
    }

    var badgeColor: String {
        switch self {
        case .free: return "#6B7280"      // Gray
        case .pro: return "#8B5CF6"       // Purple
        case .unlimited: return "#F59E0B" // Amber
        }
    }

    var iconName: String {
        switch self {
        case .free: return "person.circle"
        case .pro: return "star.circle.fill"
        case .unlimited: return "crown.fill"
        }
    }

    // MARK: - Limits

    /// Monthly character limit for cloud TTS
    var monthlyCharacterLimit: Int {
        switch self {
        case .free: return 25_000          // 25K chars (~30 min audio total per month)
        case .pro: return 1_000_000        // 1M chars (~12 hours audio)
        case .unlimited: return Int.max    // Unlimited
        }
    }

    /// Daily character limit for cloud TTS
    var dailyCharacterLimit: Int {
        switch self {
        case .free: return 4_000           // 4K chars (~5 min per day)
        case .pro: return 100_000          // 100K chars (~70 min)
        case .unlimited: return Int.max    // Unlimited
        }
    }

    /// Maximum article length for import
    var maxArticleLength: Int {
        switch self {
        case .free: return 10_000          // ~10K chars
        case .pro: return 50_000           // ~50K chars
        case .unlimited: return Int.max    // Unlimited
        }
    }

    /// Number of saved articles allowed
    var maxSavedArticles: Int {
        switch self {
        case .free: return 10
        case .pro: return 100
        case .unlimited: return Int.max
        }
    }

    /// Whether premium voices are accessible
    var hasPremiumVoiceAccess: Bool {
        switch self {
        case .free: return false
        case .pro, .unlimited: return true
        }
    }

    /// Whether character voices (Santa, etc.) are accessible
    var hasCharacterVoiceAccess: Bool {
        switch self {
        case .free: return false
        case .pro, .unlimited: return true
        }
    }

    /// Whether API access is available
    var hasAPIAccess: Bool {
        switch self {
        case .free: return false
        case .pro, .unlimited: return true
        }
    }

    /// Priority level for synthesis queue (higher = more priority)
    var synthesisPriority: Int {
        switch self {
        case .free: return 1
        case .pro: return 5
        case .unlimited: return 10
        }
    }

    // MARK: - Formatting

    var formattedMonthlyLimit: String {
        if monthlyCharacterLimit == Int.max {
            return "Unlimited"
        }
        return formatCharacterCount(monthlyCharacterLimit)
    }

    var formattedDailyLimit: String {
        if dailyCharacterLimit == Int.max {
            return "Unlimited"
        }
        return formatCharacterCount(dailyCharacterLimit)
    }

    // MARK: - Comparison

    /// Check if this plan has at least the features of another plan
    func hasAccess(to requiredPlan: Plan) -> Bool {
        let planOrder: [Plan] = [.free, .pro, .unlimited]
        guard let selfIndex = planOrder.firstIndex(of: self),
              let requiredIndex = planOrder.firstIndex(of: requiredPlan) else {
            return false
        }
        return selfIndex >= requiredIndex
    }

    /// The minimum plan required for a feature
    static func minimumPlanFor(feature: PlanFeature) -> Plan {
        switch feature {
        case .basicVoices, .onDeviceTTS:
            return .free
        case .premiumVoices, .characterVoices, .extendedArticles, .apiAccess:
            return .pro
        case .unlimitedUsage:
            return .unlimited
        }
    }
}

// MARK: - Plan Features

/// Features that require specific plans
enum PlanFeature: String, CaseIterable, Sendable {
    case basicVoices
    case premiumVoices
    case characterVoices
    case onDeviceTTS
    case extendedArticles
    case apiAccess
    case unlimitedUsage

    var displayName: String {
        switch self {
        case .basicVoices: return "Basic Cloud Voices"
        case .premiumVoices: return "Premium Voices"
        case .characterVoices: return "Character Voices"
        case .onDeviceTTS: return "On-Device TTS"
        case .extendedArticles: return "Extended Articles"
        case .apiAccess: return "API Access"
        case .unlimitedUsage: return "Unlimited Usage"
        }
    }

    var description: String {
        switch self {
        case .basicVoices: return "Access to standard quality cloud voices"
        case .premiumVoices: return "Access to premium ElevenLabs and OpenAI voices"
        case .characterVoices: return "Fun character voices like Santa and celebrities"
        case .onDeviceTTS: return "Offline text-to-speech using Apple voices"
        case .extendedArticles: return "Import and listen to longer articles"
        case .apiAccess: return "Programmatic access to TTS via API"
        case .unlimitedUsage: return "No monthly character limits"
        }
    }
}

// MARK: - Subscription Status

/// Current subscription status
enum SubscriptionStatus: String, Codable, Sendable {
    case active
    case trialing
    case pastDue
    case canceled
    case expired
    case none

    var isActive: Bool {
        switch self {
        case .active, .trialing:
            return true
        case .pastDue, .canceled, .expired, .none:
            return false
        }
    }

    var displayName: String {
        switch self {
        case .active: return "Active"
        case .trialing: return "Trial"
        case .pastDue: return "Past Due"
        case .canceled: return "Canceled"
        case .expired: return "Expired"
        case .none: return "None"
        }
    }

    var statusColor: String {
        switch self {
        case .active: return "#10B981"     // Green
        case .trialing: return "#3B82F6"   // Blue
        case .pastDue: return "#F59E0B"    // Amber
        case .canceled, .expired: return "#EF4444" // Red
        case .none: return "#6B7280"       // Gray
        }
    }
}

// MARK: - User Profile

/// User profile with subscription information
struct UserProfile: Codable, Sendable {
    let id: String
    let email: String?
    let displayName: String?
    let avatarURL: URL?
    let plan: Plan
    let subscriptionStatus: SubscriptionStatus
    let subscriptionExpiresAt: Date?
    let createdAt: Date
    let updatedAt: Date

    // MARK: - Computed Properties

    var effectivePlan: Plan {
        // If subscription is not active, fall back to free
        guard subscriptionStatus.isActive else {
            return .free
        }
        return plan
    }

    var isSubscribed: Bool {
        plan != .free && subscriptionStatus.isActive
    }

    var daysUntilExpiration: Int? {
        guard let expiresAt = subscriptionExpiresAt else { return nil }
        let days = Calendar.current.dateComponents([.day], from: Date(), to: expiresAt).day
        return days
    }

    var isExpiringSoon: Bool {
        guard let days = daysUntilExpiration else { return false }
        return days <= 7 && days > 0
    }

    // MARK: - Initialization

    init(
        id: String,
        email: String? = nil,
        displayName: String? = nil,
        avatarURL: URL? = nil,
        plan: Plan = .free,
        subscriptionStatus: SubscriptionStatus = .none,
        subscriptionExpiresAt: Date? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.email = email
        self.displayName = displayName
        self.avatarURL = avatarURL
        self.plan = plan
        self.subscriptionStatus = subscriptionStatus
        self.subscriptionExpiresAt = subscriptionExpiresAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    // MARK: - Feature Access

    func canAccess(feature: PlanFeature) -> Bool {
        let requiredPlan = Plan.minimumPlanFor(feature: feature)
        return effectivePlan.hasAccess(to: requiredPlan)
    }

    func canAccessVoice(tier: VoiceTier) -> Bool {
        switch tier {
        case .free:
            return true
        case .premium:
            return effectivePlan.hasPremiumVoiceAccess
        case .enterprise:
            return effectivePlan.hasCharacterVoiceAccess
        }
    }
}

// MARK: - Subscription Info Response

/// Response from backend /usage/full endpoint
struct FullUsageResponse: Codable, Sendable {
    let subscription: SubscriptionInfo
    let usage: UsageDetails
    let estimatedMinutesRemaining: Int

    enum CodingKeys: String, CodingKey {
        case subscription
        case usage
        case estimatedMinutesRemaining = "estimated_minutes_remaining"
    }

    struct SubscriptionInfo: Codable, Sendable {
        let tier: String
        let status: String
        let currentPeriodEnd: String?

        enum CodingKeys: String, CodingKey {
            case tier
            case status
            case currentPeriodEnd = "current_period_end"
        }
    }

    struct UsageDetails: Codable, Sendable {
        let daily: QuotaInfo
        let monthly: QuotaInfo
    }

    struct QuotaInfo: Codable, Sendable {
        let used: Int
        let limit: Int
        let remaining: Int
        let percentage: Double
        let resetsAt: String

        enum CodingKeys: String, CodingKey {
            case used
            case limit
            case remaining
            case percentage
            case resetsAt = "resets_at"
        }
    }

    // MARK: - Convenience Accessors

    var planEnum: Plan {
        Plan(rawValue: subscription.tier) ?? .free
    }

    var statusEnum: SubscriptionStatus {
        SubscriptionStatus(rawValue: subscription.status) ?? .none
    }

    var expiresAtDate: Date? {
        guard let dateString = subscription.currentPeriodEnd else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: dateString) {
            return date
        }
        // Try without fractional seconds
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: dateString)
    }

    var monthlyCharUsed: Int {
        usage.monthly.used
    }

    var monthlyCharLimit: Int {
        usage.monthly.limit
    }

    var dailyCharUsed: Int {
        usage.daily.used
    }

    var dailyCharLimit: Int {
        usage.daily.limit
    }
}

/// Response from subscription sync endpoint
struct SubscriptionSyncResponse: Codable, Sendable {
    let success: Bool
    let subscription: SyncedSubscription
    let limits: SyncedLimits

    struct SyncedSubscription: Codable, Sendable {
        let tier: String
        let status: String
        let expiresAt: String?

        enum CodingKeys: String, CodingKey {
            case tier
            case status
            case expiresAt = "expires_at"
        }
    }

    struct SyncedLimits: Codable, Sendable {
        let daily: Int
        let monthly: Int
    }

    var planEnum: Plan {
        Plan(rawValue: subscription.tier) ?? .free
    }

    var statusEnum: SubscriptionStatus {
        SubscriptionStatus(rawValue: subscription.status) ?? .none
    }
}

/// Legacy response format (kept for compatibility)
struct SubscriptionInfoResponse: Codable, Sendable {
    let userId: String
    let plan: String
    let status: String
    let expiresAt: String?
    let monthlyCharUsed: Int
    let monthlyCharLimit: Int

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case plan
        case status
        case expiresAt = "expires_at"
        case monthlyCharUsed = "monthly_char_used"
        case monthlyCharLimit = "monthly_char_limit"
    }

    var planEnum: Plan {
        Plan(rawValue: plan) ?? .free
    }

    var statusEnum: SubscriptionStatus {
        SubscriptionStatus(rawValue: status) ?? .none
    }

    var expiresAtDate: Date? {
        guard let expiresAt = expiresAt else { return nil }
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: expiresAt)
    }

    /// Create from FullUsageResponse
    init(from fullResponse: FullUsageResponse, userId: String) {
        self.userId = userId
        self.plan = fullResponse.subscription.tier
        self.status = fullResponse.subscription.status
        self.expiresAt = fullResponse.subscription.currentPeriodEnd
        self.monthlyCharUsed = fullResponse.monthlyCharUsed
        self.monthlyCharLimit = fullResponse.monthlyCharLimit
    }

    init(
        userId: String,
        plan: String,
        status: String,
        expiresAt: String?,
        monthlyCharUsed: Int,
        monthlyCharLimit: Int
    ) {
        self.userId = userId
        self.plan = plan
        self.status = status
        self.expiresAt = expiresAt
        self.monthlyCharUsed = monthlyCharUsed
        self.monthlyCharLimit = monthlyCharLimit
    }
}
