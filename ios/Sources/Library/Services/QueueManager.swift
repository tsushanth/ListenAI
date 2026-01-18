import Foundation
import Combine

// MARK: - Queue Manager

/// Manages the listening queue with persistence and automatic advancement.
@MainActor
final class QueueManager: ObservableObject {

    // MARK: - Published State

    @Published private(set) var state: QueueState = .empty
    @Published private(set) var isLoading: Bool = false

    // MARK: - Properties

    private let persistenceKey = "ReadAloudAI.QueueState"
    private let historyKey = "ReadAloudAI.ListeningHistory"
    private let maxHistoryItems = 100

    private var history: [ListeningHistoryEntry] = []
    private var currentHistoryEntry: ListeningHistoryEntry?
    private var autoAdvanceEnabled: Bool = true

    // Callbacks
    var onItemCompleted: ((QueueItem) -> Void)?
    var onQueueExhausted: (() -> Void)?
    var onCurrentItemChanged: ((QueueItem?) -> Void)?

    // MARK: - Singleton

    static let shared = QueueManager()

    // MARK: - Computed Properties

    var currentItem: QueueItem? {
        state.currentItem
    }

    var items: [QueueItem] {
        state.items
    }

    var upNext: [QueueItem] {
        state.upNext
    }

    var isEmpty: Bool {
        state.isEmpty
    }

    var count: Int {
        state.items.count
    }

    var hasNext: Bool {
        state.hasNext
    }

    var hasPrevious: Bool {
        state.hasPrevious
    }

    var repeatMode: RepeatMode {
        get { state.repeatMode }
        set {
            state.repeatMode = newValue
            saveState()
        }
    }

    var shuffleMode: ShuffleMode {
        get { state.shuffleMode }
        set {
            state.shuffleMode = newValue
            if newValue == .on {
                generateShuffledIndices()
            } else {
                state.shuffledIndices = nil
            }
            saveState()
        }
    }

    // MARK: - Initialization

    private init() {
        loadState()
        loadHistory()
    }

    // MARK: - Queue Operations

    /// Add an item to the queue.
    func addToQueue(_ item: QueueItem, position: QueuePosition = .last) {
        var newItem = item

        switch position {
        case .next:
            if let currentIndex = state.currentIndex {
                let insertIndex = currentIndex + 1
                state.items.insert(newItem, at: min(insertIndex, state.items.count))
            } else {
                state.items.insert(newItem, at: 0)
            }

        case .last:
            state.items.append(newItem)

        case .first:
            state.items.insert(newItem, at: 0)
            // Adjust current index if needed
            if let currentIndex = state.currentIndex {
                state.currentIndex = currentIndex + 1
            }

        case .at(let index):
            let safeIndex = max(0, min(index, state.items.count))
            state.items.insert(newItem, at: safeIndex)
            // Adjust current index if needed
            if let currentIndex = state.currentIndex, safeIndex <= currentIndex {
                state.currentIndex = currentIndex + 1
            }
        }

        if shuffleMode == .on {
            generateShuffledIndices()
        }

        saveState()
    }

    /// Add multiple items to the queue.
    func addToQueue(_ items: [QueueItem], position: QueuePosition = .last) {
        for (index, item) in items.enumerated() {
            switch position {
            case .next:
                addToQueue(item, position: .at((state.currentIndex ?? -1) + 1 + index))
            case .last:
                addToQueue(item, position: .last)
            case .first:
                addToQueue(item, position: .at(index))
            case .at(let baseIndex):
                addToQueue(item, position: .at(baseIndex + index))
            }
        }
    }

    /// Add an article to the queue.
    func addToQueue(_ article: Article, position: QueuePosition = .last) {
        let item = QueueItem(from: article)
        addToQueue(item, position: position)
    }

    /// Remove an item from the queue.
    func removeFromQueue(at index: Int) {
        guard index < state.items.count else { return }

        state.items.remove(at: index)

        // Adjust current index
        if let currentIndex = state.currentIndex {
            if index < currentIndex {
                state.currentIndex = currentIndex - 1
            } else if index == currentIndex {
                // Current item was removed
                if state.items.isEmpty {
                    state.currentIndex = nil
                } else if currentIndex >= state.items.count {
                    state.currentIndex = state.items.count - 1
                }
                onCurrentItemChanged?(currentItem)
            }
        }

        if shuffleMode == .on {
            generateShuffledIndices()
        }

        saveState()
    }

    /// Remove an item by ID.
    func removeFromQueue(id: UUID) {
        if let index = state.items.firstIndex(where: { $0.id == id }) {
            removeFromQueue(at: index)
        }
    }

    /// Remove multiple items.
    func removeFromQueue(at offsets: IndexSet) {
        // Remove in reverse order to maintain indices
        for index in offsets.sorted().reversed() {
            removeFromQueue(at: index)
        }
    }

