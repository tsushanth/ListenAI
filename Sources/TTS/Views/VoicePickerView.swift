import SwiftUI
import AVFoundation

// MARK: - Voice Picker View

/// Main view for selecting and customizing voice presets.
struct VoicePickerView: View {
    @StateObject private var presetManager = VoicePresetManager.shared
    @State private var searchText = ""
    @State private var selectedCategory: VoiceCategory?
    @State private var showingCustomization = false
    @State private var previewingPreset: VoicePreset?
    @State private var isPlayingPreview = false
    @Environment(\.dismiss) private var dismiss

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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Current Selection
                    currentSelectionCard

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
        }
    }

    // MARK: - Current Selection Card

    private var currentSelectionCard: some View {
        VStack(spacing: 16) {
            HStack(spacing: 16) {
                // Voice Icon
                ZStack {
                    Circle()
                        .fill(Color(hex: presetManager.selectedPreset.accentColorHex ?? "#3B82F6").gradient)
                        .frame(width: 60, height: 60)

                    Image(systemName: presetManager.selectedPreset.iconName ?? "waveform")
                        .font(.title2)
                        .foregroundStyle(.white)
                }

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
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
            ForEach(filteredPresets) { preset in
                VoicePresetCard(
                    preset: preset,
                    isSelected: preset.id == presetManager.selectedPreset.id,
                    isPreviewing: previewingPreset?.id == preset.id && isPlayingPreview,
                    onSelect: {
                        presetManager.select(preset)
                    },
                    onPreview: {
                        previewVoice(preset)
                    }
                )
            }
        }
    }

    // MARK: - Preview

    private func previewVoice(_ preset: VoicePreset) {
        previewingPreset = preset
        isPlayingPreview = true

        // Preview would be handled by TTS service
        // For now, just simulate
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            isPlayingPreview = false
            previewingPreset = nil
        }
    }
}

// MARK: - Category Chip

struct CategoryChip: View {
    let title: String
    let icon: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                Text(title)
                    .font(.subheadline)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(isSelected ? Color.blue : Color(.tertiarySystemBackground))
            .foregroundStyle(isSelected ? .white : .primary)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Voice Preset Card

struct VoicePresetCard: View {
    let preset: VoicePreset
    let isSelected: Bool
    let isPreviewing: Bool
    let onSelect: () -> Void
    let onPreview: () -> Void

    private var accentColor: Color {
        Color(hex: preset.accentColorHex ?? "#3B82F6")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                ZStack {
                    Circle()
                        .fill(accentColor.gradient)
                        .frame(width: 44, height: 44)

                    Image(systemName: preset.iconName ?? "waveform")
                        .font(.body)
                        .foregroundStyle(.white)
                }

                Spacer()

                // Tier badge
                if preset.tier == .premium {
                    Text("PRO")
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.yellow)
                        .foregroundStyle(.black)
                        .clipShape(Capsule())
                }

                // Preview button
                Button(action: onPreview) {
                    Image(systemName: isPreviewing ? "stop.circle.fill" : "play.circle.fill")
                        .font(.title2)
                        .foregroundStyle(isPreviewing ? .red : .secondary)
                }
            }

            // Name
            Text(preset.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)

            // Description
            Text(preset.voiceDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

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

            Spacer()

            // Provider & mode
            HStack {
                Image(systemName: preset.provider.iconName)
                    .font(.caption2)
                Text(preset.hasOnDeviceFallback ? "On-device available" : preset.provider.displayName)
                    .font(.caption2)
            }
            .foregroundStyle(.secondary)
        }
        .padding()
        .frame(height: 200)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isSelected ? accentColor : Color.clear, lineWidth: 3)
        )
        .onTapGesture(perform: onSelect)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(.secondary)
                    .frame(width: 24)

                Text(title)

                Spacer()

                Text(String(format: format, value * multiplier))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Slider(value: $value, in: range)
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
                Image(systemName: presetManager.selectedPreset.iconName ?? "waveform")
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
