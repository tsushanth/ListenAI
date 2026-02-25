import SwiftUI
import RevenueCatUI
import RevenueCat

/// Remote paywall powered by RevenueCatUI — design & pricing controlled from RC dashboard
struct RemotePaywallView: View {
    @Environment(\.dismiss) private var dismiss
    var triggerSource: String = "unknown"
    /// When true, advances onboarding instead of calling dismiss (for TabView context)
    var isOnboarding: Bool = false

    var body: some View {
        PaywallView(displayCloseButton: true)
            .onPurchaseCompleted { customerInfo in
                if isOnboarding {
                    OnboardingManager.shared.nextPage()
                } else {
                    dismiss()
                }
            }
            .onRestoreCompleted { customerInfo in
                if customerInfo.entitlements["premium"]?.isActive == true {
                    if isOnboarding {
                        OnboardingManager.shared.nextPage()
                    } else {
                        dismiss()
                    }
                }
            }
            .onAppear {
                Purchases.shared.attribution.setAttributes([
                    "last_paywall_source": triggerSource,
                    "last_paywall_date": ISO8601DateFormatter().string(from: Date())
                ])
            }
    }
}
