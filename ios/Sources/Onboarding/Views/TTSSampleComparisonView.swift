import SwiftUI
import AVFoundation

/// "Hear the difference" picker on the onboarding voice-selection screen.
///
/// Two cards, audibly different:
///   - **Premium voice (Kokoro)** — plays a bundled MP3 rendered by the
///     cloud Kokoro worker. On-device Kokoro on eligible devices sounds
///     near-identical (same model), so we use one sample for both.
///   - **Apple voice** — plays a live AVSpeechSynthesizer render of the
///     same sentence. Genuinely different from Kokoro; this is the honest
///     A/B users can evaluate by ear.
///
/// The picker writes `voicePresets.preferAppleVoice`. The Kokoro-vs-cloud
/// infra choice (download for offline?) lives on a separate page, only
/// shown if the user picks Kokoro here and the device can run it.
struct TTSSampleComparisonView: View {
    /// Bound selection — true = use Apple voice everywhere, false = use Kokoro.
    @Binding var preferAppleVoice: Bool

    /// Phrase rendered in both samples. Deliberately exposes things that
    /// trip up TTS engines (numbers, year, em-dash) so the user gets an
    /// honest read on the quality gap.
    static let sampleText =
        "Cardio-vascular endurance jumped 14 percent in 1998 — try saying that with a dry mouth."

    @StateObject private var playback = SamplePlaybackCoordinator()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Hear the difference")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 4)

            Text("\u{201C}\(Self.sampleText)\u{201D}")
                .font(.footnote)
                .italic()
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)

            HStack(spacing: 10) {
                sampleCard(
                    id: "premium",
                    title: "Premium voice",
                    subtitle: "Natural \u{00B7} our recommended pick",
                    tint: .purple,
                    available: NSDataAsset(name: "OfflineAISampleCloud") != nil,
                    isSelected: !preferAppleVoice,
                    onSelect: { preferAppleVoice = false },
                    onPlay: { playback.playBundledAsset(name: "OfflineAISampleCloud") }
                )
                sampleCard(
                    id: "apple",
                    title: "Apple voice",
                    subtitle: "Instant \u{00B7} no download \u{00B7} offline",
                    tint: .blue,
                    available: true,
                    isSelected: preferAppleVoice,
                    onSelect: { preferAppleVoice = true },
                    onPlay: { playback.playOnDevice(text: Self.sampleText) }
                )
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .onDisappear { playback.stop() }
    }

    @ViewBuilder
    private func sampleCard(
        id: String,
        title: String,
        subtitle: String,
        tint: Color,
        available: Bool,
        isSelected: Bool,
        onSelect: @escaping () -> Void,
        onPlay: @escaping () -> Void
    ) -> some View {
        let isPlayingThis = playback.currentlyPlaying == id

        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.primary)
                    Spacer()
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isSelected ? tint : Color(.tertiaryLabel))
                }

                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    if isPlayingThis {
                        playback.stop()
                    } else {
                        playback.stop()
                        playback.currentlyPlaying = id
                        onPlay()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isPlayingThis ? "stop.fill" : "play.fill")
                            .font(.caption.weight(.semibold))
                        Text(available ? (isPlayingThis ? "Stop" : "Play sample") : "Sample unavailable")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundColor(.white)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 12)
                    .background(available ? tint : Color.gray.opacity(0.6))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!available)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color(.tertiarySystemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? tint : Color.clear, lineWidth: 2)
            )
        }
        .buttonStyle(.plain)
    }
}

/// Plays whichever sample is currently selected — live AVSpeech for the
/// Apple card, bundled AVAudioPlayer for the Kokoro card. Only one
/// sample plays at a time.
@MainActor
final class SamplePlaybackCoordinator: NSObject, ObservableObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    @Published var currentlyPlaying: String?

    private var audioPlayer: AVAudioPlayer?
    private let speechSynth = AVSpeechSynthesizer()

    override init() {
        super.init()
        speechSynth.delegate = self
    }

    func playOnDevice(text: String) {
        configureAudioSession()
        let utterance = AVSpeechUtterance(string: text)
        if let voice = AVSpeechSynthesisVoice(language: "en-US") {
            utterance.voice = voice
        }
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        speechSynth.speak(utterance)
    }

    func playBundledAsset(name: String) {
        guard let data = NSDataAsset(name: name)?.data else {
            currentlyPlaying = nil
            return
        }
        configureAudioSession()
        do {
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            p.prepareToPlay()
            p.play()
            audioPlayer = p
        } catch {
            currentlyPlaying = nil
        }
    }

    func stop() {
        audioPlayer?.stop()
        audioPlayer = nil
        if speechSynth.isSpeaking {
            speechSynth.stopSpeaking(at: .immediate)
        }
        currentlyPlaying = nil
    }

    private func configureAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [])
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    // MARK: - Delegates

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
        Task { @MainActor in self.stop() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.currentlyPlaying = nil }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.currentlyPlaying = nil }
    }
}

#Preview {
    @Previewable @State var preferApple = false
    return TTSSampleComparisonView(preferAppleVoice: $preferApple)
        .padding()
}
