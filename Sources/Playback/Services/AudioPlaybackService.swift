import Foundation
import AVFoundation
import Combine
import MediaPlayer

// MARK: - Audio Playback Service

/// Main service for audio playback with background support, control center integration,
/// and position persistence. Works like a podcast player.
@MainActor
final class AudioPlaybackService: NSObject, ObservableObject {

    // MARK: - Published State

    @Published private(set) var state: PlaybackState = .idle
    @Published private(set) var currentItem: NowPlayingItem?
    @Published private(set) var progress: PlaybackProgress = .zero
    @Published private(set) var playbackSpeed: PlaybackSpeed = .normal
    @Published private(set) var sleepTimer: SleepTimerOption = .off
    @Published private(set) var repeatMode: RepeatMode = .off

    // Queue
    @Published private(set) var queue: [QueueItem] = []
    @Published private(set) var history: [QueueItem] = []

    // MARK: - Properties

    private var player: AVAudioPlayer?
    private var displayLink: CADisplayLink?
    private var timeObserverTask: Task<Void, Never>?

    private let audioSession = AudioSessionManager.shared
    private let nowPlayingManager = NowPlayingManager.shared
    private let positionStore = PlaybackPositionStore.shared
    private let historyStore = PlaybackHistoryStore.shared

    // Sleep timer
    private var sleepTimerTask: Task<Void, Never>?
    private var sleepTimerEndTime: Date?

    // Session tracking
    private var sessionStartTime: Date?
    private var sessionStartPosition: TimeInterval = 0

    // Settings
    var skipForwardInterval: TimeInterval = 15
    var skipBackwardInterval: TimeInterval = 15
    var pauseOnHeadphoneDisconnect: Bool = true

    // Position save interval
    private let positionSaveInterval: TimeInterval = 5.0
    private var lastPositionSaveTime: Date?

    // MARK: - Singleton

    static let shared = AudioPlaybackService()

    // MARK: - Initialization

    private override init() {
        super.init()
        setupAudioSession()
        setupRemoteCommands()
        setupInterruptionHandling()
    }

    // MARK: - Setup

    private func setupAudioSession() {
        do {
            try audioSession.configureForPlayback()
        } catch {
            print("Failed to configure audio session: \(error)")
        }
    }

    private func setupRemoteCommands() {
        nowPlayingManager.onPlay = { [weak self] in
            Task { @MainActor in
                self?.resume()
            }
        }

        nowPlayingManager.onPause = { [weak self] in
            Task { @MainActor in
                self?.pause()
            }
        }

        nowPlayingManager.onTogglePlayPause = { [weak self] in
            Task { @MainActor in
                self?.togglePlayPause()
            }
        }

        nowPlayingManager.onNextTrack = { [weak self] in
            Task { @MainActor in
                await self?.playNext()
            }
        }

        nowPlayingManager.onPreviousTrack = { [weak self] in
            Task { @MainActor in
                await self?.playPrevious()
            }
        }

        nowPlayingManager.onSkipForward = { [weak self] interval in
            Task { @MainActor in
                self?.skip(by: interval)
            }
        }

        nowPlayingManager.onSkipBackward = { [weak self] interval in
            Task { @MainActor in
                self?.skip(by: -interval)
            }
        }

        nowPlayingManager.onSeek = { [weak self] time in
            Task { @MainActor in
                self?.seek(to: time)
            }
        }

        nowPlayingManager.onChangePlaybackRate = { [weak self] rate in
            Task { @MainActor in
                self?.setPlaybackSpeed(PlaybackSpeed(rate: rate))
            }
        }
    }

    private func setupInterruptionHandling() {
        audioSession.onInterruptionBegan = { [weak self] reason in
            Task { @MainActor in
                self?.handleInterruptionBegan(reason: reason)
            }
        }

        audioSession.onInterruptionEnded = { [weak self] shouldResume in
            Task { @MainActor in
                self?.handleInterruptionEnded(shouldResume: shouldResume)
            }
        }

        audioSession.onRouteChanged = { [weak self] shouldPause in
            Task { @MainActor in
                if shouldPause && self?.pauseOnHeadphoneDisconnect == true {
                    self?.pause()
                }
            }
        }
    }

    // MARK: - Playback Control

