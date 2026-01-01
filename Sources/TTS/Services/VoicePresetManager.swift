import Foundation
import AVFoundation
import Combine

// MARK: - Voice Mode

/// Determines whether to use cloud or on-device voices.
enum VoiceMode: String, Codable, CaseIterable, Sendable {
    case automatic   // Use cloud when available, fall back to on-device
    case cloudOnly   // Always use cloud (requires API key)
    case onDeviceOnly // Always use on-device (free, works offline)

    var displayName: String {
        switch self {
        case .automatic: return "Automatic"
        case .cloudOnly: return "Cloud Only"
        case .onDeviceOnly: return "On-Device Only"
        }
    }

    var description: String {
        switch self {
        case .automatic: return "Uses premium cloud voices when available, falls back to on-device"
        case .cloudOnly: return "Always uses cloud voices (requires internet and API key)"
        case .onDeviceOnly: return "Uses built-in Apple voices (free, works offline)"
        }
    }
}

// MARK: - Resolved Voice

/// Represents a voice ready for synthesis with all parameters resolved.
struct ResolvedVoice: Sendable {
    let preset: VoicePreset
    let useCloud: Bool
    let provider: VoiceProvider
    let voiceID: String
    let modelID: String?
    let appleVoice: AVSpeechSynthesisVoice?
    let styleParameters: StyleParameters
    let cloudSettings: CloudVoiceSettings?

    var isOnDevice: Bool {
        !useCloud
    }
}

// MARK: - Voice Preset Manager

/// Manages voice presets, selection, and resolution to on-device or cloud voices.
@MainActor
final class VoicePresetManager: ObservableObject {

    // MARK: - Published State

    @Published private(set) var presets: [VoicePreset] = []
    @Published private(set) var customPresets: [VoicePreset] = []
    @Published var selectedPreset: VoicePreset
    @Published var voiceMode: VoiceMode = .automatic
    @Published var userStyleOverrides: StyleParameters?

    // Cloud configuration
    @Published var hasCloudAccess: Bool = false
    @Published var availableCloudProviders: Set<VoiceProvider> = []

    // On-device voices
    @Published private(set) var availableAppleVoices: [AVSpeechSynthesisVoice] = []
    @Published private(set) var downloadedVoices: Set<String> = []

    // MARK: - Properties

    private let presetsKey = "ListenAI.CustomPresets"
    private let selectedPresetKey = "ListenAI.SelectedPreset"
    private let voiceModeKey = "ListenAI.VoiceMode"
    private let styleOverridesKey = "ListenAI.StyleOverrides"

    private var cancellables = Set<AnyCancellable>()

    // MARK: - Singleton

    static let shared = VoicePresetManager()

    // MARK: - Computed Properties

    var allPresets: [VoicePreset] {
        presets + customPresets
    }

    var presetsByCategory: [VoiceCategory: [VoicePreset]] {
        Dictionary(grouping: allPresets, by: { $0.category })
    }

    var effectiveStyleParameters: StyleParameters {
        userStyleOverrides ?? selectedPreset.styleParameters
    }

    // MARK: - Initialization

    private init() {
        // Initialize with default preset
        self.selectedPreset = .defaultPreset

        // Load built-in presets
        presets = VoicePreset.allBuiltInPresets

        // Load saved state
        loadCustomPresets()
        loadSelectedPreset()
        loadVoiceMode()
        loadStyleOverrides()

        // Discover available Apple voices
        refreshAppleVoices()

        // Monitor for voice changes
        setupVoiceChangeObserver()
    }

    // MARK: - Voice Resolution

    /// Resolve the current preset to a ready-to-use voice configuration.
    func resolveCurrentVoice() -> ResolvedVoice {
        resolve(preset: selectedPreset)
    }

    /// Resolve a specific preset to a ready-to-use voice configuration.
    func resolve(preset: VoicePreset) -> ResolvedVoice {
        let shouldUseCloud = shouldUseCloudVoice(for: preset)

        if shouldUseCloud {
            return ResolvedVoice(
                preset: preset,
                useCloud: true,
                provider: preset.provider,
                voiceID: preset.providerVoiceID,
                modelID: preset.providerModelID,
                appleVoice: nil,
                styleParameters: userStyleOverrides ?? preset.styleParameters,
                cloudSettings: preset.cloudSettings ?? .default
            )
        } else {
            let appleVoice = preset.resolveOnDeviceVoice()

            return ResolvedVoice(
                preset: preset,
                useCloud: false,
                provider: .apple,
                voiceID: appleVoice?.identifier ?? "",
                modelID: nil,
                appleVoice: appleVoice,
                styleParameters: userStyleOverrides ?? preset.styleParameters,
                cloudSettings: nil
            )
        }
    }

