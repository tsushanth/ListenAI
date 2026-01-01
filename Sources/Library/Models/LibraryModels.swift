import Foundation
import SwiftUI

// MARK: - Queue Item

/// Represents an item in the listening queue.
struct QueueItem: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let articleID: UUID
    let title: String
    let author: String?
    let siteName: String?
    let sourceType: SourceType
    let duration: TimeInterval
    let wordCount: Int
    let addedAt: Date
    var artworkColor: CodableColor?
    var heroImageURL: URL?

    // Playback state
    var lastPlayedPosition: TimeInterval = 0
    var isCompleted: Bool = false
    var completedAt: Date?

    init(
        id: UUID = UUID(),
        articleID: UUID,
        title: String,
        author: String? = nil,
        siteName: String? = nil,
        sourceType: SourceType = .web,
        duration: TimeInterval,
        wordCount: Int = 0,
        addedAt: Date = Date(),
        artworkColor: CodableColor? = nil,
        heroImageURL: URL? = nil
    ) {
        self.id = id
        self.articleID = articleID
        self.title = title
        self.author = author
        self.siteName = siteName
        self.sourceType = sourceType
        self.duration = duration
        self.wordCount = wordCount
        self.addedAt = addedAt
        self.artworkColor = artworkColor
        self.heroImageURL = heroImageURL
    }

    /// Create from an Article
    init(from article: Article, duration: TimeInterval? = nil) {
        self.id = UUID()
        self.articleID = article.id
        self.title = article.displayTitle
        self.author = article.author
        self.siteName = article.siteName
        self.sourceType = article.sourceType
        self.duration = duration ?? article.estimatedDuration
        self.wordCount = article.wordCount
        self.addedAt = Date()
        self.heroImageURL = article.heroImageURL
    }

    var displayAuthor: String {
        author ?? siteName ?? "Unknown"
    }

    var durationFormatted: String {
        let minutes = Int(duration) / 60
        let seconds = Int(duration) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    var remainingDuration: TimeInterval {
        max(0, duration - lastPlayedPosition)
    }

    var remainingFormatted: String {
        let remaining = remainingDuration
        let minutes = Int(remaining) / 60
        let seconds = Int(remaining) % 60
        return String(format: "%d:%02d left", minutes, seconds)
    }

    var progress: Float {
        guard duration > 0 else { return 0 }
        return Float(lastPlayedPosition / duration)
    }
}

// MARK: - Playlist

/// Represents a user-created playlist of articles.
struct Playlist: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var name: String
    var description: String?
    var items: [PlaylistItem]
    var createdAt: Date
    var modifiedAt: Date
    var artworkColor: CodableColor
    var iconName: String
    var isSmart: Bool
    var smartCriteria: SmartPlaylistCriteria?

    init(
        id: UUID = UUID(),
        name: String,
        description: String? = nil,
        items: [PlaylistItem] = [],
        createdAt: Date = Date(),
        modifiedAt: Date = Date(),
        artworkColor: CodableColor = CodableColor(.blue),
        iconName: String = "list.bullet",
        isSmart: Bool = false,
        smartCriteria: SmartPlaylistCriteria? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.items = items
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.artworkColor = artworkColor
        self.iconName = iconName
        self.isSmart = isSmart
        self.smartCriteria = smartCriteria
    }

    var itemCount: Int {
        items.count
    }

    var totalDuration: TimeInterval {
        items.reduce(0) { $0 + $1.duration }
    }

    var totalDurationFormatted: String {
        let totalMinutes = Int(totalDuration) / 60
        if totalMinutes < 60 {
            return "\(totalMinutes) min"
        } else {
            let hours = totalMinutes / 60
            let minutes = totalMinutes % 60
            return "\(hours) hr \(minutes) min"
        }
    }

    var isEmpty: Bool {
        items.isEmpty
    }

    mutating func addItem(_ item: PlaylistItem) {
        items.append(item)
        modifiedAt = Date()
    }

    mutating func removeItem(at index: Int) {
        guard index < items.count else { return }
        items.remove(at: index)
        modifiedAt = Date()
    }

    mutating func moveItem(from source: IndexSet, to destination: Int) {
        items.move(fromOffsets: source, toOffset: destination)
        modifiedAt = Date()
    }

    mutating func updateItem(_ item: PlaylistItem) {
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
            modifiedAt = Date()
        }
    }
}

// MARK: - Playlist Item

