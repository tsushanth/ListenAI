import SwiftUI
import StoreKit

// Note: Accessibility extensions are defined in AccessibilityHelpers.swift

// MARK: - Usage Quota View

/// Main view displaying usage quota and statistics.
struct UsageQuotaView: View {
    @StateObject private var usageTracker = UsageTrackerService.shared
    @StateObject private var cloudUsage = UsageViewModel()
    @StateObject private var storeManager = StoreKitManager.shared
    @State private var selectedPeriod: UsagePeriod = .daily
    @Environment(\.sizeCategory) private var sizeCategory
    @Environment(\.colorSchemeContrast) private var contrast

    /// Whether to use stacked layout for accessibility sizes
    private var useStackedLayout: Bool {
        sizeCategory.isAccessibilityCategory
    }

    /// Whether the user has premium (unlimited) access
    private var isPremium: Bool {
        storeManager.isPremium
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Current tier card
                    tierCard

                    // Cloud usage (from backend)
                    cloudUsageSection

                    // Usage gauges (local tracking)
                    usageGauges

                    // Period selector
                    periodPicker

                    // Detailed usage
                    detailedUsage

                    // Statistics
                    statisticsSection

                    // Recent history
                    recentHistorySection
                }
                .padding()
            }
            .navigationTitle("Usage")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(action: { cloudUsage.showUpgradePrompt = true }) {
                            Label("Upgrade Plan", systemImage: "arrow.up.circle")
                        }

                        Button(action: { cloudUsage.showUpgradePrompt = true }) {
                            Label("View Pricing", systemImage: "dollarsign.circle")
                        }

                        Button(action: {
                            Task { await cloudUsage.refresh() }
                        }) {
                            Label("Refresh Usage", systemImage: "arrow.clockwise")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("More options")
                    .accessibilityHint("Double tap to view upgrade and pricing options")
                }
            }
            .task {
                await cloudUsage.fetchUsage()
            }
            .refreshable {
                await cloudUsage.refresh()
            }
            .sheet(isPresented: $cloudUsage.showUpgradePrompt) {
                UpgradePromptView()
            }
        }
    }

    // MARK: - Tier Card

    private var tierCard: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Current Plan")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text(isPremium ? "Premium" : "Free")
                    .font(.title2.bold())

                if isPremium {
                    HStack(spacing: 4) {
                        Image(systemName: "infinity")
                            .font(.caption)
                        Text("Unlimited")
                            .font(.caption)
                    }
                    .foregroundStyle(.green)
                } else {
                    Text("\(estimatedMinutesRemainingDisplay) remaining")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if !isPremium {
                Button(action: { cloudUsage.showUpgradePrompt = true }) {
                    Text("Upgrade")
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.blue.gradient)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(contrast == .increased ? Color.white : Color.clear, lineWidth: 2)
                        )
                }
                .accessibilityLabel("Upgrade plan")
                .accessibilityHint("Double tap to view upgrade options")
            } else {
                // Show premium badge
                Image(systemName: "crown.fill")
                    .font(.title2)
                    .foregroundStyle(.yellow.gradient)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(tierAccessibilityLabel)
    }

    /// Formatted remaining time display
    private var estimatedMinutesRemainingDisplay: String {
        let minutes = cloudUsage.estimatedMinutesRemaining
        if minutes >= 60 {
            let hours = minutes / 60
            let mins = minutes % 60
            if mins == 0 {
                return "\(hours) hr"
            }
            return "\(hours) hr \(mins) min"
        }
        return "\(minutes) min"
    }

    private var tierAccessibilityLabel: String {
        if isPremium {
            return "Current plan: Premium. Unlimited usage."
        }
        return "Current plan: Free. \(estimatedMinutesRemainingDisplay) remaining."
    }

    // MARK: - Cloud Usage Section

    private var cloudUsageSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "cloud.fill")
                    .foregroundStyle(.blue)
                Text("Cloud Usage")
                    .font(.headline)

                Spacer()

                if cloudUsage.isLoading {
                    ProgressView()
                        .scaleEffect(0.8)
                }
            }

            if isPremium {
                // Premium users - show unlimited status
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.title2)
                            .foregroundStyle(.green)

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Unlimited Access")
                                .font(.headline)
                            Text("Enjoy unlimited cloud voices with your premium subscription")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    // Show usage stats even for premium (informational)
                    if cloudUsage.charUsed > 0 {
                        HStack(spacing: 16) {
                            VStack(alignment: .leading) {
                                Text("Used This Month")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(formatCharacterCount(cloudUsage.charUsed))
                                    .font(.subheadline.bold())
                            }

                            Divider()
                                .frame(height: 30)

                            VStack(alignment: .leading) {
                                Text("Est. Audio Time")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text("\(cloudUsage.charUsed / 750) min generated")
                                    .font(.subheadline.bold())
                            }

                            Spacer()
                        }
                        .padding(.top, 4)
                    }
                }
            } else if let error = cloudUsage.errorMessage {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                // Free users - show usage bar and limits
                VStack(alignment: .leading, spacing: 8) {
                    // Progress bar
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(Color.secondary.opacity(contrast == .increased ? 0.4 : 0.2))

                            Capsule()
                                .fill(cloudUsageColor.gradient)
                                .frame(width: geometry.size.width * CGFloat(min(cloudUsage.usagePercentage, 1.0)))
                        }
                    }
                    .frame(height: contrast == .increased ? 12 : 10)

                    // Labels
                    HStack {
                        Text(cloudUsage.formattedUsageString)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        Spacer()

                        Text("\(cloudUsage.usagePercentageInt)%")
                            .font(.subheadline.bold())
                            .foregroundStyle(cloudUsageColor)
                    }
                }

                // Warning message if near limit
                if let warning = cloudUsage.warningMessage {
                    HStack(spacing: 8) {
                        Image(systemName: cloudUsage.warningLevel.iconName)
                            .foregroundStyle(Color(hex: cloudUsage.warningLevel.color))

                        Text(warning)
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Spacer()

                        if cloudUsage.isQuotaExceeded {
                            Button("Upgrade") {
                                cloudUsage.showUpgradePrompt = true
                            }
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color.blue.gradient)
                            .clipShape(Capsule())
                        }
                    }
                    .padding()
                    .background(Color(hex: cloudUsage.warningLevel.color).opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                // Quick stats for free users
                HStack(spacing: 16) {
                    VStack(alignment: .leading) {
                        Text("Remaining")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(estimatedMinutesRemainingDisplay)
                            .font(.subheadline.bold())
                    }

                    Divider()
                        .frame(height: 30)

                    VStack(alignment: .leading) {
                        Text("Characters Left")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(cloudUsage.formattedRemainingString)
                            .font(.subheadline.bold())
                    }

                    Spacer()
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(cloudUsageAccessibilityLabel)
    }

    private var cloudUsageColor: Color {
        if cloudUsage.isQuotaExceeded {
            return .red
        } else if cloudUsage.usagePercentage >= 0.9 {
            return .orange
        } else if cloudUsage.usagePercentage >= 0.8 {
            return .yellow
        } else {
            return .green
        }
    }

    private var cloudUsageAccessibilityLabel: String {
        if cloudUsage.isLoading {
            return "Cloud usage loading"
        }
        if isPremium {
            if cloudUsage.charUsed > 0 {
                return "Premium plan: Unlimited access. \(formatCharacterCount(cloudUsage.charUsed)) characters used this month."
            }
            return "Premium plan: Unlimited access."
        }
        if let error = cloudUsage.errorMessage {
            return "Cloud usage error: \(error)"
        }
        return "Cloud usage: \(cloudUsage.usagePercentageInt) percent. \(cloudUsage.formattedUsageString). \(estimatedMinutesRemainingDisplay) remaining."
    }

    // MARK: - Usage Gauges

    private var usageGauges: some View {
        Group {
            if useStackedLayout {
                // Vertical layout for accessibility sizes
                VStack(spacing: 16) {
                    gaugeContent
                }
            } else {
                // Horizontal layout for standard sizes
                HStack(spacing: 20) {
                    gaugeContent
                }
            }
        }
    }

    @ViewBuilder
    private var gaugeContent: some View {
        // Daily gauge - show unlimited for premium
        UsageGauge(
            title: "Today",
            used: usageTracker.quota.dailySummary.totalCharacters,
            limit: isPremium ? Int.max : usageTracker.quota.dailySummary.limit,
            percentage: isPremium ? 0 : usageTracker.dailyPercentage,
            warningLevel: isPremium ? .none : (usageTracker.quota.dailySummary.isAtSoftLimit ? .medium : .none)
        )

        // Monthly gauge - show unlimited for premium
        UsageGauge(
            title: "This Month",
            used: usageTracker.quota.monthlySummary.totalCharacters,
            limit: isPremium ? Int.max : usageTracker.quota.monthlySummary.limit,
            percentage: isPremium ? 0 : usageTracker.monthlyPercentage,
            warningLevel: isPremium ? .none : (usageTracker.quota.monthlySummary.isAtSoftLimit ? .medium : .none)
        )
    }

    // MARK: - Period Picker

    private var periodPicker: some View {
        Picker("Period", selection: $selectedPeriod) {
            Text("Daily").tag(UsagePeriod.daily)
            Text("Monthly").tag(UsagePeriod.monthly)
            Text("All Time").tag(UsagePeriod.allTime)
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Detailed Usage

    private var detailedUsage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Usage Details")
                .font(.headline)

            let summary = selectedPeriod == .daily
                ? usageTracker.getDailySummary()
                : usageTracker.getMonthlySummary()

            VStack(spacing: 12) {
                DetailRow(
                    title: "Characters Used",
                    value: summary.formattedTotal,
                    icon: "character.cursor.ibeam"
                )

                DetailRow(
                    title: "Requests Made",
                    value: "\(summary.totalRequests)",
                    icon: "arrow.up.circle"
                )

                DetailRow(
                    title: "Success Rate",
                    value: String(format: "%.1f%%", summary.successRate * 100),
                    icon: "checkmark.circle"
                )

                DetailRow(
                    title: "Remaining",
                    value: isPremium ? "Unlimited" : summary.formattedRemaining,
                    icon: "hourglass"
                )

                DetailRow(
                    title: "Est. Audio Time",
                    value: isPremium ? "Unlimited" : "\(summary.estimatedMinutesRemaining) min",
                    icon: "clock"
                )
            }
            .padding()
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))

            // Provider breakdown
            if !summary.charactersByProvider.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("By Provider")
                        .font(.subheadline.bold())

                    ForEach(Array(summary.charactersByProvider.keys), id: \.self) { provider in
                        if let chars = summary.charactersByProvider[provider] {
                            HStack {
                                Image(systemName: provider.iconName)
                                    .frame(width: 20)
                                Text(provider.displayName)
                                Spacer()
                                Text(formatCharacterCount(chars))
                                    .foregroundStyle(.secondary)
                            }
                            .font(.subheadline)
                        }
                    }
                }
                .padding()
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Statistics Section

    private var statisticsSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("All-Time Statistics")
                .font(.headline)

            let stats = usageTracker.getStatistics()

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                StatCard(
                    title: "Total Characters",
                    value: stats.formattedTotalCharacters,
                    icon: "character.cursor.ibeam"
                )

                StatCard(
                    title: "Total Requests",
                    value: "\(stats.totalRequestsAllTime)",
                    icon: "arrow.up.circle"
                )

                StatCard(
                    title: "Avg per Request",
                    value: formatCharacterCount(stats.averageCharactersPerRequest),
                    icon: "chart.bar"
                )

                StatCard(
                    title: "Est. Cost",
                    value: stats.formattedEstimatedCost,
                    icon: "dollarsign.circle"
                )
            }
        }
    }

    // MARK: - Recent History Section

    private var recentHistorySection: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Recent Activity")
                    .font(.headline)

                Spacer()

                NavigationLink("See All") {
                    UsageHistoryView()
                }
                .font(.subheadline)
            }

            let history = usageTracker.getHistory(limit: 5)

            if history.isEmpty {
                Text("No recent activity")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding()
            } else {
                VStack(spacing: 0) {
                    ForEach(history) { record in
                        UsageHistoryRow(record: record)

                        if record.id != history.last?.id {
                            Divider()
                                .padding(.leading, 44)
                        }
                    }
                }
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

// MARK: - Usage Gauge

struct UsageGauge: View {
    let title: String
    let used: Int
    let limit: Int
    let percentage: Float
    let warningLevel: WarningLevel

    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.sizeCategory) private var sizeCategory
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var color: Color {
        // Use higher contrast colors in increased contrast mode
        if contrast == .increased {
            return highContrastColor
        }
        return Color(hex: warningLevel.color)
    }

    private var highContrastColor: Color {
        switch warningLevel {
        case .none, .low: return .green
        case .medium: return .yellow
        case .high: return .orange
        case .critical: return .red
        }
    }

    private var isUnlimited: Bool {
        limit == Int.max
    }

    private var lineWidth: CGFloat {
        contrast == .increased ? 12 : 10
    }

    private var gaugeSize: CGFloat {
        sizeCategory.isAccessibilityCategory ? 120 : 100
    }

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                // Background circle
                Circle()
                    .stroke(
                        Color.secondary.opacity(contrast == .increased ? 0.4 : 0.2),
                        lineWidth: lineWidth
                    )

                // Progress circle
                Circle()
                    .trim(from: 0, to: CGFloat(min(percentage, 1.0)))
                    .stroke(
                        color.gradient,
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                    .animation(reduceMotion ? nil : .easeInOut, value: percentage)

                // Center content
                VStack(spacing: 2) {
                    if isUnlimited {
                        Image(systemName: "infinity")
                            .font(.title2)
                            .accessibilityHidden(true)
                    } else {
                        Text("\(Int(percentage * 100))%")
                            .font(.title2.bold())
                    }

                    Text(formatCharacterCount(used))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: gaugeSize, height: gaugeSize)

            VStack(spacing: 2) {
                Text(title)
                    .font(.subheadline.bold())

                if !isUnlimited {
                    Text("of \(formatCharacterCount(limit))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(accessibilityValue)
    }

    private var accessibilityLabel: String {
        "\(title) usage"
    }

    private var accessibilityValue: String {
        if isUnlimited {
            return "\(used.accessibleCharacterCount) used. No limit."
        }
        let percentInt = Int(percentage * 100)
        return "\(percentInt) percent. \(used.accessibleCharacterCount) of \(limit.accessibleCharacterCount)"
    }
}

// MARK: - Detail Row

struct DetailRow: View {
    let title: String
    let value: String
    let icon: String

    var body: some View {
        HStack {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 24)
                .accessibilityHidden(true)

            Text(title)
                .foregroundStyle(.secondary)

            Spacer()

            Text(value)
                .fontWeight(.medium)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value)")
    }
}

// MARK: - Stat Card

struct StatCard: View {
    let title: String
    let value: String
    let icon: String

    @Environment(\.sizeCategory) private var sizeCategory

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.blue)
                .accessibilityHidden(true)

            Text(value)
                .font(.title3.bold())
                .minimumScaleFactor(sizeCategory.isAccessibilityCategory ? 0.7 : 0.9)

            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title): \(value)")
    }
}

