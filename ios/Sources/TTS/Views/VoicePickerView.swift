import SwiftUI
import AVFoundation

// Note: Accessibility extensions are defined in AccessibilityHelpers.swift

// MARK: - Voice Picker View

/// Main view for selecting and customizing voice presets.
struct VoicePickerView: View {
    @StateObject private var presetManager = VoicePresetManager.shared
    @StateObject private var accountViewModel = UserAccountViewModel.shared
    @StateObject private var usageTracker = UsageTrackerService.shared
    @StateObject private var voicePreviewPlayer = VoicePreviewPlayer.shared
    @State private var searchText = ""
    @State private var selectedCategory: VoiceCategory?
    @State private var selectedQuality: VoiceQuality = .standard
    @State private var showingCustomization = false
    @State private var previewingPreset: VoicePreset?
    @State private var isPlayingPreview = false
    @State private var lockedVoiceForUpgrade: VoicePreset?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.sizeCategory) private var sizeCategory
    @Environment(\.colorSchemeContrast) private var contrast

    /// Whether to use single column layout for accessibility sizes
    private var useSingleColumnLayout: Bool {
        sizeCategory.isAccessibilityCategory
    }

    private var filteredPresets: [VoicePreset] {
        var presets = presetManager.availablePresets()

        if let category = selectedCategory {
            presets = presets.filter { $0.category == category }
        }

        if !searchText.isEmpty {
            presets = presetManager.search(searchText)
        }

        return presets
    }

    /// Check if a voice is accessible based on user's plan
    private func isVoiceAccessible(_ voice: VoicePreset) -> Bool {
        accountViewModel.canAccessVoice(voice)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Current Selection
                    currentSelectionCard

                    // Quality Selector hidden - all voices use Kokoro now
                    // qualitySelector

                    // Category Filter
                    categoryPicker

                    // Voice Grid
                    voiceGrid
                }
                .padding()
            }
            .navigationTitle("Choose Voice")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search voices")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .sheet(isPresented: $showingCustomization) {
                VoiceCustomizationSheet(preset: presetManager.selectedPreset)
            }
            .sheet(isPresented: $accountViewModel.showUpgradePrompt) {
                UpgradePromptView()
            }
        }
    }

    // MARK: - Current Selection Card

    private var currentSelectionCard: some View {
        VStack(spacing: 16) {
            HStack(spacing: 16) {
                // Voice Avatar
                VoicePickerAvatarView(
                    preset: presetManager.selectedPreset,
                    size: 60
                )

                VStack(alignment: .leading, spacing: 4) {
                    Text(presetManager.selectedPreset.name)
                        .font(.headline)

                    Text(presetManager.configurationSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    // Speed indicator
                    HStack(spacing: 4) {
                        Image(systemName: "speedometer")
                            .font(.caption2)
                        Text(String(format: "%.1fx", presetManager.effectiveSpeakingRate))
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }

                Spacer()

                Button(action: { showingCustomization = true }) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.title3)
                        .foregroundStyle(.blue)
                }
            }

            // Quick Speed Slider
            VStack(alignment: .leading, spacing: 4) {
                Text("Speed")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack {
                    Image(systemName: "tortoise")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Slider(
                        value: Binding(
                            get: { presetManager.effectiveSpeakingRate },
                            set: { presetManager.adjustSpeakingRate($0) }
                        ),
                        in: 0.5...2.0,
                        step: 0.1
                    )

                    Image(systemName: "hare")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Quality Selector

    private var qualitySelector: some View {
        VStack(spacing: 12) {
            // Header with premium status
            HStack {
                Text("Voice Quality")
                    .font(.headline)

                Spacer()

                if usageTracker.currentTier != .unlimited {
                    premiumSamplesBadge
                }
            }

            // Quality toggle
            HStack(spacing: 0) {
                qualityOption(
                    quality: .standard,
                    title: "Standard",
                    subtitle: "Fast & Unlimited",
                    icon: "bolt.fill",
                    isSelected: selectedQuality == .standard
                )

                qualityOption(
                    quality: .premium,
                    title: "Premium",
                    subtitle: "Highest Quality",
                    icon: "sparkles",
                    isSelected: selectedQuality == .premium,
                    isLocked: !usageTracker.canUsePremiumQuality
                )
            }
            .background(Color(.tertiarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))

            // Quality explanation
            if selectedQuality == .premium && !usageTracker.canUsePremiumQuality {
                premiumExhaustedBanner
            } else if selectedQuality == .premium {
                Text("Premium quality uses ElevenLabs for studio-grade voices")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Standard quality uses our natural-sounding Kokoro voices")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private func qualityOption(
        quality: VoiceQuality,
        title: String,
        subtitle: String,
        icon: String,
        isSelected: Bool,
        isLocked: Bool = false
    ) -> some View {
        Button(action: {
            if !isLocked {
                withAnimation(.easeInOut(duration: 0.2)) {
                    selectedQuality = quality
                }
            } else {
                accountViewModel.showUpgradePrompt = true
            }
        }) {
            VStack(spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: icon)
                        .font(.caption)

                    Text(title)
                        .font(.subheadline.weight(.semibold))

                    if isLocked {
                        Image(systemName: "lock.fill")
                            .font(.caption2)
                    }
                }

                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(isSelected && !isLocked ? Color.blue : Color.clear)
            .foregroundStyle(isSelected && !isLocked ? .white : (isLocked ? .secondary : .primary))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title) quality")
        .accessibilityHint(isLocked ? "Locked, double tap to upgrade" : (isSelected ? "Currently selected" : "Double tap to select"))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var premiumSamplesBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: "sparkles")
                .font(.caption2)

            if usageTracker.remainingPremiumSamples == Int.max {
                Text("Unlimited")
                    .font(.caption2.weight(.medium))
            } else {
                Text("\(usageTracker.remainingPremiumSamples)/\(usageTracker.dailyPremiumSampleLimit)")
                    .font(.caption2.weight(.medium))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            usageTracker.canUsePremiumQuality
                ? Color.yellow.opacity(0.2)
                : Color.gray.opacity(0.2)
        )
        .foregroundStyle(
            usageTracker.canUsePremiumQuality
                ? Color.yellow
                : Color.secondary
        )
        .clipShape(Capsule())
    }

    private var premiumExhaustedBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 2) {
                Text("Premium samples used for today")
                    .font(.caption.weight(.medium))

                Text("Resets at midnight, or upgrade for more")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button("Upgrade") {
                accountViewModel.showUpgradePrompt = true
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.blue)
            .clipShape(Capsule())
        }
        .padding()
        .background(Color.orange.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Category Picker

    private var categoryPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                CategoryChip(
                    title: "All",
                    icon: "square.grid.2x2",
                    isSelected: selectedCategory == nil
                ) {
                    selectedCategory = nil
                }

                ForEach(VoiceCategory.allCases.filter { $0 != .custom }, id: \.self) { category in
                    CategoryChip(
                        title: category.displayName,
                        icon: category.iconName,
                        isSelected: selectedCategory == category
                    ) {
                        selectedCategory = category
                    }
                }
            }
        }
    }

    // MARK: - Voice Grid

    private var voiceGrid: some View {
        let columns = useSingleColumnLayout
            ? [GridItem(.flexible())]
            : [GridItem(.flexible()), GridItem(.flexible())]

        return LazyVGrid(columns: columns, spacing: 16) {
            ForEach(filteredPresets) { preset in
                let isAccessible = isVoiceAccessible(preset)

                VoicePresetCard(
                    preset: preset,
                    isSelected: preset.id == presetManager.selectedPreset.id,
                    isPreviewing: previewingPreset?.id == preset.id && isPlayingPreview,
                    isLoading: previewingPreset?.id == preset.id && voicePreviewPlayer.isLoading,
                    isLocked: !isAccessible,
                    onSelect: {
                        if isAccessible {
                            presetManager.select(preset)
                        } else {
                            // Show upgrade prompt for locked voice
                            accountViewModel.promptUpgradeForVoice(preset)
                        }
                    },
                    onPreview: {
                        // Allow previewing locked voices
                        previewVoice(preset)
                    }
                )
            }
        }
    }

    // MARK: - Preview

    private func previewVoice(_ preset: VoicePreset) {
        // If already previewing this voice, stop it
        if previewingPreset?.id == preset.id && isPlayingPreview {
            voicePreviewPlayer.stop()
            isPlayingPreview = false
            previewingPreset = nil
            return
        }

        // Stop any current preview
        voicePreviewPlayer.stop()

        previewingPreset = preset
        isPlayingPreview = true

        // Preview using the TTS service
        Task {
            do {
                try await voicePreviewPlayer.preview(voice: preset)
            } catch {
                print("[VoicePicker] Preview failed: \(error)")
            }

            await MainActor.run {
                isPlayingPreview = false
                previewingPreset = nil
            }
        }
    }
}