/// An item within a playlist.
struct PlaylistItem: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let articleID: UUID
    let title: String
    let author: String?
    let siteName: String?
    let sourceType: SourceType
    let duration: TimeInterval
    let addedAt: Date
    var heroImageURL: URL?
    var sortOrder: Int

    // Playback tracking within playlist
    var lastPlayedPosition: TimeInterval = 0
    var playCount: Int = 0
    var lastPlayedAt: Date?

    init(
        id: UUID = UUID(),
        articleID: UUID,
        title: String,
        author: String? = nil,
        siteName: String? = nil,
        sourceType: SourceType = .web,
        duration: TimeInterval,
        addedAt: Date = Date(),
        heroImageURL: URL? = nil,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.articleID = articleID
        self.title = title
        self.author = author
        self.siteName = siteName
        self.sourceType = sourceType
        self.duration = duration
        self.addedAt = addedAt
        self.heroImageURL = heroImageURL
        self.sortOrder = sortOrder
    }

    init(from article: Article, sortOrder: Int = 0) {
        self.id = UUID()
        self.articleID = article.id
        self.title = article.displayTitle
        self.author = article.author
        self.siteName = article.siteName
        self.sourceType = article.sourceType
        self.duration = article.estimatedDuration
        self.addedAt = Date()
        self.heroImageURL = article.heroImageURL
        self.sortOrder = sortOrder
    }

    init(from queueItem: QueueItem, sortOrder: Int = 0) {
        self.id = UUID()
        self.articleID = queueItem.articleID
        self.title = queueItem.title
        self.author = queueItem.author
        self.siteName = queueItem.siteName
        self.sourceType = queueItem.sourceType
        self.duration = queueItem.duration
        self.addedAt = Date()
        self.heroImageURL = queueItem.heroImageURL
        self.sortOrder = sortOrder
    }

    var displayAuthor: String {
        author ?? siteName ?? "Unknown"
    }

    var durationFormatted: String {
        let minutes = Int(duration) / 60
        let seconds = Int(duration) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// MARK: - Smart Playlist Criteria

/// Criteria for automatically populating smart playlists.
struct SmartPlaylistCriteria: Codable, Hashable, Sendable {
    var sourceTypes: Set<SourceType>?
    var minDuration: TimeInterval?
    var maxDuration: TimeInterval?
    var addedAfter: Date?
    var addedBefore: Date?
    var unplayedOnly: Bool = false
    var limit: Int?
    var sortBy: SortOption = .addedDate
    var sortAscending: Bool = false

    enum SortOption: String, Codable, Sendable {
        case addedDate
        case title
        case duration
        case author
    }

    func matches(_ article: Article) -> Bool {
        // Check source type
        if let types = sourceTypes, !types.contains(article.sourceType) {
            return false
        }

        // Check duration
        if let min = minDuration, article.estimatedDuration < min {
            return false
        }
        if let max = maxDuration, article.estimatedDuration > max {
            return false
        }

        // Check added date
        if let after = addedAfter, article.importDate < after {
            return false
        }
        if let before = addedBefore, article.importDate > before {
            return false
        }

        return true
    }
}

// MARK: - Queue Position

/// Where to insert an item in the queue.
enum QueuePosition: Sendable {
    case next       // After current item
    case last       // End of queue
    case first      // Beginning of queue
    case at(Int)    // Specific index
}

// MARK: - Listening History

/// Tracks what the user has listened to.
struct ListeningHistoryEntry: Identifiable, Codable, Sendable {
    let id: UUID
    let articleID: UUID
    let title: String
    let author: String?
    let sourceType: SourceType
    let startedAt: Date
    var endedAt: Date?
    var durationListened: TimeInterval
    var completed: Bool

    init(
        id: UUID = UUID(),
        articleID: UUID,
        title: String,
        author: String? = nil,
        sourceType: SourceType = .web,
        startedAt: Date = Date(),
        endedAt: Date? = nil,
        durationListened: TimeInterval = 0,
        completed: Bool = false
    ) {
        self.id = id
        self.articleID = articleID
        self.title = title
        self.author = author
        self.sourceType = sourceType
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.durationListened = durationListened
        self.completed = completed
    }

    init(from queueItem: QueueItem) {
        self.id = UUID()
        self.articleID = queueItem.articleID
        self.title = queueItem.title
        self.author = queueItem.author
        self.sourceType = queueItem.sourceType
        self.startedAt = Date()
    }

    var displayDuration: String {
        let minutes = Int(durationListened) / 60
        if minutes < 60 {
            return "\(minutes) min"
        } else {
            let hours = minutes / 60
            let mins = minutes % 60
            return "\(hours) hr \(mins) min"
        }
    }
}

// MARK: - Codable Color

/// A Codable wrapper for SwiftUI Color.
struct CodableColor: Codable, Hashable, Sendable {
    let red: Double
    let green: Double
    let blue: Double
    let opacity: Double

    init(_ color: Color) {
        // Default to blue if we can't resolve
        self.red = 0.0
        self.green = 0.478
        self.blue = 1.0
        self.opacity = 1.0
    }

    init(red: Double, green: Double, blue: Double, opacity: Double = 1.0) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    var color: Color {
        Color(red: red, green: green, blue: blue, opacity: opacity)
    }

    // Preset colors
    static let blue = CodableColor(red: 0.0, green: 0.478, blue: 1.0)
    static let purple = CodableColor(red: 0.686, green: 0.322, blue: 0.871)
    static let pink = CodableColor(red: 1.0, green: 0.176, blue: 0.333)
    static let red = CodableColor(red: 1.0, green: 0.231, blue: 0.188)
    static let orange = CodableColor(red: 1.0, green: 0.584, blue: 0.0)
    static let yellow = CodableColor(red: 1.0, green: 0.8, blue: 0.0)
    static let green = CodableColor(red: 0.298, green: 0.851, blue: 0.392)
    static let teal = CodableColor(red: 0.353, green: 0.784, blue: 0.98)
    static let indigo = CodableColor(red: 0.345, green: 0.337, blue: 0.839)

    static let allColors: [CodableColor] = [
        .blue, .purple, .pink, .red, .orange, .yellow, .green, .teal, .indigo
    ]
}

// MARK: - Repeat Mode

/// Playback repeat mode for queue/playlist.
enum RepeatMode: String, Codable, CaseIterable, Sendable {
    case off
    case all
    case one

    var iconName: String {
        switch self {
        case .off: return "repeat"
        case .all: return "repeat"
        case .one: return "repeat.1"
        }
    }

    var displayName: String {
        switch self {
        case .off: return "Off"
        case .all: return "Repeat All"
        case .one: return "Repeat One"
        }
    }

    func next() -> RepeatMode {
        switch self {
        case .off: return .all
        case .all: return .one
        case .one: return .off
        }
    }
}

// MARK: - Shuffle Mode

/// Whether shuffle is enabled.
enum ShuffleMode: String, Codable, Sendable {
    case off
    case on

    var isEnabled: Bool {
        self == .on
    }

    mutating func toggle() {
        self = self == .off ? .on : .off
    }
}

// MARK: - Queue State

/// Represents the current state of the listening queue.
struct QueueState: Codable, Sendable {
    var items: [QueueItem]
    var currentIndex: Int?
    var repeatMode: RepeatMode
    var shuffleMode: ShuffleMode
    var shuffledIndices: [Int]?

    init(
        items: [QueueItem] = [],
        currentIndex: Int? = nil,
        repeatMode: RepeatMode = .off,
        shuffleMode: ShuffleMode = .off,
        shuffledIndices: [Int]? = nil
    ) {
        self.items = items
        self.currentIndex = currentIndex
        self.repeatMode = repeatMode
        self.shuffleMode = shuffleMode
        self.shuffledIndices = shuffledIndices
    }

    var currentItem: QueueItem? {
        guard let index = currentIndex, index < items.count else { return nil }
        if shuffleMode == .on, let shuffled = shuffledIndices, index < shuffled.count {
            return items[shuffled[index]]
        }
        return items[index]
    }

    var upNext: [QueueItem] {
        guard let index = currentIndex else { return items }
        let startIndex = index + 1
        guard startIndex < items.count else { return [] }

        if shuffleMode == .on, let shuffled = shuffledIndices {
            return shuffled.dropFirst(startIndex).prefix(20).compactMap { i in
                i < items.count ? items[i] : nil
            }
        }
        return Array(items.dropFirst(startIndex).prefix(20))
    }

    var hasNext: Bool {
        guard let index = currentIndex else { return !items.isEmpty }
        return index < items.count - 1 || repeatMode == .all
    }

    var hasPrevious: Bool {
        guard let index = currentIndex else { return false }
        return index > 0 || repeatMode == .all
    }

    var isEmpty: Bool {
        items.isEmpty
    }

    var totalDuration: TimeInterval {
        items.reduce(0) { $0 + $1.duration }
    }

    var remainingDuration: TimeInterval {
        guard let index = currentIndex else { return totalDuration }
        let remaining = items.dropFirst(index)
        return remaining.reduce(0) { $0 + $1.remainingDuration }
    }

    static let empty = QueueState()
}

// MARK: - Library Statistics

/// Statistics about the user's library.
struct LibraryStatistics: Sendable {
    let totalArticles: Int
    let totalPlaylists: Int
    let totalListeningTime: TimeInterval
    let articlesThisWeek: Int
    let listeningTimeThisWeek: TimeInterval
    let mostListenedSource: SourceType?
    let averageArticleLength: TimeInterval

    var totalListeningTimeFormatted: String {
        let hours = Int(totalListeningTime) / 3600
        let minutes = (Int(totalListeningTime) % 3600) / 60
        if hours > 0 {
            return "\(hours) hr \(minutes) min"
        }
        return "\(minutes) min"
    }

    var listeningTimeThisWeekFormatted: String {
        let hours = Int(listeningTimeThisWeek) / 3600
        let minutes = (Int(listeningTimeThisWeek) % 3600) / 60
        if hours > 0 {
            return "\(hours) hr \(minutes) min"
        }
        return "\(minutes) min"
    }
}
