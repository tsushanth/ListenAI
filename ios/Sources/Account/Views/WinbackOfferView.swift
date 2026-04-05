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
        ("doc.text.fill", "Listen to any document"),
        ("waveform", "Natural AI voices"),
        ("gauge.with.dots.needle.33percent", "Speed controls"),
        ("arrow.down.circle.fill", "Offline playback")
    ]

    var body: some View {
        VStack(spacing: 24) {

            // Close button
            HStack {
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)

            Spacer()

            // Badge
            Text("SPECIAL OFFER")
                .font(.caption.bold())
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(Color.orange)
                .clipShape(Capsule())

            // Headline
            Text("We miss you!")
                .font(.largeTitle.bold())

            Text("Come back and unlock everything ReadAloud AI has to offer.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            // Value props
            VStack(alignment: .leading, spacing: 16) {
                ForEach(valueProps, id: \.text) { prop in
                    HStack(spacing: 14) {
                        Image(systemName: prop.icon)
                            .font(.title3)
                            .foregroundStyle(.blue)
                            .frame(width: 28)
                        Text(prop.text)
                            .font(.body)
                    }
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal, 24)

            Spacer()

            // CTA
            Button {
                Task { await startTrial() }
            } label: {
                HStack {
                    if isPurchasing {
                        ProgressView().tint(.white)
                    } else {
                        Text(ctaText)
                            .fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(
                    LinearGradient(colors: [.blue, .purple],
                                   startPoint: .leading, endPoint: .trailing)
                )
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(isPurchasing)
            .padding(.horizontal, 24)

            // No thanks
            Button {
                dismiss()
            } label: {
                Text("No thanks")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 16)
        }
        .padding(.top)
        .alert("Error", isPresented: $showError) {
            Button("OK") {}
        } message: {
            Text(errorMessage)
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
        let annualId = ProductID.annual.rawValue

        isPurchasing = true
        defer { isPurchasing = false }

        let result = await store.purchase(productId: annualId)
        switch result {
        case .purchased:
            await PremiumManager.shared.validateSubscriptionState()
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
