import Foundation

// MARK: - Background Audio Configuration

/*
 ┌─────────────────────────────────────────────────────────────────────┐
 │                  BACKGROUND AUDIO SETUP GUIDE                       │
 ├─────────────────────────────────────────────────────────────────────┤
 │                                                                     │
 │  For background playback to work, you MUST configure your Xcode    │
 │  project with the following settings:                               │
 │                                                                     │
 │  1. ENABLE BACKGROUND MODES CAPABILITY                              │
 │     - Open your target's Signing & Capabilities tab                 │
 │     - Click "+ Capability"                                          │
 │     - Add "Background Modes"                                        │
 │     - Check "Audio, AirPlay, and Picture in Picture"                │
 │                                                                     │
 │  2. INFO.PLIST CONFIGURATION                                        │
 │     The following keys will be automatically added:                 │
 │                                                                     │
 │     <key>UIBackgroundModes</key>                                    │
 │     <array>                                                         │
 │         <string>audio</string>                                      │
 │     </array>                                                        │
 │                                                                     │
 │  3. AUDIO SESSION (Already handled by AudioSessionManager)          │
 │     - Category: .playback                                           │
 │     - Mode: .spokenAudio                                            │
 │     - Options: [.allowBluetooth, .allowAirPlay]                     │
 │                                                                     │
 │  4. NOW PLAYING INFO (Already handled by NowPlayingManager)         │
 │     - Updates MPNowPlayingInfoCenter                                │
 │     - Handles MPRemoteCommandCenter                                 │
 │                                                                     │
 └─────────────────────────────────────────────────────────────────────┘
*/

/// Configuration constants for background audio playback.
enum BackgroundAudioConfiguration {

    /// Required Info.plist key for background audio
    static let backgroundModesKey = "UIBackgroundModes"

    /// Required value for audio background mode
    static let audioBackgroundMode = "audio"

    /// Minimum iOS version for full feature support
    static let minimumIOSVersion = "17.0"

    /// Validates that the app is properly configured for background audio.
    /// Call this at app launch to catch configuration issues early.
    static func validateConfiguration() -> ConfigurationResult {
        // Check Info.plist
        guard let backgroundModes = Bundle.main.object(forInfoDictionaryKey: backgroundModesKey) as? [String] else {
            return .failure(.missingBackgroundModes)
        }

        guard backgroundModes.contains(audioBackgroundMode) else {
            return .failure(.missingAudioMode)
        }

        return .success
    }

    /// Result of configuration validation
    enum ConfigurationResult: Equatable {
        case success
        case failure(ConfigurationError)

        var isValid: Bool {
            self == .success
        }
    }

    /// Configuration errors
    enum ConfigurationError: LocalizedError {
        case missingBackgroundModes
        case missingAudioMode

        var errorDescription: String? {
            switch self {
            case .missingBackgroundModes:
                return "UIBackgroundModes not found in Info.plist. Add Background Modes capability."
            case .missingAudioMode:
                return "Audio background mode not enabled. Enable 'Audio, AirPlay, and Picture in Picture' in Background Modes."
            }
        }
    }
}

// MARK: - App Lifecycle Handling

/// Handles app lifecycle events related to audio playback.
/// Use this in your App or SceneDelegate.
@MainActor
final class PlaybackLifecycleManager: ObservableObject {

    private let playbackService: AudioPlaybackService

    init(playbackService: AudioPlaybackService = .shared) {
        self.playbackService = playbackService
    }

    /// Call when app enters background
    func handleEnterBackground() {
        // Playback continues automatically with proper configuration
        // Save position for safety
        Task {
            await PlaybackPositionStore.shared.forceSave()
        }
    }

    /// Call when app enters foreground
    func handleEnterForeground() {
        // Refresh UI state - playback state should be preserved
    }

    /// Call when app will terminate
    func handleWillTerminate() {
        // Save final position
        Task {
            await PlaybackPositionStore.shared.forceSave()
        }
    }

