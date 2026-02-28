import SwiftUI

// MARK: - Voice Selection Page View

/// Fifth onboarding screen - "Choose Your Voice"
/// Shows popular ElevenLabs voices with locally bundled audio samples.
/// The phrase each voice says: "Welcome to ReadAloud AI, I would love to read for you."
struct VoiceSelectionPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @ObservedObject private var audioPlayer = OnboardingAudioPlayer.shared
    @State private var selectedVoiceId: String?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            VStack(spacing: 8) {
                Text("Choose Your Voice")
                    .font(.system(size: 28, weight: .bold))

                Text("You can change selected voice later.")
                    .font(.body)
                    .foregroundStyle(Color(white: 0.33))
            }
            .padding(.top, 24)
            .padding(.bottom, 16)

            // Voice list
            ScrollView {
                VStack(spacing: 12) {
                    ForEach(onboardingVoices) { voice in
                        OnboardingVoiceRow(
                            voice: voice,
                            isSelected: selectedVoiceId == voice.id,
                            isPlaying: audioPlayer.currentVoiceId == voice.elevenLabsVoiceId && audioPlayer.isPlaying,
                            isLoading: audioPlayer.currentVoiceId == voice.elevenLabsVoiceId && audioPlayer.isLoading,
                            onSelect: {
                                selectedVoiceId = voice.id
                            },
                            onPlay: {
                                audioPlayer.toggle(voiceId: voice.elevenLabsVoiceId, filename: voice.sampleAudioFilename)
                            }
                        )
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 100)
            }

            Spacer()

            // Footer
            VStack(spacing: 16) {
                Button {
                    if let selectedId = selectedVoiceId,
                       let voice = onboardingVoices.first(where: { $0.id == selectedId }) {
                        manager.selectedVoiceId = voice.elevenLabsVoiceId
                        // Save to VoicePresetManager for app-wide use
                        saveSelectedVoice(voice)
                    }
                    manager.nextPage()
                } label: {
                    Text("Continue")
                }
                .buttonStyle(OnboardingPrimaryButtonStyle())
                .disabled(selectedVoiceId == nil)
                .opacity(selectedVoiceId == nil ? 0.6 : 1)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .onDisappear {
            audioPlayer.stop()
        }
    }

    // MARK: - Voice Data

    /// Popular voices for onboarding - all supported by Kokoro (selfhosted) TTS.
    /// Each has a locally bundled sample saying "Welcome to ReadAloud AI, I would love to read for you."
    private var onboardingVoices: [OnboardingVoiceData] {
        [
            OnboardingVoiceData(
                id: "adam",
                name: "Adam",
                description: "Professional Narrator",
                languages: "Multilingual",
                gender: .male,
                elevenLabsVoiceId: "pNInz6obpgDQGcFmaJgB",
                sampleAudioFilename: "voice_sample_adam",
                avatarColor: Color(red: 0.23, green: 0.51, blue: 0.96) // Blue
            ),
            OnboardingVoiceData(
                id: "bella",
                name: "Bella",
                description: "Calm & Soothing",
                languages: "Multilingual",
                gender: .female,
                elevenLabsVoiceId: "EXAVITQu4vr4xnSDxMaL",
                sampleAudioFilename: "voice_sample_bella",
                avatarColor: Color(red: 0.06, green: 0.73, blue: 0.51) // Green
            ),
            OnboardingVoiceData(
                id: "brian",
                name: "Brian",
                description: "Deep British",
                languages: "English",
                gender: .male,
                elevenLabsVoiceId: "nPczCjzI2devNBz1zQrb",
                sampleAudioFilename: "voice_sample_brian",
                avatarColor: Color(red: 0.12, green: 0.23, blue: 0.54) // Dark Blue
            ),
            OnboardingVoiceData(
                id: "josh",
                name: "Josh",
                description: "Storyteller",
                languages: "Multilingual",
                gender: .male,
                elevenLabsVoiceId: "TxGEqnHWrfWFTfGW9XjX",
                sampleAudioFilename: "voice_sample_josh",
                avatarColor: Color(red: 0.55, green: 0.24, blue: 0.96) // Purple
            ),
            OnboardingVoiceData(
                id: "charlotte",
                name: "Charlotte",
                description: "Elegant & Articulate",
                languages: "Multilingual",
                gender: .female,
                elevenLabsVoiceId: "XB0fDUnXU5powFXDhCwa",
                sampleAudioFilename: "voice_sample_charlotte",
                avatarColor: Color(red: 0.49, green: 0.23, blue: 0.93) // Violet
            ),
        ]
    }

    // MARK: - Save Voice Selection

    private func saveSelectedVoice(_ voice: OnboardingVoiceData) {
        // Find matching VoicePreset and set as default
        Task {
            await VoicePresetManager.shared.setDefaultVoiceFromOnboarding(elevenLabsVoiceId: voice.elevenLabsVoiceId)
        }
    }
}

