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
            print("[QueueCoordinator] Article not found: \(item.articleID)")
            // Try next item
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
                    }
                )
                print("[QueueCoordinator] Playing cached audio: \(article.displayTitle)")
            } catch {
                print("[QueueCoordinator] Failed to play cached audio: \(error)")
                advanceToNextItem()
            }
        } else {
            // No cached audio - need to navigate to article for synthesis
            print("[QueueCoordinator] Article needs synthesis, posting notification")
            isPlayingFromQueue = false
            NotificationCenter.default.post(
                name: .openArticleForPlayback,
                object: nil,
                userInfo: ["articleId": article.id.uuidString]
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
}