    /// Move items in the queue.
    func moveItems(from source: IndexSet, to destination: Int) {
        let currentItemID = currentItem?.id

        state.items.move(fromOffsets: source, toOffset: destination)

        // Update current index to follow the current item
        if let id = currentItemID {
            state.currentIndex = state.items.firstIndex(where: { $0.id == id })
        }

        if shuffleMode == .on {
            generateShuffledIndices()
        }

        saveState()
    }

    /// Clear the entire queue.
    func clearQueue() {
        // Complete current history entry
        completeHistoryEntry()

        state = .empty
        saveState()
        onQueueExhausted?()
    }

    /// Clear completed items from the queue.
    func clearCompletedItems() {
        let currentID = currentItem?.id
        state.items.removeAll { $0.isCompleted }

        if let id = currentID {
            state.currentIndex = state.items.firstIndex(where: { $0.id == id })
        } else if !state.items.isEmpty {
            state.currentIndex = 0
        } else {
            state.currentIndex = nil
        }

        if shuffleMode == .on {
            generateShuffledIndices()
        }

        saveState()
    }

    // MARK: - Playback Control

    /// Start playing a specific item in the queue.
    func play(at index: Int) {
        guard index < state.items.count else { return }

        // Complete previous history entry
        completeHistoryEntry()

        state.currentIndex = index
        startHistoryEntry(for: state.items[index])

        saveState()
        onCurrentItemChanged?(currentItem)
    }

    /// Start playing a specific item by ID.
    func play(id: UUID) {
        if let index = state.items.firstIndex(where: { $0.id == id }) {
            play(at: index)
        }
    }

    /// Move to the next item in the queue.
    /// Returns the next item, or nil if queue is exhausted.
    @discardableResult
    func next() -> QueueItem? {
        guard let currentIndex = state.currentIndex else {
            if !state.items.isEmpty {
                play(at: 0)
                return currentItem
            }
            return nil
        }

        // Mark current as completed
        markCurrentAsCompleted()

        let nextIndex: Int?

        if shuffleMode == .on, let shuffled = state.shuffledIndices {
            let shufflePosition = shuffled.firstIndex(of: currentIndex) ?? currentIndex
            if shufflePosition + 1 < shuffled.count {
                nextIndex = shuffled[shufflePosition + 1]
            } else if repeatMode == .all {
                generateShuffledIndices()
                nextIndex = state.shuffledIndices?.first
            } else {
                nextIndex = nil
            }
        } else {
            if currentIndex + 1 < state.items.count {
                nextIndex = currentIndex + 1
            } else if repeatMode == .all {
                nextIndex = 0
            } else {
                nextIndex = nil
            }
        }

        if let next = nextIndex {
            play(at: next)
            return currentItem
        } else {
            state.currentIndex = nil
            saveState()
            onQueueExhausted?()
            return nil
        }
    }

    /// Move to the previous item in the queue.
    /// Returns the previous item, or nil if at the beginning.
    @discardableResult
    func previous() -> QueueItem? {
        guard let currentIndex = state.currentIndex else { return nil }

        let prevIndex: Int?

        if shuffleMode == .on, let shuffled = state.shuffledIndices {
            let shufflePosition = shuffled.firstIndex(of: currentIndex) ?? currentIndex
            if shufflePosition > 0 {
                prevIndex = shuffled[shufflePosition - 1]
            } else if repeatMode == .all {
                prevIndex = shuffled.last
            } else {
                prevIndex = nil
            }
        } else {
            if currentIndex > 0 {
                prevIndex = currentIndex - 1
            } else if repeatMode == .all {
                prevIndex = state.items.count - 1
            } else {
                prevIndex = nil
            }
        }

        if let prev = prevIndex {
            play(at: prev)
            return currentItem
        }

        return nil
    }

    /// Handle item completion - called when playback finishes.
    func itemCompleted() {
        guard let item = currentItem else { return }

        markCurrentAsCompleted()
        onItemCompleted?(item)

        if repeatMode == .one {
            // Replay current item
            if let index = state.currentIndex {
                state.items[index].lastPlayedPosition = 0
                saveState()
            }
        } else if autoAdvanceEnabled {
            next()
        }
    }

    /// Update playback position for current item.
    func updatePosition(_ position: TimeInterval) {
        guard let index = state.currentIndex else { return }

        state.items[index].lastPlayedPosition = position

        // Update history entry
        if var entry = currentHistoryEntry {
            entry.durationListened = position
            currentHistoryEntry = entry
        }

        // Save periodically (every 10 seconds)
        let positionSeconds = Int(position)
        if positionSeconds % 10 == 0 {
            saveState()
        }
    }

    // MARK: - Repeat & Shuffle

    /// Toggle repeat mode.
    func toggleRepeatMode() {
        repeatMode = repeatMode.next()
    }

    /// Toggle shuffle mode.
    func toggleShuffleMode() {
        shuffleMode.toggle()
    }

