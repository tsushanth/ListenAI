import Foundation
import Combine

// MARK: - Playlist Manager

/// Manages playlists with persistence and smart playlist support.
@MainActor
final class PlaylistManager: ObservableObject {

    // MARK: - Published State

    @Published private(set) var playlists: [Playlist] = []
    @Published private(set) var isLoading: Bool = false

    // MARK: - Properties

    private let persistenceKey = "ReadAloudAI.Playlists"
    private let maxPlaylists = 100

    // MARK: - Singleton

    static let shared = PlaylistManager()

    // MARK: - Computed Properties

    var isEmpty: Bool {
        playlists.isEmpty
    }

    var count: Int {
        playlists.count
    }

    var regularPlaylists: [Playlist] {
        playlists.filter { !$0.isSmart }
    }

    var smartPlaylists: [Playlist] {
        playlists.filter { $0.isSmart }
    }

    // MARK: - Initialization

    private init() {
        loadPlaylists()
        createDefaultPlaylistsIfNeeded()
    }

    // MARK: - Playlist CRUD Operations

    /// Create a new playlist.
    @discardableResult
    func createPlaylist(
        name: String,
        description: String? = nil,
        color: CodableColor = .blue,
        iconName: String = "list.bullet"
    ) -> Playlist {
        let playlist = Playlist(
            name: name,
            description: description,
            artworkColor: color,
            iconName: iconName
        )

        playlists.append(playlist)
        savePlaylists()

        return playlist
    }

    /// Create a smart playlist.
    @discardableResult
    func createSmartPlaylist(
        name: String,
        criteria: SmartPlaylistCriteria,
        color: CodableColor = .purple,
        iconName: String = "wand.and.stars"
    ) -> Playlist {
        let playlist = Playlist(
            name: name,
            artworkColor: color,
            iconName: iconName,
            isSmart: true,
            smartCriteria: criteria
        )

        playlists.append(playlist)
        savePlaylists()

        return playlist
    }

    /// Get a playlist by ID.
    func playlist(id: UUID) -> Playlist? {
        playlists.first { $0.id == id }
    }

    /// Update a playlist.
    func updatePlaylist(_ playlist: Playlist) {
        if let index = playlists.firstIndex(where: { $0.id == playlist.id }) {
            var updated = playlist
            updated.modifiedAt = Date()
            playlists[index] = updated
            savePlaylists()
        }
    }

    /// Delete a playlist.
    func deletePlaylist(id: UUID) {
        playlists.removeAll { $0.id == id }
        savePlaylists()
    }

    /// Delete multiple playlists.
    func deletePlaylists(at offsets: IndexSet) {
        playlists.remove(atOffsets: offsets)
        savePlaylists()
    }

    /// Rename a playlist.
    func renamePlaylist(id: UUID, to newName: String) {
        if let index = playlists.firstIndex(where: { $0.id == id }) {
            playlists[index].name = newName
            playlists[index].modifiedAt = Date()
            savePlaylists()
        }
    }

    /// Duplicate a playlist.
    @discardableResult
    func duplicatePlaylist(id: UUID) -> Playlist? {
        guard let original = playlist(id: id) else { return nil }

        var duplicate = original
        duplicate = Playlist(
            name: "\(original.name) Copy",
            description: original.description,
            items: original.items,
            artworkColor: original.artworkColor,
            iconName: original.iconName,
            isSmart: original.isSmart,
            smartCriteria: original.smartCriteria
        )

        playlists.append(duplicate)
        savePlaylists()

        return duplicate
    }

    // MARK: - Playlist Item Operations