// MARK: - Usage History Row

struct UsageHistoryRow: View {
    let record: UsageRecord

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: record.provider.iconName)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(Color(.tertiarySystemBackground))
                .clipShape(Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(record.articleTitle ?? "Synthesis")
                    .font(.subheadline)
                    .lineLimit(1)

                Text(record.formattedTimestamp)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(record.formattedCharacterCount)
                    .font(.subheadline.bold())

                if !record.wasSuccessful {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityHidden(true)
                }
            }
        }
        .padding()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var label = record.articleTitle ?? "Synthesis"
        label += ". \(record.characterCount.accessibleCharacterCount)"
        label += ". \(record.formattedTimestamp)"
        label += ". Provider: \(record.provider.displayName)"
        if !record.wasSuccessful {
            label += ". Failed"
        }
        return label
    }
}

// MARK: - Usage History View

struct UsageHistoryView: View {
    @StateObject private var usageTracker = UsageTrackerService.shared

    var body: some View {
        List {
            ForEach(usageTracker.getHistory(limit: 100)) { record in
                UsageHistoryRow(record: record)
                    .listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.plain)
        .navigationTitle("Usage History")
    }
}

// MARK: - Compact Quota Display

/// Compact quota indicator for toolbar or status bar.
struct CompactQuotaDisplay: View {
    @StateObject private var usageTracker = UsageTrackerService.shared
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(spacing: 6) {
            // Progress ring
            ZStack {
                Circle()
                    .stroke(
                        Color.secondary.opacity(contrast == .increased ? 0.4 : 0.2),
                        lineWidth: contrast == .increased ? 4 : 3
                    )

                Circle()
                    .trim(from: 0, to: CGFloat(min(usageTracker.usageProgress, 1.0)))
                    .stroke(
                        progressColor.gradient,
                        style: StrokeStyle(
                            lineWidth: contrast == .increased ? 4 : 3,
                            lineCap: .round
                        )
                    )
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 20, height: 20)
            .accessibilityHidden(true)

            Text(usageTracker.remainingDisplay)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Usage quota")
        .accessibilityValue(accessibilityValue)
    }

