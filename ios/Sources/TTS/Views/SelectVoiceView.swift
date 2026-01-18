import SwiftUI
import AVFoundation

// MARK: - Voice Filter

enum VoiceFilter: String, CaseIterable {
    case popular = "Popular"
    case all = "All"
    case cloned = "Cloned"
}

// MARK: - Select Voice View

/// Voice selection view matching the reference design.
/// Shows voices in a list with profile images, waveforms, and play buttons.
/// Includes filter tabs for All, Premium Voices, and Cloned Voice.
struct SelectVoiceView: View {
    @StateObject private var presetManager = VoicePresetManager.shared
    @StateObject private var accountViewModel = UserAccountViewModel.shared
    @StateObject private var viewModel = SelectVoiceViewModel()
    @State private var previewingVoiceId: UUID?
    @State private var previewingClonedVoiceId: String?
    @State private var showingInfo = false
    @State private var selectedFilter: VoiceFilter = .popular
    @Environment(\.dismiss) private var dismiss

    /// Temporarily selected voice (not saved until Save is tapped)
    @State private var tempSelectedVoice: VoicePreset?
    @State private var tempSelectedClonedVoice: VoiceCloningService.ClonedVoice?

    init() {
        _tempSelectedVoice = State(initialValue: VoicePresetManager.shared.selectedPreset)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Filter tabs
                filterTabsView
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)

                Divider()

