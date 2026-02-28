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
                                    isPreviewing: previewingClonedVoiceId == clonedVoice.id && !viewModel.isPreviewLoading,
                                    isLoading: previewingClonedVoiceId == clonedVoice.id && viewModel.isPreviewLoading,
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
                RemotePaywallView(triggerSource: "select_voice")
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
        viewModel.stopPreview()

        if previewingVoiceId == voice.id {
            previewingVoiceId = nil
            return
        }

        previewingVoiceId = voice.id

        Task {
            // Play bundled audio sample for this voice
            if let duration = await viewModel.previewBuiltInVoice(voice) {
                // Wait for playback to complete, then reset state
                try? await Task.sleep(for: .seconds(duration))
                if previewingVoiceId == voice.id {
                    previewingVoiceId = nil
                }
            } else {
                // No bundled sample found, reset immediately
                previewingVoiceId = nil
            }
        }
    }

    private func previewClonedVoice(_ voice: VoiceCloningService.ClonedVoice) {
        previewingVoiceId = nil
        viewModel.stopPreview()

        if previewingClonedVoiceId == voice.id {
            previewingClonedVoiceId = nil
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
            // Use a deterministic ID based on the voice ID for consistency
            let stableId = stableUUID(from: clonedVoice.id)
            let preset = VoicePreset(
                id: stableId,
                name: clonedVoice.name,
                isBuiltIn: false,
                isCharacterVoice: false,
                provider: .selfhosted,  // Cloned voices use selfhosted Chatterbox TTS
                providerVoiceID: clonedVoice.id,
                providerModelID: "chatterbox",
                language: "en-US",
                supportedLanguages: ["en-US"],
                gender: .neutral,
                age: .adult,
                style: .conversational,
                category: .custom,
                voiceDescription: "Your cloned voice",
                tier: .free,  // Selfhosted is free tier
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
    let isLoading: Bool
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

                    Text(isLoading ? "Generating preview..." : "Cloned Voice • Multilingual")
                        .font(.caption)
                        .foregroundStyle(isLoading ? .orange : .secondary)
                }

                Spacer()

                // Waveform visualization
                WaveformView(isAnimating: isPreviewing || isLoading)
                    .frame(width: 60, height: 24)

                // Play button
                Button(action: onPreview) {
                    ZStack {
                        Circle()
                            .fill(Color.yellow)
                            .frame(width: 40, height: 40)

                        if isLoading {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .black))
                                .scaleEffect(0.7)
                        } else {
                            Image(systemName: isPreviewing ? "stop.fill" : "play.fill")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.black)
                                .offset(x: isPreviewing ? 0 : 2)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
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
class SelectVoiceViewModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var clonedVoices: [VoiceCloningService.ClonedVoice] = []
    @Published var isLoadingClonedVoices = false
    @Published var isPreviewPlaying = false
    @Published var isPreviewLoading = false

    private var audioPlayer: AVAudioPlayer?
    private var previewTask: Task<Void, Never>?

    /// Mapping from ElevenLabs voice IDs to bundled sample filenames
    private let voiceSampleFiles: [String: String] = [
        "21m00Tcm4TlvDq8ikWAM": "voice_sample_rachel",     // Rachel
        "pNInz6obpgDQGcFmaJgB": "voice_sample_adam",       // Adam
        "nPczCjzI2devNBz1zQrb": "voice_sample_brian",      // Brian
        "EXAVITQu4vr4xnSDxMaL": "voice_sample_bella",      // Bella
        "TxGEqnHWrfWFTfGW9XjX": "voice_sample_josh",       // Josh
        "XB0fDUnXU5powFXDhCwa": "voice_sample_charlotte",  // Charlotte
        "MF3mGyEYCl7XYWbV9V6O": "voice_sample_bella",      // Elli (uses Bella sample)
        "XrExE9yKIg1WjnnlVkGX": "voice_sample_adam",       // Matilda (uses Adam sample)
        "pqHfZKP75CvOlQylNhV4": "voice_sample_brian",      // Bill (uses Brian sample)
        "ThT5KcBeYPX3keUQqHPh": "voice_sample_bella",      // Dorothy (uses Bella sample)
        "VR6AewLTigWG4xSOukaG": "voice_sample_adam",       // Arnold (uses Adam sample)
        "JBFqnCBsd6RMkjVDRZzb": "voice_sample_brian",      // George (uses Brian sample)
        "pFZP5JQG7iQjIQuC4Bku": "voice_sample_charlotte",  // Lily (uses Charlotte sample)
    ]

    /// Sample text for cloned voice preview synthesis
    private let clonedVoiceSampleText = "Hello, this is a preview of your cloned voice. I can read your articles with this unique sound."

    /// Local cache directory for cloned voice previews
    private var previewCacheDirectory: URL {
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let previewDir = cacheDir.appendingPathComponent("cloned_voice_previews", isDirectory: true)
        try? FileManager.default.createDirectory(at: previewDir, withIntermediateDirectories: true)
        return previewDir
    }

    override init() {
        super.init()
    }

    func loadClonedVoices() async {
        isLoadingClonedVoices = true
        defer { isLoadingClonedVoices = false }

        do {
            // Force refresh to ensure we have the latest voices from server
            // This prevents showing stale/deleted voices that no longer exist
            clonedVoices = try await VoiceCloningService.shared.listClonedVoices(forceRefresh: true)
        } catch {
            // Silently fail - cloned voices just won't show
            clonedVoices = []
        }
    }

    /// Preview a built-in voice using bundled audio samples
    func previewBuiltInVoice(_ voice: VoicePreset) async -> TimeInterval? {
        stopPreview()

        // Configure audio session
        configureAudioSession()

        // Look up the bundled sample file for this voice
        guard let sampleFilename = voiceSampleFiles[voice.providerVoiceID] else {
            print("SelectVoiceViewModel: No bundled sample for voice: \(voice.name) (\(voice.providerVoiceID))")
            return nil
        }

        // Try to load the bundled WAV file
        guard let sampleURL = Bundle.main.url(forResource: sampleFilename, withExtension: "wav") else {
            print("SelectVoiceViewModel: Bundled file not found: \(sampleFilename).wav")
            return nil
        }

        do {
            audioPlayer = try AVAudioPlayer(contentsOf: sampleURL)
            audioPlayer?.delegate = self
            audioPlayer?.prepareToPlay()
            audioPlayer?.play()
            isPreviewPlaying = true

            return audioPlayer?.duration
        } catch {
            print("SelectVoiceViewModel: Error playing bundled file: \(error)")
            return nil
        }
    }

    /// Preview a cloned voice - uses cached audio if available, otherwise synthesizes and caches
    func previewClonedVoice(_ voice: VoiceCloningService.ClonedVoice) async {
        stopPreview()

        // Check for cached preview first
        let cachedURL = getCachedPreviewURL(for: voice.id)
        if FileManager.default.fileExists(atPath: cachedURL.path) {
            // Play from cache - no loading needed
            do {
                configureAudioSession()

                audioPlayer = try AVAudioPlayer(contentsOf: cachedURL)
                audioPlayer?.delegate = self
                audioPlayer?.prepareToPlay()
                audioPlayer?.play()
                isPreviewPlaying = true

                // Wait for playback to complete
                try await Task.sleep(for: .seconds(audioPlayer?.duration ?? 5))
                return
            } catch {
                // Cache file might be corrupted, delete and re-synthesize
                try? FileManager.default.removeItem(at: cachedURL)
            }
        }

        // No cached preview - synthesize and cache
        isPreviewLoading = true

        previewTask = Task {
            do {
                // Configure audio session
                configureAudioSession()

                // Synthesize sample text using the cloned voice via TTS
                let audioURL = try await synthesizeClonedVoicePreview(voiceId: voice.id)

                if Task.isCancelled { return }

                // Copy to cache for future use
                try? FileManager.default.copyItem(at: audioURL, to: cachedURL)

                audioPlayer = try AVAudioPlayer(contentsOf: audioURL)
                audioPlayer?.delegate = self
                audioPlayer?.prepareToPlay()
                audioPlayer?.play()

                await MainActor.run {
                    isPreviewLoading = false
                    isPreviewPlaying = true
                }

                // Wait for playback to complete
                try await Task.sleep(for: .seconds(audioPlayer?.duration ?? 5))
            } catch {
                await MainActor.run {
                    isPreviewLoading = false
                    isPreviewPlaying = false
                }
                print("SelectVoiceViewModel: Error previewing cloned voice: \(error)")
            }
        }
    }

    /// Get the cached preview URL for a voice ID
    /// Cloned voices return WAV format, so use .wav extension
    private func getCachedPreviewURL(for voiceId: String) -> URL {
        previewCacheDirectory.appendingPathComponent("preview_\(voiceId).wav")
    }

    /// Synthesize sample text using a cloned voice
    private func synthesizeClonedVoicePreview(voiceId: String) async throws -> URL {
        // Use TTSCoordinator to synthesize with the cloned voice
        let coordinator = TTSCoordinator.shared

        // Create a temporary voice preset for the cloned voice
        // Use selfhosted provider with custom category so TTSCoordinator routes to Chatterbox
        let tempPreset = VoicePreset(
            name: "Preview",
            isBuiltIn: false,
            isCharacterVoice: false,
            provider: .selfhosted,
            providerVoiceID: voiceId,
            providerModelID: nil,  // No model ID - uses Chatterbox for cloned voices
            language: "en-US",
            supportedLanguages: ["en-US"],
            gender: .neutral,
            age: .adult,
            style: .conversational,
            category: .custom,  // Custom category triggers cloned voice path
            voiceDescription: "Cloned voice preview",
            tier: .free,  // Cloned voices don't count against premium quota
            sampleText: clonedVoiceSampleText
        )

        // Synthesize using standard quality - TTSCoordinator will route to Chatterbox
        let audioURL = try await coordinator.synthesizeWithQuality(
            text: clonedVoiceSampleText,
            voice: tempPreset,
            quality: .standard
        )

        return audioURL
    }

    func stopPreview() {
        previewTask?.cancel()
        previewTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        isPreviewPlaying = false
        isPreviewLoading = false
    }

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("SelectVoiceViewModel: Failed to configure audio session: \(error)")
        }
    }

    // MARK: - AVAudioPlayerDelegate

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPreviewPlaying = false
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.isPreviewPlaying = false
        }
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
