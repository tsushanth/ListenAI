import Foundation
import AVFoundation
import Combine
import MediaPlayer

// MARK: - URL Audio Player

/// Simple AVPlayer-based audio player for URL playback.
/// Designed for job-based TTS where audio is loaded from a URL (local file or remote).
/// Replaces chunk-based streaming with straightforward URL playback.
/// Supports preview playback with seamless swap to full audio.
@MainActor
final class URLAudioPlayer: NSObject, ObservableObject {

    // MARK: - Published State

    /// Current playback state
    @Published private(set) var state: URLPlaybackState = .idle

    /// Current playback time in seconds
    @Published private(set) var currentTime: TimeInterval = 0

    /// Total duration in seconds
    @Published private(set) var duration: TimeInterval = 0

    /// Buffered time in seconds (for remote URLs)
    @Published private(set) var bufferedTime: TimeInterval = 0

    /// Whether audio is currently playing
    @Published private(set) var isPlaying: Bool = false

    /// Current playback rate (0.5 - 3.0)
    @Published private(set) var rate: Float = 1.0

    /// Current article ID being played (for coordination with views)
    @Published private(set) var currentArticleID: UUID?

    /// Current player mode (preview/full/none) - indicates if playing preview or full audio
    @Published private(set) var playerMode: URLPlayerMode = .none

    /// Preview audio duration (if known) - used for seek restrictions
    @Published private(set) var previewDuration: TimeInterval?

    // MARK: - Properties

    private var player: AVPlayer?
    private var playerItem: AVPlayerItem?
    private var timeObserver: Any?
    private var cancellables = Set<AnyCancellable>()

    // Audio session
    private let audioSession = AVAudioSession.sharedInstance()

    // Now playing info
    private var nowPlayingInfo: [String: Any] = [:]

    // Completion handler
    private var onPlaybackComplete: (() -> Void)?

    /// Tracks if playback reached the end naturally (not paused/stopped by user)
    /// Used to detect when preview finished so we can auto-resume with full audio
    private var didReachEndOfPlayback: Bool = false

    // MARK: - Singleton

    static let shared = URLAudioPlayer()

    private override init() {
        super.init()
        setupRemoteCommands()
        setupNotifications()
    }

    // MARK: - Public Methods

    /// Play audio from a URL (local file or remote).
    ///
    /// - Parameters:
    ///   - url: The audio URL to play
    ///   - articleID: Optional article ID for tracking
    ///   - title: Title for Now Playing info
    ///   - artist: Artist/author for Now Playing info
    ///   - startPosition: Optional position to start from (for resume)
    ///   - mode: Player mode (.preview or .full) - set after stop() to persist
    ///   - previewDuration: Duration of preview audio (for seek restrictions in preview mode)
    ///   - onComplete: Optional callback when playback completes
    func play(
        url: URL,
        articleID: UUID? = nil,
        title: String = "Audio",
        artist: String? = nil,
        startPosition: TimeInterval? = nil,
        mode: URLPlayerMode = .none,
        previewDuration: TimeInterval? = nil,
        onComplete: (() -> Void)? = nil
    ) async throws {
        print("[URLAudioPlayer] Playing: \(url.lastPathComponent), mode: \(mode)")

        // Stop any current playback
        stop()

        // Set player mode AFTER stop() so it's not reset
        playerMode = mode
        self.previewDuration = previewDuration

        // Store article ID
        currentArticleID = articleID
        onPlaybackComplete = onComplete

        // Configure audio session
        try configureAudioSession()

        // Update state
        state = .loading

        // Create player item
        let asset = AVURLAsset(url: url)

        // Load asset properties
        do {
            // Load duration
            let durationValue = try await asset.load(.duration)
            let loadedDuration = CMTimeGetSeconds(durationValue)
            if loadedDuration.isFinite && loadedDuration > 0 {
                self.duration = loadedDuration
            }
        } catch {
            print("[URLAudioPlayer] Failed to load asset duration: \(error)")
        }

        playerItem = AVPlayerItem(asset: asset)

        // Observe player item status
        playerItem?.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.handlePlayerItemStatus(status)
            }
            .store(in: &cancellables)