    /// Add an article to a playlist.
    func addToPlaylist(
        playlistID: UUID,
        article: Article
    ) {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }) else { return }

        // Check if already in playlist
        guard !playlists[index].items.contains(where: { $0.articleID == article.id }) else { return }

        let item = PlaylistItem(from: article, sortOrder: playlists[index].items.count)
        playlists[index].addItem(item)
        savePlaylists()
    }

    /// Add a queue item to a playlist.
    func addToPlaylist(
        playlistID: UUID,
        queueItem: QueueItem
    ) {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }) else { return }

        // Check if already in playlist
        guard !playlists[index].items.contains(where: { $0.articleID == queueItem.articleID }) else { return }

        let item = PlaylistItem(from: queueItem, sortOrder: playlists[index].items.count)
        playlists[index].addItem(item)
        savePlaylists()
    }

    /// Add multiple articles to a playlist.
    func addToPlaylist(
        playlistID: UUID,
        articles: [Article]
    ) {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }) else { return }

        var startOrder = playlists[index].items.count

        for article in articles {
            // Skip if already in playlist
            guard !playlists[index].items.contains(where: { $0.articleID == article.id }) else { continue }

            let item = PlaylistItem(from: article, sortOrder: startOrder)
            playlists[index].items.append(item)
            startOrder += 1
        }

        playlists[index].modifiedAt = Date()
        savePlaylists()
    }

    /// Remove an item from a playlist.
    func removeFromPlaylist(
        playlistID: UUID,
        itemID: UUID
    ) {
        guard let playlistIndex = playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        guard let itemIndex = playlists[playlistIndex].items.firstIndex(where: { $0.id == itemID }) else { return }

        playlists[playlistIndex].removeItem(at: itemIndex)
        savePlaylists()
    }

    /// Remove an article from a playlist.
    func removeFromPlaylist(
        playlistID: UUID,
        articleID: UUID
    ) {
        guard let playlistIndex = playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        guard let itemIndex = playlists[playlistIndex].items.firstIndex(where: { $0.articleID == articleID }) else { return }

        playlists[playlistIndex].removeItem(at: itemIndex)
        savePlaylists()
    }

    /// Move items within a playlist.
    func moveItems(
        in playlistID: UUID,
        from source: IndexSet,
        to destination: Int
    ) {
        guard let index = playlists.firstIndex(where: { $0.id == playlistID }) else { return }

        playlists[index].moveItem(from: source, to: destination)

        // Update sort orders
        for (idx, item) in playlists[index].items.enumerated() {
            var updatedItem = item
            updatedItem.sortOrder = idx
            playlists[index].items[idx] = updatedItem
        }

        savePlaylists()
    }

    /// Update playback tracking for a playlist item.
    func updatePlaybackPosition(
        playlistID: UUID,
        articleID: UUID,
        position: TimeInterval
    ) {
        guard let playlistIndex = playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        guard let itemIndex = playlists[playlistIndex].items.firstIndex(where: { $0.articleID == articleID }) else { return }

        playlists[playlistIndex].items[itemIndex].lastPlayedPosition = position
        playlists[playlistIndex].items[itemIndex].lastPlayedAt = Date()
        savePlaylists()
    }

    /// Mark item as played.
    func markAsPlayed(
        playlistID: UUID,
        articleID: UUID
    ) {
        guard let playlistIndex = playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        guard let itemIndex = playlists[playlistIndex].items.firstIndex(where: { $0.articleID == articleID }) else { return }

        playlists[playlistIndex].items[itemIndex].playCount += 1
        playlists[playlistIndex].items[itemIndex].lastPlayedAt = Date()
        savePlaylists()
    }

    // MARK: - Smart Playlist Operations

    /// Refresh a smart playlist with matching articles.
    func refreshSmartPlaylist(
        id: UUID,
        articles: [Article]
    ) {
        guard let index = playlists.firstIndex(where: { $0.id == id }),
              playlists[index].isSmart,
              let criteria = playlists[index].smartCriteria else { return }

        // Filter matching articles
        var matchingArticles = articles.filter { criteria.matches($0) }

        // Sort
        switch criteria.sortBy {
        case .addedDate:
            matchingArticles.sort { criteria.sortAscending ? $0.importDate < $1.importDate : $0.importDate > $1.importDate }
        case .title:
            matchingArticles.sort { criteria.sortAscending ? $0.title < $1.title : $0.title > $1.title }
        case .duration:
            matchingArticles.sort { criteria.sortAscending ? $0.estimatedDuration < $1.estimatedDuration : $0.estimatedDuration > $1.estimatedDuration }
        case .author:
            matchingArticles.sort { criteria.sortAscending ? ($0.author ?? "") < ($1.author ?? "") : ($0.author ?? "") > ($1.author ?? "") }
        }

        // Apply limit
        if let limit = criteria.limit {
            matchingArticles = Array(matchingArticles.prefix(limit))
        }

        // Convert to playlist items
        let items = matchingArticles.enumerated().map { idx, article in
            PlaylistItem(from: article, sortOrder: idx)
        }

        playlists[index].items = items
        playlists[index].modifiedAt = Date()
        savePlaylists()
    }

    // MARK: - Search & Filter

    /// Search playlists by name.
    func search(_ query: String) -> [Playlist] {
        guard !query.isEmpty else { return playlists }

        let lowercasedQuery = query.lowercased()
        return playlists.filter {
            $0.name.lowercased().contains(lowercasedQuery) ||
            ($0.description?.lowercased().contains(lowercasedQuery) ?? false)
        }
    }

    /// Get playlists containing an article.
    func playlistsContaining(articleID: UUID) -> [Playlist] {
        playlists.filter { playlist in
            playlist.items.contains { $0.articleID == articleID }
        }
    }

    /// Check if an article is in any playlist.
    func isInAnyPlaylist(articleID: UUID) -> Bool {
        playlists.contains { playlist in
            playlist.items.contains { $0.articleID == articleID }
        }
    }

    // MARK: - Sorting

    /// Sort playlists.
    func sortPlaylists(by option: PlaylistSortOption) {
        switch option {
        case .name:
            playlists.sort { $0.name < $1.name }
        case .dateCreated:
            playlists.sort { $0.createdAt > $1.createdAt }
        case .dateModified:
            playlists.sort { $0.modifiedAt > $1.modifiedAt }
        case .itemCount:
            playlists.sort { $0.itemCount > $1.itemCount }
        case .duration:
            playlists.sort { $0.totalDuration > $1.totalDuration }
        }

        savePlaylists()
    }

    // MARK: - Default Playlists

    private func createDefaultPlaylistsIfNeeded() {
        guard playlists.isEmpty else { return }

        // Create "Favorites" playlist
        let favorites = Playlist(
            name: "Favorites",
            description: "Your favorite articles",
            artworkColor: .pink,
            iconName: "heart.fill"
        )

        // Create "Listen Later" smart playlist
        let listenLater = Playlist(
            name: "Listen Later",
            description: "Articles saved for later",
            artworkColor: .orange,
            iconName: "clock.fill"
        )

        // Create "Quick Reads" smart playlist
        let quickReads = Playlist(
            name: "Quick Reads",
            description: "Articles under 5 minutes",
            artworkColor: .green,
            iconName: "bolt.fill",
            isSmart: true,
            smartCriteria: SmartPlaylistCriteria(
                maxDuration: 300, // 5 minutes
                unplayedOnly: true,
                sortBy: .addedDate
            )
        )

        playlists = [favorites, listenLater, quickReads]
        savePlaylists()
    }

    // MARK: - Persistence

    private func savePlaylists() {
        do {
            let data = try JSONEncoder().encode(playlists)
            UserDefaults.standard.set(data, forKey: persistenceKey)
        } catch {
            print("Failed to save playlists: \(error)")
        }
    }

    private func loadPlaylists() {
        guard let data = UserDefaults.standard.data(forKey: persistenceKey) else { return }

        do {
            playlists = try JSONDecoder().decode([Playlist].self, from: data)
        } catch {
            print("Failed to load playlists: \(error)")
            playlists = []
        }
    }

    // MARK: - Export/Import

    /// Export playlists to JSON data.
    func exportPlaylists() throws -> Data {
        try JSONEncoder().encode(playlists)
    }

    /// Import playlists from JSON data.
    func importPlaylists(from data: Data, merge: Bool = true) throws {
        let imported = try JSONDecoder().decode([Playlist].self, from: data)

        if merge {
            // Add imported playlists, avoiding duplicates by name
            for playlist in imported {
                if !playlists.contains(where: { $0.name == playlist.name }) {
                    playlists.append(playlist)
                }
            }
        } else {
            playlists = imported
        }

        savePlaylists()
    }
}

