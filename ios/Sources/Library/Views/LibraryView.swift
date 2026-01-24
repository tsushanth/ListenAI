import SwiftUI

// MARK: - Library Filter

enum LibraryFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case `continue` = "Continue"
    case finished = "Finished"
    case favorites = "Favorites"
    case folders = "Folders"
    case downloaded = "Downloaded"

    var id: String { rawValue }

    var icon: String? {
        switch self {
        case .favorites: return "heart.fill"
        case .folders: return "folder.fill"
        case .downloaded: return "arrow.down.circle.fill"
        default: return nil
        }
    }
}

// MARK: - Library View

/// Main library view displaying user's articles with filtering and search.
struct LibraryView: View {
    @EnvironmentObject var playbackService: AudioPlaybackService
    @EnvironmentObject var queueManager: QueueManager
    @ObservedObject private var articleStore = ArticleStore.shared

    @State private var selectedFilter: LibraryFilter = .all
    @State private var searchText = ""
    @State private var showingImportPicker = false
    @State private var selectedImportType: ImportType?
    @State private var showingSort = false
    @State private var sortOrder: SortOrder = .dateAdded
    @State private var selectedArticle: Article?
    @State private var showingUsageQuota = false
    @State private var showingUpgrade = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                // Filter chips
                filterChipsSection