        // Observe buffer
        playerItem?.publisher(for: \.loadedTimeRanges)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] ranges in
                self?.updateBufferedTime(ranges)
            }
            .store(in: &cancellables)

        // Create player
        player = AVPlayer(playerItem: playerItem)
        player?.rate = 0 // Don't auto-play yet

        // Observe player time control status
        player?.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.handleTimeControlStatus(status)
            }
            .store(in: &cancellables)

        // Setup periodic time observer
        setupTimeObserver()

        // Setup playback end notification
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerDidFinishPlaying),
            name: .AVPlayerItemDidPlayToEndTime,
            object: playerItem
        )

        // Seek to start position if provided
        if let startPos = startPosition, startPos > 0 {
            let time = CMTime(seconds: startPos, preferredTimescale: 600)
            await player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
            currentTime = startPos
        }

        // Start playback
        player?.rate = rate
        isPlaying = true
        state = .playing

        // Setup now playing info
        updateNowPlayingInfo(title: title, artist: artist)

        print("[URLAudioPlayer] Playback started, duration: \(duration)s")
    }

    /// Pause playback
    func pause() {
        player?.pause()
        isPlaying = false
        state = .paused
        updateNowPlayingPlaybackState()
        print("[URLAudioPlayer] Paused at \(currentTime)s")
    }

    /// Resume playback
    func resume() {
        guard player != nil else { return }

        do {
            try audioSession.setActive(true)
        } catch {
            print("[URLAudioPlayer] Failed to activate audio session: \(error)")
        }

        player?.rate = rate
        isPlaying = true
        state = .playing
        updateNowPlayingPlaybackState()
        print("[URLAudioPlayer] Resumed")
    }

    /// Toggle play/pause
    func togglePlayPause() {
        if isPlaying {
            pause()
        } else {
            resume()
        }
    }

    /// Stop playback completely
    func stop() {
        print("[URLAudioPlayer] Stopping playback")

        // Remove observers
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }

        NotificationCenter.default.removeObserver(
            self,
            name: .AVPlayerItemDidPlayToEndTime,
            object: playerItem
        )

        cancellables.removeAll()

        // Stop player
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        playerItem = nil

        // Reset state
        isPlaying = false
        currentTime = 0
        duration = 0
        bufferedTime = 0
        state = .idle
        currentArticleID = nil
        onPlaybackComplete = nil
        playerMode = .none
        previewDuration = nil
        didReachEndOfPlayback = false

        // Clear now playing
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// Seek to a specific time (respects preview mode restrictions)
    func seek(to time: TimeInterval) {
        guard let player = player else { return }

        // Use maxSeekableTime to respect preview mode restrictions
        let clampedTime = max(0, min(time, maxSeekableTime))
        let cmTime = CMTime(seconds: clampedTime, preferredTimescale: 600)

        player.seek(to: cmTime, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                self?.currentTime = clampedTime
                self?.updateNowPlayingPlaybackState()
            }
        }
    }

    /// Seek by a relative amount (positive = forward, negative = backward)
    func seek(by seconds: TimeInterval) {
        seek(to: currentTime + seconds)
    }

    /// Skip forward 15 seconds
    func skipForward() {
        seek(by: 15)
    }

    /// Skip backward 15 seconds
    func skipBackward() {
        seek(by: -15)
    }

    /// Set playback rate
    func setRate(_ newRate: Float) {
        let clampedRate = max(0.5, min(3.0, newRate))
        rate = clampedRate

        if isPlaying {
            player?.rate = clampedRate
        }

        updateNowPlayingPlaybackState()
    }

    // MARK: - Computed Properties

    /// Progress as a fraction (0.0 - 1.0)
    var progress: Double {
        guard duration > 0 else { return 0 }
        return currentTime / duration
    }

    /// Remaining time in seconds
    var remainingTime: TimeInterval {
        max(0, duration - currentTime)
    }

    /// Whether seeking is restricted (preview mode with limited duration)
    var isSeekRestricted: Bool {
        playerMode == .preview
    }

    /// Maximum seekable time (preview duration if in preview mode, otherwise full duration)
    var maxSeekableTime: TimeInterval {
        if playerMode == .preview, let previewDur = previewDuration {
            return previewDur
        }
        return duration
    }

    // MARK: - Preview/Full Audio Swap

    /// Swap the current audio with a new URL while preserving playback position.
    /// Used for transitioning from preview to full audio seamlessly.
    ///
    /// - Parameters:
    ///   - url: The new audio URL to swap to
    ///   - mode: The new player mode (.full for swapping from preview to full)
    ///   - preservePosition: Whether to seek to the same position after swap (default: true)
    ///   - forcePlay: Force playback to start even if not currently playing (e.g., preview ended before full was ready)
    func swapAudioURL(
        to url: URL,
        mode: URLPlayerMode,
        preservePosition: Bool = true,
        forcePlay: Bool = false
    ) async throws {
        print("[URLAudioPlayer] Swapping audio to: \(url.lastPathComponent), mode: \(mode), preservePosition: \(preservePosition), forcePlay: \(forcePlay)")

        // Capture current playback state BEFORE any changes
        let wasPlaying = isPlaying
        // Use didReachEndOfPlayback flag instead of state == .completed
        // because handleTimeControlStatus can overwrite .completed to .paused
        let previewReachedEnd = (didReachEndOfPlayback && playerMode == .preview)
        let currentPosition = currentTime
        let currentRate = rate
        let oldDuration = duration

        print("[URLAudioPlayer] Swap capture - wasPlaying: \(wasPlaying), previewReachedEnd: \(previewReachedEnd), didReachEndOfPlayback: \(didReachEndOfPlayback), position: \(String(format: "%.2f", currentPosition))s, rate: \(currentRate), oldDuration: \(String(format: "%.2f", oldDuration))s")

        // Pause current playback
        player?.pause()

        // Create new player item
        let asset = AVURLAsset(url: url)

        // Load duration
        do {
            let durationValue = try await asset.load(.duration)
            let loadedDuration = CMTimeGetSeconds(durationValue)
            if loadedDuration.isFinite && loadedDuration > 0 {
                self.duration = loadedDuration
            }
        } catch {
            print("[URLAudioPlayer] Failed to load new asset duration: \(error)")
        }

        // Remove observers from old player item
        cancellables.removeAll()

        // Remove notification observer for old player item
        if let oldItem = playerItem {
            NotificationCenter.default.removeObserver(
                self,
                name: .AVPlayerItemDidPlayToEndTime,
                object: oldItem
            )
        }

        // Create new player item
        let newPlayerItem = AVPlayerItem(asset: asset)
        playerItem = newPlayerItem

        // Re-setup observers for new player item
        newPlayerItem.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.handlePlayerItemStatus(status)
            }
            .store(in: &cancellables)

        newPlayerItem.publisher(for: \.loadedTimeRanges)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] ranges in
                self?.updateBufferedTime(ranges)
            }
            .store(in: &cancellables)

        // Setup playback end notification for new item
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerDidFinishPlaying),
            name: .AVPlayerItemDidPlayToEndTime,
            object: newPlayerItem
        )

        // Replace player item
        player?.replaceCurrentItem(with: newPlayerItem)

        // Update mode
        playerMode = mode

        // Clear preview duration if switching to full
        if mode == .full {
            previewDuration = nil
        }

        // Re-observe player time control status
        player?.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.handleTimeControlStatus(status)
            }
            .store(in: &cancellables)

        // Seek to preserved position if requested and within bounds
        if preservePosition && currentPosition > 0 && duration > 0 {
            // Clamp position to be within the new duration (with 0.5s buffer from end)
            let maxSeek = min(currentPosition, max(0, duration - 0.5))
            if maxSeek > 0 {
                let time = CMTime(seconds: maxSeek, preferredTimescale: 600)
                print("[URLAudioPlayer] Seeking to preserved position: \(String(format: "%.2f", maxSeek))s (original: \(String(format: "%.2f", currentPosition))s, newDuration: \(String(format: "%.2f", duration))s)")
                await player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
                currentTime = maxSeek
            } else {
                print("[URLAudioPlayer] Skipping seek - maxSeek is \(maxSeek)")
            }
        } else {
            print("[URLAudioPlayer] Skipping seek - preservePosition: \(preservePosition), position: \(String(format: "%.2f", currentPosition))s, duration: \(String(format: "%.2f", duration))s")
        }

        // Resume playback if:
        // 1. Was actively playing when swap started, OR
        // 2. forcePlay is true (caller wants playback to start), OR
        // 3. Preview reached end naturally (user was listening, ran out of preview, now full is ready)
        let shouldPlay = wasPlaying || forcePlay || previewReachedEnd
        if shouldPlay {
            print("[URLAudioPlayer] Starting playback at rate: \(currentRate) (wasPlaying: \(wasPlaying), forcePlay: \(forcePlay), previewReachedEnd: \(previewReachedEnd))")
            player?.rate = currentRate
            isPlaying = true
            state = .playing
        }

        // Reset the end-of-playback flag after swap
        didReachEndOfPlayback = false

        // Update now playing info
        updateNowPlayingPlaybackState()

        print("[URLAudioPlayer] Audio swapped successfully - mode: \(mode), finalPosition: \(String(format: "%.2f", currentTime))s, newDuration: \(String(format: "%.2f", duration))s, playing: \(isPlaying)")
    }

    /// Set the player mode (for external state management)
    func setPlayerMode(_ mode: URLPlayerMode, previewDuration: TimeInterval? = nil) {
        self.playerMode = mode
        self.previewDuration = previewDuration
    }

    // MARK: - Private Methods

    private func configureAudioSession() throws {
        try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audioSession.setActive(true)
    }

    private func setupTimeObserver() {
        let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
        timeObserver = player?.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            Task { @MainActor in
                guard let self = self else { return }
                let seconds = CMTimeGetSeconds(time)
                if seconds.isFinite {
                    self.currentTime = seconds
                }
            }
        }
    }

    private func handlePlayerItemStatus(_ status: AVPlayerItem.Status) {
        switch status {
        case .readyToPlay:
            // Update duration from player item if available
            if let item = playerItem {
                let itemDuration = CMTimeGetSeconds(item.duration)
                if itemDuration.isFinite && itemDuration > 0 {
                    duration = itemDuration
                }
            }
            print("[URLAudioPlayer] Ready to play, duration: \(duration)s")

        case .failed:
            let error = playerItem?.error?.localizedDescription ?? "Unknown error"
            state = .error(message: error)
            isPlaying = false
            print("[URLAudioPlayer] Failed: \(error)")

        case .unknown:
            break

        @unknown default:
            break
        }
    }

    private func handleTimeControlStatus(_ status: AVPlayer.TimeControlStatus) {
        switch status {
        case .playing:
            isPlaying = true
            state = .playing

        case .paused:
            if state != .idle && state != .error(message: "") {
                isPlaying = false
                state = .paused
            }

        case .waitingToPlayAtSpecifiedRate:
            state = .buffering

        @unknown default:
            break
        }
    }

    private func updateBufferedTime(_ ranges: [NSValue]) {
        guard let firstRange = ranges.first?.timeRangeValue else { return }
        let start = CMTimeGetSeconds(firstRange.start)
        let rangeDuration = CMTimeGetSeconds(firstRange.duration)
        bufferedTime = start + rangeDuration
    }

    @objc private func playerDidFinishPlaying() {
        print("[URLAudioPlayer] Playback finished naturally (reached end)")
        isPlaying = false
        state = .completed
        currentTime = duration
        didReachEndOfPlayback = true  // Mark that playback ended naturally

        // Call completion handler
        onPlaybackComplete?()
    }

    // MARK: - Remote Commands

    private func setupRemoteCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()

        commandCenter.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                self?.resume()
            }
            return .success
        }

        commandCenter.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                self?.pause()
            }
            return .success
        }

        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                self?.togglePlayPause()
            }
            return .success
        }

        commandCenter.skipForwardCommand.preferredIntervals = [15]
        commandCenter.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                self?.skipForward()
            }
            return .success
        }

        commandCenter.skipBackwardCommand.preferredIntervals = [15]
        commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                self?.skipBackward()
            }
            return .success
        }

        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            Task { @MainActor in
                self?.seek(to: event.positionTime)
            }
            return .success
        }

        commandCenter.changePlaybackRateCommand.supportedPlaybackRates = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]
        commandCenter.changePlaybackRateCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackRateCommandEvent else {
                return .commandFailed
            }
            Task { @MainActor in
                self?.setRate(event.playbackRate)
            }
            return .success
        }
    }

    private func setupNotifications() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        Task { @MainActor in
            switch type {
            case .began:
                pause()
            case .ended:
                if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                    if options.contains(.shouldResume) {
                        resume()
                    }
                }
            @unknown default:
                break
            }
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        Task { @MainActor in
            switch reason {
            case .oldDeviceUnavailable:
                // Headphones unplugged - pause
                pause()
            default:
                break
            }
        }
    }

    // MARK: - Now Playing Info

    private func updateNowPlayingInfo(title: String, artist: String?) {
        nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? rate : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]

        if let artist = artist {
            nowPlayingInfo[MPMediaItemPropertyArtist] = artist
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }

    private func updateNowPlayingPlaybackState() {
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? rate : 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }
}

// MARK: - URL Playback State

enum URLPlaybackState: Equatable, Sendable {
    case idle
    case loading
    case playing
    case paused
    case buffering
    case completed
    case error(message: String)

    var isActive: Bool {
        switch self {
        case .playing, .paused, .buffering:
            return true
        default:
            return false
        }
    }
}

// MARK: - URL Player Mode

/// Indicates whether the player is playing preview audio or full audio.
/// Used for job-based TTS where partial_ready provides a preview URL
/// before the full audio is ready.
enum URLPlayerMode: String, Equatable, Sendable {
    /// Not playing any audio
    case none

    /// Playing preview audio (partial_ready state)
    /// Seeking may be restricted to preview duration
    case preview

    /// Playing full audio (ready state)
    /// Full seeking is available
    case full

    /// Display name for UI badge
    var displayName: String {
        switch self {
        case .none:
            return ""
        case .preview:
            return "Preview"
        case .full:
            return "Full"
        }
    }

    /// Whether this mode indicates active playback
    var isActive: Bool {
        self != .none
    }
}
