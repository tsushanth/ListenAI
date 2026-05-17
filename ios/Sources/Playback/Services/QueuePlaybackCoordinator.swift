import Foundation
import Combine

// MARK: - Queue Playback Coordinator

/// Coordinates playback between QueueManager and URLAudioPlayer.
/// Handles auto-advance to next item when current playback completes.
@MainActor
final class QueuePlaybackCoordinator: ObservableObject {

    // MARK: - Published State

    @Published private(set) var isPlayingFromQueue: Bool = false

    // MARK: - Properties

    private let queueManager = QueueManager.shared
    private let urlPlayer = URLAudioPlayer.shared
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Singleton

    static let shared = QueuePlaybackCoordinator()

    private init() {
        setupQueueCallbacks()
    }

    // MARK: - Setup

    private func setupQueueCallbacks() {
        // When queue item changes (from next/previous or user tap), auto-play if we're in queue mode
        queueManager.onCurrentItemChanged = { [weak self] item in
            guard let self = self else { return }
            // If we're playing from queue, continue with the new item
            if self.isPlayingFromQueue, let item = item {
                Task { @MainActor in
                    await self.playQueueItem(item)
                }
            }
        }

        // When queue is exhausted, reset our state
        queueManager.onQueueExhausted = { [weak self] in
            self?.isPlayingFromQueue = false
        }
    }

    // MARK: - Public Methods

    /// Start playing from the queue (from first item or current)
    func playQueue() async {
        guard !queueManager.isEmpty else { return }

        isPlayingFromQueue = true

        // If there's a current item, play it; otherwise start from first
        if let currentItem = queueManager.currentItem {
            await playQueueItem(currentItem)
        } else {
            // Start from beginning
            queueManager.play(at: 0)
            if let firstItem = queueManager.currentItem {
                await playQueueItem(firstItem)
            }
        }
    }

    /// Play a specific queue item
    func playQueueItem(_ item: QueueItem) async {
        // Get the article from ArticleStore
        guard let article = ArticleStore.shared.article(withID: item.articleID) else {
            // Item points to an article that was never saved to the library
            // (e.g., legacy email imports before the saveToLibrary fix). The
            // user just tapped "Play" and would otherwise see nothing happen,
            // so surface the failure visibly.
            print("[QueueCoordinator] Article not found in library: \(item.articleID)")
            NotificationCenter.default.post(
                name: .queuePlaybackFailed,
                object: nil,
                userInfo: [
                    "title": item.title,
                    "reason": "This item is no longer in your library."
                ]
            )
            advanceToNextItem()
            return
        }

        // Check if article has cached audio
        if let audioURL = article.audioFileURL {
            do {
                try await urlPlayer.play(
                    url: audioURL,
                    articleID: article.id,
                    title: article.displayTitle,
                    artist: article.author ?? article.siteName,
                    startPosition: item.lastPlayedPosition,
                    mode: .full,
                    previewDuration: nil,
                    onComplete: { [weak self] in
                        Task { @MainActor in
                            self?.handlePlaybackComplete()
                        }
                    },
                    onError: { [weak self] message in
                        // AVFoundation failed asynchronously — typically a
                        // cached .mp3 that was truncated or never finished
                        // writing (we've seen Code=-17913 / duration=0 on
                        // these). Clear the broken URL and re-route through
                        // synthesis so the user sees real progress instead
                        // of a stuck "playing 0.0s".
                        Task { @MainActor in
                            self?.handleBrokenCachedAudio(article: article, item: item, message: message)
                        }
                    }
                )
                print("[QueueCoordinator] Playing cached audio: \(article.displayTitle)")
            } catch {
                print("[QueueCoordinator] Failed to play cached audio: \(error)")
                advanceToNextItem()
            }
        } else {
            // No cached audio yet — open the reader and tell it to start
            // playback automatically (which kicks off synthesis). The user
            // tapping "Play Queue" is the play intent; popping up the reader
            // without auto-starting is what made this look broken before.
            print("[QueueCoordinator] Article needs synthesis, opening reader with autoPlay")
            NotificationCenter.default.post(
                name: .openArticleForPlayback,
                object: nil,
                userInfo: [
                    "articleId": article.id.uuidString,
                    "autoPlay": true
                ]
            )
        }
    }

    /// Skip to next item in queue
    func skipToNext() {
        guard isPlayingFromQueue else { return }
        advanceToNextItem()
    }

    /// Skip to previous item in queue
    func skipToPrevious() {
        guard isPlayingFromQueue else { return }
        if let _ = queueManager.previous() {
            // onCurrentItemChanged will handle playback
        }
    }

    /// Stop queue playback
    func stopQueuePlayback() {
        isPlayingFromQueue = false
        urlPlayer.stop()
    }

    // MARK: - Private Methods

    private func handlePlaybackComplete() {
        guard isPlayingFromQueue else { return }

        // Mark current item as completed
        queueManager.itemCompleted()

        // itemCompleted() handles auto-advance via next() which triggers onCurrentItemChanged
    }

    /// AVFoundation reported that the cached audio for `article` is unusable.
    /// Reset the article's synthesis state so the next play attempt re-runs
    /// synthesis, then open the reader so the user sees something happening
    /// instead of a silent stall. Also delete the broken file from disk —
    /// otherwise the cache lookup will keep handing it back.
    private func handleBrokenCachedAudio(article: Article, item: QueueItem, message: String) {
        print("[QueueCoordinator] Broken cached audio for \(article.displayTitle): \(message). Clearing and re-routing through synthesis.")

        if let brokenURL = article.audioFileURL, brokenURL.isFileURL {
            try? FileManager.default.removeItem(at: brokenURL)
        }

        ArticleStore.shared.clearAudioFile(for: article.id)

        urlPlayer.stop()

        NotificationCenter.default.post(
            name: .openArticleForPlayback,
            object: nil,
            userInfo: [
                "articleId": article.id.uuidString,
                "autoPlay": true
            ]
        )
    }

    private func advanceToNextItem() {
        // This calls next() which triggers onCurrentItemChanged if there's a next item
        if queueManager.next() == nil {
            // No more items
            isPlayingFromQueue = false
        }
    }
}

// MARK: - Notification Names

extension Notification.Name {
    /// Posted when user needs to open an article for playback (e.g., queue item needs synthesis)
    static let openArticleForPlayback = Notification.Name("openArticleForPlayback")
    /// Posted when a child view wants to switch the parent TabView to a specific tab.
    /// userInfo: ["tab": Int] — 0=Home, 1=Library, 2=Queue, 3=Settings.
    static let switchTab = Notification.Name("switchTab")
    /// Posted when a queue item can't be played (article gone, audio missing, etc.).
    /// userInfo: ["title": String, "reason": String]. Listened for by the Queue view.
    static let queuePlaybackFailed = Notification.Name("queuePlaybackFailed")
}