    private var progressColor: Color {
        if usageTracker.usageProgress >= 1.0 {
            return .red
        } else if usageTracker.usageProgress >= 0.8 {
            return .orange
        } else {
            return .green
        }
    }

    private var accessibilityValue: String {
        let percent = Int(usageTracker.usageProgress * 100)
        return "\(percent) percent used. \(usageTracker.remainingDisplay)"
    }
}

// MARK: - Quota Status Badge

/// Badge showing quota status.
struct QuotaStatusBadge: View {
    @StateObject private var usageTracker = UsageTrackerService.shared
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            Text(statusText)
                .font(.caption)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(statusColor.opacity(contrast == .increased ? 0.25 : 0.15))
        .clipShape(Capsule())
        .overlay(
            Capsule()
                .stroke(contrast == .increased ? statusColor : Color.clear, lineWidth: 1)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Quota status: \(statusText)")
        .accessibilityAddTraits(usageTracker.quota.warningLevel >= .high ? .updatesFrequently : [])
    }

    private var statusColor: Color {
        switch usageTracker.quota.warningLevel {
        case .none, .low: return .green
        case .medium: return .yellow
        case .high: return .orange
        case .critical: return .red
        }
    }

    private var statusText: String {
        if usageTracker.quota.dailySummary.isOverLimit {
            return "Limit Reached"
        } else if usageTracker.quota.dailySummary.isAtSoftLimit {
            return "Low Quota"
        } else {
            return "Available"
        }
    }
}

// MARK: - Upgrade Prompt View

/// Paywall view for subscription purchases using StoreKit2.
struct UpgradePromptView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var storeManager = StoreKitManager.shared
    @State private var isPurchasing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Header
                    VStack(spacing: 16) {
                        Image(systemName: "crown.fill")
                            .font(.system(size: 60))
                            .foregroundStyle(.yellow.gradient)

                        Text("Go Premium")
                            .font(.largeTitle.bold())

                        Text("Unlimited cloud voices and characters")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 20)