                // Voice list
                ScrollView {
                    LazyVStack(spacing: 0) {
                        // Always show cloned voices on top (except when only showing built-in voices)
                        if !viewModel.clonedVoices.isEmpty && (selectedFilter == .popular || selectedFilter == .all || selectedFilter == .cloned) {
                            // Cloned voices header when showing mixed content
                            if selectedFilter != .cloned && !viewModel.clonedVoices.isEmpty {
                                HStack {
                                    Text("Your Voices")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                }
                                .padding(.horizontal, 20)
                                .padding(.top, 12)
                                .padding(.bottom, 4)
                            }

                            ForEach(viewModel.clonedVoices) { clonedVoice in
                                ClonedVoiceRow(
                                    voice: clonedVoice,
                                    isSelected: tempSelectedClonedVoice?.id == clonedVoice.id,
                                    isPreviewing: previewingClonedVoiceId == clonedVoice.id,
                                    onSelect: {
                                        tempSelectedClonedVoice = clonedVoice
                                        tempSelectedVoice = nil
                                    },
                                    onPreview: {
                                        previewClonedVoice(clonedVoice)
                                    }
                                )

                                Divider()
                                    .padding(.leading, 80)
                            }
                        }

                        // Built-in voices (Popular or All filter)
                        if selectedFilter == .popular || selectedFilter == .all {
                            // Section header when showing mixed content
                            if !viewModel.clonedVoices.isEmpty && selectedFilter != .cloned {
                                HStack {
                                    Text(selectedFilter == .popular ? "Popular Voices" : "All Voices")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                }
                                .padding(.horizontal, 20)
                                .padding(.top, 12)
                                .padding(.bottom, 4)
                            }

                            ForEach(filteredPresets) { voice in
                                VoiceRow(
                                    voice: voice,
                                    isSelected: tempSelectedVoice?.id == voice.id && tempSelectedClonedVoice == nil,
                                    isPreviewing: previewingVoiceId == voice.id,
                                    onSelect: {
                                        tempSelectedVoice = voice
                                        tempSelectedClonedVoice = nil
                                    },
                                    onPreview: {
                                        previewVoice(voice)
                                    }
                                )

                                if voice.id != filteredPresets.last?.id {
                                    Divider()
                                        .padding(.leading, 80)
                                }
                            }
                        }

                        // Empty state for cloned voices
                        if selectedFilter == .cloned && viewModel.clonedVoices.isEmpty {
                            VStack(spacing: 16) {
                                Image(systemName: "mic.slash")
                                    .font(.system(size: 40))
                                    .foregroundStyle(.secondary)

                                Text("No cloned voices yet")
                                    .font(.headline)
                                    .foregroundStyle(.primary)

                                Text("Create a voice clone in Settings to see it here.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                            }
                            .padding(.vertical, 60)
                            .padding(.horizontal, 40)
                        }
                    }
                    .padding(.vertical, 8)
                }

                // Save button
                Button {
                    saveSelection()
                } label: {
                    Text("Save")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .background(Color(.systemBackground))
            }
            .navigationTitle("Select Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingInfo = true
                    } label: {
                        Image(systemName: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                }

                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .alert("About Voices", isPresented: $showingInfo) {
                Button("OK", role: .cancel) { }
            } message: {
                Text("Premium voices offer high-quality, natural-sounding speech with multilingual support. Cloned voices let you listen to content in your own voice or voices you've created.")
            }
            .sheet(isPresented: $accountViewModel.showUpgradePrompt) {
                UpgradePromptView()
            }
            .task {
                await viewModel.loadClonedVoices()
            }
        }
    }

    // MARK: - Filter Tabs

    private var filterTabsView: some View {
        HStack(spacing: 8) {
            ForEach(VoiceFilter.allCases, id: \.self) { filter in
                VoiceFilterChip(
                    title: filter.rawValue,
                    isSelected: selectedFilter == filter,
                    onTap: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            selectedFilter = filter
                        }
                    }
                )
            }
            Spacer()
        }
    }

    // MARK: - Filtered Presets

    private var filteredPresets: [VoicePreset] {
        switch selectedFilter {
        case .popular:
            return VoicePreset.popularPresets
        case .all:
            return VoicePreset.allBuiltInPresets
        case .cloned:
            return [] // Cloned voices handled separately
        }
    }

    // MARK: - Preview Actions

    private func previewVoice(_ voice: VoicePreset) {
        previewingClonedVoiceId = nil

        if previewingVoiceId == voice.id {
            previewingVoiceId = nil
            return
        }

        previewingVoiceId = voice.id

        // Simulate preview playback
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if previewingVoiceId == voice.id {
                previewingVoiceId = nil
            }
        }
    }

    private func previewClonedVoice(_ voice: VoiceCloningService.ClonedVoice) {
        previewingVoiceId = nil

        if previewingClonedVoiceId == voice.id {
            previewingClonedVoiceId = nil
            viewModel.stopPreview()
            return
        }

        previewingClonedVoiceId = voice.id

        Task {
            await viewModel.previewClonedVoice(voice)
            previewingClonedVoiceId = nil
        }
    }

    // MARK: - Save Selection

    private func saveSelection() {
        if let clonedVoice = tempSelectedClonedVoice {
            // Create a VoicePreset from the cloned voice
            // Use a deterministic ID based on the ElevenLabs voice ID for consistency
            let stableId = stableUUID(from: clonedVoice.id)
            let preset = VoicePreset(
                id: stableId,
                name: clonedVoice.name,
                isBuiltIn: false,
                isCharacterVoice: false,
                provider: .elevenLabs,
                providerVoiceID: clonedVoice.id,
                providerModelID: "eleven_multilingual_v2",
                language: "en-US",
                supportedLanguages: ["en-US", "es", "fr", "de", "it", "pt", "pl", "hi", "ar", "zh"],
                gender: .neutral,
                age: .adult,
                style: .conversational,
                category: .custom,
                voiceDescription: "Your cloned voice",
                tier: .premium,
                sampleText: "Hello, this is your cloned voice."
            )
            presetManager.select(preset)

            // Post notification that voice changed so article views can regenerate audio
            NotificationCenter.default.post(name: .voiceDidChange, object: preset)

            dismiss()
        } else if let voice = tempSelectedVoice {
            if accountViewModel.canAccessVoice(voice) {
                presetManager.select(voice)

                // Post notification that voice changed
                NotificationCenter.default.post(name: .voiceDidChange, object: voice)

                dismiss()
            } else {
                accountViewModel.promptUpgradeForVoice(voice)
            }
        }
    }

    /// Create a stable UUID from a string (ElevenLabs voice ID)
    private func stableUUID(from string: String) -> UUID {
        // Hash the string to create consistent UUID components
        let hash = string.utf8.reduce(0) { (result, char) -> UInt64 in
            result &* 31 &+ UInt64(char)
        }

        // Create UUID bytes from the hash
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in 0..<8 {
            bytes[i] = UInt8((hash >> (i * 8)) & 0xFF)
        }
        // Use reversed string hash for second half too
        let reversedString = String(string.reversed())
        let hash2 = reversedString.utf8.reduce(0) { (result, char) -> UInt64 in
            result &* 37 &+ UInt64(char)
        }
        for i in 0..<8 {
            bytes[8 + i] = UInt8((hash2 >> (i * 8)) & 0xFF)
        }

        // Set version and variant bits for UUID v4 format
        bytes[6] = (bytes[6] & 0x0F) | 0x40  // Version 4
        bytes[8] = (bytes[8] & 0x3F) | 0x80  // Variant

        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3],
                          bytes[4], bytes[5], bytes[6], bytes[7],
                          bytes[8], bytes[9], bytes[10], bytes[11],
                          bytes[12], bytes[13], bytes[14], bytes[15]))
    }
}

