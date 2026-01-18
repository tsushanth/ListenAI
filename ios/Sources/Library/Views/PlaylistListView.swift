import SwiftUI

// MARK: - Playlist List View

/// View displaying all user playlists.
struct PlaylistListView: View {
    @StateObject private var playlistManager = PlaylistManager.shared
    @State private var searchText = ""
    @State private var showingCreateSheet = false
    @State private var sortOption: PlaylistSortOption = .dateModified
    @State private var editMode: EditMode = .inactive

    private var filteredPlaylists: [Playlist] {
        if searchText.isEmpty {
            return playlistManager.playlists
        }
        return playlistManager.search(searchText)
    }

    var body: some View {
        NavigationStack {
            Group {
                if playlistManager.isEmpty && searchText.isEmpty {
                    emptyStateView
                } else {
                    playlistListView
                }
            }
            .navigationTitle("Playlists")
            .searchable(text: $searchText, prompt: "Search playlists")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !playlistManager.isEmpty {
                        EditButton()
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 16) {
                        Menu {
                            ForEach(PlaylistSortOption.allCases, id: \.self) { option in
                                Button(action: {
                                    sortOption = option
                                    playlistManager.sortPlaylists(by: option)
                                }) {
                                    HStack {
                                        Text(option.displayName)
                                        if sortOption == option {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                            }
                        } label: {
                            Image(systemName: "arrow.up.arrow.down")
                        }

                        Button(action: { showingCreateSheet = true }) {
                            Image(systemName: "plus")
                        }
                    }
                }
            }
            .environment(\.editMode, $editMode)
            .sheet(isPresented: $showingCreateSheet) {
                CreatePlaylistSheet()
            }
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        ContentUnavailableView {
            Label("No Playlists", systemImage: "music.note.list")
        } description: {
            Text("Create playlists to organize your articles.")
        } actions: {
            Button("Create Playlist") {
                showingCreateSheet = true
            }
            .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Playlist List

    private var playlistListView: some View {
        List {
            // Smart Playlists Section
            if !playlistManager.smartPlaylists.isEmpty {
                Section("Smart Playlists") {
                    ForEach(playlistManager.smartPlaylists) { playlist in
                        NavigationLink(value: playlist) {
                            PlaylistRow(playlist: playlist)
                        }
                    }
                    .onDelete { offsets in
                        let smartPlaylists = playlistManager.smartPlaylists
                        for index in offsets {
                            playlistManager.deletePlaylist(id: smartPlaylists[index].id)
                        }
                    }
                }
            }

            // Regular Playlists Section
            Section("My Playlists") {
                ForEach(filteredPlaylists.filter { !$0.isSmart }) { playlist in
                    NavigationLink(value: playlist) {
                        PlaylistRow(playlist: playlist)
                    }
                }
                .onDelete { offsets in
                    let regularPlaylists = filteredPlaylists.filter { !$0.isSmart }
                    for index in offsets {
                        playlistManager.deletePlaylist(id: regularPlaylists[index].id)
                    }
                }
            }

            // Statistics
            if !playlistManager.isEmpty {
                Section {
                    let stats = playlistManager.statistics
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(stats.playlistCount) playlist\(stats.playlistCount == 1 ? "" : "s")")
                        Text("\(stats.totalItems) total item\(stats.totalItems == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationDestination(for: Playlist.self) { playlist in
            PlaylistDetailView(playlist: playlist)
        }
    }
}

// MARK: - Playlist Row

struct PlaylistRow: View {
    let playlist: Playlist
    @State private var showingEditSheet = false

    var body: some View {
        HStack(spacing: 12) {
            // Playlist artwork
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(playlist.artworkColor.color.gradient)
                    .frame(width: 50, height: 50)

                Image(systemName: playlist.iconName)
                    .font(.title3)
                    .foregroundStyle(.white)

                if playlist.isSmart {
                    Image(systemName: "sparkle")
                        .font(.caption2)
                        .foregroundStyle(.white)
                        .offset(x: 16, y: -16)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(playlist.name)
                        .font(.headline)

                    if playlist.isSmart {
                        Image(systemName: "wand.and.stars")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 8) {
                    Text("\(playlist.itemCount) item\(playlist.itemCount == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if playlist.totalDuration > 0 {
                        Text("•")
                            .foregroundStyle(.secondary)

                        Text(playlist.totalDurationFormatted)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()
        }
        .contextMenu {
            Button(action: {
                QueueManager.shared.playPlaylist(playlist)
            }) {
                Label("Play", systemImage: "play.fill")
            }

            Button(action: {
                QueueManager.shared.addPlaylistToQueue(playlist, position: .next)
            }) {
                Label("Play Next", systemImage: "text.insert")
            }

            Button(action: {
                QueueManager.shared.addPlaylistToQueue(playlist, position: .last)
            }) {
                Label("Add to Queue", systemImage: "text.append")
            }

            Divider()

            Button(action: { showingEditSheet = true }) {
                Label("Edit", systemImage: "pencil")
            }

            Button(action: {
                PlaylistManager.shared.duplicatePlaylist(id: playlist.id)
            }) {
                Label("Duplicate", systemImage: "plus.square.on.square")
            }

            Divider()

            Button(role: .destructive, action: {
                PlaylistManager.shared.deletePlaylist(id: playlist.id)
            }) {
                Label("Delete", systemImage: "trash")
            }
        }
        .sheet(isPresented: $showingEditSheet) {
            EditPlaylistSheet(playlist: playlist)
        }
    }
}

// MARK: - Create Playlist Sheet

struct CreatePlaylistSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var playlistManager = PlaylistManager.shared

    @State private var name = ""
    @State private var description = ""
    @State private var selectedColor: CodableColor = .blue
    @State private var selectedIcon = "list.bullet"
    @State private var isSmart = false

    private let iconOptions = [
        "list.bullet", "heart.fill", "star.fill", "bookmark.fill",
        "folder.fill", "tag.fill", "clock.fill", "bolt.fill",
        "flame.fill", "leaf.fill", "brain.head.profile", "sparkles"
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Playlist Name", text: $name)

                    TextField("Description (optional)", text: $description, axis: .vertical)
                        .lineLimit(2...4)
                }

                Section("Appearance") {
                    // Color picker
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(CodableColor.allColors, id: \.self) { color in
                            Circle()
                                .fill(color.color)
                                .frame(width: 36, height: 36)
                                .overlay {
                                    if selectedColor == color {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.white)
                                            .font(.caption.bold())
                                    }
                                }
                                .onTapGesture {
                                    selectedColor = color
                                }
                        }
                    }
                    .padding(.vertical, 8)

                    // Icon picker
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(iconOptions, id: \.self) { icon in
                            ZStack {
                                Circle()
                                    .fill(selectedIcon == icon ? selectedColor.color : Color.secondary.opacity(0.2))
                                    .frame(width: 36, height: 36)

                                Image(systemName: icon)
                                    .foregroundStyle(selectedIcon == icon ? .white : .primary)
                            }
                            .onTapGesture {
                                selectedIcon = icon
                            }
                        }
                    }
                    .padding(.vertical, 8)
                }

                Section {
                    Toggle("Smart Playlist", isOn: $isSmart)
                } footer: {
                    Text("Smart playlists automatically include articles matching certain criteria.")
                }

                // Preview
                Section("Preview") {
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(selectedColor.color.gradient)
                                .frame(width: 50, height: 50)

                            Image(systemName: selectedIcon)
                                .font(.title3)
                                .foregroundStyle(.white)
                        }

                        VStack(alignment: .leading) {
                            Text(name.isEmpty ? "Playlist Name" : name)
                                .font(.headline)
                            Text("0 items")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("New Playlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        if isSmart {
                            playlistManager.createSmartPlaylist(
                                name: name,
                                criteria: SmartPlaylistCriteria(),
                                color: selectedColor,
                                iconName: selectedIcon
                            )
                        } else {
                            playlistManager.createPlaylist(
                                name: name,
                                description: description.isEmpty ? nil : description,
                                color: selectedColor,
                                iconName: selectedIcon
                            )
                        }
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

// MARK: - Edit Playlist Sheet

struct EditPlaylistSheet: View {
    let playlist: Playlist
    @Environment(\.dismiss) private var dismiss
    @StateObject private var playlistManager = PlaylistManager.shared

    @State private var name: String
    @State private var description: String
    @State private var selectedColor: CodableColor
    @State private var selectedIcon: String

    private let iconOptions = [
        "list.bullet", "heart.fill", "star.fill", "bookmark.fill",
        "folder.fill", "tag.fill", "clock.fill", "bolt.fill",
        "flame.fill", "leaf.fill", "brain.head.profile", "sparkles"
    ]

    init(playlist: Playlist) {
        self.playlist = playlist
        _name = State(initialValue: playlist.name)
        _description = State(initialValue: playlist.description ?? "")
        _selectedColor = State(initialValue: playlist.artworkColor)
        _selectedIcon = State(initialValue: playlist.iconName)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Playlist Name", text: $name)

                    TextField("Description (optional)", text: $description, axis: .vertical)
                        .lineLimit(2...4)
                }

                Section("Appearance") {
                    // Color picker
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(CodableColor.allColors, id: \.self) { color in
                            Circle()
                                .fill(color.color)
                                .frame(width: 36, height: 36)
                                .overlay {
                                    if selectedColor == color {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.white)
                                            .font(.caption.bold())
                                    }
                                }
                                .onTapGesture {
                                    selectedColor = color
                                }
                        }
                    }
                    .padding(.vertical, 8)

                    // Icon picker
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(iconOptions, id: \.self) { icon in
                            ZStack {
                                Circle()
                                    .fill(selectedIcon == icon ? selectedColor.color : Color.secondary.opacity(0.2))
                                    .frame(width: 36, height: 36)

                                Image(systemName: icon)
                                    .foregroundStyle(selectedIcon == icon ? .white : .primary)
                            }
                            .onTapGesture {
                                selectedIcon = icon
                            }
                        }
                    }
                    .padding(.vertical, 8)
                }

                Section {
                    Button(role: .destructive, action: {
                        playlistManager.deletePlaylist(id: playlist.id)
                        dismiss()
                    }) {
                        HStack {
                            Spacer()
                            Text("Delete Playlist")
                            Spacer()
                        }
                    }
                }
            }
            .navigationTitle("Edit Playlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var updated = playlist
                        updated.name = name
                        updated.description = description.isEmpty ? nil : description
                        updated.artworkColor = selectedColor
                        updated.iconName = selectedIcon
                        playlistManager.updatePlaylist(updated)
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

// MARK: - Add to Playlist Menu

/// Menu for adding an article to a playlist.
struct AddToPlaylistMenu: View {
    let article: Article
    @StateObject private var playlistManager = PlaylistManager.shared
    @State private var showingCreateSheet = false

    var body: some View {
        Menu {
            ForEach(playlistManager.playlists.filter { !$0.isSmart }) { playlist in
                Button(action: {
                    playlistManager.addToPlaylist(playlistID: playlist.id, article: article)
                }) {
                    Label {
                        Text(playlist.name)
                    } icon: {
                        if playlist.items.contains(where: { $0.articleID == article.id }) {
                            Image(systemName: "checkmark")
                        } else {
                            Image(systemName: playlist.iconName)
                        }
                    }
                }
            }

            Divider()

            Button(action: { showingCreateSheet = true }) {
                Label("New Playlist...", systemImage: "plus")
            }
        } label: {
            Label("Add to Playlist", systemImage: "text.badge.plus")
        }
        .sheet(isPresented: $showingCreateSheet) {
            CreatePlaylistSheet()
        }
    }
}

// MARK: - Preview

#Preview {
    PlaylistListView()
}
