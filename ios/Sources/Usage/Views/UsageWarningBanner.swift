import SwiftUI

// MARK: - Usage Warning Banner

/// Banner displayed when usage approaches or exceeds limits.
struct UsageWarningBanner: View {
    @StateObject private var usageTracker = UsageTrackerService.shared
    @StateObject private var cloudUsage = UsageViewModel()
    @StateObject private var storeManager = StoreKitManager.shared
    @State private var isExpanded = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.sizeCategory) private var sizeCategory
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Whether the user has premium access
    private var isPremium: Bool {
        storeManager.isPremium
    }

    /// Whether to show the banner (either local or cloud warning) - never for premium users
    private var shouldShowBanner: Bool {
        // Premium users never see quota warnings
        guard !isPremium else { return false }
        return usageTracker.showWarningBanner || cloudUsage.showWarningBanner
    }

    /// Prioritize cloud warning over local warning
    private var activeWarningLevel: WarningLevel {
        if cloudUsage.isQuotaExceeded {
            return .critical
        } else if cloudUsage.isNearLimit {
            return cloudUsage.warningLevel
        }
        return usageTracker.quota.warningLevel
    }

    /// Get the appropriate warning message
    private var activeWarningMessage: String? {
        if cloudUsage.isQuotaExceeded || cloudUsage.isNearLimit {
            return cloudUsage.warningMessage
        }
        return usageTracker.warningMessage
    }

    var body: some View {
        if shouldShowBanner {
            VStack(spacing: 0) {
                // Main banner
                Button(action: {
                    if reduceMotion {
                        isExpanded.toggle()
                    } else {
                        withAnimation { isExpanded.toggle() }
                    }
                }) {
                    HStack(spacing: 12) {
                        // Warning icon
                        Image(systemName: activeWarningLevel.iconName)
                            .font(.title3)
                            .foregroundStyle(warningColor)
                            .accessibilityHidden(true)

                        // Message
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bannerTitle)
                                .font(.subheadline.bold())
                                .foregroundStyle(.primary)

                            if let message = activeWarningMessage {
                                Text(message)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(isExpanded ? nil : 1)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        Spacer()

                        // Expand/collapse indicator
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)

                        // Dismiss button
                        Button(action: { dismissBanner() }) {
                            Image(systemName: "xmark")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                                .padding(6)
                                .background(Color.secondary.opacity(contrast == .increased ? 0.25 : 0.15))
                                .clipShape(Circle())
                                .overlay(
                                    Circle()
                                        .stroke(contrast == .increased ? Color.secondary : Color.clear, lineWidth: 1)
                                )
                        }
                        .accessibilityLabel("Dismiss warning")
                        .accessibilityHint("Double tap to hide this warning banner")
                    }
                    .padding()
                    .background(bannerBackground)
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(bannerAccessibilityLabel)
                .accessibilityHint(isExpanded ? "Double tap to collapse" : "Double tap to expand for more details")
                .accessibilityAddTraits(.isButton)

                // Expanded content
                if isExpanded {
                    expandedContent
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(contrast == .increased ? warningColor : Color.clear, lineWidth: 2)
            )
            .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
            .padding(.horizontal)
            .accessibilityAddTraits(.updatesFrequently)
            .task {
                await cloudUsage.fetchUsage()
            }
            .sheet(isPresented: $cloudUsage.showUpgradePrompt) {
                RemotePaywallView(triggerSource: "usage_warning")
            }
        }
    }

    private var bannerAccessibilityLabel: String {
        var label = "\(bannerTitle) warning"
        if let message = activeWarningMessage {
            label += ". \(message)"
        }
        return label
    }

    private func dismissBanner() {
        usageTracker.dismissWarning()
        cloudUsage.dismissWarning()
    }

    // MARK: - Expanded Content

    private var expandedContent: some View {
        VStack(spacing: 16) {
            Divider()

            // Cloud usage (if available)
            if cloudUsage.charLimit > 0 {
                UsageProgressBar(
                    title: "Cloud (Monthly)",
                    used: cloudUsage.charUsed,
                    limit: cloudUsage.charLimit,
                    percentage: Float(cloudUsage.usagePercentage)
                )
            }

            // Usage bars
            VStack(spacing: 12) {
                UsageProgressBar(
                    title: "Daily (Local)",
                    used: usageTracker.quota.dailySummary.totalCharacters,
                    limit: usageTracker.quota.dailySummary.limit,
                    percentage: usageTracker.dailyPercentage
                )

                UsageProgressBar(
                    title: "Monthly (Local)",
                    used: usageTracker.quota.monthlySummary.totalCharacters,
                    limit: usageTracker.quota.monthlySummary.limit,
                    percentage: usageTracker.monthlyPercentage
                )
            }

            // Action buttons
            HStack(spacing: 12) {
                Button(action: { cloudUsage.showUpgradePrompt = true }) {
                    HStack {
                        Image(systemName: "arrow.up.circle")
                        Text("Upgrade Plan")
                    }
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.blue.gradient)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                NavigationLink(destination: UsageQuotaView()) {
                    HStack {
                        Image(systemName: "chart.bar")
                        Text("View Details")
                    }
                    .font(.subheadline.bold())
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.secondary.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            // Tip
            HStack(spacing: 8) {
                Image(systemName: "lightbulb.fill")
                    .foregroundStyle(.yellow)
                Text("Tip: Use on-device voices to save your cloud quota")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(bannerBackground)
    }

    // MARK: - Helpers

    private var bannerTitle: String {
        switch activeWarningLevel {
        case .critical:
            return "Quota Exceeded"
        case .high:
            return "Almost at Limit"
        case .medium:
            return "Quota Warning"
        default:
            return "Usage Update"
        }
    }

    private var warningColor: Color {
        Color(hex: activeWarningLevel.color)
    }

    private var bannerBackground: Color {
        colorScheme == .dark
            ? Color(.secondarySystemBackground)
            : Color(.systemBackground)
    }
}

// MARK: - Usage Progress Bar

struct UsageProgressBar: View {
    let title: String
    let used: Int
    let limit: Int
    let percentage: Float

    @Environment(\.colorSchemeContrast) private var contrast

    private var isUnlimited: Bool {
        limit == Int.max
    }

    private var progressColor: Color {
        if percentage >= 1.0 {
            return .red
        } else if percentage >= 0.9 {
            return .orange
        } else if percentage >= 0.8 {
            return .yellow
        } else {
            return .green
        }
    }

    private var barHeight: CGFloat {
        contrast == .increased ? 8 : 6
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                    .font(.caption.bold())

                Spacer()

                if isUnlimited {
                    Text("Unlimited")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("\(formatCharacterCount(used)) / \(formatCharacterCount(limit))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    // Background
                    Capsule()
                        .fill(Color.secondary.opacity(contrast == .increased ? 0.4 : 0.2))

                    // Progress
                    Capsule()
                        .fill(progressColor.gradient)
                        .frame(width: geometry.size.width * CGFloat(min(percentage, 1.0)))
                }
            }
            .frame(height: barHeight)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) usage")
        .accessibilityValue(accessibilityValue)
    }

    private var accessibilityValue: String {
        if isUnlimited {
            return "\(used.accessibleCharacterCount) used. Unlimited."
        }
        let percentInt = Int(percentage * 100)
        return "\(percentInt) percent. \(used.accessibleCharacterCount) of \(limit.accessibleCharacterCount)"
    }
}

// Note: accessibleCharacterCount is defined in AccessibilityHelpers.swift

// MARK: - Inline Quota Warning

/// Inline warning shown before synthesis.
struct InlineQuotaWarning: View {
    let estimate: UsageEstimate
    var onProceed: (() -> Void)?
    var onCancel: (() -> Void)?
    var onUseOnDevice: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Header
            HStack {
                Image(systemName: warningIcon)
                    .foregroundStyle(warningColor)

                Text(warningTitle)
                    .font(.headline)

                Spacer()
            }

            // Details
            VStack(alignment: .leading, spacing: 8) {
                DetailItem(
                    label: "Content Size",
                    value: estimate.formattedCharacterCount
                )

                DetailItem(
                    label: "Est. Duration",
                    value: estimate.formattedDuration
                )

                if estimate.willExceedDailyLimit {
                    DetailItem(
                        label: "Daily Remaining After",
                        value: formatCharacterCount(estimate.remainingAfterDaily),
                        isWarning: true
                    )
                }

                if estimate.willExceedMonthlyLimit {
                    DetailItem(
                        label: "Monthly Remaining After",
                        value: formatCharacterCount(estimate.remainingAfterMonthly),
                        isWarning: true
                    )
                }
            }

            // Recommendation
            HStack(spacing: 8) {
                Image(systemName: "lightbulb.fill")
                    .foregroundStyle(.yellow)
                Text(estimate.recommendedAction.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .background(Color.yellow.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            // Actions
            HStack(spacing: 12) {
                if estimate.canProceed {
                    Button(action: { onProceed?() }) {
                        Text("Proceed")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Color.blue.gradient)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }

                if let onUseOnDevice = onUseOnDevice {
                    Button(action: onUseOnDevice) {
                        Text("Use On-Device")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Color.secondary.opacity(0.15))
                            .foregroundStyle(.primary)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }

                Button(action: { onCancel?() }) {
                    Text("Cancel")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.secondary.opacity(0.15))
                        .foregroundStyle(.secondary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var warningIcon: String {
        if !estimate.canProceed {
            return "xmark.octagon.fill"
        } else if estimate.recommendedAction == .useOnDevice {
            return "exclamationmark.triangle.fill"
        } else {
            return "info.circle.fill"
        }
    }

    private var warningColor: Color {
        if !estimate.canProceed {
            return .red
        } else if estimate.recommendedAction == .useOnDevice {
            return .orange
        } else {
            return .blue
        }
    }

    private var warningTitle: String {
        if !estimate.canProceed {
            return "Quota Exceeded"
        } else if estimate.willExceedDailyLimit || estimate.willExceedMonthlyLimit {
            return "Approaching Limit"
        } else {
            return "Usage Estimate"
        }
    }
}

// MARK: - Detail Item

private struct DetailItem: View {
    let label: String
    let value: String
    var isWarning: Bool = false

    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Spacer()

            Text(value)
                .font(.subheadline.bold())
                .foregroundStyle(isWarning ? .red : .primary)
        }
    }
}

// MARK: - Toast Notification

/// Floating toast for usage notifications.
struct UsageToast: View {
    let message: String
    let level: WarningLevel
    @Binding var isPresented: Bool

    var body: some View {
        if isPresented {
            HStack(spacing: 10) {
                Image(systemName: level.iconName)
                    .foregroundStyle(Color(hex: level.color))

                Text(message)
                    .font(.subheadline)
                    .lineLimit(2)

                Spacer()

                Button(action: { isPresented = false }) {
                    Image(systemName: "xmark")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.15), radius: 8, y: 4)
            .padding(.horizontal)
            .transition(.move(edge: .top).combined(with: .opacity))
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                    withAnimation {
                        isPresented = false
                    }
                }
            }
        }
    }
}

// MARK: - Synthesis Confirmation Sheet

/// Confirmation sheet before large synthesis.
struct SynthesisConfirmationSheet: View {
    let estimate: UsageEstimate
    let articleTitle: String
    @Binding var isPresented: Bool
    var onConfirm: ((Bool) -> Void)? // Bool = use cloud

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                // Article info
                VStack(spacing: 8) {
                    Image(systemName: "doc.text.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.blue)

                    Text(articleTitle)
                        .font(.headline)
                        .multilineTextAlignment(.center)

                    Text("\(estimate.formattedCharacterCount) characters • \(estimate.formattedDuration)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.top)

                // Quota impact
                VStack(alignment: .leading, spacing: 12) {
                    Text("Quota Impact")
                        .font(.headline)

                    HStack {
                        VStack(alignment: .leading) {
                            Text("Daily Remaining")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(formatCharacterCount(estimate.remainingAfterDaily))
                                .font(.title3.bold())
                                .foregroundStyle(estimate.willExceedDailyLimit ? .red : .primary)
                        }

                        Spacer()

                        VStack(alignment: .trailing) {
                            Text("Monthly Remaining")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(formatCharacterCount(estimate.remainingAfterMonthly))
                                .font(.title3.bold())
                                .foregroundStyle(estimate.willExceedMonthlyLimit ? .red : .primary)
                        }
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                Spacer()

                // Actions
                VStack(spacing: 12) {
                    if estimate.canProceed {
                        Button(action: {
                            onConfirm?(true)
                            isPresented = false
                        }) {
                            HStack {
                                Image(systemName: "cloud.fill")
                                Text("Use Cloud Voice")
                            }
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.blue.gradient)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }

                    Button(action: {
                        onConfirm?(false)
                        isPresented = false
                    }) {
                        HStack {
                            Image(systemName: "iphone")
                            Text("Use On-Device Voice (Free)")
                        }
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.secondary.opacity(0.15))
                        .foregroundStyle(.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            .padding()
            .navigationTitle("Confirm Synthesis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        isPresented = false
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Quota Limit Sheet (Paywall)

/// Paywall sheet displayed when quota is exceeded or premium features are required.
/// Presents upgrade options alongside on-device voice fallback.
struct QuotaLimitSheet: View {
    let error: TTSJobError
    @Binding var isPresented: Bool
    var onUpgrade: (() -> Void)?
    var onUseOnDevice: (() -> Void)?
    var onDismiss: (() -> Void)?

    @StateObject private var storeManager = StoreKitManager.shared

    /// Whether this is a daily vs monthly limit
    private var isDailyLimit: Bool {
        if case .dailyQuotaExceeded = error { return true }
        return false
    }

    /// Whether user is on free tier
    private var isFreeTier: Bool {
        !storeManager.isPremium
    }

    /// Whether to show rate limit countdown
    private var isRateLimited: Bool {
        if case .rateLimited = error { return true }
        return false
    }

    private func formatSeconds(_ seconds: Int) -> String {
        if seconds >= 3600 {
            let hours = seconds / 3600
            let mins = (seconds % 3600) / 60
            return mins > 0 ? "\(hours)h \(mins)m" : "\(hours)h"
        } else if seconds >= 60 {
            return "\(seconds / 60) minutes"
        } else {
            return "\(seconds) seconds"
        }
    }

    /// Premium benefits to display
    private let premiumBenefits = [
        ("waveform", "Unlimited AI Voices", "Access all premium cloud voices"),
        ("clock.fill", "No Daily Limits", "Listen as much as you want"),
        ("hare.fill", "Priority Processing", "Faster audio generation"),
        ("sparkles", "New Voices First", "Early access to new voice releases"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Header
                    VStack(spacing: 12) {
                        Image(systemName: "crown.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(
                                LinearGradient(
                                    colors: [.yellow, .orange],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .padding(.top, 16)

                        Text("Unlock Premium Voices")
                            .font(.title.bold())

                        // Show quota info if available
                        switch error {
                        case .dailyQuotaExceeded(let used, let limit) where limit > 0:
                            if used >= limit {
                                Text("You've used all \(formatSeconds(limit)) of your free daily quota.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                            } else {
                                Text("This article is too long for your remaining quota (\(formatSeconds(limit - used)) left today).")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                            }
                        case .monthlyQuotaExceeded(let used, let limit) where limit > 0:
                            if used >= limit {
                                Text("You've used all \(formatSeconds(limit)) of your monthly quota.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                            } else {
                                Text("This article is too long for your remaining quota (\(formatSeconds(limit - used)) left this month).")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                            }
                        case .rateLimited(let retryAfter):
                            Text("Please wait \(retryAfter) seconds before trying again.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        default:
                            Text("Upgrade to continue using premium AI voices")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                    }
                    .padding(.horizontal)

                    // Premium benefits
                    if !isRateLimited {
                        VStack(alignment: .leading, spacing: 16) {
                            ForEach(premiumBenefits, id: \.0) { icon, title, subtitle in
                                HStack(spacing: 16) {
                                    Image(systemName: icon)
                                        .font(.title2)
                                        .foregroundStyle(.yellow)
                                        .frame(width: 32)

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(title)
                                            .font(.subheadline.weight(.semibold))
                                        Text(subtitle)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }

                                    Spacer()
                                }
                            }
                        }
                        .padding()
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .padding(.horizontal)
                    }

                    Spacer(minLength: 20)

                    // Action buttons
                    VStack(spacing: 12) {
                        // Upgrade button (primary CTA)
                        if !isRateLimited {
                            Button(action: {
                                onUpgrade?()
                                isPresented = false
                            }) {
                                HStack {
                                    Image(systemName: "crown.fill")
                                    Text(isFreeTier ? "Upgrade to Premium" : "Manage Subscription")
                                }
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(
                                    LinearGradient(
                                        colors: [.yellow, .orange],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                )
                                .foregroundStyle(.black)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                            }

                            // Pricing hint
                            Text("Starting at $4.99/month")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        // Use on-device voice (secondary option)
                        if let onUseOnDevice = onUseOnDevice {
                            Button(action: {
                                onUseOnDevice()
                                isPresented = false
                            }) {
                                HStack {
                                    Image(systemName: "iphone")
                                    Text("Continue with On-Device Voice")
                                }
                                .font(.subheadline.weight(.medium))
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(Color(.systemGray5))
                                .foregroundStyle(.primary)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                            }
                        }

                        // Dismiss
                        Button(action: {
                            onDismiss?()
                            isPresented = false
                        }) {
                            Text(isRateLimited ? "OK" : "Maybe Later")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 8)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom)
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: {
                        onDismiss?()
                        isPresented = false
                    }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Quota Error State

/// Tracks quota-related error state for the UI
@MainActor
class QuotaErrorState: ObservableObject {
    static let shared = QuotaErrorState()

    /// Current quota error (if any)
    @Published var currentError: TTSJobError?

    /// Whether the quota limit sheet is showing
    @Published var showQuotaSheet = false

    /// Whether Play button should be disabled due to quota
    @Published var isPlayDisabledDueToQuota = false

    /// Message to show when Play is disabled
    @Published var playDisabledMessage: String?

    private init() {}

    /// Handle a quota-related error from the job API
    func handleQuotaError(_ error: TTSJobError) {
        currentError = error
        showQuotaSheet = true

        // Disable play for daily quota exceeded on free tier
        if case .dailyQuotaExceeded = error {
            if !StoreKitManager.shared.isPremium {
                isPlayDisabledDueToQuota = true
                playDisabledMessage = "Daily limit reached. Upgrade or try tomorrow."
            }
        }
    }

    /// Clear quota error state (e.g., when sheet is dismissed)
    func clearError() {
        currentError = nil
        // Keep isPlayDisabledDueToQuota until quota resets or user upgrades
    }

    /// Reset play disabled state (e.g., on app launch to check if day changed)
    func checkAndResetDailyQuota() {
        // Check if we're on a new day
        let lastQuotaResetKey = "lastQuotaResetDate"
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())

        if let lastReset = UserDefaults.standard.object(forKey: lastQuotaResetKey) as? Date {
            let lastResetDay = calendar.startOfDay(for: lastReset)
            if today > lastResetDay {
                // New day - reset quota block
                isPlayDisabledDueToQuota = false
                playDisabledMessage = nil
                UserDefaults.standard.set(today, forKey: lastQuotaResetKey)
            }
        } else {
            UserDefaults.standard.set(today, forKey: lastQuotaResetKey)
        }
    }
}

// MARK: - Preview

#Preview {
    VStack {
        UsageWarningBanner()

        Spacer()
    }
}

#Preview("Quota Limit Sheet - Daily") {
    QuotaLimitSheet(
        error: .dailyQuotaExceeded(used: 300, limit: 300),
        isPresented: .constant(true),
        onUpgrade: {},
        onUseOnDevice: {},
        onDismiss: {}
    )
}

#Preview("Quota Limit Sheet - Monthly") {
    QuotaLimitSheet(
        error: .monthlyQuotaExceeded(used: 10000, limit: 10000),
        isPresented: .constant(true),
        onUpgrade: {},
        onUseOnDevice: {},
        onDismiss: {}
    )
}