// MARK: - Playlist Sort Option

enum PlaylistSortOption: String, CaseIterable, Sendable {
    case name
    case dateCreated
    case dateModified
    case itemCount
    case duration

    var displayName: String {
        switch self {
        case .name: return "Name"
        case .dateCreated: return "Date Created"
        case .dateModified: return "Recently Modified"
        case .itemCount: return "Number of Items"
        case .duration: return "Total Duration"
        }
    }
}

// MARK: - Playlist Manager Extensions

extension PlaylistManager {

    /// Get total statistics across all playlists.
    var statistics: (playlistCount: Int, totalItems: Int, totalDuration: TimeInterval) {
        let totalItems = playlists.reduce(0) { $0 + $1.itemCount }
        let totalDuration = playlists.reduce(0) { $0 + $1.totalDuration }
        return (playlists.count, totalItems, totalDuration)
    }

    /// Quick add to favorites.
    func addToFavorites(_ article: Article) {
        if let favorites = playlists.first(where: { $0.name == "Favorites" }) {
            addToPlaylist(playlistID: favorites.id, article: article)
        }
    }

    /// Check if article is in favorites.
    func isFavorite(articleID: UUID) -> Bool {
        guard let favorites = playlists.first(where: { $0.name == "Favorites" }) else { return false }
        return favorites.items.contains { $0.articleID == articleID }
    }

    /// Toggle favorite status.
    func toggleFavorite(_ article: Article) {
        guard let favorites = playlists.first(where: { $0.name == "Favorites" }) else { return }

        if favorites.items.contains(where: { $0.articleID == article.id }) {
            removeFromPlaylist(playlistID: favorites.id, articleID: article.id)
        } else {
            addToPlaylist(playlistID: favorites.id, article: article)
        }
    }
}
