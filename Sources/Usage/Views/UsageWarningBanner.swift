import SwiftUI

// MARK: - Usage Warning Banner

/// Banner displayed when usage approaches or exceeds limits.
struct UsageWarningBanner: View {
    @StateObject private var usageTracker = UsageTrackerService.shared
    @State private var isExpanded = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if usageTracker.showWarningBanner {
            VStack(spacing: 0) {
                // Main banner
                Button(action: { withAnimation { isExpanded.toggle() } }) {
                    HStack(spacing: 12) {
                        // Warning icon
                        Image(systemName: usageTracker.quota.warningLevel.iconName)
                            .font(.title3)
                            .foregroundStyle(warningColor)

                        // Message
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bannerTitle)
                                .font(.subheadline.bold())
                                .foregroundStyle(.primary)

                            if let message = usageTracker.warningMessage {
                                Text(message)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(isExpanded ? nil : 1)
                            }
                        }

                        Spacer()

                        // Expand/collapse indicator
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        // Dismiss button
                        Button(action: { usageTracker.dismissWarning() }) {
                            Image(systemName: "xmark")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                                .padding(6)
                                .background(Color.secondary.opacity(0.15))
                                .clipShape(Circle())
                        }
                    }
                    .padding()
                    .background(bannerBackground)
                }
                .buttonStyle(.plain)

                // Expanded content
                if isExpanded {
                    expandedContent
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
            .padding(.horizontal)
        }
    }

    // MARK: - Expanded Content

    private var expandedContent: some View {
        VStack(spacing: 16) {
            Divider()

            // Usage bars
            VStack(spacing: 12) {
                UsageProgressBar(
                    title: "Daily",
                    used: usageTracker.quota.dailySummary.totalCharacters,
                    limit: usageTracker.quota.dailySummary.limit,
                    percentage: usageTracker.dailyPercentage
                )

                UsageProgressBar(
                    title: "Monthly",
                    used: usageTracker.quota.monthlySummary.totalCharacters,
                    limit: usageTracker.quota.monthlySummary.limit,
                    percentage: usageTracker.monthlyPercentage
                )
            }

            // Action buttons
            HStack(spacing: 12) {
                Button(action: {}) {
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
        switch usageTracker.quota.warningLevel {
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
        Color(hex: usageTracker.quota.warningLevel.color)
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
                        .fill(Color.secondary.opacity(0.2))

                    // Progress
                    Capsule()
                        .fill(progressColor.gradient)
                        .frame(width: geometry.size.width * CGFloat(min(percentage, 1.0)))
                }
            }
            .frame(height: 6)
        }
    }
}

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

// MARK: - Preview

#Preview {
    VStack {
        UsageWarningBanner()

        Spacer()
    }
}
