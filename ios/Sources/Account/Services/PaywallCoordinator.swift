import Foundation
import Combine
import StoreKit

// MARK: - PaywallConfigService

/// Fetches and caches the server-controlled paywall mode.
/// "soft"       – paywall shown only on first app open; no re-show after dismiss; no winback.
/// "aggressive" – full frequency (3rd/7th open, every 10th after 17th; winback enabled).
@MainActor
final class PaywallConfigService {

    static let shared = PaywallConfigService()

    enum PaywallMode: String {
        case soft
        case aggressive
    }

    private(set) var mode: PaywallMode = .soft

    private let backendURL = URL(string: "https://listenai-backend.fly.dev")!
    private let cacheKey = "readAloudAI_paywallMode"
    private let cacheExpiryKey = "readAloudAI_paywallModeExpiry"
    private let cacheTTL: TimeInterval = 3_600

    private init() {
        if let raw = UserDefaults.standard.string(forKey: cacheKey),
           let cached = PaywallMode(rawValue: raw) {
            mode = cached
        }
    }

    func refresh() async {
        let expiry = UserDefaults.standard.double(forKey: cacheExpiryKey)
        if expiry > Date().timeIntervalSince1970,
           let raw = UserDefaults.standard.string(forKey: cacheKey),
           let cached = PaywallMode(rawValue: raw) {
            mode = cached
            return
        }
        do {
            let url = backendURL.appendingPathComponent("api/config")
            let (data, _) = try await URLSession.shared.data(from: url)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let raw = json["paywallMode"] as? String,
               let fetched = PaywallMode(rawValue: raw) {
                mode = fetched
                UserDefaults.standard.set(raw, forKey: cacheKey)
                UserDefaults.standard.set(Date().timeIntervalSince1970 + cacheTTL, forKey: cacheExpiryKey)
            }
        } catch {
            // Network failure — keep using cached / default mode silently.
        }
    }
}

/// Tracks paywall dismissals and determines when to show a winback offer.
/// After 3+ dismisses with a 1-day cooldown, shows WinbackOfferView.
@MainActor
final class PaywallCoordinator: ObservableObject {

    static let shared = PaywallCoordinator()

    // MARK: - Published

    @Published var showWinbackOffer = false

    // MARK: - UserDefaults Keys

    private let dismissCountKey = "readAloudAI_paywallDismissCount"
    private let lastDismissDateKey = "readAloudAI_lastPaywallDismissDate"
    private let lastWinbackShownKey = "readAloudAI_lastWinbackShownDate"

    // MARK: - Thresholds

    private let requiredDismisses = 3
    private let cooldownInterval: TimeInterval = 86_400 // 1 day

    // MARK: - Computed

    var paywallDismissCount: Int {
        get { UserDefaults.standard.integer(forKey: dismissCountKey) }
        set { UserDefaults.standard.set(newValue, forKey: dismissCountKey) }
    }

    private var lastDismissDate: Date? {
        get { UserDefaults.standard.object(forKey: lastDismissDateKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: lastDismissDateKey) }
    }

    private var lastWinbackShownDate: Date? {
        get { UserDefaults.standard.object(forKey: lastWinbackShownKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: lastWinbackShownKey) }
    }

    private init() {}

    // MARK: - Methods

    /// Call when the user dismisses the paywall without purchasing.
    func trackDismiss() {
        // Don't track if user is already premium
        guard !PremiumManager.shared.isPremium else { return }

        paywallDismissCount += 1
        lastDismissDate = Date()

        print("[PaywallCoordinator] Paywall dismissed. Count: \(paywallDismissCount)")
    }

    /// Check whether the winback offer should be shown.
    ///
    /// Apple guideline 5.6 forbids POST-DISMISS discount prompts (manipulating
    /// users who just closed a paywall). It does NOT forbid showing a discount
    /// to a user with an EXPIRED subscription on app launch — that's the
    /// "win-back" pattern Apple explicitly supports via promotional offers.
    ///
    /// Trigger: at most once per `winbackCooldown` (1 day), only if:
    ///   1. User is not currently premium
    ///   2. User has at least one expired auto-renewable subscription transaction
    ///   3. We haven't shown a winback offer in the last 24h
    func checkWinbackEligibility() {
        // Skip if user is currently subscribed
        guard !PremiumManager.shared.isPremium else { return }

        // Cooldown: don't pester more than once per day even if eligible
        if let lastShown = lastWinbackShownDate,
           Date().timeIntervalSince(lastShown) < cooldownInterval {
            return
        }

        // Async check — don't block app launch on StoreKit
        Task { [weak self] in
            guard let self else { return }
            let hasExpired = await Self.hasExpiredAutoRenewableSubscription()
            guard hasExpired else { return }
            await MainActor.run {
                self.showWinbackOffer = true
                self.lastWinbackShownDate = Date()
                print("[PaywallCoordinator] Win-back offer surfaced (expired sub detected)")
            }
        }
    }

    /// Inspect StoreKit transaction history for any expired auto-renewable subscription.
    /// Uses `Transaction.all` which yields verified transactions for this Apple ID.
    private static func hasExpiredAutoRenewableSubscription() async -> Bool {
        for await result in Transaction.all {
            guard case .verified(let transaction) = result else { continue }
            guard transaction.productType == .autoRenewable else { continue }
            // Skip refunded transactions
            if transaction.revocationDate != nil { continue }
            if let exp = transaction.expirationDate, exp < Date() {
                return true
            }
        }
        return false
    }
}
