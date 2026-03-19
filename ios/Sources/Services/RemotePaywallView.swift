import SwiftUI
import PaywallKit
import RevenueCat

/// PaywallKit-powered paywall replacing the RevenueCatUI remote paywall.
struct RemotePaywallView: View {
    @Environment(\.dismiss) private var dismiss
    var triggerSource: String = "unknown"
    /// When true, advances onboarding instead of calling dismiss (for TabView context)
    var isOnboarding: Bool = false

    @State private var paywallProducts: [PaywallProduct] = []

    private func handleDismiss() {
        if isOnboarding {
            OnboardingManager.shared.nextPage()
        } else {
            PaywallCoordinator.shared.trackDismiss()
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
            products: paywallProducts,
            theme: PaywallTheme(accent: Color(red: 1.0, green: 0.5, blue: 0.0), accent2: Color(red: 0.9, green: 0.2, blue: 0.3)),
            showWinback: true,
            onPurchase: { productId in
                await purchaseProduct(productId: productId)
            },
            onRestore: {
                await restorePurchases()
            },
            onDismiss: {
                handleDismiss()
            }
        )
        .task {
            await loadProducts()
        }
        .onAppear {
            Purchases.shared.attribution.setAttributes([
                "last_paywall_source": triggerSource,
                "last_paywall_date": ISO8601DateFormatter().string(from: Date())
            ])
        }
    }

    // MARK: - Product Loading

    private func loadProducts() async {
        let rcManager = RevenueCatManager.shared
        if rcManager.packages.isEmpty {
            await rcManager.loadOfferings()
        }

        paywallProducts = rcManager.packages.compactMap { pkg -> PaywallProduct? in
            let product = pkg.storeProduct
            let period: PaywallProduct.Period
            switch pkg.packageType {
            case .weekly: period = .weekly
            case .monthly: period = .monthly
            case .annual: period = .yearly
            case .lifetime: period = .lifetime
            default:
                if product.productIdentifier.contains("lifetime") { period = .lifetime }
                else if product.productIdentifier.contains("yearly") || product.productIdentifier.contains("annual") { period = .yearly }
                else if product.productIdentifier.contains("monthly") { period = .monthly }
                else if product.productIdentifier.contains("weekly") { period = .weekly }
                else { return nil }
            }

            var trialDays: Int? = nil
            if let intro = product.introductoryDiscount,
               intro.paymentMode == .freeTrial {
                let sub = intro.subscriptionPeriod
                switch sub.unit {
                case .day: trialDays = sub.value
                case .week: trialDays = sub.value * 7
                case .month: trialDays = sub.value * 30
                case .year: trialDays = sub.value * 365
                @unknown default: trialDays = sub.value
                }
            }

            return PaywallProduct(
                id: product.productIdentifier,
                localizedPrice: product.localizedPriceString,
                price: product.price,
                currencyCode: product.currencyCode ?? "USD",
                trialDays: trialDays,
                period: period
            )
        }
    }

    // MARK: - Purchase

    private func purchaseProduct(productId: String) async {
        let rcManager = RevenueCatManager.shared

        guard let package = rcManager.packages.first(where: {
            $0.storeProduct.productIdentifier == productId
        }) else {
            print("[ReadAloudPaywall] No package found for \(productId)")
            return
        }

        do {
            try await rcManager.purchase(package)
            await MainActor.run { handleDismiss() }
        } catch {
            print("[ReadAloudPaywall] Purchase failed: \(error)")
        }
    }

    // MARK: - Restore

    private func restorePurchases() async {
        await RevenueCatManager.shared.restorePurchases()
        if RevenueCatManager.shared.isPremium {
            await MainActor.run { handleDismiss() }
        }
    }
}