    /// Play an audio file
    func play(
        item: NowPlayingItem,
        from position: TimeInterval? = nil
    ) async throws {
        // Save current session if any
        await endCurrentSession()

        // Update state
        state = .loading(articleID: item.articleID)
        currentItem = item

        do {
            // Activate audio session
            try audioSession.activate()

            // Load audio file
            guard FileManager.default.fileExists(atPath: item.audioURL.path) else {
                throw PlaybackError.fileNotFound(url: item.audioURL)
            }

            player = try AVAudioPlayer(contentsOf: item.audioURL)
            player?.delegate = self
            player?.enableRate = true
            player?.rate = playbackSpeed.rate
            player?.prepareToPlay()

            // Get duration
            let duration = player?.duration ?? item.duration

            // Determine start position
            var startPosition = position ?? 0
            if position == nil {
                // Check for saved position
                if let savedPosition = await positionStore.getPosition(for: item.articleID) {
                    if !savedPosition.isCompleted {
                        startPosition = savedPosition.position
                    }
                }
            }

            // Seek to position
            if startPosition > 0 {
                player?.currentTime = min(startPosition, duration - 1)
            }

            // Start playback
            guard player?.play() == true else {
                throw PlaybackError.playerInitFailed(reason: "Failed to start playback")
            }

            // Update state
            state = .playing(articleID: item.articleID)
            progress = PlaybackProgress(
                currentTime: player?.currentTime ?? 0,
                duration: duration,
                bufferedTime: duration
            )

            // Start session tracking
            sessionStartTime = Date()
            sessionStartPosition = player?.currentTime ?? 0

            // Update now playing info
            updateNowPlayingInfo()

            // Start time observation
            startTimeObservation()

        } catch let error as PlaybackError {
            state = .error(message: error.localizedDescription)
            throw error
        } catch {
            let playbackError = PlaybackError.playerInitFailed(reason: error.localizedDescription)
            state = .error(message: playbackError.localizedDescription)
            throw playbackError
        }
    }

    /// Resume playback
    func resume() {
        guard let player = player else { return }

        do {
            try audioSession.activate()
            player.rate = playbackSpeed.rate
            player.play()

            if let item = currentItem {
                state = .playing(articleID: item.articleID)
            }

            // Resume session tracking
            if sessionStartTime == nil {
                sessionStartTime = Date()
                sessionStartPosition = player.currentTime
            }

            updateNowPlayingInfo()
            startTimeObservation()

        } catch {
            print("Failed to resume: \(error)")
        }
    }

    /// Pause playback
    func pause() {
        player?.pause()

        if let item = currentItem {
            state = .paused(articleID: item.articleID)
        }

        // Save position immediately
        saveCurrentPosition()

        // Update now playing
        updateNowPlayingInfo()

        // Stop time observation
        stopTimeObservation()
    }

    /// Toggle play/pause
    func togglePlayPause() {
        if state.isPlaying {
            pause()
        } else if state.canPlay {
            resume()
        }
    }

    /// Stop playback
    func stop() async {
        await endCurrentSession()

        player?.stop()
        player = nil

        state = .idle
        currentItem = nil
        progress = .zero

        nowPlayingManager.clearNowPlayingInfo()
        stopTimeObservation()
        cancelSleepTimer()

        audioSession.deactivate()
    }

    /// Seek to a specific time
    func seek(to time: TimeInterval) {
        guard let player = player else { return }

        let clampedTime = max(0, min(time, player.duration))
        player.currentTime = clampedTime

        progress = PlaybackProgress(
            currentTime: clampedTime,
            duration: player.duration,
            bufferedTime: player.duration
        )

        // Update now playing
        nowPlayingManager.updatePlaybackPosition(
            currentTime: clampedTime,
            rate: playbackSpeed.rate,
            isPlaying: state.isPlaying
        )

        // Save position
        saveCurrentPosition()
    }

    /// Skip forward or backward
    func skip(by interval: TimeInterval) {
        guard let player = player else { return }

        let newTime = player.currentTime + interval
        seek(to: newTime)
    }

    /// Skip forward
    func skipForward() {
        skip(by: skipForwardInterval)
    }

    /// Skip backward
    func skipBackward() {
        skip(by: -skipBackwardInterval)
    }

    // MARK: - Playback Speed

    /// Set playback speed
    func setPlaybackSpeed(_ speed: PlaybackSpeed) {
        playbackSpeed = speed
        player?.rate = speed.rate

        nowPlayingManager.updatePlaybackRate(speed.rate, isPlaying: state.isPlaying)
    }