    /// Determine if cloud voice should be used for a preset.
    private func shouldUseCloudVoice(for preset: VoicePreset) -> Bool {
        switch voiceMode {
        case .onDeviceOnly:
            return false

        case .cloudOnly:
            return hasCloudAccess && availableCloudProviders.contains(preset.provider)

        case .automatic:
            // Use cloud if:
            // 1. Cloud access is available
            // 2. The provider is available
            // 3. The preset is a cloud voice or premium
            if hasCloudAccess && availableCloudProviders.contains(preset.provider) {
                return preset.isCloudVoice || preset.tier == .premium
            }
            return false
        }
    }

    // MARK: - Preset Selection

    /// Select a preset.
    func select(_ preset: VoicePreset) {
        selectedPreset = preset
        saveSelectedPreset()
    }

    /// Select preset by ID.
    func select(presetID: UUID) {
        if let preset = allPresets.first(where: { $0.id == presetID }) {
            select(preset)
        }
    }

    /// Reset to default preset.
    func resetToDefault() {
        select(.defaultPreset)
        userStyleOverrides = nil
        saveStyleOverrides()
    }

    // MARK: - Custom Presets

    /// Create a custom preset from an existing one.
    @discardableResult
    func createCustomPreset(
        basedOn preset: VoicePreset,
        name: String,
        styleParameters: StyleParameters? = nil
    ) -> VoicePreset {
        var custom = preset
        custom = VoicePreset(
            name: name,
            isBuiltIn: false,
            isCharacterVoice: preset.isCharacterVoice,
            provider: preset.provider,
            providerVoiceID: preset.providerVoiceID,
            providerModelID: preset.providerModelID,
            onDeviceMapping: preset.onDeviceMapping,
            language: preset.language,
            supportedLanguages: preset.supportedLanguages,
            gender: preset.gender,
            age: preset.age,
            style: preset.style,
            category: .custom,
            voiceDescription: "Custom voice based on \(preset.name)",
            tier: preset.tier,
            styleParameters: styleParameters ?? preset.styleParameters,
            emotion: preset.emotion,
            cloudSettings: preset.cloudSettings,
            iconName: "slider.horizontal.3",
            accentColorHex: preset.accentColorHex,
            sampleText: preset.sampleText
        )

        customPresets.append(custom)
        saveCustomPresets()

        return custom
    }

    /// Update a custom preset.
    func updateCustomPreset(_ preset: VoicePreset) {
        if let index = customPresets.firstIndex(where: { $0.id == preset.id }) {
            customPresets[index] = preset
            saveCustomPresets()

            // Update selected if it's the same preset
            if selectedPreset.id == preset.id {
                selectedPreset = preset
            }
        }
    }

    /// Delete a custom preset.
    func deleteCustomPreset(id: UUID) {
        customPresets.removeAll { $0.id == id }
        saveCustomPresets()

        // Reset to default if deleted preset was selected
        if selectedPreset.id == id {
            select(.defaultPreset)
        }
    }

    // MARK: - Style Overrides

    /// Apply temporary style overrides.
    func applyStyleOverrides(_ overrides: StyleParameters) {
        userStyleOverrides = overrides
        saveStyleOverrides()
    }

    /// Clear style overrides.
    func clearStyleOverrides() {
        userStyleOverrides = nil
        saveStyleOverrides()
    }

    /// Adjust speaking rate.
    func adjustSpeakingRate(_ rate: Float) {
        var current = userStyleOverrides ?? selectedPreset.styleParameters
        current.speakingRate = max(0.5, min(2.0, rate))
        userStyleOverrides = current
        saveStyleOverrides()
    }

    /// Adjust pitch.
    func adjustPitch(_ pitch: Float) {
        var current = userStyleOverrides ?? selectedPreset.styleParameters
        current.pitch = max(0.5, min(2.0, pitch))
        userStyleOverrides = current
        saveStyleOverrides()
    }

    // MARK: - Cloud Configuration

    /// Configure cloud access.
    func configureCloudAccess(
        hasAccess: Bool,
        providers: Set<VoiceProvider>
    ) {
        hasCloudAccess = hasAccess
        availableCloudProviders = providers
    }

    /// Check if a provider is configured.
    func isProviderConfigured(_ provider: VoiceProvider) -> Bool {
        if provider == .apple { return true }
        return hasCloudAccess && availableCloudProviders.contains(provider)
    }

    // MARK: - Apple Voices

    /// Refresh available Apple voices.
    func refreshAppleVoices() {
        availableAppleVoices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .sorted { $0.name < $1.name }

        // Track downloaded enhanced voices
        downloadedVoices = Set(
            availableAppleVoices
                .filter { $0.quality == .enhanced || $0.quality == .premium }
                .map { $0.identifier }
        )
    }

    /// Check if an Apple voice is available.
    func isAppleVoiceAvailable(_ identifier: String) -> Bool {
        availableAppleVoices.contains { $0.identifier == identifier }
    }