// MARK: - Onboarding Voice Data

struct OnboardingVoiceData: Identifiable {
    let id: String
    let name: String
    let description: String
    let languages: String
    let gender: OnboardingVoiceGender
    let elevenLabsVoiceId: String
    let sampleAudioFilename: String
    let avatarColor: Color

    enum OnboardingVoiceGender {
        case male
        case female
    }
}

// MARK: - Onboarding Voice Row

struct OnboardingVoiceRow: View {
    let voice: OnboardingVoiceData
    let isSelected: Bool
    let isPlaying: Bool
    var isLoading: Bool = false
    let onSelect: () -> Void
    let onPlay: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 16) {
                // Avatar
                ZStack {
                    Circle()
                        .fill(voice.avatarColor.opacity(0.2))
                        .frame(width: 60, height: 60)

                    Image(systemName: "person.fill")
                        .font(.title2)
                        .foregroundStyle(voice.avatarColor)
                }

                // Voice info
                VStack(alignment: .leading, spacing: 4) {
                    Text(voice.name)
                        .font(.headline)
                        .foregroundStyle(.primary)

                    Text("\(voice.description) • \(voice.languages)")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    // Waveform
                    HStack(spacing: 2) {
                        ForEach(0..<20, id: \.self) { index in
                            RoundedRectangle(cornerRadius: 1)
                                .fill(isLoading ? Color.orange : (isPlaying ? Color.yellow : Color.gray.opacity(0.3)))
                                .frame(width: 2, height: waveformHeight(for: index, isPlaying: isPlaying || isLoading))
                        }
                    }
                }

                Spacer()

                // Play button
                Button(action: onPlay) {
                    ZStack {
                        Circle()
                            .fill(Color.yellow)
                            .frame(width: 44, height: 44)

                        if isLoading {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .black))
                                .scaleEffect(0.8)
                        } else {
                            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                                .font(.body)
                                .foregroundStyle(.black)
                        }
                    }
                }
                .disabled(isLoading)
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color(.systemBackground))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(isSelected ? Color.yellow : Color.clear, lineWidth: 2)
                    )
            )
            .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        }
        .buttonStyle(.plain)
    }

    private func waveformHeight(for index: Int, isPlaying: Bool) -> CGFloat {
        if isPlaying {
            // Animated heights when playing
            let baseHeights: [CGFloat] = [8, 12, 6, 14, 10, 16, 8, 12, 18, 10, 14, 8, 12, 10]
            return baseHeights[index % baseHeights.count]
        } else {
            // Static pattern
            let pattern: [CGFloat] = [6, 10, 8, 12, 6, 10, 14, 8, 10, 6, 12, 8, 10, 6, 14, 8, 10, 12, 8, 6]
            return pattern[index % pattern.count]
        }
    }
}

#Preview("VoiceSelection") {
    VoiceSelectionPageView()
}
