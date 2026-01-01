import SwiftUI

// MARK: - Usage Quota View

/// Main view displaying usage quota and statistics.
struct UsageQuotaView: View {
    @StateObject private var usageTracker = UsageTrackerService.shared
    @State private var selectedPeriod: UsagePeriod = .daily

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Current tier card
                    tierCard

                    // Usage gauges
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
                        Button(action: {}) {
                            Label("Upgrade Plan", systemImage: "arrow.up.circle")
                        }

                        Button(action: {}) {
                            Label("View Pricing", systemImage: "dollarsign.circle")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
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

                Text(usageTracker.currentTier.displayName)
                    .font(.title2.bold())

                if usageTracker.currentTier != .unlimited {
                    Text("\(formatCharacterCount(usageTracker.currentTier.monthlyLimit)) chars/month")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if usageTracker.currentTier != .unlimited {
                Button(action: {}) {
                    Text("Upgrade")
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.blue.gradient)
                        .clipShape(Capsule())
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Usage Gauges

    private var usageGauges: some View {
        HStack(spacing: 20) {
            // Daily gauge
            UsageGauge(
                title: "Today",
                used: usageTracker.quota.dailySummary.totalCharacters,
                limit: usageTracker.quota.dailySummary.limit,
                percentage: usageTracker.dailyPercentage,
                warningLevel: usageTracker.quota.dailySummary.isAtSoftLimit ? .medium : .none
            )

            // Monthly gauge
            UsageGauge(
                title: "This Month",
                used: usageTracker.quota.monthlySummary.totalCharacters,
                limit: usageTracker.quota.monthlySummary.limit,
                percentage: usageTracker.monthlyPercentage,
                warningLevel: usageTracker.quota.monthlySummary.isAtSoftLimit ? .medium : .none
            )
        }
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
                    value: summary.formattedRemaining,
                    icon: "hourglass"
                )

                DetailRow(
                    title: "Est. Audio Time",
                    value: "\(summary.estimatedMinutesRemaining) min",
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

    private var color: Color {
        Color(hex: warningLevel.color)
    }

    private var isUnlimited: Bool {
        limit == Int.max
    }

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                // Background circle
                Circle()
                    .stroke(Color.secondary.opacity(0.2), lineWidth: 10)

                // Progress circle
                Circle()
                    .trim(from: 0, to: CGFloat(min(percentage, 1.0)))
                    .stroke(
                        color.gradient,
                        style: StrokeStyle(lineWidth: 10, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                    .animation(.easeInOut, value: percentage)

                // Center content
                VStack(spacing: 2) {
                    if isUnlimited {
                        Image(systemName: "infinity")
                            .font(.title2)
                    } else {
                        Text("\(Int(percentage * 100))%")
                            .font(.title2.bold())
                    }

                    Text(formatCharacterCount(used))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 100, height: 100)

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

            Text(title)
                .foregroundStyle(.secondary)

            Spacer()

            Text(value)
                .fontWeight(.medium)
        }
        .font(.subheadline)
    }
}

// MARK: - Stat Card

struct StatCard: View {
    let title: String
    let value: String
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.blue)

            Text(value)
                .font(.title3.bold())

            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
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
                }
            }
        }
        .padding()
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

    var body: some View {
        HStack(spacing: 6) {
            // Progress ring
            ZStack {
                Circle()
                    .stroke(Color.secondary.opacity(0.2), lineWidth: 3)

                Circle()
                    .trim(from: 0, to: CGFloat(min(usageTracker.usageProgress, 1.0)))
                    .stroke(
                        progressColor.gradient,
                        style: StrokeStyle(lineWidth: 3, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 20, height: 20)

            Text(usageTracker.remainingDisplay)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
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
}

// MARK: - Quota Status Badge

/// Badge showing quota status.
struct QuotaStatusBadge: View {
    @StateObject private var usageTracker = UsageTrackerService.shared

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            Text(statusText)
                .font(.caption)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(statusColor.opacity(0.15))
        .clipShape(Capsule())
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

// MARK: - Preview

#Preview {
    UsageQuotaView()
}
