import SwiftUI
import PaywallKit

// MARK: - Paywall Page View

/// Final onboarding screen - "Get Unlimited Access" subscription paywall.
/// Shows subscription benefits and free trial option.
///
/// Required information per App Store Guidelines 3.1.2:
/// - Title of auto-renewing subscription
/// - Length of subscription
/// - Price of subscription
/// - Functional links to Privacy Policy and Terms of Use (EULA)
struct LegacyPaywallPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @ObservedObject private var store = StoreManager.shared
    @State private var selectedPlan: LegacySubscriptionPlan = .annual
    @State private var isPurchasing = false
    @State private var showError = false
    @State private var errorMessage = ""
    @Environment(\.dismiss) private var dismiss

    enum LegacySubscriptionPlan {
        case annual
        case weekly
    }

    // Subscription details
    private let subscriptionTitle = "ReadAloud AI Pro"

    // Legal URLs (required by App Store)
    private let privacyURL = URL(string: "https://kreativekoala.llc/privacy")!
    private let termsURL = URL(string: "https://kreativekoala.llc/terms")!

    // MARK: - Computed Properties

    /// Get the weekly product from StoreManager
    private var weeklyProduct: PaywallProduct? {
        store.paywallProducts.first { $0.period == .weekly }
    }

    /// Get the annual product from StoreManager
    private var annualProduct: PaywallProduct? {
        store.paywallProducts.first { $0.period == .yearly }
    }

    /// Currently selected product ID
    private var selectedProductId: String? {
        selectedPlan == .annual ? annualProduct?.id : weeklyProduct?.id
    }

    /// Price string or fallback
    private var weeklyPrice: String {
        weeklyProduct?.localizedPrice ?? "$7.99"
    }

    /// Annual price string
    private var annualPrice: String {
        annualProduct?.localizedPrice ?? "$39.99"
    }

    /// Check if the selected product has a free trial
    private var hasFreeTrial: Bool {
        let product = selectedPlan == .annual ? annualProduct : weeklyProduct
        return (product?.trialDays ?? 0) > 0
    }

    /// Free trial duration string
    private var trialDuration: String {
        let product = selectedPlan == .annual ? annualProduct : weeklyProduct
        if let days = product?.trialDays, days > 0 {
            return "\(days) days"
        }
        return "7 days"
    }

    /// Trial days as integer for date calculation
    private var trialDays: Int {
        let product = selectedPlan == .annual ? annualProduct : weeklyProduct
        return product?.trialDays ?? 7
    }

    /// Calculate weekly equivalent for annual plan
    private var annualWeeklyEquivalent: String {
        if let product = annualProduct {
            let weeklyPrice = product.price / 52
            let formatter = NumberFormatter()
            formatter.numberStyle = .currency
            formatter.currencyCode = product.currencyCode
            return formatter.string(from: weeklyPrice as NSDecimalNumber) ?? "$0.77"
        }
        return "$0.77"
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                // Close and Restore buttons
                HStack {
                    Button {
                        manager.nextPage()  // Go to sign-in page
                    } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(Circle())
                            .contentShape(Circle())
                    }
                    .disabled(isPurchasing)

                    Spacer()

                    Button {
                        restorePurchases()
                    } label: {
                        Text("Restore")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(Capsule())
                            .contentShape(Capsule())
                    }
                    .disabled(isPurchasing)
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)

                // Hero illustration
                heroIllustration
                    .padding(.top, 8)

                // Title
                VStack(spacing: 8) {
                    Text("Get Unlimited Access")
                        .font(.system(size: 26, weight: .bold))

                    Text("Read anything aloud in top-quality voices")
                        .font(.subheadline)
                        .foregroundStyle(Color(white: 0.33))
                }
                .padding(.top, 16)

                // Subscription features
                subscriptionFeatures
                    .padding(.horizontal, 24)
                    .padding(.top, 16)

                // Subscription options
                subscriptionOptions
                    .padding(.horizontal, 20)
                    .padding(.top, 20)

                // Pricing breakdown
                pricingBreakdown
                    .padding(.horizontal, 20)
                    .padding(.top, 16)

                Spacer()

                // CTA Button
                VStack(spacing: 12) {
                    Button {
                        purchaseSubscription()
                    } label: {
                        HStack(spacing: 8) {
                            if isPurchasing {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                    .scaleEffect(0.8)
                            }
                            Text(isPurchasing ? "Processing..." : (hasFreeTrial ? "Start Free Trial" : "Subscribe Now"))
                                .font(.headline)
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 56)
                        .background(isPurchasing ? Color.gray : Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .contentShape(RoundedRectangle(cornerRadius: 16))
                    }
                    .disabled(isPurchasing || selectedProductId == nil)

                    // Subscription terms (required by App Store)
                    Text(subscriptionTermsText)
                        .font(.caption2)
                        .foregroundStyle(Color(white: 0.33))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 8)

                    // Footer links (functional links required by App Store 3.1.2)
                    HStack {
                        Link("Terms of Use", destination: termsURL)
                            .font(.caption)
                            .foregroundStyle(.blue)

                        Spacer()

                        HStack(spacing: 4) {
                            Image(systemName: "lock.fill")
                                .font(.caption2)
                            Text("Secured with Apple")
                                .font(.caption)
                        }
                        .foregroundStyle(Color(white: 0.33))

                        Spacer()

                        Link("Privacy Policy", destination: privacyURL)
                            .font(.caption)
                            .foregroundStyle(.blue)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
            .frame(maxWidth: 500)  // Constrain width on iPad for better UX
            .frame(maxWidth: .infinity)  // Center within parent
            .disabled(isPurchasing)
        }
        .alert("Error", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage)
        }
        .task {
            // Load products if not already loaded
            if store.paywallProducts.isEmpty {
                await store.loadProducts()
            }
        }
    }

    // MARK: - Subscription Terms Text

    private var subscriptionTermsText: String {
        if selectedPlan == .annual {
            if hasFreeTrial {
                return "Auto-renewable Annual subscription. \(annualPrice)/year after \(trialDuration) free trial. Cancel anytime."
            } else {
                return "Auto-renewable Annual subscription. \(annualPrice)/year. Cancel anytime."
            }
        } else {
            return "Auto-renewable Weekly subscription. \(weeklyPrice)/week. Cancel anytime."
        }
    }

    // MARK: - Purchase Actions

    private func purchaseSubscription() {
        guard let productId = selectedProductId else {
            errorMessage = "Subscription not available. Please try again later."
            showError = true
            return
        }

        isPurchasing = true

        Task {
            let result = await store.purchase(productId: productId)
            await MainActor.run {
                isPurchasing = false
                switch result {
                case .purchased:
                    Task { await PremiumManager.shared.validateSubscriptionState() }
                    manager.nextPage()
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
    }

    private func restorePurchases() {
        isPurchasing = true

        Task {
            await store.restore()
            await PremiumManager.shared.validateSubscriptionState()
            await MainActor.run {
                isPurchasing = false
                if PremiumManager.shared.isPremium {
                    manager.nextPage()
                }
            }
        }
    }

    // MARK: - Subscription Features

    private var subscriptionFeatures: some View {
        VStack(alignment: .leading, spacing: 10) {
            PaywallFeatureRow(icon: "waveform", text: "Unlimited text-to-speech with cloud voices")
            PaywallFeatureRow(icon: "person.wave.2", text: "Premium AI voices from ElevenLabs")
            PaywallFeatureRow(icon: "mic.fill", text: "Create custom voice clones")
            PaywallFeatureRow(icon: "text.magnifyingglass", text: "AI-powered article summaries")
            PaywallFeatureRow(icon: "gauge.with.dots.needle.67percent", text: "Speed control up to 3x")
        }
    }

    // MARK: - Hero Illustration

    @ViewBuilder
    private var heroIllustration: some View {
        ZStack {
            // Background gradient
            LinearGradient(
                colors: [Color(red: 1.0, green: 0.97, blue: 0.91), Color(red: 1.0, green: 0.95, blue: 0.84)],
                startPoint: .top,
                endPoint: .bottom
            )

            // Waveform bars on sides
            HStack {
                // Left waveform
                HStack(spacing: 4) {
                    ForEach(0..<6, id: \.self) { index in
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color.yellow)
                            .frame(width: 6, height: waveHeight(index: index))
                    }
                }

                Spacer()

                // Right waveform
                HStack(spacing: 4) {
                    ForEach(0..<6, id: \.self) { index in
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color.yellow)
                            .frame(width: 6, height: waveHeight(index: 5 - index))
                    }
                }
            }
            .padding(.horizontal, 20)

            // Phone mockup
            ZStack {
                // Phone frame
                RoundedRectangle(cornerRadius: 32)
                    .fill(Color(.systemBackground))
                    .frame(width: 180, height: 220)
                    .shadow(color: .black.opacity(0.1), radius: 12, y: 6)

                // Document icon inside
                VStack(spacing: 8) {
                    // Document lines
                    VStack(spacing: 4) {
                        ForEach(0..<6, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.gray.opacity(0.2))
                                .frame(height: 8)
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 40)

                    Spacer()
                }
                .frame(width: 180, height: 220)

                // File type icons floating around
                FileTypeIconSmall(type: "URL", color: .orange)
                    .offset(x: -80, y: -60)

                FileTypeIconSmall(type: "DOC", color: .orange)
                    .offset(x: 80, y: -40)

                FileTypeIconSmall(type: "PDF", color: .purple)
                    .offset(x: -90, y: 20)

                FileTypeIconSmall(type: "ePUB", color: .green)
                    .offset(x: 85, y: 50)
            }
        }
        .frame(height: 260)
    }

    private func waveHeight(index: Int) -> CGFloat {
        let heights: [CGFloat] = [30, 50, 70, 90, 70, 50]
        return heights[index % heights.count]
    }

    // MARK: - Subscription Options

    private var subscriptionOptions: some View {
        VStack(spacing: 12) {
            // Annual option (recommended)
            SubscriptionOptionCard(
                title: "Annual",
                price: annualPrice,
                period: "/year",
                subtitle: "Just \(annualWeeklyEquivalent)/week",
                badge: "SAVE 90%",
                hasFreeTrial: (annualProduct?.trialDays ?? 0) > 0,
                trialDuration: annualProduct.map { "\($0.trialDays ?? 7) days" } ?? "7 days",
                isSelected: selectedPlan == .annual
            ) {
                selectedPlan = .annual
            }

            // Weekly option
            SubscriptionOptionCard(
                title: "Weekly",
                price: weeklyPrice,
                period: "/week",
                subtitle: nil,
                badge: nil,
                hasFreeTrial: false,
                trialDuration: nil,
                isSelected: selectedPlan == .weekly
            ) {
                selectedPlan = .weekly
            }
        }
    }

    // MARK: - Pricing Breakdown

    private var pricingBreakdown: some View {
        VStack(spacing: 8) {
            HStack {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.primary)
                        .frame(width: 6, height: 6)
                    Text("Due today")
                        .font(.subheadline)
                }

                Spacer()

                if hasFreeTrial {
                    Text("\(trialDuration) free")
                        .font(.subheadline)
                        .foregroundStyle(.green)
                    Text("$0.00")
                        .font(.subheadline.weight(.semibold))
                } else {
                    Text(selectedPlan == .annual ? annualPrice : weeklyPrice)
                        .font(.subheadline.weight(.semibold))
                }
            }

            if hasFreeTrial {
                HStack {
                    HStack(spacing: 6) {
                        Rectangle()
                            .fill(Color.primary)
                            .frame(width: 2, height: 20)
                            .padding(.leading, 2)
                        Text(dueDateString)
                            .font(.subheadline)
                            .foregroundStyle(Color(white: 0.33))
                    }

                    Spacer()

                    Text(selectedPlan == .annual ? annualPrice : weeklyPrice)
                        .font(.subheadline)
                        .foregroundStyle(Color(white: 0.33))
                }
            }
        }
    }

    private var dueDateString: String {
        let calendar = Calendar.current
        let futureDate = calendar.date(byAdding: .day, value: trialDays, to: Date()) ?? Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM d, yyyy"
        return "Due \(formatter.string(from: futureDate))"
    }
}

