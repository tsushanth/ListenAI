import Foundation
import AVFoundation
import Combine

// MARK: - Audio Session Manager

/// Manages the AVAudioSession for background playback and audio routing.
final class AudioSessionManager: ObservableObject {

    // MARK: - Published State

    @Published private(set) var state: AudioSessionState = .inactive
    @Published private(set) var isInterrupted: Bool = false
    @Published private(set) var interruptionReason: InterruptionReason?

    // MARK: - Properties

    private let session = AVAudioSession.sharedInstance()
    private var observers: [NSObjectProtocol] = []

    // Callbacks
    var onInterruptionBegan: ((InterruptionReason) -> Void)?
    var onInterruptionEnded: ((Bool) -> Void)? // Bool = should resume
    var onRouteChanged: ((Bool) -> Void)? // Bool = should pause

    // MARK: - Singleton

    static let shared = AudioSessionManager()

    // MARK: - Initialization

    private init() {
        setupNotifications()
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: - Session Configuration

    /// Configure the audio session for playback
    func configureForPlayback() throws {
        do {
            // Set category for background audio playback
            // Note: .allowBluetooth is for recording, not playback - don't include it
            // For playback, Bluetooth audio routing happens automatically
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.allowAirPlay, .duckOthers]
            )

            updateState()
        } catch {
            // Log error but try a simpler configuration as fallback
            print("Audio session configuration failed: \(error)")

            // Try simpler configuration without special options
            do {
                try session.setCategory(.playback, mode: .default, options: [])
                updateState()
            } catch {
                throw PlaybackError.audioSessionFailed(reason: error.localizedDescription)
            }
        }
    }

    /// Configure audio session for TTS synthesis (less strict, for writing audio to file)
    func configureForSynthesis() {
        do {
            // Use ambient category for synthesis - it's less strict
            try session.setCategory(.ambient, mode: .default)
        } catch {
            // Synthesis can proceed even if this fails on simulator
            print("Audio session configuration for synthesis failed: \(error)")
        }
    }

    /// Activate the audio session
    func activate() throws {
        do {
            try session.setActive(true, options: [])
            updateState()
        } catch {
            throw PlaybackError.audioSessionFailed(reason: error.localizedDescription)
        }
    }

    /// Deactivate the audio session
    func deactivate() {
        do {
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
            updateState()
        } catch {
            // Deactivation failure is non-critical
            print("Failed to deactivate audio session: \(error)")
        }
    }

    // MARK: - Route Information

    /// Check if headphones are currently connected
    var isHeadphonesConnected: Bool {
        let outputs = session.currentRoute.outputs
        return outputs.contains { output in
            output.portType == .headphones ||
            output.portType == .headsetMic
        }
    }

    /// Check if Bluetooth audio is connected
    var isBluetoothConnected: Bool {
        let outputs = session.currentRoute.outputs
        return outputs.contains { output in
            output.portType == .bluetoothA2DP ||
            output.portType == .bluetoothLE ||
            output.portType == .bluetoothHFP
        }
    }

    /// Get current output route name
    var currentOutputRoute: String {
        session.currentRoute.outputs.first?.portName ?? "Unknown"
    }

    // MARK: - Private Methods

    private func setupNotifications() {
        // Interruption notifications
        let interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }
        observers.append(interruptionObserver)

        // Route change notifications
        let routeChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            self?.handleRouteChange(notification)
        }
        observers.append(routeChangeObserver)

        // Media services reset
        let mediaResetObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: session,
            queue: .main
        ) { [weak self] _ in
            self?.handleMediaServicesReset()
        }
        observers.append(mediaResetObserver)
    }

    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            isInterrupted = true

            // Determine interruption reason
            let reason: InterruptionReason
            if let wasSuspended = userInfo[AVAudioSessionInterruptionWasSuspendedKey] as? Bool,
               wasSuspended {
                reason = .systemAlert
            } else {
                // Default to other audio app - iOS doesn't always tell us the specific reason
                reason = .otherAudioApp
            }

            interruptionReason = reason
            onInterruptionBegan?(reason)

        case .ended:
            isInterrupted = false
            interruptionReason = nil

            // Check if we should resume
            var shouldResume = false
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                shouldResume = options.contains(.shouldResume)
            }

            onInterruptionEnded?(shouldResume)

        @unknown default:
            break
        }

        updateState()
    }

    private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        var shouldPause = false

        switch reason {
        case .oldDeviceUnavailable:
            // Headphones were unplugged - pause playback
            shouldPause = true

        case .newDeviceAvailable:
            // New device connected - continue playing
            shouldPause = false

        case .override, .wakeFromSleep, .noSuitableRouteForCategory, .routeConfigurationChange:
            // Handle other route changes
            break

        case .categoryChange:
            // Another app may have changed the audio category
            break

        default:
            break
        }

        updateState()
        onRouteChanged?(shouldPause)
    }

    private func handleMediaServicesReset() {
        // Media services were reset - need to reconfigure
        do {
            try configureForPlayback()
            try activate()
        } catch {
            print("Failed to reconfigure after media reset: \(error)")
        }
    }

    private func updateState() {
        state = AudioSessionState(
            isActive: session.isOtherAudioPlaying == false,
            category: session.category.rawValue,
            mode: session.mode.rawValue,
            outputRoute: currentOutputRoute,
            isHeadphonesConnected: isHeadphonesConnected,
            isBluetoothConnected: isBluetoothConnected
        )
    }
}
