import SwiftUI

// Note: Accessibility extensions are defined in AccessibilityHelpers.swift

// MARK: - Audio Player View

/// Full-screen audio player view similar to podcast players.
struct AudioPlayerView: View {

    @ObservedObject var playbackService: AudioPlaybackService
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var isDraggingScrubber = false
    @State private var scrubberValue: Double = 0
    @State private var showSpeedPicker = false
    @State private var showSleepTimer = false
    @State private var showQueue = false

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                // Drag indicator
                dragIndicator

                // Artwork
                artworkView(size: geometry.size.width - 80)
                    .padding(.top, 20)

                Spacer()

                // Track info
                trackInfoView
                    .padding(.horizontal, 24)

                // Progress
                progressView
                    .padding(.horizontal, 24)
                    .padding(.top, 24)

                // Main controls
                mainControlsView
                    .padding(.top, 32)

                // Secondary controls
                secondaryControlsView
                    .padding(.top, 24)
                    .padding(.bottom, 40)
            }
            .background(Color(.systemBackground))
        }
        .sheet(isPresented: $showSpeedPicker) {
            SpeedPickerView(
                currentSpeed: playbackService.playbackSpeed,
                onSelect: { speed in
                    playbackService.setPlaybackSpeed(speed)
                    showSpeedPicker = false
                }
            )
            .presentationDetents([.height(400)])
        }
        .sheet(isPresented: $showSleepTimer) {
            SleepTimerView(
                currentTimer: playbackService.sleepTimer,
                onSelect: { timer in
                    playbackService.setSleepTimer(timer)
                    showSleepTimer = false
                }
            )
            .presentationDetents([.height(500)])
        }
        .sheet(isPresented: $showQueue) {
            QueueView(playbackService: playbackService)
        }
    }

    // MARK: - Subviews

    private var dragIndicator: some View {
        Capsule()
            .fill(Color(.systemGray3))
            .frame(width: 36, height: 5)
            .padding(.top, 8)
            .accessibilityHidden(true)
    }

    private func artworkView(size: CGFloat) -> some View {
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
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.2), radius: 20, y: 10)
        .accessibilityHidden(true)
    }

    private var artworkPlaceholder: some View {
        ZStack {
            LinearGradient(
                colors: [
                    playbackService.currentItem?.artworkColor ?? .blue,
                    (playbackService.currentItem?.artworkColor ?? .blue).opacity(0.6)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            Image(systemName: "headphones")
                .font(.system(size: 80, weight: .light))
                .foregroundColor(.white.opacity(0.8))
        }
    }

    private var trackInfoView: some View {
        VStack(spacing: 4) {
            Text(playbackService.currentItem?.title ?? "Not Playing")
                .font(.title2)
                .fontWeight(.semibold)
                .lineLimit(2)
                .multilineTextAlignment(.center)

            Text(playbackService.currentItem?.displayAuthor ?? "")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(trackInfoAccessibilityLabel)
    }

    private var trackInfoAccessibilityLabel: String {
        guard let item = playbackService.currentItem else {
            return "Not playing"
        }
        return "\(item.title) by \(item.displayAuthor)"
    }

    private var progressView: some View {
        VStack(spacing: 8) {
            // Scrubber
            Slider(
                value: Binding(
                    get: {
                        isDraggingScrubber ? scrubberValue : playbackService.progress.progress
                    },
                    set: { newValue in
                        scrubberValue = newValue
                    }
                ),
                in: 0...1,
                onEditingChanged: { editing in
                    isDraggingScrubber = editing
                    if !editing {
                        let newTime = scrubberValue * playbackService.progress.duration
                        playbackService.seek(to: newTime)
                    }
                }
            )
            .tint(.primary)
            .accessibilityLabel("Playback position")
            .accessibilityValue(progressAccessibilityValue)
            .accessibilityHint("Adjust to seek through the audio")

            // Time labels
            HStack {
                Text(currentTimeString)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                    .accessibilityHidden(true)

                Spacer()

                Text(remainingTimeString)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                    .accessibilityHidden(true)
            }
        }
    }

    private var progressAccessibilityValue: String {
        let current = playbackService.progress.currentTime.accessibleDuration
        let total = playbackService.progress.duration.accessibleDuration
        let percent = Int(playbackService.progress.progress * 100)
        return "\(current) of \(total), \(percent) percent complete"
    }

    private var currentTimeString: String {
        if isDraggingScrubber {
            let time = scrubberValue * playbackService.progress.duration
            return time.formattedDuration
        }
        return playbackService.progress.currentTime.formattedDuration
    }

    private var remainingTimeString: String {
        if isDraggingScrubber {
            let time = scrubberValue * playbackService.progress.duration
            let remaining = playbackService.progress.duration - time
            return remaining.formattedRemaining
        }
        return playbackService.progress.remainingTime.formattedRemaining
    }

    private var mainControlsView: some View {
        HStack(spacing: 40) {
            // Skip backward
            Button {
                playbackService.skipBackward()
            } label: {
                Image(systemName: "gobackward.15")
                    .font(.system(size: 32))
            }
            .buttonStyle(PlayerButtonStyle())
            .accessibilityLabel("Skip back 15 seconds")
            .accessibilityHint("Double tap to go back")

            // Play/Pause
            Button {
                playbackService.togglePlayPause()
            } label: {
                Image(systemName: playbackService.state.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 44))
            }
            .buttonStyle(PlayPauseButtonStyle(contrast: contrast))
            .accessibilityLabel(playbackService.state.isPlaying ? "Pause" : "Play")
            .accessibilityHint(playbackService.state.isPlaying ? "Double tap to pause" : "Double tap to play")

            // Skip forward
            Button {
                playbackService.skipForward()
            } label: {
                Image(systemName: "goforward.15")
                    .font(.system(size: 32))
            }
            .buttonStyle(PlayerButtonStyle())
            .accessibilityLabel("Skip forward 15 seconds")
            .accessibilityHint("Double tap to skip ahead")
        }
    }

    private var secondaryControlsView: some View {
        HStack(spacing: 24) {
            // Speed button
            Button {
                showSpeedPicker = true
            } label: {
                Text(playbackService.playbackSpeed.displayName)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemGray5))
                    .clipShape(Capsule())
                    .overlay(
                        Capsule()
                            .stroke(contrast == .increased ? Color.primary : Color.clear, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Playback speed: \(playbackService.playbackSpeed.displayName)")
            .accessibilityHint("Double tap to change speed")

            Spacer()

            // Sleep timer
            Button {
                showSleepTimer = true
            } label: {
                Image(systemName: sleepTimerIcon)
                    .font(.title3)
            }
            .buttonStyle(SecondaryButtonStyle())
            .accessibilityLabel(playbackService.sleepTimer == .off ? "Sleep timer off" : "Sleep timer on")
            .accessibilityHint("Double tap to set sleep timer")

            // Repeat mode
            Button {
                playbackService.toggleRepeatMode()
            } label: {
                Image(systemName: playbackService.repeatMode.iconName)
                    .font(.title3)
                    .foregroundColor(playbackService.repeatMode == .off ? .secondary : .primary)
            }
            .buttonStyle(SecondaryButtonStyle())
            .accessibilityLabel("Repeat: \(playbackService.repeatMode.displayName)")
            .accessibilityHint("Double tap to change repeat mode")
            .accessibilityAddTraits(playbackService.repeatMode != .off ? .isSelected : [])

            // Queue
            Button {
                showQueue = true
            } label: {
                Image(systemName: "list.bullet")
                    .font(.title3)
            }
            .buttonStyle(SecondaryButtonStyle())
            .accessibilityLabel("Queue")
            .accessibilityHint("Double tap to view and manage queue")
        }
        .padding(.horizontal, 32)
    }

    private var sleepTimerIcon: String {
        playbackService.sleepTimer == .off ? "moon" : "moon.fill"
    }
}

// MARK: - Button Styles

struct PlayerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(.primary)
            .scaleEffect(configuration.isPressed ? 0.9 : 1.0)
            .animation(.easeInOut(duration: 0.1), value: configuration.isPressed)
    }
}