    /// Call when scene disconnects (for multi-window support)
    func handleSceneDisconnect() {
        // Save position but don't stop playback
        Task {
            await PlaybackPositionStore.shared.forceSave()
        }
    }
}

// MARK: - Sample App Integration

/*
 ┌─────────────────────────────────────────────────────────────────────┐
 │                    SAMPLE APP INTEGRATION                           │
 ├─────────────────────────────────────────────────────────────────────┤
 │                                                                     │
 │  // In your App.swift:                                              │
 │                                                                     │
 │  @main                                                              │
 │  struct ListenAIApp: App {                                          │
 │      @Environment(\.scenePhase) private var scenePhase              │
 │      @StateObject private var playbackService = AudioPlaybackService.shared │
 │      private let lifecycleManager = PlaybackLifecycleManager()      │
 │                                                                     │
 │      init() {                                                       │
 │          // Validate background audio configuration                 │
 │          let result = BackgroundAudioConfiguration.validateConfiguration() │
 │          if case .failure(let error) = result {                     │
 │              print("⚠️ Background audio not configured: \(error)")  │
 │          }                                                          │
 │      }                                                              │
 │                                                                     │
 │      var body: some Scene {                                         │
 │          WindowGroup {                                              │
 │              ContentView()                                          │
 │                  .environmentObject(playbackService)                │
 │                  .overlay(alignment: .bottom) {                     │
 │                      MiniPlayerView(playbackService: playbackService) │
 │                  }                                                  │
 │          }                                                          │
 │          .onChange(of: scenePhase) { _, phase in                    │
 │              switch phase {                                         │
 │              case .background:                                      │
 │                  lifecycleManager.handleEnterBackground()           │
 │              case .active:                                          │
 │                  lifecycleManager.handleEnterForeground()           │
 │              case .inactive:                                        │
 │                  break                                              │
 │              @unknown default:                                      │
 │                  break                                              │
 │              }                                                      │
 │          }                                                          │
 │      }                                                              │
 │  }                                                                  │
 │                                                                     │
 └─────────────────────────────────────────────────────────────────────┘
*/

// MARK: - Testing Background Playback

/*
 ┌─────────────────────────────────────────────────────────────────────┐
 │                 TESTING BACKGROUND PLAYBACK                         │
 ├─────────────────────────────────────────────────────────────────────┤
 │                                                                     │
 │  1. START PLAYBACK                                                  │
 │     - Launch app and start playing audio                            │
 │     - Verify controls appear on lock screen                         │
 │                                                                     │
 │  2. TEST BACKGROUND                                                 │
 │     - Press home button / swipe up                                  │
 │     - Audio should continue playing                                 │
 │     - Lock screen shows Now Playing widget                          │
 │                                                                     │
 │  3. TEST CONTROL CENTER                                             │
 │     - Open Control Center                                           │
 │     - Verify play/pause, skip buttons work                          │
 │     - Verify scrubber position updates                              │
 │     - Verify artwork and track info displayed                       │
 │                                                                     │
 │  4. TEST INTERRUPTIONS                                              │
 │     - Receive phone call → playback should pause                    │
 │     - End call → may auto-resume based on system                    │
 │     - Unplug headphones → should pause                              │
 │                                                                     │
 │  5. TEST AIRPODS                                                    │
 │     - Double-tap → toggle play/pause                                │
 │     - Long press → Siri (may interrupt)                             │
 │     - Remove one AirPod → may pause                                 │
 │                                                                     │
 │  6. TEST CARPLAY (if available)                                     │
 │     - Connect to CarPlay                                            │
 │     - Verify audio routes correctly                                 │
 │     - Verify controls work                                          │
 │                                                                     │
 │  7. TEST PERSISTENCE                                                │
 │     - Play partially, force quit app                                │
 │     - Relaunch → should resume from saved position                  │
 │                                                                     │
 └─────────────────────────────────────────────────────────────────────┘
*/