                    // Features list
                    VStack(alignment: .leading, spacing: 12) {
                        FeatureRow(icon: "waveform", text: "All premium AI voices")
                        FeatureRow(icon: "infinity", text: "Unlimited characters")
                        FeatureRow(icon: "icloud.fill", text: "Cloud sync across devices")
                        FeatureRow(icon: "bolt.fill", text: "Priority processing")
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .padding(.horizontal)

                    // Subscription options
                    VStack(spacing: 12) {
                        // Annual plan (best value)
                        if let annualProduct = storeManager.product(for: .annual) {
                            SubscriptionCard(
                                product: annualProduct,
                                isSelected: true,
                                badge: "SAVE 90%",
                                isPurchasing: isPurchasing
                            ) {
                                await purchase(annualProduct)
                            }
                        } else {
                            SubscriptionCardPlaceholder(
                                name: "Annual",
                                price: "$39.99/year",
                                isSelected: true,
                                badge: "SAVE 90%"
                            )
                        }

                        // Weekly plan
                        if let weeklyProduct = storeManager.product(for: .weekly) {
                            SubscriptionCard(
                                product: weeklyProduct,
                                isSelected: false,
                                badge: nil,
                                isPurchasing: isPurchasing
                            ) {
                                await purchase(weeklyProduct)
                            }
                        } else {
                            SubscriptionCardPlaceholder(
                                name: "Weekly",
                                price: "$7.99/week",
                                isSelected: false,
                                badge: nil
                            )
                        }
                    }
                    .padding(.horizontal)

                    // Free tier info
                    Text("Free users get 5 minutes of cloud voice usage")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    // Restore purchases
                    Button {
                        Task {
                            await storeManager.restorePurchases()
                            if storeManager.isPremium {
                                dismiss()
                            }
                        }
                    } label: {
                        if storeManager.isLoading && !isPurchasing {
                            ProgressView()
                                .scaleEffect(0.8)
                        } else {
                            Text("Restore Purchases")
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .disabled(storeManager.isLoading)

                    // Terms and privacy
                    VStack(spacing: 4) {
                        Text("Subscription auto-renews. Cancel anytime.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)

                        HStack(spacing: 16) {
                            Link("Terms", destination: URL(string: "https://kreativekoala.llc/terms")!)
                            Link("Privacy", destination: URL(string: "https://kreativekoala.llc/privacy")!)
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.bottom, 20)
                }
            }
            .navigationTitle("Upgrade")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
            .alert("Error", isPresented: $storeManager.showError) {
                Button("OK", role: .cancel) { }
            } message: {
                Text(storeManager.errorMessage ?? "An error occurred")
            }
            .task {
                if storeManager.products.isEmpty {
                    await storeManager.loadProducts()
                }
            }
        }
    }

    private func purchase(_ product: Product) async {
        isPurchasing = true

        do {
            try await storeManager.purchase(product)
            // Purchase successful - dismiss the paywall
            isPurchasing = false
            dismiss()
        } catch StoreError.userCancelled {
            // User cancelled, do nothing
            isPurchasing = false
        } catch {
            // Error handled by StoreKitManager
            isPurchasing = false
        }
    }
}

// MARK: - Feature Row

private struct FeatureRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.blue)
                .frame(width: 24)

            Text(text)
                .font(.subheadline)
        }
    }
}

