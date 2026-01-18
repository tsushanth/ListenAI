import Foundation
import Combine

// MARK: - User Account ViewModel

/// ViewModel for managing user account state and subscription.
/// Provides plan-based feature gating and usage quota management.
@MainActor
final class UserAccountViewModel: ObservableObject {

    // MARK: - Published State

    /// Current user profile (nil if not signed in)
    @Published private(set) var userProfile: UserProfile?

    /// Whether the user is currently signed in
    @Published private(set) var isSignedIn: Bool = false

    /// Whether subscription data is loading
    @Published private(set) var isLoading: Bool = false

    /// Error message if subscription fetch failed
    @Published private(set) var errorMessage: String?

    /// Whether to show the upgrade prompt
    @Published var showUpgradePrompt: Bool = false

    /// Feature that triggered the upgrade prompt (for context)
    @Published private(set) var upgradePromptFeature: PlanFeature?

    // MARK: - Computed Properties

    /// Current effective plan (free if not signed in or subscription inactive)
    var currentPlan: Plan {
        userProfile?.effectivePlan ?? .free
    }

    /// Whether user has an active paid subscription
    var isSubscribed: Bool {
        userProfile?.isSubscribed ?? false
    }

    /// Monthly character limit based on current plan
    var monthlyCharacterLimit: Int {
        currentPlan.monthlyCharacterLimit
    }

    /// Daily character limit based on current plan
    var dailyCharacterLimit: Int {
        currentPlan.dailyCharacterLimit
    }

    /// Formatted monthly limit string
    var formattedMonthlyLimit: String {
        currentPlan.formattedMonthlyLimit
    }

    /// Formatted daily limit string
    var formattedDailyLimit: String {
        currentPlan.formattedDailyLimit
    }

    /// Whether premium voices are accessible
    /// Checks both local plan AND StoreKit subscription status
    var canAccessPremiumVoices: Bool {
        // If StoreKit says we're premium, allow access
        if StoreKitManager.shared.isPremium {
            return true
        }
        return currentPlan.hasPremiumVoiceAccess
    }

    /// Whether character voices are accessible
    var canAccessCharacterVoices: Bool {
        currentPlan.hasCharacterVoiceAccess
    }

    /// Display name for the user
    var displayName: String {
        userProfile?.displayName ?? userProfile?.email ?? "Guest"
    }

    /// User's email
    var email: String? {
        userProfile?.email
    }

    /// Avatar URL
    var avatarURL: URL? {
        userProfile?.avatarURL
    }

    /// Subscription status display
    var subscriptionStatusDisplay: String {
        guard let profile = userProfile else {
            return "Not signed in"
        }
        if profile.plan == .free {
            return "Free Plan"
        }
        return "\(profile.plan.displayName) - \(profile.subscriptionStatus.displayName)"
    }

    /// Days until subscription expires (nil if not applicable)
    var daysUntilExpiration: Int? {
        userProfile?.daysUntilExpiration
    }

    /// Whether subscription is expiring soon
    var isExpiringSoon: Bool {
        userProfile?.isExpiringSoon ?? false
    }

    // MARK: - Private Properties

    private var cancellables = Set<AnyCancellable>()
    private let userDefaultsKey = "ListenAI.UserProfile"

    // MARK: - Singleton

    static let shared = UserAccountViewModel()

    // MARK: - Initialization

    private init() {
        loadCachedProfile()
    }

    // MARK: - Authentication

    /// Sign in with user ID (called after Supabase auth)
    func signIn(userId: String, email: String?) {
        // Create initial profile with free plan
        let profile = UserProfile(
            id: userId,
            email: email,
            plan: .free,
            subscriptionStatus: .none
        )
        userProfile = profile
        isSignedIn = true
        cacheProfile(profile)

        // Fetch actual subscription status from backend
        Task {
            await refreshSubscriptionStatus()
        }
    }

    /// Sign out and clear profile
    func signOut() {
        userProfile = nil
        isSignedIn = false
        clearCachedProfile()
    }

    // MARK: - Subscription Management

    /// Refresh subscription status from backend.
    /// Fetches the latest subscription and usage data from the Cloud Run backend.
    func refreshSubscriptionStatus() async {
        guard let profile = userProfile else { return }

        isLoading = true
        errorMessage = nil

        do {
            let subscriptionInfo = try await fetchSubscriptionInfo(userId: profile.id)
            updateProfile(with: subscriptionInfo)
            isLoading = false
        } catch {
            // Don't show error for auth issues - user might not be signed in to backend yet
            if case ListenAICloudError.noAuthToken = error {
                print("[UserAccount] No auth token - skipping subscription refresh")
            } else if case ListenAICloudError.unauthorized = error {
                print("[UserAccount] Unauthorized - skipping subscription refresh")
            } else {
                errorMessage = "Failed to refresh subscription: \(error.localizedDescription)"
                print("[UserAccount] Subscription refresh error: \(error)")
            }
            isLoading = false
        }
    }

    /// Fetch subscription info from backend via /usage/full endpoint
    private func fetchSubscriptionInfo(userId: String) async throws -> SubscriptionInfoResponse {
        guard let cloudService = TTSServiceFactory.listenAICloudService else {
            throw AccountError.notConfigured
        }

        // Fetch full usage response which includes subscription info
        let fullUsage = try await cloudService.fetchFullUsage()

        // Convert to SubscriptionInfoResponse for compatibility
        return SubscriptionInfoResponse(from: fullUsage, userId: userId)
    }

