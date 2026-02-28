import SwiftUI
import RevenueCatUI
import RevenueCat

/// Full RevenueCat paywall (design controlled from RC dashboard) with a custom
/// 44x44pt close button overlay for iPad accessibility (Guideline 2.1).
struct RemotePaywallView: View {
    @Environment(\.dismiss) private var dismiss
    var triggerSource: String = "unknown"
    /// When true, advances onboarding instead of calling dismiss (for TabView context)
    var isOnboarding: Bool = false

    private func handleDismiss() {
        if isOnboarding {
            OnboardingManager.shared.nextPage()
        } else {
            dismiss()
        }
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Full RevenueCat paywall — template, features, pricing all from RC dashboard
            PaywallView(displayCloseButton: false)
                .onPurchaseCompleted { _ in handleDismiss() }
                .onRestoreCompleted { customerInfo in
                    if customerInfo.entitlements["premium"]?.isActive == true {
                        handleDismiss()
                    }
                }

            // Custom close button — 44x44pt minimum tap target (Guideline 2.1)
            Button(action: handleDismiss) {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .contentShape(Circle())
            }
            .padding(.leading, 16)
            .padding(.top, 16)
        }
        .onAppear {
            Purchases.shared.attribution.setAttributes([
                "last_paywall_source": triggerSource,
                "last_paywall_date": ISO8601DateFormatter().string(from: Date())
            ])
        }
    }
}
