import SwiftUI

// MARK: - Paywall Page View

/// Final onboarding screen - "Get Unlimited Access" subscription paywall.
/// Shows subscription benefits and free trial option.
///
/// Required information per App Store Guidelines 3.1.2:
/// - Title of auto-renewing subscription
/// - Length of subscription
/// - Price of subscription
/// - Functional links to Privacy Policy and Terms of Use (EULA)
struct PaywallPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @State private var freeTrialEnabled = true
    @Environment(\.dismiss) private var dismiss

    // Pricing - subscription details
    private let subscriptionTitle = "ReadAloud AI Pro"
    private let subscriptionLength = "Weekly"
    private let weeklyPrice = "$9.99"
    private let trialDays = 7

    // Legal URLs (required by App Store)
    private let privacyURL = URL(string: "https://kreativekoala.llc/privacy")!
    private let termsURL = URL(string: "https://kreativekoala.llc/terms")!

    var body: some View {
        VStack(spacing: 0) {
            // Close and Restore buttons
            HStack {
                Button {
                    manager.completeOnboarding()
                } label: {
                    Image(systemName: "xmark")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(Circle())
                        .contentShape(Circle())
                }

                Spacer()

                Button {
                    // Restore purchases
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
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 16)

            // Subscription card
            subscriptionCard
                .padding(.horizontal, 20)
                .padding(.top, 20)

            // Free trial toggle
            freeTrialToggle
                .padding(.horizontal, 20)
                .padding(.top, 16)

            // Pricing breakdown
            pricingBreakdown
                .padding(.horizontal, 20)
                .padding(.top, 12)

            Spacer()

            // CTA Button
            VStack(spacing: 12) {
                Button {
                    // Start subscription/trial
                    manager.completeOnboarding()
                } label: {
                    Text(freeTrialEnabled ? "Try for Free" : "Subscribe Now")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 56)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .contentShape(RoundedRectangle(cornerRadius: 16))
                }

                // Subscription terms (required by App Store)
                Text("Auto-renewable \(subscriptionLength) subscription. \(weeklyPrice)/week after \(trialDays)-day free trial. Cancel anytime.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
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
                    .foregroundStyle(.secondary)

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

    // MARK: - Subscription Card

    private var subscriptionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Subscription title (required by App Store)
            HStack {
                Text(subscriptionTitle)
                    .font(.headline)

                Spacer()

                // Subscription length badge
                Text(subscriptionLength)
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.yellow.opacity(0.2))
                    .foregroundStyle(.orange)
                    .cornerRadius(6)
            }

            Text("Unlock Unlimited Listening Experience, Download and Listen Offline, Listen Any Text Document, Best AI Voices Available.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // Price and length (required by App Store)
            Text("Free for \(trialDays) days, then \(weeklyPrice)/week")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .cornerRadius(16)
    }

    // MARK: - Free Trial Toggle

    private var freeTrialToggle: some View {
        HStack {
            Text("Free Trial Enabled")
                .font(.subheadline)

            Spacer()

            Toggle("", isOn: $freeTrialEnabled)
                .labelsHidden()
                .tint(.green)
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .cornerRadius(12)
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

                if freeTrialEnabled {
                    Text("\(trialDays) days free")
                        .font(.subheadline)
                        .foregroundStyle(.green)
                    Text("$0.00")
                        .font(.subheadline.weight(.semibold))
                } else {
                    Text(weeklyPrice)
                        .font(.subheadline.weight(.semibold))
                }
            }

            HStack {
                HStack(spacing: 6) {
                    Rectangle()
                        .fill(Color.primary)
                        .frame(width: 2, height: 20)
                        .padding(.leading, 2)
                    Text(dueDateString)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text(weeklyPrice)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
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

#Preview("Paywall") {
    PaywallPageView()
}
