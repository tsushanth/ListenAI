import Foundation
import AVFoundation

// MARK: - Onboarding Audio Player

/// Audio player for playing voice samples during onboarding.
/// Uses pre-bundled audio samples for instant playback without network calls.
@MainActor
final class OnboardingAudioPlayer: NSObject, ObservableObject {

    // MARK: - Published State

    @Published private(set) var isPlaying: Bool = false
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var currentVoiceId: String?

    // MARK: - Singleton

    static let shared = OnboardingAudioPlayer()

    // MARK: - Private Properties

    private var audioPlayer: AVAudioPlayer?
    private var currentTask: Task<Void, Never>?

    /// Mapping from ElevenLabs voice IDs to bundled sample filenames
    private let voiceSampleFiles: [String: String] = [
        "21m00Tcm4TlvDq8ikWAM": "voice_sample_rachel",     // Rachel
        "pNInz6obpgDQGcFmaJgB": "voice_sample_adam",       // Adam
        "nPczCjzI2devNBz1zQrb": "voice_sample_brian",      // Brian
        "EXAVITQu4vr4xnSDxMaL": "voice_sample_bella",      // Bella
        "TxGEqnHWrfWFTfGW9XjX": "voice_sample_josh",       // Josh
        "XB0fDUnXU5powFXDhCwa": "voice_sample_charlotte",  // Charlotte
    ]

    // MARK: - Initialization

    private override init() {
        super.init()
        // Defer audio session configuration to avoid crashes during app init
    }

    // MARK: - Audio Session

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("OnboardingAudioPlayer: Failed to configure audio session: \(error)")
        }
    }

    // MARK: - Playback

    /// Play sample audio for a voice using bundled audio files.
    /// - Parameters:
    ///   - voiceId: The ElevenLabs voice ID (used for tracking state and lookup)
    ///   - filename: Ignored - we use voiceId to look up bundled files
    func play(voiceId: String, filename: String) {
        // Stop any currently playing audio
        stop()

        // Configure audio session on first play
        configureAudioSession()

        currentVoiceId = voiceId

        // Look up the bundled sample file for this voice
        guard let sampleFilename = voiceSampleFiles[voiceId] else {
            print("OnboardingAudioPlayer: No bundled sample for voice ID: \(voiceId)")
            currentVoiceId = nil
            return
        }

        // Try to load the bundled WAV file
        guard let sampleURL = Bundle.main.url(forResource: sampleFilename, withExtension: "wav") else {
            print("OnboardingAudioPlayer: Bundled file not found: \(sampleFilename).wav")
            currentVoiceId = nil
            return
        }

        do {
            print("OnboardingAudioPlayer: Playing bundled sample: \(sampleFilename).wav")

            // Play the bundled audio file
            audioPlayer = try AVAudioPlayer(contentsOf: sampleURL)
            audioPlayer?.delegate = self
            audioPlayer?.prepareToPlay()
            audioPlayer?.play()

            isPlaying = true

            print("OnboardingAudioPlayer: Playing...")

        } catch {
            print("OnboardingAudioPlayer: Error playing bundled file: \(error)")
            currentVoiceId = nil
        }
    }

    /// Stop playback
    func stop() {
        currentTask?.cancel()
        currentTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        isLoading = false
        isPlaying = false
        currentVoiceId = nil
    }

    /// Toggle playback for a voice
    func toggle(voiceId: String, filename: String) {
        if currentVoiceId == voiceId && (isPlaying || isLoading) {
            stop()
        } else {
            play(voiceId: voiceId, filename: filename)
        }
    }
}

// MARK: - AVAudioPlayerDelegate

extension OnboardingAudioPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
            self.currentVoiceId = nil
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.isPlaying = false
            self.currentVoiceId = nil
        }
    }
}
