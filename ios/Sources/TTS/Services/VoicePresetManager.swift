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

// MARK: - Voice Cloning Model

/// The model used for voice cloning synthesis.
enum VoiceCloningModel: String, Codable, CaseIterable, Sendable {
    case chatterbox // MIT licensed, expressive, default
    case xtts       // XTTS v2, multilingual support, faster

    var displayName: String {
        switch self {
        case .chatterbox: return "Quality"
        case .xtts: return "Fast"
        }
    }

    var description: String {
        switch self {
        case .chatterbox: return "Best quality, slower (~5 min for long articles)"
        case .xtts: return "Faster synthesis, good quality (~1 min)"
        }
    }

    var iconName: String {
        switch self {
        case .chatterbox: return "sparkles"
        case .xtts: return "bolt.fill"
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
    @Published var voiceCloningModel: VoiceCloningModel = .chatterbox
    @Published var userStyleOverrides: StyleParameters?

    /// When true, route synthesis to on-device Kokoro 82M (FluidAudio) instead of
    /// the ListenAI cloud backend. Persisted across launches. Only takes effect on
    /// eligible devices (`KokoroModelManager.isDeviceEligible`) and presets that
    /// declare a `kokoroVoiceID`. Defaults to true on fresh installs of eligible
    /// devices (set in `loadUseOfflineAI`).
    @Published var useOfflineAI: Bool = false {
        didSet {
            guard oldValue != useOfflineAI else { return }
            saveUseOfflineAI()
        }
    }

    /// When true, the model download may use cellular. When false (default),
    /// the download is deferred until the device is on WiFi. Persisted.
    @Published var allowCellularModelDownload: Bool = false {
        didSet {
            guard oldValue != allowCellularModelDownload else { return }
            UserDefaults.standard.set(allowCellularModelDownload, forKey: allowCellularDownloadKey)
        }
    }

    // Cloud configuration
    @Published var hasCloudAccess: Bool = false
    @Published var availableCloudProviders: Set<VoiceProvider> = []

    // On-device voices
    @Published private(set) var availableAppleVoices: [AVSpeechSynthesisVoice] = []
    @Published private(set) var downloadedVoices: Set<String> = []

    // MARK: - Properties

    private let presetsKey = "ReadAloudAI.CustomPresets"
    private let selectedPresetKey = "ReadAloudAI.SelectedPreset"
    private let voiceModeKey = "ReadAloudAI.VoiceMode"
    private let voiceCloningModelKey = "ReadAloudAI.VoiceCloningModel"
    private let styleOverridesKey = "ReadAloudAI.StyleOverrides"
    private let useOfflineAIKey = "ReadAloudAI.UseOfflineAI"
    private let useOfflineAIWasSetKey = "ReadAloudAI.UseOfflineAIWasSet"
    private let allowCellularDownloadKey = "ReadAloudAI.AllowCellularModelDownload"

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
        loadVoiceCloningModel()
        loadStyleOverrides()
        loadUseOfflineAI()

        // Discover available Apple voices
        refreshAppleVoices()

        // Monitor for voice changes
        setupVoiceChangeObserver()
    }

    // MARK: - Offline AI Overlay

    /// True when "Offline AI" is enabled AND the device can run Kokoro on-device.
    /// Distinct from `useOfflineAI` (the user's stored toggle) so callers can ask
    /// the routing question without re-checking eligibility.
    var isOfflineAIActive: Bool {
        useOfflineAI && KokoroModelManager.isDeviceEligible
    }

    /// Returns a preset overlay routed to `.kokoroOnDevice` when offline AI applies
    /// for the given preset, or `nil` if the preset should keep its original
    /// provider (cloud / Apple). Used by `TTSCoordinator` to redirect synthesis
    /// without persisting a synthetic preset.
    func offlineAIOverlay(for preset: VoicePreset) -> VoicePreset? {
        guard isOfflineAIActive,
              let kokoroID = preset.kokoroVoiceID,
              !kokoroID.isEmpty,
              KokoroVoiceCatalog.allIDs.contains(kokoroID)
        else { return nil }

        return VoicePreset(
            id: preset.id,
            name: preset.name,
            isBuiltIn: preset.isBuiltIn,
            isCharacterVoice: preset.isCharacterVoice,
            provider: .kokoroOnDevice,
            providerVoiceID: kokoroID,
            providerModelID: nil,
            kokoroVoiceID: kokoroID,
            onDeviceMapping: preset.onDeviceMapping,
            language: preset.language,
            supportedLanguages: preset.supportedLanguages,
            gender: preset.gender,
            age: preset.age,
            style: preset.style,
            category: preset.category,
            voiceDescription: preset.voiceDescription,
            tier: .free,
            requiresDownload: false,
            downloadSizeBytes: nil,
            isDownloaded: KokoroModelManager.shared.isReady,
            styleParameters: preset.styleParameters,
            emotion: preset.emotion,
            cloudSettings: nil,
            characterID: preset.characterID,
            characterDescription: preset.characterDescription,
            specialInstructions: preset.specialInstructions,
            iconName: preset.iconName,
            accentColorHex: preset.accentColorHex,
            sampleAudioURL: preset.sampleAudioURL,
            sampleText: preset.sampleText
        )
    }

    /// Convenience: returns the overlay if applicable, otherwise the original preset.
    func presetForSynthesis(_ preset: VoicePreset) -> VoicePreset {
        offlineAIOverlay(for: preset) ?? preset
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
        // Allow voices with Kokoro support OR cloned voices (selfhosted Chatterbox voices)
        // Cloned voices: not built-in, category is .custom, no kokoroVoiceID
        let isClonedVoice = !preset.isBuiltIn && preset.category == .custom && preset.kokoroVoiceID == nil

        guard preset.kokoroVoiceID != nil || isClonedVoice else {
            print("[VoicePresetManager] Cannot select '\(preset.name)' - no Kokoro ID and not a cloned voice")
            return
        }
        selectedPreset = preset
        saveSelectedPreset()

        if isClonedVoice {
            print("[VoicePresetManager] Selected cloned voice: \(preset.name) with ID: \(preset.providerVoiceID)")
        } else {
            print("[VoicePresetManager] Selected voice: \(preset.name) with Kokoro ID: \(preset.kokoroVoiceID ?? "nil")")
        }
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
    /// Only returns voices with Kokoro support (premium-only voices excluded).
    func availablePresets() -> [VoicePreset] {
        // Filter to only voices with Kokoro support
        let kokoroSupportedPresets = allPresets.filter { $0.kokoroVoiceID != nil }

        switch voiceMode {
        case .onDeviceOnly:
            // All Kokoro presets work with on-device fallback
            return kokoroSupportedPresets

        case .cloudOnly:
            // Only show presets with available cloud providers
            return kokoroSupportedPresets.filter { isProviderConfigured($0.provider) }

        case .automatic:
            // Show all Kokoro-supported presets
            return kokoroSupportedPresets
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
        guard let data = UserDefaults.standard.data(forKey: selectedPresetKey) else {
            print("[VoicePresetManager] No saved preset found, using default: \(VoicePreset.defaultPreset.name) with Kokoro ID: \(VoicePreset.defaultPreset.kokoroVoiceID ?? "nil")")
            return
        }

        do {
            let loadedPreset = try JSONDecoder().decode(VoicePreset.self, from: data)

            // Validate that the loaded preset has a kokoroVoiceID (required for Kokoro TTS)
            // OR is a cloned voice (custom category, no kokoroVoiceID - uses Chatterbox)
            let isClonedVoice = !loadedPreset.isBuiltIn && loadedPreset.category == .custom && loadedPreset.kokoroVoiceID == nil

            if loadedPreset.kokoroVoiceID != nil {
                selectedPreset = loadedPreset
                print("[VoicePresetManager] Loaded saved voice: \(loadedPreset.name) with Kokoro ID: \(loadedPreset.kokoroVoiceID ?? "nil"), provider: \(loadedPreset.provider)")
            } else if isClonedVoice {
                selectedPreset = loadedPreset
                print("[VoicePresetManager] Loaded cloned voice: \(loadedPreset.name) with ID: \(loadedPreset.providerVoiceID)")
            } else {
                print("[VoicePresetManager] Saved voice '\(loadedPreset.name)' has no Kokoro ID and is not a cloned voice, using default: \(VoicePreset.defaultPreset.name)")
                selectedPreset = .defaultPreset
                saveSelectedPreset() // Persist the change
            }
        } catch {
            print("[VoicePresetManager] Failed to load selected preset: \(error), using default: \(VoicePreset.defaultPreset.name)")
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

    private func saveVoiceCloningModel() {
        UserDefaults.standard.set(voiceCloningModel.rawValue, forKey: voiceCloningModelKey)
    }

    private func loadVoiceCloningModel() {
        if let raw = UserDefaults.standard.string(forKey: voiceCloningModelKey),
           let model = VoiceCloningModel(rawValue: raw) {
            voiceCloningModel = model
        }
    }

    /// Set the voice cloning model preference.
    func setVoiceCloningModel(_ model: VoiceCloningModel) {
        voiceCloningModel = model
        saveVoiceCloningModel()
        print("[VoicePresetManager] Voice cloning model set to: \(model.displayName)")
    }

    private func saveUseOfflineAI() {
        UserDefaults.standard.set(useOfflineAI, forKey: useOfflineAIKey)
        UserDefaults.standard.set(true, forKey: useOfflineAIWasSetKey)
    }

    private func loadUseOfflineAI() {
        // Fresh install: default to ON for eligible devices so the offline
        // path becomes the default for most users. The onboarding screen
        // gives them a chance to opt out before download starts.
        let wasSet = UserDefaults.standard.bool(forKey: useOfflineAIWasSetKey)
        if wasSet {
            useOfflineAI = UserDefaults.standard.bool(forKey: useOfflineAIKey)
        } else {
            useOfflineAI = KokoroModelManager.isDeviceEligible
        }
        allowCellularModelDownload = UserDefaults.standard.bool(forKey: allowCellularDownloadKey)
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

    // MARK: - Onboarding Voice Selection

    /// Set the default voice from onboarding selection.
    /// This finds the matching VoicePreset by ElevenLabs voice ID and sets it as selected.
    /// - Parameter elevenLabsVoiceId: The ElevenLabs provider voice ID selected during onboarding
    func setDefaultVoiceFromOnboarding(elevenLabsVoiceId: String) {
        // Find matching preset by providerVoiceID
        if let preset = allPresets.first(where: { $0.providerVoiceID == elevenLabsVoiceId }) {
            select(preset)
            print("VoicePresetManager: Set default voice from onboarding: \(preset.name)")
        } else {
            // Fallback to default (Adam Kokoro) if voice not found
            print("VoicePresetManager: Voice ID \(elevenLabsVoiceId) not found, using default")
            select(.defaultPreset)
        }
    }

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
