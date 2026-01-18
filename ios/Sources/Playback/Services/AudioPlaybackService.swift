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

    // UI state - hide mini player when article reader is showing its own player
    @Published var isArticleReaderActive: Bool = false

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
        // Don't configure audio session during init - wait until playback starts
        // This prevents issues when the app is launched but audio isn't immediately needed
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

    /// Ensure audio session is configured before playback
    private func ensureAudioSessionConfigured() throws {
        do {
            try audioSession.configureForPlayback()
        } catch {
            // Log but don't throw - we'll try to play anyway
            print("Audio session configuration warning: \(error)")
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
        print("[Playback] Starting playback for: \(item.title)")
        print("[Playback] Audio URL: \(item.audioURL.path)")

        // Stop any currently playing audio first
        if player?.isPlaying == true {
            print("[Playback] Stopping previous playback")
            player?.stop()
        }
        stopTimeObservation()

        // Save current session if any
        await endCurrentSession()

        // Update state
        state = .loading(articleID: item.articleID)
        currentItem = item

        do {
            // Configure and activate audio session
            try? ensureAudioSessionConfigured()
            try audioSession.activate()
            print("[Playback] Audio session activated")

            // Load audio file
            guard FileManager.default.fileExists(atPath: item.audioURL.path) else {
                print("[Playback] ERROR: File not found at \(item.audioURL.path)")
                throw PlaybackError.fileNotFound(url: item.audioURL)
            }
            print("[Playback] File exists, creating player...")

            // Fix extension if file format doesn't match (e.g., WAV data saved as .mp3)
            let audioURL = correctedAudioURL(for: item.audioURL)

            player = try AVAudioPlayer(contentsOf: audioURL)
            print("[Playback] Player created successfully")
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
            print("[Playback] Calling play()...")
            guard player?.play() == true else {
                print("[Playback] ERROR: play() returned false")
                throw PlaybackError.playerInitFailed(reason: "Failed to start playback")
            }
            print("[Playback] SUCCESS: Playback started!")

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
        case .first:
            queue.insert(item, at: 0)
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
                heroImageURL: current.artworkURL
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
            artworkURL: nextQueueItem.heroImageURL,
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
                heroImageURL: current.artworkURL
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
            artworkURL: previousItem.heroImageURL,
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
        repeatMode = repeatMode.next()
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

    /// Detect actual audio format from file magic bytes and return corrected URL if extension mismatches
    private func correctedAudioURL(for url: URL) -> URL {
        // Read first 12 bytes to detect format
        guard let handle = try? FileHandle(forReadingFrom: url),
              let data = try? handle.read(upToCount: 12),
              data.count >= 4 else {
            try? FileHandle(forReadingFrom: url).closeFile()
            return url
        }
        try? handle.close()

        let bytes = [UInt8](data)
        var detectedExtension: String?

        // WAV: starts with "RIFF" (0x52 0x49 0x46 0x46) and contains "WAVE" at offset 8
        if bytes.count >= 12 &&
           bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 &&
           bytes[8] == 0x57 && bytes[9] == 0x41 && bytes[10] == 0x56 && bytes[11] == 0x45 {
            detectedExtension = "wav"
        }
        // MP3: starts with ID3 tag (0x49 0x44 0x33) or frame sync (0xFF 0xFB/FA/F3/F2)
        else if (bytes[0] == 0x49 && bytes[1] == 0x44 && bytes[2] == 0x33) ||
                (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0) {
            detectedExtension = "mp3"
        }
        // AAC/M4A: starts with "ftyp" at offset 4
        else if bytes.count >= 8 &&
                bytes[4] == 0x66 && bytes[5] == 0x74 && bytes[6] == 0x79 && bytes[7] == 0x70 {
            detectedExtension = "m4a"
        }

        // If detected extension differs from actual extension, copy to temp file with correct extension
        if let detected = detectedExtension,
           url.pathExtension.lowercased() != detected {
            print("[Playback] Format mismatch: file has .\(url.pathExtension) but contains \(detected.uppercased()) data")

            let tempDir = FileManager.default.temporaryDirectory
            let correctedURL = tempDir.appendingPathComponent("\(UUID().uuidString).\(detected)")

            do {
                try FileManager.default.copyItem(at: url, to: correctedURL)
                print("[Playback] Copied to corrected URL: \(correctedURL.lastPathComponent)")
                return correctedURL
            } catch {
                print("[Playback] Failed to copy file: \(error)")
            }
        }

        return url
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

// Note: QueuePosition is defined in LibraryModels.swift