// MARK: - Notifications

extension Notification.Name {
    static let voiceDidChange = Notification.Name("com.listenai.voiceDidChange")
}

// MARK: - Voice Filter Chip

private struct VoiceFilterChip: View {
    let title: String
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(isSelected ? .primary : .secondary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(isSelected ? Color(.systemGray5) : Color.clear)
                .clipShape(Capsule())
                .overlay {
                    if !isSelected {
                        Capsule()
                            .strokeBorder(Color(.systemGray4), lineWidth: 1)
                    }
                }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Voice Row

private struct VoiceRow: View {
    let voice: VoicePreset
    let isSelected: Bool
    let isPreviewing: Bool
    let onSelect: () -> Void
    let onPreview: () -> Void

    @StateObject private var accountViewModel = UserAccountViewModel.shared

    private var isLocked: Bool {
        !accountViewModel.canAccessVoice(voice)
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 16) {
                // Profile image
                VoiceAvatar(voice: voice, size: 56)

                // Voice info
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(voice.name)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)

                        if isLocked {
                            Image(systemName: "lock.fill")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Text(voiceQualityLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Waveform visualization
                WaveformView(isAnimating: isPreviewing)
                    .frame(width: 60, height: 24)

                // Play button
                Button(action: onPreview) {
                    ZStack {
                        Circle()
                            .fill(Color.yellow)
                            .frame(width: 40, height: 40)

                        Image(systemName: isPreviewing ? "stop.fill" : "play.fill")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.black)
                            .offset(x: isPreviewing ? 0 : 2)
                    }
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(isSelected ? Color.blue.opacity(0.1) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var voiceStyleLabel: String {
        // Show the style as primary info
        voice.style.description
    }

    private var voiceQualityLabel: String {
        var parts: [String] = []

        // Add style first
        parts.append(voice.style.displayName)

        // Add quality indicator
        if voice.provider == .elevenLabs {
            parts.append("Premium")
        } else if voice.provider == .openAI {
            parts.append("Cloud")
        }

        return parts.joined(separator: " • ")
    }
}

// MARK: - Cloned Voice Row

private struct ClonedVoiceRow: View {
    let voice: VoiceCloningService.ClonedVoice
    let isSelected: Bool
    let isPreviewing: Bool
    let onSelect: () -> Void
    let onPreview: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 16) {
                // Avatar placeholder
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color(.systemGray5))
                    .frame(width: 56, height: 56)
                    .overlay {
                        Image(systemName: "person.fill")
                            .font(.title2)
                            .foregroundStyle(Color(.systemGray3))
                    }

                // Voice info
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(voice.name)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)

                        Image(systemName: "mic.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    Text("Cloned Voice • Multilingual")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Waveform visualization
                WaveformView(isAnimating: isPreviewing)
                    .frame(width: 60, height: 24)

                // Play button
                Button(action: onPreview) {
                    ZStack {
                        Circle()
                            .fill(Color.yellow)
                            .frame(width: 40, height: 40)

                        Image(systemName: isPreviewing ? "stop.fill" : "play.fill")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.black)
                            .offset(x: isPreviewing ? 0 : 2)
                    }
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(isSelected ? Color.blue.opacity(0.1) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Voice Avatar

struct VoiceAvatar: View {
    let voice: VoicePreset
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(avatarGradient)
                .frame(width: size, height: size)

            // Use emoji if available, otherwise fallback to icon or initials
            if let emoji = voice.avatarEmoji {
                Text(emoji)
                    .font(.system(size: size * 0.55))
            } else if let iconName = voice.iconName {
                Image(systemName: iconName)
                    .font(.system(size: size * 0.4))
                    .foregroundStyle(.white)
            } else {
                Text(voiceInitials)
                    .font(.system(size: size * 0.35, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
    }

    private var avatarGradient: LinearGradient {
        let baseColor = Color(hex: voice.accentColorHex ?? "#6B7280")
        return LinearGradient(
            colors: [baseColor, baseColor.opacity(0.7)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var voiceInitials: String {
        let words = voice.name.split(separator: " ")
        if words.count >= 2 {
            return String(words[0].prefix(1) + words[1].prefix(1))
        }
        return String(voice.name.prefix(2)).uppercased()
    }
}

// MARK: - Waveform View

struct WaveformView: View {
    let isAnimating: Bool

    @State private var animationPhase: CGFloat = 0

    private let barCount = 12

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<barCount, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3, height: barHeight(for: index))
            }
        }
        .animation(isAnimating ? .easeInOut(duration: 0.3).repeatForever(autoreverses: true) : .default, value: animationPhase)
        .onChange(of: isAnimating) { _, newValue in
            if newValue {
                withAnimation {
                    animationPhase = 1
                }
            } else {
                animationPhase = 0
            }
        }
    }

    private func barHeight(for index: Int) -> CGFloat {
        let baseHeights: [CGFloat] = [8, 12, 16, 20, 16, 24, 20, 16, 20, 16, 12, 8]
        let height = baseHeights[index % baseHeights.count]

        if isAnimating {
            let variation = sin(CGFloat(index) + animationPhase * .pi * 2) * 4
            return max(4, height + variation)
        }

        return height
    }
}

// MARK: - Select Voice View Model

@MainActor
class SelectVoiceViewModel: ObservableObject {
    @Published var clonedVoices: [VoiceCloningService.ClonedVoice] = []
    @Published var isLoadingClonedVoices = false

    private var audioPlayer: AVAudioPlayer?

    func loadClonedVoices() async {
        isLoadingClonedVoices = true
        defer { isLoadingClonedVoices = false }

        do {
            clonedVoices = try await VoiceCloningService.shared.listClonedVoices()
        } catch {
            // Silently fail - cloned voices just won't show
            clonedVoices = []
        }
    }

    func previewClonedVoice(_ voice: VoiceCloningService.ClonedVoice) async {
        do {
            let audioURL = try await VoiceCloningService.shared.previewClonedVoice(voice.id)
            audioPlayer = try AVAudioPlayer(contentsOf: audioURL)
            audioPlayer?.play()

            // Wait for playback to complete
            try await Task.sleep(for: .seconds(audioPlayer?.duration ?? 3))
        } catch {
            // Silently fail
        }
    }

    func stopPreview() {
        audioPlayer?.stop()
        audioPlayer = nil
    }
}

// MARK: - Article Voice Selector

/// A voice selector button for use in article reader views.
/// Shows current voice with option to change.
struct ArticleVoiceSelector: View {
    @StateObject private var presetManager = VoicePresetManager.shared
    @State private var showingVoicePicker = false

    var body: some View {
        Button {
            showingVoicePicker = true
        } label: {
            HStack(spacing: 8) {
                VoiceAvatar(voice: presetManager.selectedPreset, size: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text(presetManager.selectedPreset.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)

                    Text("Tap to change voice")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showingVoicePicker) {
            SelectVoiceView()
        }
    }
}

// MARK: - Inline Voice Picker

/// Compact inline voice picker for toolbars.
struct InlineVoicePicker: View {
    @StateObject private var presetManager = VoicePresetManager.shared
    @State private var showingVoicePicker = false

    var body: some View {
        Button {
            showingVoicePicker = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "person.wave.2")
                    .font(.subheadline)
                Text(presetManager.selectedPreset.name)
                    .font(.subheadline)
                    .lineLimit(1)
            }
            .foregroundStyle(.primary)
        }
        .sheet(isPresented: $showingVoicePicker) {
            SelectVoiceView()
        }
    }
}

// MARK: - Preview

#Preview {
    SelectVoiceView()
}
