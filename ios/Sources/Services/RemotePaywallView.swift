import SwiftUI
import PaywallKit

/// PaywallKit-powered paywall with StoreKit 2 purchases.
struct RemotePaywallView: View {
    @Environment(\.dismiss) private var dismiss
    var triggerSource: String = "unknown"
    /// When true, advances onboarding instead of calling dismiss (for TabView context)
    var isOnboarding: Bool = false
    @State private var didPurchaseOrRestore = false
    @ObservedObject private var store = StoreManager.shared

    private func handleDismiss() {
        if isOnboarding {
            OnboardingManager.shared.nextPage()
        } else {
            if !didPurchaseOrRestore {
                PaywallCoordinator.shared.trackDismiss()
            }
            dismiss()
        }
    }

    var body: some View {
        PaywallKit.PaywallView(
            appId: "readaloud",
            appName: "ReadAloud Premium",
            features: [
                PaywallFeature(icon: "\u{1F5E3}", title: "Premium Voices", description: "Natural-sounding AI voices"),
                PaywallFeature(icon: "\u{1F4D6}", title: "Unlimited Articles", description: "No reading limits"),
                PaywallFeature(icon: "\u{26A1}", title: "Faster Processing", description: "Priority text-to-speech"),
                PaywallFeature(icon: "\u{1F30D}", title: "All Languages", description: "50+ language support"),
                PaywallFeature(icon: "\u{1F4E5}", title: "Offline Playback", description: "Download for later")
            ],
            products: store.paywallProducts,
            theme: PaywallTheme(accent: Color(red: 1.0, green: 0.5, blue: 0.0), accent2: Color(red: 0.9, green: 0.2, blue: 0.3)),
            showWinback: true,
            onPurchase: { productId in
                let result = await store.purchase(productId: productId)
                if case .purchased = result {
                    didPurchaseOrRestore = true
                    await PremiumManager.shared.validateSubscriptionState()
                    await MainActor.run { handleDismiss() }
                    return true
                }
                return false
            },
            onRestore: {
                await store.restore()
                await PremiumManager.shared.validateSubscriptionState()
                if PremiumManager.shared.isPremium {
                    didPurchaseOrRestore = true
                    await MainActor.run { handleDismiss() }
                }
            },
            onDismiss: {
                handleDismiss()
            }
        )
        .task {
            if store.paywallProducts.isEmpty {
                await store.loadProducts()
            }
        }
    }
}
