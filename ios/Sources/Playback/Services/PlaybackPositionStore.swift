import Foundation

// MARK: - Playback Position Store

/// Persists and retrieves listening positions for articles.
actor PlaybackPositionStore {

    // MARK: - Properties

    private let userDefaults: UserDefaults
    private let storageKey = "com.listenai.playback.positions"
    private let maxStoredPositions = 100

    private var positions: [UUID: ListeningPosition] = [:]
    private var isDirty = false

    // MARK: - Singleton

    static let shared = PlaybackPositionStore()

    // MARK: - Initialization

    private init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        loadPositions()
    }

    // MARK: - Public Methods

    /// Get the saved position for an article
    func getPosition(for articleID: UUID) -> ListeningPosition? {
        positions[articleID]
    }

    /// Save the current position for an article
    func savePosition(
        articleID: UUID,
        position: TimeInterval,
        duration: TimeInterval
    ) {
        let listeningPosition = ListeningPosition(
            articleID: articleID,
            position: position,
            duration: duration,
            updatedAt: Date(),
            isCompleted: duration > 0 && position / duration >= 0.95
        )

        positions[articleID] = listeningPosition
        isDirty = true

        // Debounced save
        Task {
            try? await Task.sleep(nanoseconds: 500_000_000) // 0.5s
            await saveIfDirty()
        }
    }

    /// Mark an article as completed
    func markCompleted(articleID: UUID, duration: TimeInterval) {
        let position = ListeningPosition(
            articleID: articleID,
            position: duration,
            duration: duration,
            updatedAt: Date(),
            isCompleted: true
        )

        positions[articleID] = position
        isDirty = true
        persistPositions()
    }

    /// Clear the position for an article
    func clearPosition(for articleID: UUID) {
        positions.removeValue(forKey: articleID)
        isDirty = true
        persistPositions()
    }

    /// Get all stored positions
    func getAllPositions() -> [ListeningPosition] {
        Array(positions.values).sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Get recently listened articles
    func getRecentlyListened(limit: Int = 10) -> [ListeningPosition] {
        Array(positions.values)
            .filter { !$0.isCompleted }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(limit)
            .map { $0 }
    }

    /// Force save to disk
    func forceSave() {
        persistPositions()
    }

    // MARK: - Private Methods

    private func loadPositions() {
        guard let data = userDefaults.data(forKey: storageKey) else { return }

        do {
            let decoder = JSONDecoder()
            let stored = try decoder.decode([UUID: ListeningPosition].self, from: data)
            positions = stored
        } catch {
            print("Failed to load playback positions: \(error)")
        }
    }

    private func saveIfDirty() {
        guard isDirty else { return }
        persistPositions()
    }

    private func persistPositions() {
        // Prune old positions if exceeding limit
        if positions.count > maxStoredPositions {
            let sorted = positions.values.sorted { $0.updatedAt > $1.updatedAt }
            let toKeep = sorted.prefix(maxStoredPositions)
            positions = Dictionary(uniqueKeysWithValues: toKeep.map { ($0.articleID, $0) })
        }

        do {
            let encoder = JSONEncoder()
            let data = try encoder.encode(positions)
            userDefaults.set(data, forKey: storageKey)
            isDirty = false
        } catch {
            print("Failed to save playback positions: \(error)")
        }
    }
}

// MARK: - Playback History Store

/// Stores listening history for statistics and analytics.
actor PlaybackHistoryStore {

    // MARK: - Types

    struct HistoryEntry: Codable, Identifiable {
        let id: UUID
        let articleID: UUID
        let title: String
        let startedAt: Date
        let endedAt: Date
        let startPosition: TimeInterval
        let endPosition: TimeInterval
        let duration: TimeInterval
        let completed: Bool

        var listenedDuration: TimeInterval {
            endPosition - startPosition
        }
    }

    // MARK: - Properties

    private let userDefaults: UserDefaults
    private let storageKey = "com.listenai.playback.history"
    private let maxHistoryEntries = 500

    private var history: [HistoryEntry] = []

    // MARK: - Singleton

    static let shared = PlaybackHistoryStore()

    // MARK: - Initialization

    private init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        loadHistory()
    }

    // MARK: - Public Methods

    /// Record a listening session
    func recordSession(
        articleID: UUID,
        title: String,
        startedAt: Date,
        endedAt: Date,
        startPosition: TimeInterval,
        endPosition: TimeInterval,
        duration: TimeInterval,
        completed: Bool
    ) {
        let entry = HistoryEntry(
            id: UUID(),
            articleID: articleID,
            title: title,
            startedAt: startedAt,
            endedAt: endedAt,
            startPosition: startPosition,
            endPosition: endPosition,
            duration: duration,
            completed: completed
        )

        history.insert(entry, at: 0)

        // Prune if over limit
        if history.count > maxHistoryEntries {
            history = Array(history.prefix(maxHistoryEntries))
        }

        persistHistory()
    }

    /// Get listening history
    func getHistory(limit: Int? = nil) -> [HistoryEntry] {
        if let limit = limit {
            return Array(history.prefix(limit))
        }
        return history
    }

    /// Get history for a specific article
    func getHistory(for articleID: UUID) -> [HistoryEntry] {
        history.filter { $0.articleID == articleID }
    }

    /// Get total listening time
    func getTotalListeningTime() -> TimeInterval {
        history.reduce(0) { $0 + $1.listenedDuration }
    }

    /// Get listening time for a date range
    func getListeningTime(from: Date, to: Date) -> TimeInterval {
        history
            .filter { $0.startedAt >= from && $0.startedAt <= to }
            .reduce(0) { $0 + $1.listenedDuration }
    }

    /// Get completed articles count
    func getCompletedCount() -> Int {
        Set(history.filter { $0.completed }.map { $0.articleID }).count
    }

    /// Clear all history
    func clearHistory() {
        history.removeAll()
        persistHistory()
    }

    // MARK: - Private Methods

    private func loadHistory() {
        guard let data = userDefaults.data(forKey: storageKey) else { return }

        do {
            let decoder = JSONDecoder()
            history = try decoder.decode([HistoryEntry].self, from: data)
        } catch {
            print("Failed to load playback history: \(error)")
        }
    }

    private func persistHistory() {
        do {
            let encoder = JSONEncoder()
            let data = try encoder.encode(history)
            userDefaults.set(data, forKey: storageKey)
        } catch {
            print("Failed to save playback history: \(error)")
        }
    }
}