    /// Update profile with subscription info from backend
    private func updateProfile(with info: SubscriptionInfoResponse) {
        guard var profile = userProfile else { return }

        profile = UserProfile(
            id: profile.id,
            email: profile.email,
            displayName: profile.displayName,
            avatarURL: profile.avatarURL,
            plan: info.planEnum,
            subscriptionStatus: info.statusEnum,
            subscriptionExpiresAt: info.expiresAtDate,
            createdAt: profile.createdAt,
            updatedAt: Date()
        )

        userProfile = profile
        cacheProfile(profile)
    }

    // MARK: - Feature Access

    /// Check if user can access a specific feature
    func canAccess(feature: PlanFeature) -> Bool {
        userProfile?.canAccess(feature: feature) ?? (Plan.minimumPlanFor(feature: feature) == .free)
    }

    /// Check if user can access a voice tier
    func canAccessVoice(tier: VoiceTier) -> Bool {
        // If StoreKit says we're premium, allow all voice tiers
        if StoreKitManager.shared.isPremium {
            return true
        }
        return userProfile?.canAccessVoice(tier: tier) ?? (tier == .free)
    }

    /// Check if user can access a specific voice preset
    func canAccessVoice(_ voice: VoicePreset) -> Bool {
        // If StoreKit says we're premium, allow all voices
        if StoreKitManager.shared.isPremium {
            return true
        }
        return canAccessVoice(tier: voice.tier)
    }

    /// Show upgrade prompt for a specific feature
    /// Does nothing if user already has premium via StoreKit
    func promptUpgrade(for feature: PlanFeature) {
        // Don't show upgrade prompt if already premium
        if StoreKitManager.shared.isPremium {
            return
        }
        upgradePromptFeature = feature
        showUpgradePrompt = true
    }

    /// Show upgrade prompt for accessing a voice
    /// Does nothing if user already has premium via StoreKit
    func promptUpgradeForVoice(_ voice: VoicePreset) {
        // Don't show upgrade prompt if already premium
        if StoreKitManager.shared.isPremium {
            return
        }
        if voice.tier == .premium {
            promptUpgrade(for: .premiumVoices)
        } else if voice.tier == .enterprise {
            promptUpgrade(for: .characterVoices)
        }
    }

    // MARK: - Plan Comparison

    /// Get features available in a specific plan
    func features(for plan: Plan) -> [PlanFeature] {
        PlanFeature.allCases.filter { feature in
            plan.hasAccess(to: Plan.minimumPlanFor(feature: feature))
        }
    }

    /// Get features user would gain by upgrading to a plan
    func additionalFeatures(upgrading to: Plan) -> [PlanFeature] {
        let currentFeatures = Set(features(for: currentPlan))
        let targetFeatures = Set(features(for: to))
        return Array(targetFeatures.subtracting(currentFeatures))
    }

    // MARK: - Usage Quota

    /// Check if user has enough quota for synthesis
    func hasQuotaFor(characterCount: Int, usageViewModel: UsageViewModel) -> Bool {
        let remaining = monthlyCharacterLimit - usageViewModel.charUsed
        return characterCount <= remaining
    }

    /// Get remaining characters based on plan limit and current usage
    func remainingCharacters(usageViewModel: UsageViewModel) -> Int {
        max(0, monthlyCharacterLimit - usageViewModel.charUsed)
    }

    // MARK: - Persistence

    private func cacheProfile(_ profile: UserProfile) {
        if let data = try? JSONEncoder().encode(profile) {
            UserDefaults.standard.set(data, forKey: userDefaultsKey)
        }
    }

    private func loadCachedProfile() {
        guard let data = UserDefaults.standard.data(forKey: userDefaultsKey),
              let profile = try? JSONDecoder().decode(UserProfile.self, from: data) else {
            return
        }
        userProfile = profile
        isSignedIn = true
    }

    private func clearCachedProfile() {
        UserDefaults.standard.removeObject(forKey: userDefaultsKey)
    }
}

// MARK: - Account Errors

enum AccountError: LocalizedError {
    case notConfigured
    case notSignedIn
    case networkError(String)
    case subscriptionFetchFailed

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Account service not configured"
        case .notSignedIn:
            return "User not signed in"
        case .networkError(let message):
            return "Network error: \(message)"
        case .subscriptionFetchFailed:
            return "Failed to fetch subscription status"
        }
    }
}

// MARK: - Convenience Extensions

extension UserAccountViewModel {

    /// Quick check for premium access
    /// Checks both local plan AND StoreKit subscription status
    var isPremium: Bool {
        // Check StoreKit first (for actual purchases)
        if StoreKitManager.shared.isPremium {
            return true
        }
        return currentPlan != .free
    }

    /// Plan badge text for UI
    var planBadgeText: String {
        currentPlan.displayName
    }

    /// Plan badge color for UI
    var planBadgeColor: String {
        currentPlan.badgeColor
    }

    /// Upgrade call-to-action text based on current plan
    var upgradeCallToAction: String {
        switch currentPlan {
        case .free:
            return "Upgrade to Pro"
        case .pro:
            return "Go Unlimited"
        case .unlimited:
            return "You have the best plan!"
        }
    }

    /// Whether to show upgrade options
    var shouldShowUpgradeOption: Bool {
        currentPlan != .unlimited
    }
}