// MARK: - Voice Preview Player

/// Handles voice preview playback using the TTS backend for natural-sounding voices
@MainActor
final class VoicePreviewPlayer: ObservableObject {
    static let shared = VoicePreviewPlayer()

    @Published private(set) var isPlaying: Bool = false
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var currentVoiceId: UUID?
    @Published private(set) var errorMessage: String?

    private var audioPlayer: AVAudioPlayer?
    private var currentTask: Task<Void, Never>?

    private init() {}

    /// Preview a voice using the TTS backend for natural-sounding playback
    func preview(voice: VoicePreset) async throws {
        // Cancel any existing preview
        stop()

        currentVoiceId = voice.id
        isLoading = true
        errorMessage = nil

        do {
            // Configure audio session first
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)

            // Use the voice's sample text
            let previewText = voice.sampleText

            print("[VoicePreview] Starting preview for \(voice.name): \(previewText)")

            // Synthesize using TTSCoordinator (uses backend TTS service)
            let audioURL = try await TTSCoordinator.shared.synthesize(
                text: previewText,
                voice: voice
            )

            print("[VoicePreview] Got audio URL: \(audioURL)")

            // Check if we were cancelled during synthesis
            try Task.checkCancellation()

            isLoading = false
            isPlaying = true

            // Play the audio
            let player = try AVAudioPlayer(contentsOf: audioURL)
            self.audioPlayer = player
            player.play()

            print("[VoicePreview] Playing audio...")

            // Wait for playback to finish
            while player.isPlaying {
                try await Task.sleep(nanoseconds: 100_000_000) // 100ms
                try Task.checkCancellation()
            }

            print("[VoicePreview] Playback complete")

        } catch is CancellationError {
            print("[VoicePreview] Preview cancelled")
        } catch {
            print("[VoicePreview] Error: \(error)")
            errorMessage = error.localizedDescription
            throw error
        }