    /// Get recommended Apple voice for a preset.
    func recommendedAppleVoice(for preset: VoicePreset) -> AVSpeechSynthesisVoice? {
        preset.resolveOnDeviceVoice()
    }

    // MARK: - Search & Filter

    /// Search presets by name or description.
    func search(_ query: String) -> [VoicePreset] {
        guard !query.isEmpty else { return allPresets }

        let lowercased = query.lowercased()
        return allPresets.filter {
            $0.name.lowercased().contains(lowercased) ||
            $0.voiceDescription.lowercased().contains(lowercased) ||
            $0.category.displayName.lowercased().contains(lowercased)
        }
    }

    /// Filter presets by category.
    func presets(for category: VoiceCategory) -> [VoicePreset] {
        allPresets.filter { $0.category == category }
    }

    /// Filter presets by tier.
    func presets(for tier: VoiceTier) -> [VoicePreset] {
        allPresets.filter { $0.tier == tier }
    }

    /// Get presets available for current configuration.
    func availablePresets() -> [VoicePreset] {
        switch voiceMode {
        case .onDeviceOnly:
            // All presets work with on-device fallback
            return allPresets

        case .cloudOnly:
            // Only show presets with available cloud providers
            return allPresets.filter { isProviderConfigured($0.provider) }

        case .automatic:
            // Show all presets
            return allPresets
        }
    }

    // MARK: - Preview

    /// Get sample text for a preset.
    func sampleText(for preset: VoicePreset) -> String {
        preset.sampleText
    }

    // MARK: - Private Methods

    private func setupVoiceChangeObserver() {
        NotificationCenter.default.publisher(for: AVSpeechSynthesizer.availableVoicesDidChangeNotification)
            .sink { [weak self] _ in
                self?.refreshAppleVoices()
            }
            .store(in: &cancellables)
    }

    // MARK: - Persistence

    private func saveCustomPresets() {
        do {
            let data = try JSONEncoder().encode(customPresets)
            UserDefaults.standard.set(data, forKey: presetsKey)
        } catch {
            print("Failed to save custom presets: \(error)")
        }
    }

    private func loadCustomPresets() {
        guard let data = UserDefaults.standard.data(forKey: presetsKey) else { return }

        do {
            customPresets = try JSONDecoder().decode([VoicePreset].self, from: data)
        } catch {
            print("Failed to load custom presets: \(error)")
            customPresets = []
        }
    }

    private func saveSelectedPreset() {
        do {
            let data = try JSONEncoder().encode(selectedPreset)
            UserDefaults.standard.set(data, forKey: selectedPresetKey)
        } catch {
            print("Failed to save selected preset: \(error)")
        }
    }

    private func loadSelectedPreset() {
        guard let data = UserDefaults.standard.data(forKey: selectedPresetKey) else { return }

        do {
            selectedPreset = try JSONDecoder().decode(VoicePreset.self, from: data)
        } catch {
            print("Failed to load selected preset: \(error)")
            selectedPreset = .defaultPreset
        }
    }

    private func saveVoiceMode() {
        UserDefaults.standard.set(voiceMode.rawValue, forKey: voiceModeKey)
    }

    private func loadVoiceMode() {
        if let raw = UserDefaults.standard.string(forKey: voiceModeKey),
           let mode = VoiceMode(rawValue: raw) {
            voiceMode = mode
        }
    }

    private func saveStyleOverrides() {
        if let overrides = userStyleOverrides {
            do {
                let data = try JSONEncoder().encode(overrides)
                UserDefaults.standard.set(data, forKey: styleOverridesKey)
            } catch {
                print("Failed to save style overrides: \(error)")
            }
        } else {
            UserDefaults.standard.removeObject(forKey: styleOverridesKey)
        }
    }

    private func loadStyleOverrides() {
        guard let data = UserDefaults.standard.data(forKey: styleOverridesKey) else { return }

        do {
            userStyleOverrides = try JSONDecoder().decode(StyleParameters.self, from: data)
        } catch {
            print("Failed to load style overrides: \(error)")
        }
    }
}

// MARK: - Voice Preset Manager Extensions

extension VoicePresetManager {

    /// Get a quick summary of the current voice configuration.
    var configurationSummary: String {
        let resolved = resolveCurrentVoice()
        let modeLabel = resolved.useCloud ? "Cloud" : "On-Device"
        return "\(selectedPreset.name) (\(modeLabel))"
    }

    /// Check if premium features are available.
    var hasPremiumAccess: Bool {
        hasCloudAccess && !availableCloudProviders.isEmpty
    }

    /// Get the effective speaking rate.
    var effectiveSpeakingRate: Float {
        effectiveStyleParameters.speakingRate
    }

    /// Get the effective pitch.
    var effectivePitch: Float {
        effectiveStyleParameters.pitch
    }
}
