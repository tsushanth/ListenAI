import SwiftUI
import AVFoundation

// MARK: - Voice Marketplace View

/// Main marketplace view for browsing and discovering shared community voices.
struct VoiceMarketplaceView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = VoiceMarketplaceViewModel()

    @State private var searchText = ""
    @State private var selectedSort: VoiceMarketplaceService.SortOption = .popular
    @State private var showingShareSheet = false
    @State private var showingMyShares = false
    @State private var showingRewards = false
    @State private var selectedVoice: VoiceMarketplaceService.SharedVoice?
    @State private var pendingRewards: Double = 0
    @State private var hasSharedVoices = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Search bar and filters
                VStack(spacing: 12) {
                    // Search
                    HStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)

                        TextField("Search voices...", text: $searchText)
                            .textInputAutocapitalization(.never)
                            .onSubmit {
                                Task { await viewModel.search(query: searchText) }
                            }

                        if !searchText.isEmpty {
                            Button {
                                searchText = ""
                                Task { await viewModel.load() }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(10)

                    // Sort options
                    HStack(spacing: 8) {
                        ForEach(VoiceMarketplaceService.SortOption.allCases, id: \.self) { option in
                            SortChip(
                                title: option.displayName,
                                isSelected: selectedSort == option
                            ) {
                                selectedSort = option
                                Task { await viewModel.load(sort: option) }
                            }
                        }
                        Spacer()
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 12)

                Divider()

                // Rewards banner (show if user has pending rewards OR has shared voices)
                if pendingRewards > 0 || hasSharedVoices {
                    rewardsBanner
                        .padding(.horizontal)
                        .padding(.top, 8)
                }

                // Content
                if viewModel.isLoading && viewModel.voices.isEmpty {
                    loadingView
                } else if viewModel.voices.isEmpty {
                    emptyView
                } else {
                    voiceListView
                }
            }
            .navigationTitle("Voice Marketplace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.body)
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            showingShareSheet = true
                        } label: {
                            Label("Share Your Voice", systemImage: "square.and.arrow.up")
                        }

                        Button {
                            showingMyShares = true
                        } label: {
                            Label("My Shared Voices", systemImage: "person.crop.circle")
                        }

                        Button {
                            showingRewards = true
                        } label: {
                            Label("Rewards", systemImage: "gift.fill")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body)
                    }
                }
            }
            .task {
                await viewModel.load(sort: selectedSort)
                await loadRewardsStatus()
            }
            .refreshable {
                await viewModel.load(sort: selectedSort)
            }
            .alert("Error", isPresented: $viewModel.showError) {
                Button("OK") {}
            } message: {
                Text(viewModel.errorMessage)
            }
            .sheet(isPresented: $showingShareSheet) {
                NavigationStack {
                    ShareVoiceView()
                }
            }
            .sheet(isPresented: $showingMyShares) {
                NavigationStack {
                    MySharedVoicesView()
                }
            }
            .sheet(isPresented: $showingRewards) {
                NavigationStack {
                    RewardsView()
                }
            }
            .sheet(item: $selectedVoice) { voice in
                NavigationStack {
                    VoiceDetailView(voice: voice)
                }
            }
        }
    }

    // MARK: - Loading View

    private var loadingView: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
            Text("Loading voices...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }

    // MARK: - Empty View

    private var emptyView: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "waveform.circle")
                .font(.system(size: 64))
                .foregroundStyle(.secondary)

            VStack(spacing: 8) {
                Text("No Voices Found")
                    .font(.title2.bold())

                Text(searchText.isEmpty
                     ? "Be the first to share your voice with the community!"
                     : "Try a different search term")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if searchText.isEmpty {
                Button {
                    showingShareSheet = true
                } label: {
                    Text("Share Your Voice")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(Color.blue)
                        .cornerRadius(10)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 32)
    }

    // MARK: - Voice List View

    private var voiceListView: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(viewModel.voices) { voice in
                    SharedVoiceCard(
                        voice: voice,
                        isPlaying: viewModel.playingVoiceId == voice.id,
                        isLoading: viewModel.loadingVoiceId == voice.id,
                        onPlay: {
                            Task { await viewModel.playPreview(voice) }
                        },
                        onTap: {
                            selectedVoice = voice
                        }
                    )
                }

                if viewModel.hasMore {
                    Button {
                        Task { await viewModel.loadMore() }
                    } label: {
                        if viewModel.isLoading {
                            ProgressView()
                        } else {
                            Text("Load More")
                                .font(.subheadline)
                                .foregroundStyle(.blue)
                        }
                    }
                    .padding()
                }
            }
            .padding()
        }
    }

    // MARK: - Rewards Banner

    private var rewardsBanner: some View {
        Button {
            showingRewards = true
        } label: {
            HStack(spacing: 12) {
                // Icon
                ZStack {
                    Circle()
                        .fill(pendingRewards > 0 ? Color.orange.opacity(0.15) : Color.green.opacity(0.15))
                        .frame(width: 44, height: 44)

                    Image(systemName: pendingRewards > 0 ? "gift.fill" : "chart.line.uptrend.xyaxis")
                        .font(.title3)
                        .foregroundStyle(pendingRewards > 0 ? .orange : .green)
                }

                // Text
                VStack(alignment: .leading, spacing: 2) {
                    if pendingRewards > 0 {
                        Text("You have rewards to claim!")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)

                        Text("\(String(format: "%.2f", pendingRewards)) minutes waiting")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    } else {
                        Text("Your voices are earning")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)

                        Text("View your earnings and stats")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
            .background(Color(.secondarySystemBackground))
            .cornerRadius(12)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Load Rewards Status

    private func loadRewardsStatus() async {
        do {
            let summary = try await VoiceMarketplaceService.shared.getRewardsSummary()
            pendingRewards = summary.pending.minutes

            // Check if user has shared any voices
            let shares = try await VoiceMarketplaceService.shared.getMyShares()
            hasSharedVoices = shares.contains { $0.status == "active" }
        } catch {
            // Silently fail - banner just won't show
        }
    }
}

// MARK: - Sort Chip

private struct SortChip: View {
    let title: String
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(isSelected ? .white : .primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(isSelected ? Color.blue : Color(.secondarySystemBackground))
                .cornerRadius(16)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Shared Voice Card

private struct SharedVoiceCard: View {
    let voice: VoiceMarketplaceService.SharedVoice
    let isPlaying: Bool
    let isLoading: Bool
    let onPlay: () -> Void
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    // Avatar
                    voiceAvatar

                    // Info
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(voice.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)

                            if voice.isOwn {
                                Text("YOU")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.blue)
                                    .cornerRadius(4)
                            }
                        }

                        HStack(spacing: 8) {
                            // Rating
                            HStack(spacing: 2) {
                                Image(systemName: "star.fill")
                                    .foregroundStyle(.yellow)
                                Text(String(format: "%.1f", voice.avgRating))
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)

                            // Usage count
                            HStack(spacing: 2) {
                                Image(systemName: "play.fill")
                                Text("\(voice.usageCount)")
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()

                    // Play button
                    Button(action: onPlay) {
                        ZStack {
                            Circle()
                                .fill(Color.yellow)
                                .frame(width: 44, height: 44)

                            if isLoading {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .black))
                                    .scaleEffect(0.7)
                            } else {
                                Image(systemName: isPlaying ? "stop.fill" : "play.fill")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundStyle(.black)
                                    .offset(x: isPlaying ? 0 : 2)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }

                // Tags
                if !voice.tags.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(voice.tags.prefix(5), id: \.self) { tag in
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

                // Description preview
                if let description = voice.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding()
            .background(Color(.secondarySystemBackground))
            .cornerRadius(16)
        }
        .buttonStyle(.plain)
    }

    private var voiceAvatar: some View {
        ZStack {
            Circle()
                .fill(avatarGradient)
                .frame(width: 56, height: 56)

            Image(systemName: "waveform")
                .font(.title2)
                .foregroundStyle(.white)
        }
    }

    private var avatarGradient: LinearGradient {
        // Generate consistent color based on voice ID
        let hash = voice.id.hashValue
        let hue = Double(abs(hash) % 360) / 360.0
        let color = Color(hue: hue, saturation: 0.6, brightness: 0.8)
        return LinearGradient(
            colors: [color, color.opacity(0.7)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

// MARK: - View Model

@MainActor
class VoiceMarketplaceViewModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var voices: [VoiceMarketplaceService.SharedVoice] = []
    @Published var isLoading = false
    @Published var showError = false
    @Published var errorMessage = ""
    @Published var playingVoiceId: String?
    @Published var loadingVoiceId: String?
    @Published var hasMore = true

    private var audioPlayer: AVAudioPlayer?
    private var currentSort: VoiceMarketplaceService.SortOption = .popular
    private var currentSearch: String?
    private var offset = 0
    private let limit = 20

    func load(sort: VoiceMarketplaceService.SortOption = .popular) async {
        currentSort = sort
        currentSearch = nil
        offset = 0
        hasMore = true
        isLoading = true

        defer { isLoading = false }

        do {
            voices = try await VoiceMarketplaceService.shared.browse(
                sort: sort,
                limit: limit,
                offset: 0
            )
            hasMore = voices.count >= limit
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }

    func search(query: String) async {
        currentSearch = query.isEmpty ? nil : query
        offset = 0
        hasMore = true
        isLoading = true

        defer { isLoading = false }

        do {
            voices = try await VoiceMarketplaceService.shared.browse(
                search: currentSearch,
                sort: currentSort,
                limit: limit,
                offset: 0
            )
            hasMore = voices.count >= limit
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }

    func loadMore() async {
        guard !isLoading, hasMore else { return }

        offset += limit
        isLoading = true

        defer { isLoading = false }

        do {
            let newVoices = try await VoiceMarketplaceService.shared.browse(
                search: currentSearch,
                sort: currentSort,
                limit: limit,
                offset: offset
            )
            voices.append(contentsOf: newVoices)
            hasMore = newVoices.count >= limit
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }

    func playPreview(_ voice: VoiceMarketplaceService.SharedVoice) async {
        // Stop if already playing this voice
        if playingVoiceId == voice.id {
            stopPlayback()
            return
        }

        stopPlayback()

        guard let urlString = voice.previewAudioUrl,
              let url = URL(string: urlString) else {
            return
        }

        loadingVoiceId = voice.id

        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)

            let (data, _) = try await URLSession.shared.data(from: url)

            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("preview_\(voice.id).wav")
            try data.write(to: tempURL)

            audioPlayer = try AVAudioPlayer(contentsOf: tempURL)
            audioPlayer?.delegate = self
            audioPlayer?.prepareToPlay()
            audioPlayer?.play()

            loadingVoiceId = nil
            playingVoiceId = voice.id
        } catch {
            loadingVoiceId = nil
            errorMessage = "Failed to play preview"
            showError = true
        }
    }

    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        playingVoiceId = nil
        loadingVoiceId = nil
    }

    // MARK: - AVAudioPlayerDelegate

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.playingVoiceId = nil
        }
    }
}

// MARK: - Preview

#Preview {
    VoiceMarketplaceView()
}
