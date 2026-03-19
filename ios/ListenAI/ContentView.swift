import SwiftUI

// MARK: - Content View

/// Main app container with 3-tab navigation: Home, Library, Settings.
struct ContentView: View {
    @EnvironmentObject var playbackService: AudioPlaybackService
    @EnvironmentObject var queueManager: QueueManager
    @EnvironmentObject var usageTracker: UsageTrackerService
    @ObservedObject private var urlPlayer = URLAudioPlayer.shared
    @State private var selectedTab = 0
    @State private var showingPlayer = false
    @State private var articleToOpen: Article?
    @State private var showingQueue = false
    @State private var showingFeedbackPrompt = false

    /// Whether any playback is active (from either player)
    private var hasActivePlayback: Bool {
        playbackService.currentItem != nil || urlPlayer.currentArticleID != nil
    }

    /// Whether using URL player (job-based) vs traditional playback
    private var isUsingURLPlayer: Bool {
        urlPlayer.currentArticleID != nil && urlPlayer.state.isActive
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedTab) {
                // Home Tab
                NavigationStack {
                    HomeView()
                }
                .tabItem {
                    Label("Home", systemImage: "house.fill")
                }
                .tag(0)

                // Library Tab
                NavigationStack {
                    LibraryView()
                }
                .tabItem {
                    Label("My Library", systemImage: "doc.fill")
                }
                .tag(1)

                // Queue Tab
                NavigationStack {
                    ListeningQueueView()
                }
                .tabItem {
                    Label("Queue", systemImage: "list.bullet")
                }
                .tag(2)

                // Settings Tab
                NavigationStack {
                    SettingsView()
                }
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
                .tag(3)
            }

            // Mini Player Overlay - hidden when ArticleReaderView is showing its own player
            VStack(spacing: 0) {
                Spacer()
                if hasActivePlayback && !playbackService.isArticleReaderActive {
                    MiniPlayerView(playbackService: playbackService)
                        .onTapGesture {
                            handleMiniPlayerTap()
                        }
                        .padding(.bottom, 49) // Tab bar height
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        .fullScreenCover(item: $articleToOpen) { article in
            // Open ArticleReaderView when tapping mini player during URL playback
            NavigationStack {
                ArticleReaderView(article: article)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") {
                                articleToOpen = nil
                            }
                        }
                    }
            }
        }
        .onChange(of: playbackService.isArticleReaderActive) { _, newValue in
            print("[ContentView] isArticleReaderActive changed to: \(newValue)")
        }
        .onChange(of: playbackService.currentItem?.id) { _, newValue in
            print("[ContentView] currentItem changed to: \(newValue?.uuidString ?? "nil")")
        }
        .onChange(of: urlPlayer.currentArticleID) { _, newValue in
            print("[ContentView] urlPlayer.currentArticleID changed to: \(newValue?.uuidString ?? "nil")")
        }
        .animation(.easeInOut(duration: 0.25), value: playbackService.isArticleReaderActive)
        .animation(.easeInOut(duration: 0.25), value: playbackService.currentItem?.id)
        .animation(.easeInOut(duration: 0.25), value: urlPlayer.currentArticleID)
        .sheet(isPresented: $showingPlayer) {
            AudioPlayerView(playbackService: playbackService)
        }
        .sheet(isPresented: $showingQueue) {
            QueueSheet()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openArticleForPlayback)) { notification in
            // Handle request to open article for playback (e.g., from queue when synthesis needed)
            if let articleIdString = notification.userInfo?["articleId"] as? String,
               let articleId = UUID(uuidString: articleIdString),
               let article = ArticleStore.shared.article(withID: articleId) {
                articleToOpen = article
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AppReviewService.shouldShowFeedbackPromptNotification)) { _ in
            showingFeedbackPrompt = true
        }
        .sheet(isPresented: $showingFeedbackPrompt) {
            FeedbackPromptView(
                onYes: {
                    AppReviewService.shared.requestAppStoreReview()
                },
                onNo: {
                    AppReviewService.shared.userNotEnjoying()
                }
            )
            .presentationDetents([.height(280)])
            .presentationDragIndicator(.visible)
        }
    }

    // MARK: - Actions

    /// Handle mini player tap - always opens ArticleReaderView for the current article
    private func handleMiniPlayerTap() {
        // First try URL player (job-based TTS)
        if isUsingURLPlayer {
            if let articleId = urlPlayer.currentArticleID,
               let article = ArticleStore.shared.article(withID: articleId) {
                articleToOpen = article
                return
            }
        }

        // Then try traditional playback service
        if let currentItem = playbackService.currentItem,
           let article = ArticleStore.shared.article(withID: currentItem.id) {
            articleToOpen = article
            return
        }

        // Fallback to AudioPlayerView if we can't find the article
        showingPlayer = true
    }
}

// MARK: - Article Row (for Library compatibility)

struct ArticleRow: View {
    let article: Article
    @EnvironmentObject var queueManager: QueueManager

    var body: some View {
        HStack(spacing: 12) {
            // Source icon
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(article.sourceType.accentColor.opacity(0.2))
                    .frame(width: 50, height: 50)

                Image(systemName: article.sourceType.iconName)
                    .font(.title2)
                    .foregroundColor(article.sourceType.accentColor)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(article.displayTitle)
                    .font(.headline)
                    .lineLimit(2)

                Text(article.displayAuthor)
                    .font(.subheadline)
                    .foregroundColor(.secondary)

                HStack {
                    Text(article.estimatedDuration.formattedDurationShort)
                        .font(.caption)
                        .foregroundColor(.secondary)

                    if article.synthesisStatus.isComplete {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundColor(.green)
                    }
                }
            }

            Spacer()
        }
        .contentShape(Rectangle())
        .swipeActions(edge: .trailing) {
            Button {
                queueManager.addToQueue(article, position: .last)
            } label: {
                Label("Queue", systemImage: "text.badge.plus")
            }
            .tint(.blue)
        }
    }
}

// MARK: - Sample Data Extension

extension Article {
    static var sampleArticles: [Article] {
        [
            Article(
                sourceType: .web,
                sourceURL: URL(string: "https://example.com/article1"),
                title: "The Future of AI in Education",
                author: "Jane Smith",
                siteName: "Tech Today",
                rawText: "Artificial intelligence is transforming education in unprecedented ways...",
                synthesisStatus: .completed
            ),
            Article(
                sourceType: .pdf,
                sourceFileName: "research-paper.pdf",
                title: "Climate Change: A Comprehensive Overview",
                author: "Dr. Robert Johnson",
                rawText: "Climate change poses significant challenges to our planet...",
                synthesisStatus: .notStarted
            ),
            Article(
                sourceType: .clipboard,
                title: "Quick Notes from Meeting",
                rawText: "Key points discussed in today's meeting included...",
                synthesisStatus: .inProgress(progress: 0.45)
            )
        ]
    }
}

// MARK: - Preview

#Preview {
    ContentView()
        .environmentObject(AudioPlaybackService.shared)
        .environmentObject(QueueManager.shared)
        .environmentObject(UsageTrackerService.shared)
}
