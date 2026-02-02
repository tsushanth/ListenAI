import SwiftUI

// MARK: - My Shared Voices View

/// View showing user's shared voices with stats and revoke option.
struct MySharedVoicesView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = MySharedVoicesViewModel()

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.shares.isEmpty {
                loadingView
            } else if viewModel.shares.isEmpty {
                emptyView
            } else {
                sharedVoicesListView
            }
        }
        .navigationTitle("My Shared Voices")
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
        .alert("Revoke Voice", isPresented: $viewModel.showRevokeConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Revoke", role: .destructive) {
                Task { await viewModel.confirmRevoke() }
            }
        } message: {
            Text("Are you sure you want to revoke this voice from the marketplace? It will no longer be available for others to use.")
        }
        .alert("Error", isPresented: $viewModel.showError) {
            Button("OK") {}
        } message: {
            Text(viewModel.errorMessage)
        }
        .alert("Success", isPresented: $viewModel.showSuccess) {
            Button("OK") {}
        } message: {
            Text("Voice has been revoked from the marketplace.")
        }
    }

    // MARK: - Loading View

    private var loadingView: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
            Text("Loading your shared voices...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }

    // MARK: - Empty View

    private var emptyView: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "square.and.arrow.up.circle")
                .font(.system(size: 64))
                .foregroundStyle(.secondary)

            VStack(spacing: 8) {
                Text("No Shared Voices")
                    .font(.title2.bold())

                Text("You haven't shared any voices to the marketplace yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer()
        }
        .padding(.horizontal, 32)
    }

    // MARK: - Shared Voices List View

    private var sharedVoicesListView: some View {
        List {
            ForEach(viewModel.shares) { share in
                MySharedVoiceRow(
                    share: share,
                    earnings: viewModel.getEarnings(for: share.id)
                ) {
                    viewModel.requestRevoke(share)
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

// MARK: - My Shared Voice Row

private struct MySharedVoiceRow: View {
    let share: VoiceMarketplaceService.MySharedVoice
    let earnings: Double
    let onRevoke: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                // Avatar
                ZStack {
                    Circle()
                        .fill(avatarGradient)
                        .frame(width: 50, height: 50)

                    Image(systemName: "waveform")
                        .font(.title3)
                        .foregroundStyle(.white)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(share.displayName)
                        .font(.body.weight(.semibold))

                    StatusBadge(status: share.status)
                }

                Spacer()

                if share.status == "active" {
                    Button(role: .destructive) {
                        onRevoke()
                    } label: {
                        Text("Revoke")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.red)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color.red.opacity(0.1))
                            .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                }
            }

            // Stats including earnings
            HStack(spacing: 12) {
                StatItem(icon: "star.fill", color: .yellow, value: String(format: "%.1f", share.avgRating), label: "rating")
                StatItem(icon: "play.fill", color: .blue, value: "\(share.usageCount)", label: "uses")
                StatItem(icon: "gift.fill", color: .green, value: String(format: "%.2f", earnings), label: "min earned")
            }

            // Tags
            if !share.tags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(share.tags.prefix(5), id: \.self) { tag in
                            Text(tag)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color(.tertiarySystemBackground))
                                .cornerRadius(8)
                        }
                    }
                }
            }

            // Revoked info
            if share.status == "revoked", let reason = share.revokedReason {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("Revoked: \(reason)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 4)
            }

            // Date
            Text("Shared \(share.createdAt.formatted(.relative(presentation: .named)))")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
    }

    private var avatarGradient: LinearGradient {
        let hash = share.id.hashValue
        let hue = Double(abs(hash) % 360) / 360.0
        let color = Color(hue: hue, saturation: 0.6, brightness: 0.8)
        return LinearGradient(
            colors: [color, color.opacity(0.7)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

// MARK: - Status Badge

private struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(statusText)
            .font(.caption2.weight(.medium))
            .foregroundStyle(statusColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(statusColor.opacity(0.15))
            .cornerRadius(4)
    }

    private var statusText: String {
        switch status {
        case "active": return "Active"
        case "pending_review": return "Pending Review"
        case "suspended": return "Suspended"
        case "revoked": return "Revoked"
        default: return status.capitalized
        }
    }

    private var statusColor: Color {
        switch status {
        case "active": return .green
        case "pending_review": return .orange
        case "suspended": return .red
        case "revoked": return .gray
        default: return .secondary
        }
    }
}

// MARK: - Stat Item

private struct StatItem: View {
    let icon: String
    let color: Color
    let value: String
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(color)
            Text(value)
                .font(.caption.weight(.medium))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - View Model

@MainActor
class MySharedVoicesViewModel: ObservableObject {
    @Published var shares: [VoiceMarketplaceService.MySharedVoice] = []
    @Published var earningsPerVoice: [String: Double] = [:]
    @Published var isLoading = false
    @Published var showError = false
    @Published var errorMessage = ""
    @Published var showSuccess = false
    @Published var showRevokeConfirmation = false

    private var shareToRevoke: VoiceMarketplaceService.MySharedVoice?

    func load() async {
        isLoading = true
        defer { isLoading = false }

        do {
            // Load shares and reward history in parallel
            async let sharesTask = VoiceMarketplaceService.shared.getMyShares()
            async let historyTask = VoiceMarketplaceService.shared.getRewardHistory(limit: 500)

            shares = try await sharesTask
            let history = try await historyTask

            // Aggregate earnings per voice
            var earnings: [String: Double] = [:]
            for entry in history {
                earnings[entry.sharedVoiceId, default: 0] += entry.rewardMinutes
            }
            earningsPerVoice = earnings
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }

    func getEarnings(for shareId: String) -> Double {
        earningsPerVoice[shareId] ?? 0
    }

    func requestRevoke(_ share: VoiceMarketplaceService.MySharedVoice) {
        shareToRevoke = share
        showRevokeConfirmation = true
    }

    func confirmRevoke() async {
        guard let share = shareToRevoke else { return }

        do {
            try await VoiceMarketplaceService.shared.revokeVoice(id: share.id)
            // Refresh the list
            await load()
            showSuccess = true
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }

        shareToRevoke = nil
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        MySharedVoicesView()
    }
}