                // Content
                if filteredArticles.isEmpty {
                    emptyStateView
                } else {
                    articleListView
                }
            }
            .background(Color(.systemGroupedBackground))

            // Floating Action Button
            fabButton
        }
        .navigationTitle("My Library")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 8) {
                    // Usage quota badge
                    Button {
                        showingUsageQuota = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chart.bar.fill")
                                .font(.caption2)
                            Text("Usage")
                                .font(.caption.bold())
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.blue.opacity(0.15))
                        .foregroundStyle(.blue)
                        .clipShape(Capsule())
                    }

                    // PRO Badge
                    Button {
                        showingUpgrade = true
                    } label: {
                        Text("PRO")
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.green)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .sheet(isPresented: $showingUsageQuota) {
            NavigationStack {
                UsageQuotaView()
            }
        }
        .sheet(isPresented: $showingUpgrade) {
            UpgradePromptView()
        }
        .searchable(text: $searchText, prompt: "Search articles")
        .sheet(isPresented: $showingImportPicker) {
            ImportPickerSheet(selectedImportType: $selectedImportType)
        }
        .sheet(item: $selectedImportType) { importType in
            ImportSheetView(initialType: importType)
        }
        .onChange(of: selectedImportType) { _, newValue in
            // Reset mini player visibility when import sheet is dismissed
            if newValue == nil {
                AudioPlaybackService.shared.isArticleReaderActive = false
            }
        }
        .navigationDestination(item: $selectedArticle) { article in
            ArticleReaderView(article: article)
        }
        .onChange(of: selectedArticle) { _, newValue in
            // Reset mini player visibility when navigating away from article
            if newValue == nil {
                AudioPlaybackService.shared.isArticleReaderActive = false
            }
        }
    }

    // MARK: - Filter Chips

    private var filterChipsSection: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(LibraryFilter.allCases) { filter in
                    FilterChip(
                        title: filter.rawValue,
                        icon: filter.icon,
                        isSelected: selectedFilter == filter
                    ) {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            selectedFilter = filter
                        }
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
        }
        .background(Color(.systemBackground))
    }

    // MARK: - Article List

    private var articleListView: some View {
        List {
            ForEach(filteredArticles) { article in
                ArticleRowCard(
                    article: article,
                    onPlay: {
                        selectedArticle = article
                    },
                    onQueue: {
                        queueManager.addToQueue(article, position: .last)
                    },
                    onFavorite: {
                        articleStore.toggleFavorite(article)
                    },
                    onShare: {
                        shareArticle(article)
                    },
                    onDelete: {
                        articleStore.deleteArticle(article)
                    }
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    selectedArticle = article
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        articleStore.deleteArticle(article)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }

                    Button {
                        queueManager.addToQueue(article, position: .last)
                    } label: {
                        Label("Queue", systemImage: "text.badge.plus")
                    }
                    .tint(.blue)
                }
                .swipeActions(edge: .leading) {
                    Button {
                        articleStore.toggleFavorite(article)
                    } label: {
                        Label("Favorite", systemImage: article.isFavorite ? "heart.slash" : "heart")
                    }
                    .tint(.pink)
                }
            }
        }
        .listStyle(.plain)
    }

    private func shareArticle(_ article: Article) {
        let text = "\(article.displayTitle)\n\n\(article.rawText.prefix(500))..."
        let activityVC = UIActivityViewController(activityItems: [text], applicationActivities: nil)

        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first,
           let rootVC = window.rootViewController {
            rootVC.present(activityVC, animated: true)
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        ContentUnavailableView {
            Label(emptyStateTitle, systemImage: emptyStateIcon)
        } description: {
            Text(emptyStateDescription)
        } actions: {
            Button("Add Content") {
                showingImportPicker = true
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var emptyStateTitle: String {
        switch selectedFilter {
        case .all: return "No Articles Yet"
        case .continue: return "Nothing in Progress"
        case .finished: return "Nothing Finished"
        case .favorites: return "No Favorites"
        case .folders: return "No Folders"
        case .downloaded: return "Nothing Downloaded"
        }
    }

    private var emptyStateIcon: String {
        switch selectedFilter {
        case .all: return "doc.text"
        case .continue: return "play.circle"
        case .finished: return "checkmark.circle"
        case .favorites: return "heart"
        case .folders: return "folder"
        case .downloaded: return "arrow.down.circle"
        }
    }

    private var emptyStateDescription: String {
        switch selectedFilter {
        case .all: return "Add articles from web links, documents, or paste text."
        case .continue: return "Start listening to see your in-progress items here."
        case .finished: return "Completed articles will appear here."
        case .favorites: return "Mark articles as favorites to find them quickly."
        case .folders: return "Organize your articles into folders."
        case .downloaded: return "Download articles for offline listening."
        }
    }

    // MARK: - FAB Button

    private var fabButton: some View {
        Button {
            showingImportPicker = true
        } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Color.blue)
                .clipShape(Circle())
                .shadow(color: .blue.opacity(0.3), radius: 8, x: 0, y: 4)
        }
        .padding(.trailing, 20)
        .padding(.bottom, 20)
        .accessibilityLabel("Add new content")
        .accessibilityHint("Double tap to import articles")
    }

    // MARK: - Filtered Articles

    private var filteredArticles: [Article] {
        var result = articleStore.articles

        // Apply filter
        switch selectedFilter {
        case .all:
            break
        case .continue:
            result = result.filter { !$0.isCompleted && $0.listenedDuration > 0 }
        case .finished:
            result = result.filter { $0.isCompleted }
        case .favorites:
            result = result.filter { $0.isFavorite }
        case .folders:
            // TODO: Folder filtering
            break
        case .downloaded:
            result = result.filter { $0.audioFileURL != nil }
        }

        // Apply search
        if !searchText.isEmpty {
            result = result.filter {
                $0.title.localizedCaseInsensitiveContains(searchText) ||
                ($0.author?.localizedCaseInsensitiveContains(searchText) ?? false)
            }
        }

        // Apply sort
        switch sortOrder {
        case .dateAdded:
            result.sort { $0.createdAt > $1.createdAt }
        case .title:
            result.sort { $0.title < $1.title }
        case .author:
            result.sort { ($0.author ?? "") < ($1.author ?? "") }
        case .duration:
            result.sort { $0.estimatedDuration > $1.estimatedDuration }
        }

        return result
    }
}

// MARK: - Sort Order

enum SortOrder: String, CaseIterable {
    case dateAdded = "date_added"
    case title = "title"
    case author = "author"
    case duration = "duration"

    var displayName: String {
        switch self {
        case .dateAdded: return "Date Added"
        case .title: return "Title"
        case .author: return "Author"
        case .duration: return "Duration"
        }
    }
}

// MARK: - Filter Chip

struct FilterChip: View {
    let title: String
    let icon: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let icon = icon {
                    Image(systemName: icon)
                        .font(.caption)
                }
                Text(title)
                    .font(.subheadline.weight(isSelected ? .semibold : .regular))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(isSelected ? Color.primary : Color(.secondarySystemBackground))
            .foregroundStyle(isSelected ? Color(.systemBackground) : .primary)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Article Row Card

struct ArticleRowCard: View {
    let article: Article
    let onPlay: () -> Void
    let onQueue: () -> Void
    let onFavorite: () -> Void
    let onShare: () -> Void
    let onDelete: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 12) {
            // Thumbnail with synthesis status overlay
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(thumbnailColor)
                    .frame(width: 56, height: 56)

                // Show different icons based on synthesis status
                if article.synthesisStatus.isInProgress {
                    // Animated progress indicator
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        .scaleEffect(0.8)
                } else if case .queued = article.synthesisStatus {
                    // Queued icon
                    Image(systemName: "clock.fill")
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.8))
                } else if article.synthesisStatus.isComplete {
                    // Ready to play
                    Image(systemName: "play.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                } else if case .failed = article.synthesisStatus {
                    // Failed icon
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.white)
                } else {
                    // Default source icon
                    Image(systemName: article.sourceType.iconName)
                        .font(.title3)
                        .foregroundStyle(.white)
                }
            }

            // Content
            VStack(alignment: .leading, spacing: 4) {
                // Title with ellipsis prefix for truncated text (like reference)
                HStack(spacing: 2) {
                    Text("···")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                    Text(article.displayTitle)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                }

                // Synthesis status row or metadata row
                if !article.synthesisStatus.isComplete && !isNotStarted {
                    synthesisStatusRow
                } else {
                    metadataRow
                }
            }

            Spacer()

            // Context menu button (vertical ellipsis like reference)
            Menu {
                Button(action: onPlay) {
                    Label("Play", systemImage: "play.fill")
                }

                Button(action: onQueue) {
                    Label("Add to Queue", systemImage: "text.badge.plus")
                }

                Divider()

                Button(action: onFavorite) {
                    Label(article.isFavorite ? "Unfavorite" : "Favorite",
                          systemImage: article.isFavorite ? "heart.slash" : "heart")
                }

                Button(action: onShare) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }

                Divider()

                Button(role: .destructive, action: onDelete) {
                    Label("Delete", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(90)) // Vertical ellipsis like reference
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Helper Views

    private var synthesisStatusRow: some View {
        HStack(spacing: 4) {
            if article.synthesisStatus.isInProgress {
                Image(systemName: "waveform")
                    .font(.caption)
                    .foregroundStyle(.blue)
                    .symbolEffect(.variableColor.iterative)
                Text("Preparing audio...")
                    .font(.caption)
                    .foregroundStyle(.blue)
            } else if case .queued(let position) = article.synthesisStatus {
                Image(systemName: "clock")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Text("Queued #\(position)")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if case .failed(let message) = article.synthesisStatus {
                Image(systemName: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
                Text(message.prefix(30) + (message.count > 30 ? "..." : ""))
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(1)
            }
            Spacer()
        }
    }

    private var metadataRow: some View {
        HStack(spacing: 4) {
            Text(article.createdAt.formatted(.dateTime.month(.abbreviated).day()))
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("•")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(article.sourceType.displayName)
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("•")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(article.estimatedDurationFormatted + " left")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Helper Properties

    private var isNotStarted: Bool {
        if case .notStarted = article.synthesisStatus { return true }
        return false
    }

    private var thumbnailColor: Color {
        switch article.sourceType {
        case .web: return .blue
        case .pdf: return .red
        case .clipboard: return .purple
        case .file: return .orange
        case .manual: return .green
        }
    }
}

// MARK: - Article Extensions

extension Article {
    var estimatedDurationFormatted: String {
        let minutes = Int(estimatedDuration / 60)
        if minutes < 1 {
            return "< 1 min"
        } else if minutes == 1 {
            return "1 min"
        } else {
            return "\(minutes) min"
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        LibraryView()
            .environmentObject(AudioPlaybackService.shared)
            .environmentObject(QueueManager.shared)
    }
}
