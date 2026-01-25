import SwiftUI

// Note: Accessibility extensions are defined in AccessibilityHelpers.swift

// MARK: - Listening Queue View

/// Main view for displaying and managing the listening queue.
struct ListeningQueueView: View {
    @StateObject private var queueManager = QueueManager.shared
    @StateObject private var queueCoordinator = QueuePlaybackCoordinator.shared
    @ObservedObject private var urlPlayer = URLAudioPlayer.shared
    @State private var editMode: EditMode = .inactive
    @State private var showingClearConfirmation = false
    @State private var selectedItem: QueueItem?
    @Environment(\.sizeCategory) private var sizeCategory
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        NavigationStack {
            Group {
                if queueManager.isEmpty {
                    emptyStateView
                } else {
                    queueListView
                }
            }
            .navigationTitle("Queue")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !queueManager.isEmpty {
                        EditButton()
                    }
                }

                ToolbarItem(placement: .principal) {
                    if !queueManager.isEmpty {
                        Button {
                            Task {
                                await queueCoordinator.playQueue()
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: queueCoordinator.isPlayingFromQueue ? "pause.fill" : "play.fill")
                                Text(queueCoordinator.isPlayingFromQueue ? "Playing" : "Play Queue")
                                    .fontWeight(.semibold)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(Color.blue)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        }
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(action: { queueManager.toggleShuffleMode() }) {
                            Label(
                                queueManager.shuffleMode.isEnabled ? "Shuffle On" : "Shuffle Off",
                                systemImage: "shuffle"
                            )
                        }

                        Button(action: { queueManager.toggleRepeatMode() }) {
                            Label(
                                queueManager.repeatMode.displayName,
                                systemImage: queueManager.repeatMode.iconName
                            )
                        }

                        Divider()

                        Button(action: { queueManager.clearCompletedItems() }) {
                            Label("Clear Completed", systemImage: "checkmark.circle")
                        }

                        Button(role: .destructive, action: { showingClearConfirmation = true }) {
                            Label("Clear All", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(queueManager.isEmpty)
                }
            }
            .environment(\.editMode, $editMode)
            .confirmationDialog(
                "Clear Queue?",
                isPresented: $showingClearConfirmation,
                titleVisibility: .visible
            ) {
                Button("Clear All", role: .destructive) {
                    queueManager.clearQueue()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will remove all items from your queue.")
            }
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        ContentUnavailableView {
            Label("No Items in Queue", systemImage: "list.bullet")
        } description: {
            Text("Add articles to your queue to listen later.")
        } actions: {
            Button("Browse Library") {
                // Navigate to library
            }
            .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Queue List

    private var queueListView: some View {
        List {
            // All Queue Items Section - show all items with current item highlighted
            Section {
                ForEach(Array(queueManager.items.enumerated()), id: \.element.id) { index, item in
                    let isCurrentItem = queueManager.state.currentIndex == index

                    if isCurrentItem {
                        // Show as "Now Playing" style
                        NowPlayingRow(item: item)
                            .listRowBackground(Color.blue.opacity(0.1))
                    } else {
                        // Regular queue item - tap to play
                        QueueItemRow(
                            item: item,
                            onTap: {
                                // Set as current and start playback
                                queueManager.play(at: index)
                                Task {
                                    await queueCoordinator.playQueue()
                                }
                            }
                        )
                    }
                }
                .onDelete { offsets in
                    queueManager.removeFromQueue(at: offsets)
                }
                .onMove { source, destination in
                    queueManager.moveItems(from: source, to: destination)
                }
            } header: {
                HStack {
                    Text("Queue")
                    Spacer()
                    Text(queueManager.summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // Playback Controls - show when playing from queue
            if queueCoordinator.isPlayingFromQueue {
                Section {
                    HStack(spacing: 0) {
                        Spacer()

                        // Previous button
                        Button {
                            queueCoordinator.skipToPrevious()
                        } label: {
                            Image(systemName: "backward.fill")
                                .font(.title2)
                                .frame(width: 60, height: 44)
                        }
                        .disabled(!queueManager.hasPrevious)

                        Spacer()

                        // Play/Pause button
                        Button {
                            urlPlayer.togglePlayPause()
                        } label: {
                            Image(systemName: urlPlayer.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                                .font(.system(size: 50))
                        }

                        Spacer()

                        // Next button
                        Button {
                            queueCoordinator.skipToNext()
                        } label: {
                            Image(systemName: "forward.fill")
                                .font(.title2)
                                .frame(width: 60, height: 44)
                        }
                        .disabled(!queueManager.hasNext)

                        Spacer()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.blue)
                    .padding(.vertical, 8)
                } header: {
                    Text("Controls")
                }
            }

            // Queue Info
            Section {
                HStack(spacing: 16) {
                    Label(
                        queueManager.shuffleMode.isEnabled ? "Shuffle" : "In Order",
                        systemImage: "shuffle"
                    )
                    .foregroundStyle(queueManager.shuffleMode.isEnabled ? .blue : .secondary)

                    Label(
                        queueManager.repeatMode.displayName,
                        systemImage: queueManager.repeatMode.iconName
                    )
                    .foregroundStyle(queueManager.repeatMode != .off ? .blue : .secondary)

                    Spacer()

                    Text(queueManager.remainingSummary)
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }
        }
        .listStyle(.insetGrouped)
    }
}

// MARK: - Now Playing Row

struct NowPlayingRow: View {
    let item: QueueItem
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(spacing: 12) {
            // Artwork
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(item.artworkColor?.color ?? Color.blue)
                    .frame(width: 60, height: 60)

                Image(systemName: item.sourceType.iconName)
                    .font(.title2)
                    .foregroundStyle(.white)

                // Playing indicator
                Image(systemName: "waveform")
                    .font(.caption)
                    .foregroundStyle(.white)
                    .offset(y: 20)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.headline)
                    .lineLimit(2)

                Text(item.displayAuthor)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                // Progress bar
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(Color.secondary.opacity(contrast == .increased ? 0.4 : 0.2))
                            .frame(height: contrast == .increased ? 6 : 4)

                        Capsule()
                            .fill(Color.blue)
                            .frame(
                                width: geometry.size.width * CGFloat(item.progress),
                                height: contrast == .increased ? 6 : 4
                            )
                    }
                }
                .frame(height: contrast == .increased ? 6 : 4)
                .accessibilityHidden(true)

                Text(item.remainingFormatted)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(nowPlayingAccessibilityLabel)
        .accessibilityValue("\(Int(item.progress * 100)) percent complete")
        .accessibilityHint("Currently playing")
    }

    private var nowPlayingAccessibilityLabel: String {
        var label = "Now playing: \(item.title)"
        label += " by \(item.displayAuthor)"
        label += ". \(item.remainingFormatted) remaining"
        return label
    }
}

// MARK: - Queue Item Row

struct QueueItemRow: View {
    let item: QueueItem
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Artwork
                ZStack {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(item.artworkColor?.color ?? Color.gray.opacity(0.3))
                        .frame(width: 44, height: 44)

                    Image(systemName: item.sourceType.iconName)
                        .font(.body)
                        .foregroundStyle(.white)
                }
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                        .lineLimit(2)

                    HStack(spacing: 8) {
                        Text(item.displayAuthor)
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Text("•")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)

                        Text(item.durationFormatted)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if item.isCompleted {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(queueItemAccessibilityLabel)
        .accessibilityHint("Double tap to play")
        .accessibilityAddTraits(.isButton)
    }

    private var queueItemAccessibilityLabel: String {
        var label = item.title
        label += " by \(item.displayAuthor)"
        label += ". Duration: \(item.duration.accessibleDuration)"
        if item.isCompleted {
            label += ". Completed"
        }
        return label
    }
}

// MARK: - Queue Controls View

/// Compact controls for the queue (shuffle, repeat).
struct QueueControlsView: View {
    @ObservedObject var queueManager: QueueManager

    var body: some View {
        HStack(spacing: 24) {
            Button(action: { queueManager.toggleShuffleMode() }) {
                Image(systemName: "shuffle")
                    .font(.title3)
                    .foregroundStyle(queueManager.shuffleMode.isEnabled ? .blue : .secondary)
            }
            .accessibilityLabel(queueManager.shuffleMode.isEnabled ? "Shuffle on" : "Shuffle off")
            .accessibilityHint("Double tap to toggle shuffle")
            .accessibilityAddTraits(queueManager.shuffleMode.isEnabled ? .isSelected : [])

            Button(action: { queueManager.toggleRepeatMode() }) {
                Image(systemName: queueManager.repeatMode.iconName)
                    .font(.title3)
                    .foregroundStyle(queueManager.repeatMode != .off ? .blue : .secondary)
            }
            .accessibilityLabel("Repeat: \(queueManager.repeatMode.displayName)")
            .accessibilityHint("Double tap to change repeat mode")
            .accessibilityAddTraits(queueManager.repeatMode != .off ? .isSelected : [])
        }
    }
}

// MARK: - Add to Queue Button

/// Reusable button for adding items to queue.
struct AddToQueueButton: View {
    let article: Article
    @ObservedObject var queueManager: QueueManager
    @State private var showingOptions = false

    var isInQueue: Bool {
        queueManager.contains(articleID: article.id)
    }

    var body: some View {
        Menu {
            Button(action: {
                queueManager.addToQueue(article, position: .next)
            }) {
                Label("Play Next", systemImage: "text.insert")
            }

            Button(action: {
                queueManager.addToQueue(article, position: .last)
            }) {
                Label("Add to Queue", systemImage: "text.append")
            }

            if isInQueue {
                Divider()
                Button(role: .destructive, action: {
                    queueManager.removeFromQueue(id: article.id)
                }) {
                    Label("Remove from Queue", systemImage: "minus.circle")
                }
            }
        } label: {
            Label(
                isInQueue ? "In Queue" : "Add to Queue",
                systemImage: isInQueue ? "text.badge.checkmark" : "text.badge.plus"
            )
        }
    }
}

// MARK: - Queue Sheet

/// Bottom sheet showing the queue.
struct QueueSheet: View {
    @StateObject private var queueManager = QueueManager.shared
    @Environment(\.dismiss) private var dismiss
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        NavigationStack {
            ListeningQueueView()
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") {
                            dismiss()
                        }
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Mini Queue Preview

/// Shows a preview of upcoming items.
struct MiniQueuePreview: View {
    @ObservedObject var queueManager: QueueManager
    let maxItems: Int

    init(queueManager: QueueManager = .shared, maxItems: Int = 3) {
        self.queueManager = queueManager
        self.maxItems = maxItems
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Up Next")
                .font(.headline)

            if queueManager.upNext.isEmpty {
                Text("No more items")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(queueManager.upNext.prefix(maxItems)) { item in
                    HStack {
                        Image(systemName: item.sourceType.iconName)
                            .foregroundStyle(.secondary)
                            .frame(width: 20)

                        Text(item.title)
                            .font(.subheadline)
                            .lineLimit(1)

                        Spacer()

                        Text(item.durationFormatted)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if queueManager.upNext.count > maxItems {
                    Text("+ \(queueManager.upNext.count - maxItems) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Preview

#Preview {
    ListeningQueueView()
}