// MARK: - Small File Type Icon

struct FileTypeIconSmall: View {
    let type: String
    let color: Color

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(color)
                .frame(width: 36, height: 44)

            Text(type)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.white)
        }
        .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
    }
}

// MARK: - Paywall Feature Row

struct PaywallFeatureRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.orange)
                .frame(width: 24)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Color(white: 0.2))
        }
    }
}

// MARK: - Subscription Option Card

struct SubscriptionOptionCard: View {
    let title: String
    let price: String
    let period: String
    let subtitle: String?
    let badge: String?
    let hasFreeTrial: Bool
    let trialDuration: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(.primary)

                        if let badge = badge {
                            Text(badge)
                                .font(.caption2.bold())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Color.green)
                                .cornerRadius(4)
                        }
                    }

                    HStack(spacing: 4) {
                        Text(price)
                            .font(.title3.bold())
                            .foregroundStyle(.primary)
                        Text(period)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    if let subtitle = subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if hasFreeTrial, let duration = trialDuration {
                        Text("\(duration) free trial")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }

                Spacer()

                // Selection indicator
                ZStack {
                    Circle()
                        .strokeBorder(isSelected ? Color.black : Color.gray.opacity(0.3), lineWidth: 2)
                        .frame(width: 24, height: 24)

                    if isSelected {
                        Circle()
                            .fill(Color.black)
                            .frame(width: 16, height: 16)
                    }
                }
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(isSelected ? Color.black : Color.clear, lineWidth: 2)
            )
        }
        .buttonStyle(.plain)
    }
}

#Preview("Paywall") {
    LegacyPaywallPageView()
}