    /// Cycle through playback speeds
    func cyclePlaybackSpeed() {
        guard let currentIndex = PlaybackSpeed.speeds.firstIndex(of: playbackSpeed) else {
            setPlaybackSpeed(.normal)
            return
        }

        let nextIndex = (currentIndex + 1) % PlaybackSpeed.speeds.count
        setPlaybackSpeed(PlaybackSpeed.speeds[nextIndex])
    }

    // MARK: - Queue Management

    /// Add item to queue
    func addToQueue(_ item: QueueItem, position: QueuePosition = .last) {
        switch position {
        case .next:
            queue.insert(item, at: 0)
        case .last:
            queue.append(item)
        case .at(let index):
            queue.insert(item, at: min(index, queue.count))
        }

        nowPlayingManager.setTrackNavigationEnabled(!queue.isEmpty)
    }

    /// Remove item from queue
    func removeFromQueue(at index: Int) {
        guard index < queue.count else { return }
        queue.remove(at: index)

        nowPlayingManager.setTrackNavigationEnabled(!queue.isEmpty)
    }

    /// Move item in queue
    func moveInQueue(from source: IndexSet, to destination: Int) {
        queue.move(fromOffsets: source, toOffset: destination)
    }

    /// Clear the queue
    func clearQueue() {
        queue.removeAll()
        nowPlayingManager.setTrackNavigationEnabled(false)
    }

    /// Play next item in queue
    func playNext() async {
        guard !queue.isEmpty else {
            // Check repeat mode
            if repeatMode == .one {
                seek(to: 0)
                resume()
            }
            return
        }

        // Move current to history
        if let current = currentItem {
            let historyItem = QueueItem(
                articleID: current.articleID,
                title: current.title,
                author: current.author,
                duration: current.duration,
                artworkURL: current.artworkURL
            )
            history.insert(historyItem, at: 0)
        }

        // Get next item
        let nextQueueItem = queue.removeFirst()

        // Convert to NowPlayingItem and play
        let nextItem = NowPlayingItem(
            id: nextQueueItem.id,
            articleID: nextQueueItem.articleID,
            title: nextQueueItem.title,
            author: nextQueueItem.author,
            siteName: nil,
            audioURL: URL(fileURLWithPath: ""), // Would come from article lookup
            duration: nextQueueItem.duration,
            artworkURL: nextQueueItem.artworkURL,
            artworkColor: .blue
        )

        try? await play(item: nextItem, from: 0)
    }

    /// Play previous item
    func playPrevious() async {
        // If more than 3 seconds in, restart current track
        if let player = player, player.currentTime > 3 {
            seek(to: 0)
            return
        }

        // Otherwise, play from history
        guard !history.isEmpty else { return }

        // Move current back to queue
        if let current = currentItem {
            let queueItem = QueueItem(
                articleID: current.articleID,
                title: current.title,
                author: current.author,
                duration: current.duration,
                artworkURL: current.artworkURL
            )
            queue.insert(queueItem, at: 0)
        }

        // Get previous item
        let previousItem = history.removeFirst()

        // Play it
        let item = NowPlayingItem(
            id: previousItem.id,
            articleID: previousItem.articleID,
            title: previousItem.title,
            author: previousItem.author,
            siteName: nil,
            audioURL: URL(fileURLWithPath: ""),
            duration: previousItem.duration,
            artworkURL: previousItem.artworkURL,
            artworkColor: .blue
        )

        try? await play(item: item, from: 0)
    }

    // MARK: - Sleep Timer

    /// Set sleep timer
    func setSleepTimer(_ option: SleepTimerOption) {
        cancelSleepTimer()
        sleepTimer = option

        switch option {
        case .off:
            break

        case .minutes(let mins):
            let duration = TimeInterval(mins * 60)
            sleepTimerEndTime = Date().addingTimeInterval(duration)

            sleepTimerTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))