        isLoading = false
        isPlaying = false
        currentVoiceId = nil
    }

    /// Stop current preview
    func stop() {
        currentTask?.cancel()
        currentTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        isLoading = false
        isPlaying = false
        currentVoiceId = nil
        errorMessage = nil
    }
}

// MARK: - Voice Picker Avatar View

/// Enhanced voice avatar for the voice picker with gender indicators
struct VoicePickerAvatarView: View {
    let preset: VoicePreset
    let size: CGFloat
    var isLocked: Bool = false

    private var accentColor: Color {
        isLocked ? .gray : Color(hex: preset.accentColorHex ?? "#3B82F6")
    }

    /// Get appropriate SF Symbol for the voice based on gender
    private var genderIcon: String {
        switch preset.gender {
        case .male:
            return "person.fill"
        case .female:
            return "person.fill"
        case .neutral:
            return "person.fill"
        }
    }

    /// Get initials from the voice name
    private var initials: String {
        let words = preset.name.split(separator: " ")
        if words.count >= 2 {
            return String(words[0].prefix(1) + words[1].prefix(1)).uppercased()
        } else if let first = words.first {
            return String(first.prefix(2)).uppercased()
        }
        return "V"
    }

    var body: some View {
        ZStack {
            // Background circle with gradient
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            accentColor,
                            accentColor.opacity(0.7)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: size, height: size)

            // Content: emoji, image, or icon
            if isLocked {
                Image(systemName: "lock.fill")
                    .font(.system(size: size * 0.4))
                    .foregroundStyle(.white)
            } else if let emoji = preset.avatarEmoji {
                // Character voices have emojis
                Text(emoji)
                    .font(.system(size: size * 0.55))
            } else if preset.isCharacterVoice {
                // Character voice without emoji - use themed icon
                Image(systemName: characterIcon)
                    .font(.system(size: size * 0.45))
                    .foregroundStyle(.white)
            } else {
                // Regular voice - show person silhouette with gender styling
                VStack(spacing: 0) {
                    // Head
                    Circle()
                        .fill(Color.white)
                        .frame(width: size * 0.35, height: size * 0.35)
                        .offset(y: size * 0.02)

                    // Body
                    Capsule()
                        .fill(Color.white)
                        .frame(width: size * 0.5, height: size * 0.25)
                        .offset(y: -size * 0.02)
                }
            }
        }
        .overlay(
            // Gender indicator dot
            genderIndicator
                .offset(x: size * 0.35, y: size * 0.35)
        )
    }

    /// Icon for character voices based on their category/style
    private var characterIcon: String {
        switch preset.style {
        case .narrative, .dramatic:
            return "book.fill"
        case .news, .serious:
            return "newspaper.fill"
        case .calm:
            return "leaf.fill"
        case .conversational, .friendly:
            return "mic.fill"
        case .educational:
            return "graduationcap.fill"
        case .character, .whimsical:
            return "theatermasks.fill"
        case .excited:
            return "sparkles"
        default:
            return "waveform"
        }
    }

    @ViewBuilder
    private var genderIndicator: some View {
        if !isLocked && !preset.isCharacterVoice {
            Circle()
                .fill(genderColor)
                .frame(width: size * 0.22, height: size * 0.22)
                .overlay(
                    Circle()
                        .stroke(Color(.systemBackground), lineWidth: 2)
                )
        }
    }

    private var genderColor: Color {
        switch preset.gender {
        case .male:
            return .blue
        case .female:
            return .pink
        case .neutral:
            return .purple
        }
    }
}

