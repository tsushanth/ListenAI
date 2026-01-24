import SwiftUI

// MARK: - Mini Player View

/// Compact player bar that appears at the bottom of the screen.
/// Supports both traditional AudioPlaybackService and URLAudioPlayer.
struct MiniPlayerView: View {

    @ObservedObject var playbackService: AudioPlaybackService
    @ObservedObject var urlPlayer = URLAudioPlayer.shared
    @State private var showFullPlayer = false

    /// Whether any playback is active (from either player)
    private var hasActivePlayback: Bool {
        playbackService.currentItem != nil || urlPlayer.currentArticleID != nil
    }

    /// Whether using URL player (job-based) vs traditional playback
    private var isUsingURLPlayer: Bool {
        urlPlayer.currentArticleID != nil && urlPlayer.state.isActive
    }

    var body: some View {
        if hasActivePlayback {
            VStack(spacing: 0) {
                // Progress bar at top (like reference)
                progressBar

                // Mini player content
                HStack(spacing: 12) {
                    // Artwork (rounded like reference)
                    artworkView
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                    // Track info with time remaining
                    trackInfoView

                    Spacer()

                    // Controls (play/pause and close button like reference)
                    controlsView
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color(.systemBackground))
            }
            .contentShape(Rectangle())
            .onTapGesture {
                showFullPlayer = true
            }
            .sheet(isPresented: $showFullPlayer) {
                AudioPlayerView(playbackService: playbackService)
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: - Subviews

    private var progressBar: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                // Background
                Rectangle()
                    .fill(Color(.systemGray5))

                // Progress - use URL player if active, otherwise traditional
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: geometry.size.width * currentProgress)
            }
        }
        .frame(height: 2)
    }

    private var currentProgress: Double {
        if isUsingURLPlayer {
            guard urlPlayer.duration > 0 else { return 0 }
            return urlPlayer.currentTime / urlPlayer.duration
        }
        return playbackService.progress.progress
    }

    private var artworkView: some View {
        Group {
            if let artworkURL = playbackService.currentItem?.artworkURL {
                AsyncImage(url: artworkURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    default:
                        artworkPlaceholder
                    }
                }
            } else {
                artworkPlaceholder
            }
        }
    }

    private var artworkPlaceholder: some View {
        ZStack {
            Color(playbackService.currentItem?.artworkColor ?? .blue)

            Image(systemName: "headphones")
                .font(.title3)
                .foregroundColor(.white.opacity(0.8))
        }
    }

    private var trackInfoView: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(currentTitle)
                .font(.subheadline)
                .fontWeight(.medium)
                .lineLimit(1)

            // Show time remaining like reference
            Text(remainingTimeText)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(1)
        }
    }

    private var currentTitle: String {
        if isUsingURLPlayer {
            // Get article title from ArticleStore using the current article ID
            if let articleId = urlPlayer.currentArticleID,
               let article = ArticleStore.shared.article(withID: articleId) {
                return article.displayTitle
            }
            return "Playing..."
        }
        return playbackService.currentItem?.title ?? ""
    }

    private var remainingTimeText: String {
        let remaining: TimeInterval
        if isUsingURLPlayer {
            remaining = urlPlayer.duration - urlPlayer.currentTime
        } else {
            remaining = playbackService.progress.duration - playbackService.progress.currentTime
        }
        let minutes = Int(remaining / 60)
        if minutes < 1 {
            return "< 1 m left"
        } else {
            return "\(minutes) m left"
        }
    }

    private var controlsView: some View {
        HStack(spacing: 16) {
            // Play/Pause button
            Button {
                if isUsingURLPlayer {
                    urlPlayer.togglePlayPause()
                } else {
                    playbackService.togglePlayPause()
                }
            } label: {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.title2)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)

            // Close button (X) like reference
            Button {
                if isUsingURLPlayer {
                    urlPlayer.stop()
                } else {
                    Task {
                        await playbackService.stop()
                    }
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.systemGray5))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
    }

    private var isPlaying: Bool {
        if isUsingURLPlayer {
            return urlPlayer.isPlaying
        }
        return playbackService.state.isPlaying
    }
}

