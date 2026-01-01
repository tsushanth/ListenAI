import SwiftUI

// MARK: - Listening Queue View

/// Main view for displaying and managing the listening queue.
struct ListeningQueueView: View {
    @StateObject private var queueManager = QueueManager.shared
    @State private var editMode: EditMode = .inactive
    @State private var showingClearConfirmation = false
    @State private var selectedItem: QueueItem?

    var body: some View {
        NavigationStack {
            Group {
                if queueManager.isEmpty {
                    emptyStateView
                } else {
                    queueListView
                }
            }
            .navigationTitle("Up Next")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !queueManager.isEmpty {
                        EditButton()
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
            // Now Playing Section
            if let currentItem = queueManager.currentItem {
                Section {
                    NowPlayingRow(item: currentItem)
                } header: {
                    Text("Now Playing")
                }
            }

            // Up Next Section
            if !queueManager.upNext.isEmpty {
                Section {
                    ForEach(queueManager.upNext) { item in
                        QueueItemRow(
                            item: item,
                            onTap: { queueManager.play(id: item.id) }
                        )
                    }
                    .onDelete { offsets in
                        // Adjust offsets to account for current item
                        let adjustedOffsets = IndexSet(offsets.map { $0 + (queueManager.state.currentIndex ?? -1) + 1 })
                        queueManager.removeFromQueue(at: adjustedOffsets)
                    }
                    .onMove { source, destination in
                        // Adjust indices
                        let baseIndex = (queueManager.state.currentIndex ?? -1) + 1
                        let adjustedSource = IndexSet(source.map { $0 + baseIndex })
                        queueManager.moveItems(from: adjustedSource, to: destination + baseIndex)
                    }
                } header: {
                    HStack {
                        Text("Up Next")
                        Spacer()
                        Text(queueManager.remainingSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Queue Summary
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(queueManager.summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

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
                        }
                        .font(.caption)
                    }

                    Spacer()
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

// MARK: - Now Playing Row

struct NowPlayingRow: View {
    let item: QueueItem

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
                            .fill(Color.secondary.opacity(0.2))
                            .frame(height: 4)

                        Capsule()
                            .fill(Color.blue)
                            .frame(width: geometry.size.width * CGFloat(item.progress), height: 4)
                    }
                }
                .frame(height: 4)

                Text(item.remainingFormatted)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding(.vertical, 4)
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

                        Text(item.durationFormatted)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if item.isCompleted {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
        }
        .buttonStyle(.plain)
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

            Button(action: { queueManager.toggleRepeatMode() }) {
                Image(systemName: queueManager.repeatMode.iconName)
                    .font(.title3)
                    .foregroundStyle(queueManager.repeatMode != .off ? .blue : .secondary)
            }
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