// MARK: - Category Chip

struct CategoryChip: View {
    let title: String
    let icon: String
    let isSelected: Bool
    let action: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.subheadline)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(isSelected ? Color.blue : Color(.tertiarySystemBackground))
            .foregroundStyle(isSelected ? .white : .primary)
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(
                        contrast == .increased && isSelected ? Color.white : Color.clear,
                        lineWidth: 2
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title) category")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint(isSelected ? "Currently selected" : "Double tap to filter by this category")
    }
}

// MARK: - Voice Preset Card

struct VoicePresetCard: View {
    let preset: VoicePreset
    let isSelected: Bool
    let isPreviewing: Bool
    var isLoading: Bool = false
    var isLocked: Bool = false
    let onSelect: () -> Void
    let onPreview: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.sizeCategory) private var sizeCategory

    private var accentColor: Color {
        Color(hex: preset.accentColorHex ?? "#3B82F6")
    }

    private var cardHeight: CGFloat {
        sizeCategory.isAccessibilityCategory ? 260 : 200
    }

    @ViewBuilder
    private var tierBadge: some View {
        // Character voices get a special badge
        if preset.isCharacterVoice {
            Text("CHARACTER")
                .font(.caption2.bold())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.purple)
            .foregroundStyle(.white)
            .clipShape(Capsule())
            .accessibilityLabel("Character voice")
        }
        // No premium tier badges - all voices use Kokoro now
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                // Voice Avatar
                VoicePickerAvatarView(
                    preset: preset,
                    size: 44,
                    isLocked: isLocked
                )
                .accessibilityHidden(true)

                Spacer()

                // Tier badge
                tierBadge

                // Preview button
                Button(action: onPreview) {
                    ZStack {
                        Circle()
                            .fill(isPreviewing ? Color.red.opacity(0.15) : Color.blue.opacity(0.1))
                            .frame(width: 36, height: 36)

                        if isLoading {
                            ProgressView()
                                .scaleEffect(0.8)
                        } else {
                            Image(systemName: isPreviewing ? "stop.fill" : "play.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(isPreviewing ? .red : .blue)
                        }
                    }
                }
                .disabled(isLoading)
                .accessibilityLabel(isLoading ? "Loading preview" : (isPreviewing ? "Stop preview" : "Preview voice"))
                .accessibilityHint(isPreviewing ? "Double tap to stop" : "Double tap to hear a sample")
            }

            // Name
            HStack(spacing: 4) {
                Text(preset.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(isLocked ? .secondary : .primary)

                if isLocked {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            // Description
            Text(preset.voiceDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(sizeCategory.isAccessibilityCategory ? 4 : 2)
                .fixedSize(horizontal: false, vertical: true)

            // Style indicators
            HStack(spacing: 8) {
                StyleIndicator(
                    icon: "speedometer",
                    value: preset.styleParameters.speakingRate,
                    label: "Speed"
                )

                StyleIndicator(
                    icon: "waveform",
                    value: preset.styleParameters.expressiveness,
                    label: "Expression"
                )
            }
            .opacity(isLocked ? 0.5 : 1.0)
            .accessibilityHidden(true)

            Spacer()

            // Quality badge - all voices use Kokoro (standard) now
            if !isLocked {
                HStack(spacing: 2) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 8))
                    Text("Kokoro")
                        .font(.system(size: 9, weight: .medium))
                }
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.green.opacity(0.15))
                .foregroundStyle(.green)
                .clipShape(Capsule())
            }
        }
        .padding()
        .frame(height: cardHeight)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isSelected && !isLocked ? accentColor : Color.clear, lineWidth: contrast == .increased ? 4 : 3)
        )
        .opacity(isLocked ? 0.85 : 1.0)
        .onTapGesture(perform: onSelect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(cardAccessibilityLabel)
        .accessibilityHint(isLocked ? "Double tap to view upgrade options" : "Double tap to select this voice")
        .accessibilityAddTraits(isSelected && !isLocked ? [.isButton, .isSelected] : .isButton)
    }

    private var cardAccessibilityLabel: String {
        var label = preset.name
        if isLocked {
            label += ", Locked"
        }
        if preset.tier == .premium {
            label += ", Premium tier"
        } else if preset.tier == .enterprise {
            label += ", Enterprise tier"
        }
        if preset.isCharacterVoice {
            label += ", Character voice"
        }
        label += ". \(preset.voiceDescription)"
        label += ". Speed: \(String(format: "%.1f", preset.styleParameters.speakingRate))"

        // Quality support
        if preset.supportsStandardQuality && preset.supportsPremiumQuality {
            label += ". Supports both Standard and Premium quality"
        } else if preset.supportsStandardQuality {
            label += ". Standard quality"
        } else if preset.isPremiumOnly {
            label += ". Premium quality only"
        }

        if isSelected && !isLocked {
            label += ". Selected"
        }
        return label
    }
}

