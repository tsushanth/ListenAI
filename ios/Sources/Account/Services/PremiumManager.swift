import Foundation
import PaywallKit

/// User subscription tier
enum SubscriptionTier: String, Codable {
    case free = "free"
    case premium = "premium"
    case lifetime = "lifetime"

    var displayName: String {
        switch self {
        case .free: return "Free"
        case .premium: return "Premium"
        case .lifetime: return "Lifetime"
        }
    }
}

/// Manager for premium feature access and subscription state.
/// Bridges PaywallKit's StoreManager with the rest of the app.
@MainActor
@Observable
final class PremiumManager {

    // MARK: - Singleton

    static let shared = PremiumManager()

    // MARK: - Properties

    /// Current subscription tier
    private(set) var currentTier: SubscriptionTier = .free

    /// Subscription expiration date (nil for lifetime or free)
    private(set) var subscriptionExpirationDate: Date?

    /// Whether user has any premium access
    var isPremium: Bool {
        currentTier != .free
    }

    /// Whether user has lifetime access
    var isLifetime: Bool {
        currentTier == .lifetime
    }

    private let store = StoreManager.shared

    // MARK: - UserDefaults Keys

    private enum UserDefaultsKey {
        static let subscriptionTier = "com.readaloud.subscription.tier"
        static let subscriptionExpiration = "com.readaloud.subscription.expiration"
        static let lastValidationDate = "com.readaloud.validation.date"
    }

    // MARK: - Initialization

    private init() {
        loadPersistedState()
    }

    // MARK: - Public Methods

    /// Validate and update subscription state via StoreKit 2
    func validateSubscriptionState() async {
        await store.refreshSubscriptionStatus()

        if store.isLifetime {
            currentTier = .lifetime
        } else if store.isPremium {
            currentTier = .premium
        } else {
            currentTier = .free
        }
        subscriptionExpirationDate = store.subscriptionExpirationDate

        // Update usage tracker
        UsageTrackerService.shared.setTier(isPremium ? .pro : .free)

        persistState()
    }

    /// Handle successful purchase
    func handlePurchase(productID: String, price: Double = 0, currency: String = "USD", isTrial: Bool = false) async {
        await validateSubscriptionState()
        if isTrial {
            TikTokHelper.shared.logTrialStarted(productId: productID)
            FacebookSDKManager.shared.logTrialStarted(productId: productID)
        } else {
            TikTokHelper.shared.logSubscription(price: price, currency: currency, productId: productID)
            FacebookSDKManager.shared.logSubscription(price: price, currency: currency, productId: productID)
        }
    }

    /// Check if subscription is expiring soon (within 3 days)
    func isSubscriptionExpiringSoon() -> Bool {
        guard let expirationDate = subscriptionExpirationDate else { return false }
        let threeDaysFromNow = Calendar.current.date(byAdding: .day, value: 3, to: Date()) ?? Date()
        return expirationDate < threeDaysFromNow && expirationDate > Date()
    }

    /// Get remaining days of subscription
    func remainingSubscriptionDays() -> Int? {
        guard let expirationDate = subscriptionExpirationDate else { return nil }
        let calendar = Calendar.current
        let components = calendar.dateComponents([.day], from: Date(), to: expirationDate)
        return components.day
    }

    // MARK: - Private Methods

    private func loadPersistedState() {
        let defaults = UserDefaults.standard

        if let tierRaw = defaults.string(forKey: UserDefaultsKey.subscriptionTier),
           let tier = SubscriptionTier(rawValue: tierRaw) {
            currentTier = tier
        }

        if let expirationInterval = defaults.object(forKey: UserDefaultsKey.subscriptionExpiration) as? TimeInterval {
            let expirationDate = Date(timeIntervalSince1970: expirationInterval)
            if expirationDate > Date() {
                subscriptionExpirationDate = expirationDate
            } else {
                currentTier = .free
            }
        }
    }

    private func persistState() {
        let defaults = UserDefaults.standard

        defaults.set(currentTier.rawValue, forKey: UserDefaultsKey.subscriptionTier)

        if let expirationDate = subscriptionExpirationDate {
            defaults.set(expirationDate.timeIntervalSince1970, forKey: UserDefaultsKey.subscriptionExpiration)
        } else {
            defaults.removeObject(forKey: UserDefaultsKey.subscriptionExpiration)
        }

        defaults.set(Date().timeIntervalSince1970, forKey: UserDefaultsKey.lastValidationDate)
    }
}