// MARK: - Subscription Card

private struct SubscriptionCard: View {
    let product: Product
    let isSelected: Bool
    let badge: String?
    let isPurchasing: Bool
    let onPurchase: () async -> Void

    var body: some View {
        Button {
            Task {
                await onPurchase()
            }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(product.isAnnual ? "Annual" : "Weekly")
                            .font(.headline)

                        if let badge = badge {
                            Text(badge)
                                .font(.caption2.bold())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(Color.orange.gradient)
                                .clipShape(Capsule())
                        }
                    }

                    Text(product.displayPrice + (product.isAnnual ? "/year" : "/week"))
                        .font(.title3.bold())
                        .foregroundStyle(isSelected ? .blue : .primary)

                    if product.isAnnual {
                        Text("Just $0.77/week")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if isPurchasing {
                    ProgressView()
                } else {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title2)
                        .foregroundStyle(isSelected ? .blue : .secondary)
                }
            }
            .padding()
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? Color.blue : Color.clear, lineWidth: 2)
            )
        }
        .buttonStyle(.plain)
        .disabled(isPurchasing)
    }
}

// MARK: - Subscription Card Placeholder

private struct SubscriptionCardPlaceholder: View {
    let name: String
    let price: String
    let isSelected: Bool
    let badge: String?

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(name)
                        .font(.headline)

