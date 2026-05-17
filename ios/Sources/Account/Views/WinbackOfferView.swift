import SwiftUI
import PaywallKit

/// A special offer view shown to users who have dismissed the paywall multiple times.
/// Provides a compelling value proposition to win back churning users.
struct WinbackOfferView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = StoreManager.shared
    @State private var isPurchasing = false
    @State private var showError = false
    @State private var errorMessage = ""

    private let valueProps: [(icon: String, text: String)] = [
        ("headphones", "Unlimited articles & documents"),
        ("waveform", "Premium AI voices"),
        ("arrow.down.circle.fill", "Offline playback"),
        ("globe", "50+ languages supported")
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    // Special offer badge
                    Text("SPECIAL OFFER")
                        .font(.caption)
                        .fontWeight(.heavy)
                        .tracking(1.5)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                        .background(
                            LinearGradient(
                                colors: [.orange, .red],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .clipShape(Capsule())
                        .padding(.top, 24)

                    // Headline
                    VStack(spacing: 8) {
                        Text("Listen to Anything, Anywhere")
                            .font(.largeTitle)
                            .fontWeight(.bold)
                            .multilineTextAlignment(.center)

                        Text("You're this close to unlocking the full ReadAloud AI experience.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }

                    // Value propositions
                    VStack(spacing: 16) {
                        ForEach(valueProps, id: \.text) { prop in
                            HStack(spacing: 14) {
                                Image(systemName: prop.icon)
                                    .font(.title3)
                                    .foregroundStyle(.blue)
                                    .frame(width: 32)

                                Text(prop.text)
                                    .font(.body)
                                    .fontWeight(.medium)

                                Spacer()

                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .padding()
                    .background(Color(.systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 14))

                    // CTA Button
                    Button {
                        Task { await startTrial() }
                    } label: {
                        HStack {
                            if isPurchasing {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text(ctaText)
                                    .fontWeight(.semibold)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(
                            LinearGradient(
                                colors: [.blue, .purple],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(isPurchasing)

                    // No thanks
                    Button {
                        dismiss()
                    } label: {
                        Text("No thanks")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    // Legal
                    Text("Subscription automatically renews unless cancelled at least 24 hours before the end of the current period.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)

                    Spacer(minLength: 0)
                }
                .padding(.horizontal)
            }
            .background(Color(.systemGroupedBackground))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .font(.title2)
                    }
                }
            }
            .task {
                if store.paywallProducts.isEmpty {
                    await store.loadProducts()
                }
            }
            .alert("Error", isPresented: $showError) {
                Button("OK") { showError = false }
            } message: {
                Text(errorMessage)
            }
        }
    }

    // MARK: - Helpers

    private var ctaText: String {
        if let annualProduct = store.paywallProducts.first(where: { $0.period == .yearly }) {
            if let trialDays = annualProduct.trialDays, trialDays > 0 {
                return "Start \(trialDays)-Day Free Trial"
            }
            return "Subscribe - \(annualProduct.localizedPrice)/yr"
        }
        return "Start Free Trial"
    }

    private func startTrial() async {
        let annualId = "com.kreativekoala.listenai.annual"
        // ASC-configured promotional offer: 50% off the first year for users
        // returning after their subscription expired. Server-signed via
        // PaywallKit-API → /redeem-promo, then redeemed against StoreKit.
        let winbackOfferCode = "annual_winback_50off"

        isPurchasing = true
        defer { isPurchasing = false }

        let result = await store.purchaseWithPromoOffer(
            productId: annualId,
            offerCode: winbackOfferCode
        )
        switch result {
        case .purchased:
            await PremiumManager.shared.handlePurchase(productID: annualId)
            dismiss()
        case .cancelled:
            break
        case .failed(let error):
            errorMessage = error.localizedDescription
            showError = true
        case .pending:
            errorMessage = "Purchase is pending approval"
            showError = true
        }
    }
}

#Preview {
    WinbackOfferView()
}