                await MainActor.run {
                    self?.handleSleepTimerFired()
                }
            }

        case .endOfArticle:
            // Will be handled in playback completion
            sleepTimerEndTime = nil

        case .endOfQueue:
            // Will be handled in queue completion
            sleepTimerEndTime = nil
        }
    }

    /// Cancel sleep timer
    func cancelSleepTimer() {
        sleepTimerTask?.cancel()
        sleepTimerTask = nil
        sleepTimerEndTime = nil
        sleepTimer = .off
    }

    /// Get remaining sleep timer time
    var sleepTimerRemaining: TimeInterval? {
        guard let endTime = sleepTimerEndTime else { return nil }
        return max(0, endTime.timeIntervalSinceNow)
    }

    private func handleSleepTimerFired() {
        pause()
        cancelSleepTimer()
    }

    // MARK: - Repeat Mode

    /// Toggle repeat mode
    func toggleRepeatMode() {
        repeatMode = repeatMode.next
    }

    // MARK: - Private Methods

    private func startTimeObservation() {
        stopTimeObservation()

        timeObserverTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000) // 0.25s

                await MainActor.run {
                    self?.updateProgress()
                }
            }
        }
    }

    private func stopTimeObservation() {
        timeObserverTask?.cancel()
        timeObserverTask = nil
    }

    private func updateProgress() {
        guard let player = player else { return }

        progress = PlaybackProgress(
            currentTime: player.currentTime,
            duration: player.duration,
            bufferedTime: player.duration
        )

        // Periodically save position
        if let lastSave = lastPositionSaveTime {
            if Date().timeIntervalSince(lastSave) >= positionSaveInterval {
                saveCurrentPosition()
            }
        } else {
            saveCurrentPosition()
        }

        // Update now playing position (less frequently)
        nowPlayingManager.updatePlaybackPosition(
            currentTime: player.currentTime,
            rate: playbackSpeed.rate,
            isPlaying: state.isPlaying
        )
    }

    private func saveCurrentPosition() {
        guard let item = currentItem,
              let player = player else { return }

        Task {
            await positionStore.savePosition(
                articleID: item.articleID,
                position: player.currentTime,
                duration: player.duration
            )
        }

        lastPositionSaveTime = Date()
    }

    private func updateNowPlayingInfo() {
        guard let item = currentItem,
              let player = player else { return }

        nowPlayingManager.updateNowPlayingInfo(
            item: item,
            currentTime: player.currentTime,
            duration: player.duration,
            rate: playbackSpeed.rate,
            isPlaying: state.isPlaying
        )
    }

    private func endCurrentSession() async {
        guard let item = currentItem,
              let startTime = sessionStartTime,
              let player = player else { return }

        // Record session
        await historyStore.recordSession(
            articleID: item.articleID,
            title: item.title,
            startedAt: startTime,
            endedAt: Date(),
            startPosition: sessionStartPosition,
            endPosition: player.currentTime,
            duration: player.duration,
            completed: progress.isComplete
        )

        // Save final position
        await positionStore.savePosition(
            articleID: item.articleID,
            position: player.currentTime,
            duration: player.duration
        )

        sessionStartTime = nil
        sessionStartPosition = 0
    }

    private func handleInterruptionBegan(reason: InterruptionReason) {
        if let item = currentItem {
            state = .interrupted(articleID: item.articleID, reason: reason)
        }

        player?.pause()
        saveCurrentPosition()
        stopTimeObservation()
    }

    private func handleInterruptionEnded(shouldResume: Bool) {
        if shouldResume && currentItem != nil {
            resume()
        } else if let item = currentItem {
            state = .paused(articleID: item.articleID)
        }
    }

    private func handlePlaybackCompletion() async {
        // Mark as completed
        if let item = currentItem {
            await positionStore.markCompleted(
                articleID: item.articleID,
                duration: progress.duration
            )
        }

        // Handle sleep timer
        if sleepTimer == .endOfArticle {
            cancelSleepTimer()
            await stop()
            return
        }

        // Check repeat mode
        if repeatMode == .one {
            seek(to: 0)
            resume()
            return
        }

        // Play next or stop
        if !queue.isEmpty {
            await playNext()
        } else if repeatMode == .all && !history.isEmpty {
            // Restart from beginning of history
            queue = history.reversed()
            history.removeAll()
            await playNext()
        } else if sleepTimer == .endOfQueue {
            cancelSleepTimer()
            await stop()
        } else {
            await stop()
        }
    }
}

// MARK: - AVAudioPlayerDelegate

extension AudioPlaybackService: AVAudioPlayerDelegate {

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            await handlePlaybackCompletion()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            let errorMessage = error?.localizedDescription ?? "Unknown decode error"
            state = .error(message: errorMessage)
        }
    }
}

// MARK: - Queue Position

enum QueuePosition {
    case next
    case last
    case at(index: Int)
}