                    if let badge = badge {
                        Text(badge)
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Color.orange.gradient)
                            .clipShape(Capsule())
                    }
                }

                Text(price)
                    .font(.title3.bold())
                    .foregroundStyle(isSelected ? .blue : .primary)
            }

            Spacer()

            ProgressView()
                .scaleEffect(0.8)
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(isSelected ? Color.blue : Color.clear, lineWidth: 2)
        )
    }
}

// MARK: - Quota Exceeded Alert View

/// Alert view shown when quota is exceeded during synthesis.
struct QuotaExceededAlertView: View {
    @ObservedObject var usageViewModel: UsageViewModel
    @Binding var isPresented: Bool
    var onUseOnDevice: (() -> Void)?
    var onUpgrade: (() -> Void)?

    var body: some View {
        VStack(spacing: 24) {
            // Icon
            Image(systemName: "xmark.octagon.fill")
                .font(.system(size: 50))
                .foregroundStyle(.red)

            // Title
            Text("Quota Exceeded")
                .font(.title2.bold())

            // Message
            Text(UsageViewModel.quotaExceededMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            // Usage info
            VStack(spacing: 8) {
                Text("Monthly Usage")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text(usageViewModel.compactUsageString)
                    .font(.title3.bold())
            }
            .padding()
            .frame(maxWidth: .infinity)
            .background(Color(.tertiarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))

            // Actions
            VStack(spacing: 12) {
                Button(action: {
                    isPresented = false
                    onUpgrade?()
                }) {
                    HStack {
                        Image(systemName: "crown.fill")
                        Text("Upgrade Plan")
                    }
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.blue.gradient)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                if onUseOnDevice != nil {
                    Button(action: {
                        isPresented = false
                        onUseOnDevice?()
                    }) {
                        HStack {
                            Image(systemName: "iphone")
                            Text("Use On-Device Voice")
                        }
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.secondary.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                }

                Button("Cancel") {
                    isPresented = false
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
        }
        .padding(24)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .shadow(color: .black.opacity(0.2), radius: 20, y: 10)
        .padding(.horizontal, 32)
    }
}

// MARK: - Preview

#Preview {
    UsageQuotaView()
}