    // MARK: - Queue from Playlist

    /// Replace queue with playlist contents.
    func playPlaylist(_ playlist: Playlist, startingAt index: Int = 0) {
        clearQueue()

        let queueItems = playlist.items.enumerated().map { idx, item in
            QueueItem(
                articleID: item.articleID,
                title: item.title,
                author: item.author,
                siteName: item.siteName,
                sourceType: item.sourceType,
                duration: item.duration,
                heroImageURL: item.heroImageURL
            )
        }

        state.items = queueItems

        if shuffleMode == .on {
            generateShuffledIndices()
        }

        if !queueItems.isEmpty {
            play(at: index)
        }
    }

    /// Add playlist contents to queue.
    func addPlaylistToQueue(_ playlist: Playlist, position: QueuePosition = .last) {
        let queueItems = playlist.items.map { item in
            QueueItem(
                articleID: item.articleID,
                title: item.title,
                author: item.author,
                siteName: item.siteName,
                sourceType: item.sourceType,
                duration: item.duration,
                heroImageURL: item.heroImageURL
            )
        }

        addToQueue(queueItems, position: position)
    }

    // MARK: - History

    /// Get listening history.
    func getHistory(limit: Int = 50) -> [ListeningHistoryEntry] {
        Array(history.prefix(limit))
    }

    /// Clear listening history.
    func clearHistory() {
        history.removeAll()
        saveHistory()
    }

    // MARK: - Private Methods

    private func markCurrentAsCompleted() {
        guard let index = state.currentIndex else { return }

        state.items[index].isCompleted = true
        state.items[index].completedAt = Date()

        completeHistoryEntry()
        saveState()
    }

    private func generateShuffledIndices() {
        var indices = Array(0..<state.items.count)

        // Keep current item at current position if playing
        if let currentIndex = state.currentIndex {
            indices.remove(at: currentIndex)
            indices.shuffle()
            indices.insert(currentIndex, at: currentIndex)
        } else {
            indices.shuffle()
        }

        state.shuffledIndices = indices
    }

    private func startHistoryEntry(for item: QueueItem) {
        currentHistoryEntry = ListeningHistoryEntry(from: item)
    }

    private func completeHistoryEntry() {
        guard var entry = currentHistoryEntry else { return }

        entry.endedAt = Date()
        entry.completed = (currentItem?.isCompleted ?? false)

        history.insert(entry, at: 0)

        // Trim history
        if history.count > maxHistoryItems {
            history = Array(history.prefix(maxHistoryItems))
        }

        saveHistory()
        currentHistoryEntry = nil
    }

    // MARK: - Persistence

    private func saveState() {
        do {
            let data = try JSONEncoder().encode(state)
            UserDefaults.standard.set(data, forKey: persistenceKey)
        } catch {
            print("Failed to save queue state: \(error)")
        }
    }

    private func loadState() {
        guard let data = UserDefaults.standard.data(forKey: persistenceKey) else { return }

        do {
            state = try JSONDecoder().decode(QueueState.self, from: data)
        } catch {
            print("Failed to load queue state: \(error)")
            state = .empty
        }
    }

    private func saveHistory() {
        do {
            let data = try JSONEncoder().encode(history)
            UserDefaults.standard.set(data, forKey: historyKey)
        } catch {
            print("Failed to save history: \(error)")
        }
    }

    private func loadHistory() {
        guard let data = UserDefaults.standard.data(forKey: historyKey) else { return }

        do {
            history = try JSONDecoder().decode([ListeningHistoryEntry].self, from: data)
        } catch {
            print("Failed to load history: \(error)")
            history = []
        }
    }
}

// MARK: - Queue Manager Extensions

extension QueueManager {

    /// Get queue summary for display.
    var summary: String {
        let count = state.items.count
        if count == 0 {
            return "Queue is empty"
        }

        let totalMinutes = Int(state.totalDuration) / 60
        if totalMinutes < 60 {
            return "\(count) item\(count == 1 ? "" : "s") • \(totalMinutes) min"
        } else {
            let hours = totalMinutes / 60
            let mins = totalMinutes % 60
            return "\(count) item\(count == 1 ? "" : "s") • \(hours) hr \(mins) min"
        }
    }

    /// Get remaining time summary.
    var remainingSummary: String {
        let remaining = state.remainingDuration
        let minutes = Int(remaining) / 60

        if minutes < 60 {
            return "\(minutes) min remaining"
        } else {
            let hours = minutes / 60
            let mins = minutes % 60
            return "\(hours) hr \(mins) min remaining"
        }
    }

    /// Check if an article is in the queue.
    func contains(articleID: UUID) -> Bool {
        state.items.contains { $0.articleID == articleID }
    }

    /// Get position in queue for an article.
    func position(for articleID: UUID) -> Int? {
        state.items.firstIndex { $0.articleID == articleID }
    }
}