// MARK: - Style Indicator

struct StyleIndicator: View {
    let icon: String
    let value: Float
    let label: String

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption2)
                Text(String(format: "%.1f", value))
                    .font(.caption2.monospacedDigit())
            }

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.2))
                        .frame(height: 4)

                    Capsule()
                        .fill(Color.blue)
                        .frame(width: geometry.size.width * CGFloat(min(1, value)), height: 4)
                }
            }
            .frame(height: 4)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Voice Customization Sheet

struct VoiceCustomizationSheet: View {
    let preset: VoicePreset
    @StateObject private var presetManager = VoicePresetManager.shared
    @Environment(\.dismiss) private var dismiss

    @State private var speakingRate: Float
    @State private var pitch: Float
    @State private var volume: Float
    @State private var expressiveness: Float
    @State private var warmth: Float
    @State private var pauseDuration: Float

    init(preset: VoicePreset) {
        self.preset = preset
        let params = VoicePresetManager.shared.effectiveStyleParameters
        _speakingRate = State(initialValue: params.speakingRate)
        _pitch = State(initialValue: params.pitch)
        _volume = State(initialValue: params.volume)
        _expressiveness = State(initialValue: params.expressiveness)
        _warmth = State(initialValue: params.warmth)
        _pauseDuration = State(initialValue: params.pauseDuration)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Speed & Pitch") {
                    SliderRow(
                        title: "Speaking Rate",
                        value: $speakingRate,
                        range: 0.5...2.0,
                        icon: "speedometer",
                        format: "%.1fx"
                    )

                    SliderRow(
                        title: "Pitch",
                        value: $pitch,
                        range: 0.5...2.0,
                        icon: "waveform.path",
                        format: "%.2f"
                    )

                    SliderRow(
                        title: "Volume",
                        value: $volume,
                        range: 0.0...1.0,
                        icon: "speaker.wave.3",
                        format: "%.0f%%",
                        multiplier: 100
                    )
                }

                Section("Expression") {
                    SliderRow(
                        title: "Expressiveness",
                        value: $expressiveness,
                        range: 0.0...1.0,
                        icon: "theatermasks",
                        format: "%.0f%%",
                        multiplier: 100
                    )

                    SliderRow(
                        title: "Warmth",
                        value: $warmth,
                        range: 0.0...1.0,
                        icon: "sun.max",
                        format: "%.0f%%",
                        multiplier: 100
                    )
                }

                Section("Pacing") {
                    SliderRow(
                        title: "Pause Duration",
                        value: $pauseDuration,
                        range: 0.5...2.0,
                        icon: "pause.circle",
                        format: "%.1fx"
                    )
                }

