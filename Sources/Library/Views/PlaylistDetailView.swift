import SwiftUI

// MARK: - Playlist Detail View

/// Detailed view of a playlist showing all items.
struct PlaylistDetailView: View {
    let playlist: Playlist
    @StateObject private var playlistManager = PlaylistManager.shared
    @StateObject private var queueManager = QueueManager.shared
    @State private var editMode: EditMode = .inactive
    @State private var showingEditSheet = false
    @State private var showingDeleteConfirmation = false
    @State private var selectedItems: Set<UUID> = []
    @Environment(\.dismiss) private var dismiss

    // Get the live playlist from the manager
    private var livePlaylist: Playlist {
        playlistManager.playlist(id: playlist.id) ?? playlist
    }

    var body: some View {
        Group {
            if livePlaylist.isEmpty {
                emptyStateView
            } else {
                playlistContentView
            }
        }
        .navigationTitle(livePlaylist.name)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(action: {
                        queueManager.playPlaylist(livePlaylist)
                    }) {
                        Label("Play All", systemImage: "play.fill")
                    }

                    Button(action: {
                        queueManager.playPlaylist(livePlaylist)
                        queueManager.shuffleMode = .on
                    }) {
                        Label("Shuffle Play", systemImage: "shuffle")
                    }

                    Button(action: {
                        queueManager.addPlaylistToQueue(livePlaylist, position: .last)
                    }) {
                        Label("Add to Queue", systemImage: "text.append")
                    }

                    Divider()

                    Button(action: { showingEditSheet = true }) {
                        Label("Edit Playlist", systemImage: "pencil")
                    }

                    if !livePlaylist.isSmart {
                        Button(role: .destructive, action: { showingDeleteConfirmation = true }) {
                            Label("Delete Playlist", systemImage: "trash")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }

            if !livePlaylist.isEmpty && !livePlaylist.isSmart {
                ToolbarItem(placement: .topBarTrailing) {
                    EditButton()
                }
            }
        }
        .environment(\.editMode, $editMode)
        .sheet(isPresented: $showingEditSheet) {
            EditPlaylistSheet(playlist: livePlaylist)
        }
        .confirmationDialog(
            "Delete Playlist?",
            isPresented: $showingDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                playlistManager.deletePlaylist(id: playlist.id)
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete \"\(livePlaylist.name)\" and cannot be undone.")
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: 24) {
            // Playlist header
            playlistHeader

            Spacer()

            ContentUnavailableView {
                Label("No Items", systemImage: "music.note")
            } description: {
                if livePlaylist.isSmart {
                    Text("No articles match this playlist's criteria.")
                } else {
                    Text("Add articles to this playlist from your library.")
                }
            }

            Spacer()
        }
    }

    // MARK: - Playlist Content

    private var playlistContentView: some View {
        List {
            // Header Section
            Section {
                playlistHeader
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            // Play Controls
            Section {
                HStack(spacing: 12) {
                    Button(action: {
                        queueManager.playPlaylist(livePlaylist)
                    }) {
                        HStack {
                            Image(systemName: "play.fill")
                            Text("Play")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    Button(action: {
                        queueManager.playPlaylist(livePlaylist)
                        queueManager.shuffleMode = .on
                    }) {
                        HStack {
                            Image(systemName: "shuffle")
                            Text("Shuffle")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(Color.clear)
            }

            // Items Section
            Section {
                ForEach(livePlaylist.items) { item in
                    PlaylistItemRow(
                        item: item,
                        playlistID: livePlaylist.id,
                        onPlay: {
                            if let index = livePlaylist.items.firstIndex(where: { $0.id == item.id }) {
                                queueManager.playPlaylist(livePlaylist, startingAt: index)
                            }
                        }
                    )
                }
                .onDelete { offsets in
                    for index in offsets {
                        let item = livePlaylist.items[index]
                        playlistManager.removeFromPlaylist(playlistID: livePlaylist.id, itemID: item.id)
                    }
                }
                .onMove { source, destination in
                    playlistManager.moveItems(in: livePlaylist.id, from: source, to: destination)
                }
            } header: {
                HStack {
                    Text("\(livePlaylist.itemCount) items")
                    Spacer()
                    Text(livePlaylist.totalDurationFormatted)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Playlist Header

    private var playlistHeader: some View {
        VStack(spacing: 16) {
            // Artwork
            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .fill(livePlaylist.artworkColor.color.gradient)
                    .frame(width: 140, height: 140)
                    .shadow(color: livePlaylist.artworkColor.color.opacity(0.4), radius: 10, y: 5)

                Image(systemName: livePlaylist.iconName)
                    .font(.system(size: 48))
                    .foregroundStyle(.white)

                if livePlaylist.isSmart {
                    Image(systemName: "sparkle")
                        .font(.title3)
                        .foregroundStyle(.white)
                        .offset(x: 50, y: -50)
                }
            }

            VStack(spacing: 4) {
                Text(livePlaylist.name)
                    .font(.title2.bold())

                if let description = livePlaylist.description {
                    Text(description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                if livePlaylist.isSmart {
                    Label("Smart Playlist", systemImage: "wand.and.stars")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }
}

// MARK: - Playlist Item Row

struct PlaylistItemRow: View {
    let item: PlaylistItem
    let playlistID: UUID
    let onPlay: () -> Void

    @StateObject private var playlistManager = PlaylistManager.shared
    @StateObject private var queueManager = QueueManager.shared

    var body: some View {
        Button(action: onPlay) {
            HStack(spacing: 12) {
                // Artwork
                ZStack {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.gray.opacity(0.2))
                        .frame(width: 44, height: 44)

                    Image(systemName: item.sourceType.iconName)
                        .foregroundStyle(.secondary)
                }

                // Content
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

                    // Progress indicator if partially played
                    if item.lastPlayedPosition > 0 && item.lastPlayedPosition < item.duration {
                        GeometryReader { geometry in
                            ZStack(alignment: .leading) {
                                Capsule()
                                    .fill(Color.secondary.opacity(0.2))
                                    .frame(height: 3)

                                Capsule()
                                    .fill(Color.blue)
                                    .frame(
                                        width: geometry.size.width * CGFloat(item.lastPlayedPosition / item.duration),
                                        height: 3
                                    )
                            }
                        }
                        .frame(height: 3)
                    }
                }

                Spacer()

                // Play count badge
                if item.playCount > 0 {
                    Text("\(item.playCount)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: onPlay) {
                Label("Play", systemImage: "play.fill")
            }

            Button(action: {
                let queueItem = QueueItem(
                    articleID: item.articleID,
                    title: item.title,
                    author: item.author,
                    siteName: item.siteName,
                    sourceType: item.sourceType,
                    duration: item.duration,
                    heroImageURL: item.heroImageURL
                )
                queueManager.addToQueue(queueItem, position: .next)
            }) {
                Label("Play Next", systemImage: "text.insert")
            }

            Button(action: {
                let queueItem = QueueItem(
                    articleID: item.articleID,
                    title: item.title,
                    author: item.author,
                    siteName: item.siteName,
                    sourceType: item.sourceType,
                    duration: item.duration,
                    heroImageURL: item.heroImageURL
                )
                queueManager.addToQueue(queueItem, position: .last)
            }) {
                Label("Add to Queue", systemImage: "text.append")
            }

            Divider()

            Button(role: .destructive, action: {
                playlistManager.removeFromPlaylist(playlistID: playlistID, itemID: item.id)
            }) {
                Label("Remove from Playlist", systemImage: "minus.circle")
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                playlistManager.removeFromPlaylist(playlistID: playlistID, itemID: item.id)
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                let queueItem = QueueItem(
                    articleID: item.articleID,
                    title: item.title,
                    author: item.author,
                    siteName: item.siteName,
                    sourceType: item.sourceType,
                    duration: item.duration,
                    heroImageURL: item.heroImageURL
                )
                queueManager.addToQueue(queueItem, position: .next)
            } label: {
                Label("Play Next", systemImage: "text.insert")
            }
            .tint(.blue)
        }
    }
}

// MARK: - Compact Playlist Card

/// A compact card view for displaying a playlist.
struct PlaylistCard: View {
    let playlist: Playlist
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                // Artwork
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(playlist.artworkColor.color.gradient)
                        .frame(height: 100)

                    Image(systemName: playlist.iconName)
                        .font(.largeTitle)
                        .foregroundStyle(.white)

                    if playlist.isSmart {
                        VStack {
                            HStack {
                                Spacer()
                                Image(systemName: "sparkle")
                                    .font(.caption)
                                    .foregroundStyle(.white)
                                    .padding(6)
                            }
                            Spacer()
                        }
                    }
                }

                // Info
                VStack(alignment: .leading, spacing: 2) {
                    Text(playlist.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text("\(playlist.itemCount) items")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Playlist Grid

/// A grid view of playlists.
struct PlaylistGrid: View {
    let playlists: [Playlist]
    let columns: Int
    let onSelect: (Playlist) -> Void

    init(
        playlists: [Playlist],
        columns: Int = 2,
        onSelect: @escaping (Playlist) -> Void
    ) {
        self.playlists = playlists
        self.columns = columns
        self.onSelect = onSelect
    }

    private var gridColumns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 16), count: columns)
    }

    var body: some View {
        LazyVGrid(columns: gridColumns, spacing: 16) {
            ForEach(playlists) { playlist in
                PlaylistCard(playlist: playlist) {
                    onSelect(playlist)
                }
            }
        }
        .padding(.horizontal)
    }
}

// MARK: - Favorites Button

/// Quick toggle button for adding/removing from favorites.
struct FavoritesButton: View {
    let article: Article
    @StateObject private var playlistManager = PlaylistManager.shared

    var isFavorite: Bool {
        playlistManager.isFavorite(articleID: article.id)
    }

    var body: some View {
        Button(action: {
            playlistManager.toggleFavorite(article)
        }) {
            Image(systemName: isFavorite ? "heart.fill" : "heart")
                .foregroundStyle(isFavorite ? .red : .secondary)
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        PlaylistDetailView(
            playlist: Playlist(
                name: "Test Playlist",
                description: "A sample playlist for testing",
                items: [
                    PlaylistItem(
                        articleID: UUID(),
                        title: "Sample Article",
                        author: "John Doe",
                        duration: 300
                    )
                ],
                artworkColor: .purple,
                iconName: "star.fill"
            )
        )
    }
}