struct PlayPauseButtonStyle: ButtonStyle {
    var contrast: ColorSchemeContrast = .standard

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(.white)
            .frame(width: 80, height: 80)
            .background(Color.primary)
            .clipShape(Circle())
            .overlay(
                Circle()
                    .stroke(contrast == .increased ? Color.white : Color.clear, lineWidth: 3)
            )
            .scaleEffect(configuration.isPressed ? 0.95 : 1.0)
            .animation(.easeInOut(duration: 0.1), value: configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(.primary)
            .opacity(configuration.isPressed ? 0.5 : 1.0)
    }
}

// MARK: - Speed Picker View

struct SpeedPickerView: View {
    let currentSpeed: PlaybackSpeed
    let onSelect: (PlaybackSpeed) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(PlaybackSpeed.speeds, id: \.rate) { speed in
                    Button {
                        onSelect(speed)
                    } label: {
                        HStack {
                            Text(speed.displayName)
                                .foregroundColor(.primary)

                            Spacer()

                            if speed == currentSpeed {
                                Image(systemName: "checkmark")
                                    .foregroundColor(.accentColor)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Playback Speed")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

// MARK: - Sleep Timer View

struct SleepTimerView: View {
    let currentTimer: SleepTimerOption
    let onSelect: (SleepTimerOption) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(SleepTimerOption.presets, id: \.displayName) { option in
                    Button {
                        onSelect(option)
                    } label: {
                        HStack {
                            Text(option.displayName)
                                .foregroundColor(.primary)

                            Spacer()

                            if optionsMatch(option, currentTimer) {
                                Image(systemName: "checkmark")
                                    .foregroundColor(.accentColor)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Sleep Timer")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func optionsMatch(_ a: SleepTimerOption, _ b: SleepTimerOption) -> Bool {
        switch (a, b) {
        case (.off, .off): return true
        case (.minutes(let m1), .minutes(let m2)): return m1 == m2
        case (.endOfArticle, .endOfArticle): return true
        case (.endOfQueue, .endOfQueue): return true
        default: return false
        }
    }
}

// MARK: - Queue View

struct QueueView: View {
    @ObservedObject var playbackService: AudioPlaybackService
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                // Now Playing
                if let current = playbackService.currentItem {
                    Section("Now Playing") {
                        PlaybackQueueItemRow(
                            title: current.title,
                            author: current.displayAuthor,
                            duration: current.duration,
                            isPlaying: true
                        )
                    }
                }

                // Up Next
                if !playbackService.queue.isEmpty {
                    Section("Up Next") {
                        ForEach(playbackService.queue) { item in
                            PlaybackQueueItemRow(
                                title: item.title,
                                author: item.author ?? "",
                                duration: item.duration,
                                isPlaying: false
                            )
                        }
                        .onMove { from, to in
                            playbackService.moveInQueue(from: from, to: to)
                        }
                        .onDelete { indexSet in
                            indexSet.forEach { playbackService.removeFromQueue(at: $0) }
                        }
                    }
                }

                // History
                if !playbackService.history.isEmpty {
                    Section("Recently Played") {
                        ForEach(playbackService.history.prefix(5)) { item in
                            PlaybackQueueItemRow(
                                title: item.title,
                                author: item.author ?? "",
                                duration: item.duration,
                                isPlaying: false
                            )
                            .foregroundColor(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Queue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

// MARK: - Queue Item Row

struct PlaybackQueueItemRow: View {
    let title: String
    let author: String
    let duration: TimeInterval
    let isPlaying: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 12) {
            if isPlaying {
                Image(systemName: "waveform")
                    .foregroundColor(.accentColor)
                    .symbolEffect(.variableColor, isActive: !reduceMotion)
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                    .lineLimit(1)

                Text(author)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(duration.formattedDurationShort)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var label = title
        if !author.isEmpty {
            label += " by \(author)"
        }
        label += ". Duration: \(duration.accessibleDuration)"
        if isPlaying {
            label += ". Now playing"
        }
        return label
    }
}

// MARK: - Preview

#Preview {
    AudioPlayerView(playbackService: AudioPlaybackService.shared)
}
