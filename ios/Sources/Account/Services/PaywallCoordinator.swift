import Foundation
import Combine

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
    /// Call on app foreground or after paywall dismiss.
    func checkWinbackEligibility() {
        guard !PremiumManager.shared.isPremium else { return }
        guard paywallDismissCount >= requiredDismisses else { return }

        // Cooldown: at least 1 day since last dismiss
        guard let lastDismiss = lastDismissDate,
              Date().timeIntervalSince(lastDismiss) >= cooldownInterval else { return }

        // Don't show again within cooldown period
        if let lastShown = lastWinbackShownDate,
           Date().timeIntervalSince(lastShown) < cooldownInterval {
            return
        }

        showWinbackOffer = true
        lastWinbackShownDate = Date()
        print("[PaywallCoordinator] Showing winback offer")
    }
}