                Section {
                    Button("Reset to Preset Defaults") {
                        resetToDefaults()
                    }
                    .foregroundStyle(.red)
                }

                Section {
                    Button("Save as Custom Voice") {
                        saveAsCustom()
                    }
                }
            }
            .navigationTitle("Customize Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        applyChanges()
                        dismiss()
                    }
                }
            }
        }
    }

    private func resetToDefaults() {
        speakingRate = preset.styleParameters.speakingRate
        pitch = preset.styleParameters.pitch
        volume = preset.styleParameters.volume
        expressiveness = preset.styleParameters.expressiveness
        warmth = preset.styleParameters.warmth
        pauseDuration = preset.styleParameters.pauseDuration
    }

    private func applyChanges() {
        let overrides = StyleParameters(
            speakingRate: speakingRate,
            pitch: pitch,
            volume: volume,
            emphasis: preset.styleParameters.emphasis,
            pauseDuration: pauseDuration,
            expressiveness: expressiveness,
            warmth: warmth,
            clarity: preset.styleParameters.clarity
        )
        presetManager.applyStyleOverrides(overrides)
    }

    private func saveAsCustom() {
        let customParams = StyleParameters(
            speakingRate: speakingRate,
            pitch: pitch,
            volume: volume,
            emphasis: preset.styleParameters.emphasis,
            pauseDuration: pauseDuration,
            expressiveness: expressiveness,
            warmth: warmth,
            clarity: preset.styleParameters.clarity
        )
        presetManager.createCustomPreset(
            basedOn: preset,
            name: "\(preset.name) (Custom)",
            styleParameters: customParams
        )
        dismiss()
    }
}

// MARK: - Slider Row

struct SliderRow: View {
    let title: String
    @Binding var value: Float
    let range: ClosedRange<Float>
    let icon: String
    let format: String
    var multiplier: Float = 1

    private var formattedValue: String {
        String(format: format, value * multiplier)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)

                Text(title)

                Spacer()

                Text(formattedValue)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Slider(value: $value, in: range)
                .accessibilityLabel(title)
                .accessibilityValue(formattedValue)
        }
    }
}

// MARK: - Voice Mode Picker

struct VoiceModePicker: View {
    @StateObject private var presetManager = VoicePresetManager.shared

    var body: some View {
        Picker("Voice Mode", selection: $presetManager.voiceMode) {
            ForEach(VoiceMode.allCases, id: \.self) { mode in
                VStack(alignment: .leading) {
                    Text(mode.displayName)
                    Text(mode.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .tag(mode)
            }
        }
        .pickerStyle(.inline)
    }
}

// MARK: - Compact Voice Selector

/// A compact voice selector for use in toolbars or menus.
struct CompactVoiceSelector: View {
    @StateObject private var presetManager = VoicePresetManager.shared
    @State private var showingPicker = false

    var body: some View {
        Button(action: { showingPicker = true }) {
            HStack(spacing: 6) {
                if let emoji = presetManager.selectedPreset.avatarEmoji {
                    Text(emoji)
                } else {
                    Image(systemName: presetManager.selectedPreset.iconName ?? "waveform")
                }
                Text(presetManager.selectedPreset.name)
                    .lineLimit(1)
            }
            .font(.subheadline)
        }
        .sheet(isPresented: $showingPicker) {
            VoicePickerView()
        }
    }
}

// MARK: - Voice Quick Actions

/// Quick action buttons for voice control.
struct VoiceQuickActions: View {
    @StateObject private var presetManager = VoicePresetManager.shared

    let speedSteps: [Float] = [0.75, 1.0, 1.25, 1.5, 2.0]

    var body: some View {
        HStack(spacing: 16) {
            // Speed selector
            Menu {
                ForEach(speedSteps, id: \.self) { speed in
                    Button(action: {
                        presetManager.adjustSpeakingRate(speed)
                    }) {
                        HStack {
                            Text(String(format: "%.2fx", speed))
                            if abs(presetManager.effectiveSpeakingRate - speed) < 0.01 {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                Label(
                    String(format: "%.1fx", presetManager.effectiveSpeakingRate),
                    systemImage: "speedometer"
                )
            }

            // Voice selector
            CompactVoiceSelector()
        }
    }
}

// MARK: - Color Extension

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3: // RGB (12-bit)
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // RGB (24-bit)
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // ARGB (32-bit)
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 59, 130, 246) // Default blue
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// MARK: - Preview

#Preview {
    VoicePickerView()
}