// MARK: - Floating Mini Player

/// A floating mini player that can be placed at the bottom of any view.
struct FloatingMiniPlayer: View {

    @ObservedObject var playbackService: AudioPlaybackService

    var body: some View {
        VStack {
            Spacer()

            MiniPlayerView(playbackService: playbackService)
                .shadow(color: .black.opacity(0.1), radius: 8, y: -2)
        }
        .animation(.spring(response: 0.3), value: playbackService.currentItem != nil)
    }
}

// MARK: - Player Container

/// Container view that wraps content with a mini player at the bottom.
struct PlayerContainerView<Content: View>: View {

    @ObservedObject var playbackService: AudioPlaybackService
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack(alignment: .bottom) {
            content()
                .padding(.bottom, playbackService.currentItem != nil ? 70 : 0)

            MiniPlayerView(playbackService: playbackService)
        }
    }
}

// MARK: - Compact Player Controls

/// Even more compact controls for use in navigation bars or small spaces.
struct CompactPlayerControls: View {

    @ObservedObject var playbackService: AudioPlaybackService

    var body: some View {
        HStack(spacing: 16) {
            // Progress indicator
            CircularProgressView(progress: playbackService.progress.progress)
                .frame(width: 32, height: 32)
                .overlay {
                    Button {
                        playbackService.togglePlayPause()
                    } label: {
                        Image(systemName: playbackService.state.isPlaying ? "pause.fill" : "play.fill")
                            .font(.caption)
                    }
                }
        }
    }
}

// MARK: - Circular Progress View

struct CircularProgressView: View {
    let progress: Double

    /// Safely bounded progress value to prevent NaN/Infinity issues
    private var safeProgress: Double {
        let value = progress.isNaN || progress.isInfinite ? 0 : progress
        return min(max(value, 0), 1)
    }

    var body: some View {
        ZStack {
            // Background circle
            Circle()
                .stroke(Color(.systemGray5), lineWidth: 3)

            // Progress arc
            Circle()
                .trim(from: 0, to: safeProgress)
                .stroke(
                    Color.accentColor,
                    style: StrokeStyle(lineWidth: 3, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.1), value: safeProgress)
        }
    }
}

// MARK: - Waveform Animation View

struct WaveformAnimationView: View {
    let isAnimating: Bool
    let barCount: Int = 4

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<barCount, id: \.self) { index in
                WaveformBar(isAnimating: isAnimating, delay: Double(index) * 0.1)
            }
        }
    }
}

struct WaveformBar: View {
    let isAnimating: Bool
    let delay: Double

    @State private var height: CGFloat = 0.3

    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.accentColor)
            .frame(width: 3)
            .scaleEffect(y: height, anchor: .bottom)
            .animation(
                isAnimating ?
                    .easeInOut(duration: 0.4)
                    .repeatForever(autoreverses: true)
                    .delay(delay) :
                    .default,
                value: height
            )
            .onAppear {
                if isAnimating {
                    height = 1.0
                }
            }
            .onChange(of: isAnimating) { _, animating in
                height = animating ? 1.0 : 0.3
            }
    }
}

// MARK: - Now Playing Indicator

/// Small indicator showing current playback state.
struct NowPlayingIndicator: View {

    @ObservedObject var playbackService: AudioPlaybackService

    var body: some View {
        if playbackService.currentItem != nil {
            HStack(spacing: 8) {
                WaveformAnimationView(isAnimating: playbackService.state.isPlaying)
                    .frame(width: 20, height: 16)

                VStack(alignment: .leading, spacing: 0) {
                    Text(playbackService.currentItem?.title ?? "")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .lineLimit(1)

                    Text(playbackService.progress.currentTime.formattedDuration)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(.systemGray6))
            .clipShape(Capsule())
        }
    }
}

// MARK: - Preview

#Preview("Mini Player") {
    VStack {
        Spacer()
        MiniPlayerView(playbackService: AudioPlaybackService.shared)
    }
}

#Preview("Waveform") {
    WaveformAnimationView(isAnimating: true)
        .frame(width: 30, height: 20)
}
