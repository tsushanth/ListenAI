import SwiftUI

// MARK: - Rewards View

/// View showing user's rewards from shared voices.
struct RewardsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = RewardsViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Summary cards
                summaryCardsSection

                Divider()
                    .padding(.horizontal)

                // Credit button
                if viewModel.pendingMinutes > 0 {
                    creditSection
                }

                // History
                historySection
            }
            .padding(.vertical)
        }
        .navigationTitle("Rewards")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
        .task {
            await viewModel.load()
        }
        .refreshable {
            await viewModel.load()
        }
        .alert("Rewards Credited", isPresented: $viewModel.showCreditSuccess) {
            Button("OK") {}
        } message: {
            Text("Successfully credited \(String(format: "%.2f", viewModel.lastCreditedMinutes)) minutes to your account!")
        }
        .alert("Error", isPresented: $viewModel.showError) {
            Button("OK") {}
        } message: {
            Text(viewModel.errorMessage)
        }
    }

    // MARK: - Summary Cards

    private var summaryCardsSection: some View {
        VStack(spacing: 16) {
            // Pending rewards
            RewardSummaryCard(
                title: "Pending Rewards",
                value: String(format: "%.2f", viewModel.pendingMinutes),
                unit: "minutes",
                subtitle: "\(viewModel.pendingCount) transactions",
                iconName: "clock.fill",
                iconColor: .orange,
                backgroundColor: Color.orange.opacity(0.1)
            )

            // Total earned
            RewardSummaryCard(
                title: "Total Earned",
                value: String(format: "%.2f", viewModel.totalCreditedMinutes),
                unit: "minutes",
                subtitle: "All time",
                iconName: "gift.fill",
                iconColor: .green,
                backgroundColor: Color.green.opacity(0.1)
            )
        }
        .padding(.horizontal)
    }

    // MARK: - Credit Section

    private var creditSection: some View {
        VStack(spacing: 12) {
            Button {
                Task { await viewModel.creditRewards() }
            } label: {
                HStack {
                    if viewModel.isClaiming {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: "arrow.down.circle.fill")
                    }

                    Text(viewModel.isClaiming ? "Claiming..." : "Claim \(String(format: "%.2f", viewModel.pendingMinutes)) Minutes")
                        .fontWeight(.semibold)
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Color.blue)
                .cornerRadius(12)
            }
            .disabled(viewModel.isClaiming)

            Text("Add pending minutes to your account quota")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal)
    }

    // MARK: - History Section

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Reward History")
                .font(.headline)
                .padding(.horizontal)

            if viewModel.isLoading && viewModel.history.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .padding(.vertical, 32)
            } else if viewModel.history.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "tray")
                        .font(.title)
                        .foregroundStyle(.secondary)

                    Text("No rewards yet")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Text("Share your voice and earn rewards when others use it!")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
            } else {
                LazyVStack(spacing: 1) {
                    ForEach(viewModel.history) { entry in
                        RewardHistoryRow(entry: entry)
                    }
                }
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)
                .padding(.horizontal)
            }
        }
    }
}

// MARK: - Reward Summary Card

private struct RewardSummaryCard: View {
    let title: String
    let value: String
    let unit: String
    let subtitle: String
    let iconName: String
    let iconColor: Color
    let backgroundColor: Color

    var body: some View {
        HStack(spacing: 16) {
            // Icon
            ZStack {
                Circle()
                    .fill(backgroundColor)
                    .frame(width: 56, height: 56)

                Image(systemName: iconName)
                    .font(.title2)
                    .foregroundStyle(iconColor)
            }

            // Info
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    Text(value)
                        .font(.title.bold())

                    Text(unit)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Spacer()
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .cornerRadius(16)
    }
}

// MARK: - Reward History Row

private struct RewardHistoryRow: View {
    let entry: VoiceMarketplaceService.RewardHistoryEntry

    var body: some View {
        HStack(spacing: 12) {
            // Status icon
            ZStack {
                Circle()
                    .fill(entry.credited ? Color.green.opacity(0.1) : Color.orange.opacity(0.1))
                    .frame(width: 40, height: 40)

                Image(systemName: entry.credited ? "checkmark.circle.fill" : "clock.fill")
                    .foregroundStyle(entry.credited ? .green : .orange)
            }

            // Info
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.voiceName)
                    .font(.subheadline.weight(.medium))

                Text("\(entry.charactersGenerated) chars • \(Int(entry.secondsGenerated))s")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Reward amount
            VStack(alignment: .trailing, spacing: 2) {
                Text("+\(String(format: "%.3f", entry.rewardMinutes))")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(entry.credited ? .green : .primary)

                Text("min")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            // Date
            Text(entry.createdAt.formatted(.relative(presentation: .numeric)))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: 50, alignment: .trailing)
        }
        .padding()
        .background(Color(.systemBackground))
    }
}

// MARK: - View Model

@MainActor
class RewardsViewModel: ObservableObject {
    @Published var pendingMinutes: Double = 0
    @Published var pendingCount: Int = 0
    @Published var totalCreditedMinutes: Double = 0
    @Published var history: [VoiceMarketplaceService.RewardHistoryEntry] = []
    @Published var isLoading = false
    @Published var isClaiming = false
    @Published var showError = false
    @Published var errorMessage = ""
    @Published var showCreditSuccess = false
    @Published var lastCreditedMinutes: Double = 0

    func load() async {
        isLoading = true
        defer { isLoading = false }

        do {
            // Load summary
            let summary = try await VoiceMarketplaceService.shared.getRewardsSummary()
            pendingMinutes = summary.pending.minutes
            pendingCount = summary.pending.count
            totalCreditedMinutes = summary.credited.totalMinutes

            // Load history
            history = try await VoiceMarketplaceService.shared.getRewardHistory()
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }

    func creditRewards() async {
        isClaiming = true
        defer { isClaiming = false }

        do {
            let credited = try await VoiceMarketplaceService.shared.creditRewards()
            lastCreditedMinutes = credited
            showCreditSuccess = true

            // Refresh data
            await load()
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        RewardsView()
    }
}
