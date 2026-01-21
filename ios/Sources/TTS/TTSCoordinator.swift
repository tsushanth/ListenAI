import Foundation
import Combine

// MARK: - TTS Coordinator

/// High-level coordinator for TTS operations.
/// Manages service selection, caching, and provides a simplified interface for the app.
@MainActor
final class TTSCoordinator: ObservableObject {

    // MARK: - Published State

    @Published private(set) var currentSynthesisProgress: SynthesisProgress?
    @Published private(set) var isSynthesizing: Bool = false
    @Published private(set) var lastError: TTSError?
    @Published private(set) var availableVoices: [VoicePreset] = []

    // Quota exceeded state
    @Published var showQuotaExceededAlert: Bool = false
    @Published private(set) var quotaExceededInfo: QuotaExceededInfo?

    /// Information about quota exceeded state
    struct QuotaExceededInfo {
        let charUsed: Int
        let charLimit: Int
        let suggestOnDevice: Bool
        var originalVoice: VoicePreset?
    }

    // MARK: - Properties

    private let ttsManager: TTSManager
    private let cacheManager: AudioCacheManager
    private let presetManager: VoicePresetManager
    private var currentTaskID: UUID?
    private var cancellables = Set<AnyCancellable>()

    // Voice selection state (synced from VoicePresetManager)
    @Published var selectedVoice: VoicePreset?
    @Published var defaultSpeed: Float = 1.0
    @Published var defaultPitch: Float = 1.0

    /// Current voice quality preference
    @Published var selectedQuality: VoiceQuality = .standard

    /// Premium samples used today (for free users)
    @Published private(set) var premiumSamplesUsedToday: Int = 0

    /// Maximum premium samples allowed per day for current tier
    @Published private(set) var dailyPremiumSampleLimit: Int = 3

    // MARK: - Singleton

    static let shared = TTSCoordinator()

    // MARK: - Initialization

    private init() {
        self.ttsManager = TTSManager.shared
        self.cacheManager = AudioCacheManager.shared
        self.presetManager = VoicePresetManager.shared

        // Enable cloud voices for premium quality
        // Standard quality uses self-hosted (unlimited)
        // Premium quality uses ElevenLabs (quota-limited)
        presetManager.configureCloudAccess(
            hasAccess: true,
            providers: [.elevenLabs, .selfhosted]
        )

        // Sync with VoicePresetManager
        setupPresetManagerSync()

        // Load premium sample count from storage
        loadPremiumSampleCount()

        // Load default voice
        Task {
            await loadAvailableVoices()
        }
    }

    // MARK: - Premium Sample Tracking

    private func loadPremiumSampleCount() {
        let today = Calendar.current.startOfDay(for: Date())
        let lastResetDate = UserDefaults.standard.object(forKey: "premiumSampleResetDate") as? Date

        // Reset count if it's a new day
        if lastResetDate == nil || !Calendar.current.isDate(lastResetDate!, inSameDayAs: today) {
            UserDefaults.standard.set(today, forKey: "premiumSampleResetDate")
            UserDefaults.standard.set(0, forKey: "premiumSamplesUsedToday")
            premiumSamplesUsedToday = 0
        } else {
            premiumSamplesUsedToday = UserDefaults.standard.integer(forKey: "premiumSamplesUsedToday")
        }
    }

    private func incrementPremiumSampleCount() {
        premiumSamplesUsedToday += 1
        UserDefaults.standard.set(premiumSamplesUsedToday, forKey: "premiumSamplesUsedToday")
    }

    /// Check if user can use premium quality
    var canUsePremiumQuality: Bool {
        // Enterprise/premium subscribers have unlimited
        if dailyPremiumSampleLimit == .max {
            return true
        }
        return premiumSamplesUsedToday < dailyPremiumSampleLimit
    }

    /// Remaining premium samples for today
    var remainingPremiumSamples: Int {
        if dailyPremiumSampleLimit == .max {
            return .max
        }
        return max(0, dailyPremiumSampleLimit - premiumSamplesUsedToday)
    }

    /// Update tier-based limits
    func updateTierLimits(tier: VoiceTier) {
        dailyPremiumSampleLimit = tier.dailyPremiumSamples
    }

    // MARK: - Preset Manager Sync

    private func setupPresetManagerSync() {
        // Observe preset manager's selected preset and sync to our selectedVoice
        presetManager.$selectedPreset
            .sink { [weak self] preset in
                guard let self = self else { return }
                self.selectedVoice = preset
                self.defaultSpeed = self.presetManager.effectiveStyleParameters.speakingRate
                self.defaultPitch = self.presetManager.effectiveStyleParameters.pitch
                print("[TTS] Synced voice from PresetManager: \(preset.name), speed: \(self.defaultSpeed)")
            }
            .store(in: &cancellables)

        // Also observe style overrides
        presetManager.$userStyleOverrides
            .sink { [weak self] _ in
                guard let self = self else { return }
                self.defaultSpeed = self.presetManager.effectiveStyleParameters.speakingRate
                self.defaultPitch = self.presetManager.effectiveStyleParameters.pitch
            }
            .store(in: &cancellables)
    }

    // MARK: - Voice Management

    /// Load all available voices from all providers
    func loadAvailableVoices() async {
        var voices: [VoicePreset] = []

        // Get Apple voices (always available)
        let appleService = OnDeviceTTSService()
        let appleVoices = await appleService.availableVoices()
        voices.append(contentsOf: appleVoices)

        // Add character voices
        voices.append(contentsOf: VoicePreset.characterPresets)

        // Sort by name
        availableVoices = voices.sorted { $0.name < $1.name }

        // Set default voice if not set
        if selectedVoice == nil {
            selectedVoice = availableVoices.first { $0.provider == .apple && $0.language.starts(with: "en") }
        }
    }

    /// Select a voice for synthesis
    func selectVoice(_ voice: VoicePreset) {
        // Update via preset manager so everything stays in sync
        presetManager.select(voice)
        // The sync will update our selectedVoice, defaultSpeed, defaultPitch
    }

    /// Enable or disable cloud TTS access
    /// Call this when user exceeds quota or when quota is restored
    func setCloudAccessEnabled(_ enabled: Bool) {
        presetManager.configureCloudAccess(
            hasAccess: enabled,
            providers: enabled ? [.elevenLabs] : []
        )
        print("[TTS] Cloud access \(enabled ? "enabled" : "disabled")")

        // If cloud access was disabled and current voice is cloud, switch to Apple voice
        if !enabled, let currentVoice = selectedVoice, currentVoice.provider != .apple {
            if let appleVoice = availableVoices.first(where: { $0.provider == .apple && $0.language.starts(with: "en") }) {
                selectVoice(appleVoice)
                print("[TTS] Switched to on-device voice due to quota: \(appleVoice.name)")
            }
        }
    }

    /// Check if cloud TTS is currently enabled
    var isCloudAccessEnabled: Bool {
        presetManager.hasCloudAccess
    }

    /// Check if user can synthesize with current quota
    func canSynthesizeWithQuota(characterCount: Int) -> Bool {
        return UsageTrackerService.shared.canSynthesize(characterCount: characterCount)
    }

    /// Get voices filtered by criteria
    func voices(
        provider: VoiceProvider? = nil,
        tier: VoiceTier? = nil,
        language: String? = nil,
        isCharacter: Bool? = nil
    ) -> [VoicePreset] {
        availableVoices.filter { voice in
            if let provider = provider, voice.provider != provider { return false }
            if let tier = tier, voice.tier != tier { return false }
            if let language = language, !voice.language.starts(with: language) { return false }
            if let isCharacter = isCharacter, voice.isCharacterVoice != isCharacter { return false }
            return true
        }
    }

    // MARK: - Synthesis

    /// Synthesize text to audio using the selected voice preset.
    /// Uses standard (Kokoro) quality by default for cost efficiency.
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - voice: The voice to use (or uses selected voice from VoicePresetManager)
    ///   - options: Synthesis options (or uses defaults)
    /// - Returns: URL to the generated audio file
    func synthesize(
        text: String,
        voice: VoicePreset? = nil,
        options: SynthesisOptions? = nil
    ) async throws -> URL {
        // Delegate to synthesizeWithQuality using standard (Kokoro) quality by default.
        // This ensures consistent voice selection and uses cost-efficient Kokoro TTS.
        // Premium (ElevenLabs) quality can be requested explicitly via synthesizeWithQuality.
        return try await synthesizeWithQuality(
            text: text,
            voice: voice,
            quality: .standard
        )
    }

    /// Synthesize with automatic provider fallback when rate limited
    private func synthesizeWithFallback(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) async throws -> SynthesisResult {
        // Define fallback order for cloud providers
        let fallbackProviders: [VoiceProvider] = [.openAI, .googleCloud]

        do {
            // Try primary provider first
            return try await ttsManager.synthesize(
                text: text,
                voice: voice,
                options: options
            )
        } catch let error as TTSError {
            // Check if it's a rate limit error that we can retry with fallback
            switch error {
            case .rateLimited(let retryAfter):
                print("[TTS] Rate limited by \(voice.provider.displayName), retry after: \(retryAfter)s")

                // If it's a cloud voice, try fallback providers
                if voice.provider.isCloudBased {
                    for fallbackProvider in fallbackProviders {
                        // Skip if same as current provider
                        guard fallbackProvider != voice.provider else { continue }

                        // Try to find an equivalent voice from fallback provider
                        if let fallbackVoice = findEquivalentVoice(for: voice, provider: fallbackProvider) {
                            print("[TTS] Trying fallback provider: \(fallbackProvider.displayName)")
                            do {
                                return try await ttsManager.synthesize(
                                    text: text,
                                    voice: fallbackVoice,
                                    options: options
                                )
                            } catch {
                                print("[TTS] Fallback provider \(fallbackProvider.displayName) also failed: \(error)")
                                continue
                            }
                        }
                    }

                    // All cloud providers failed, fall back to on-device
                    print("[TTS] All cloud providers rate limited, falling back to on-device")
                    let onDeviceVoice = createOnDeviceFallback(for: voice)
                    return try await ttsManager.synthesize(
                        text: text,
                        voice: onDeviceVoice,
                        options: options
                    )
                }
                throw error

            case .quotaExceeded, .subscriptionRequired:
                // For quota/subscription issues, fall back to on-device immediately
                print("[TTS] Quota/subscription issue, falling back to on-device")
                let onDeviceVoice = createOnDeviceFallback(for: voice)
                return try await ttsManager.synthesize(
                    text: text,
                    voice: onDeviceVoice,
                    options: options
                )

            default:
                throw error
            }
        }
    }

    /// Find an equivalent voice from a different provider
    private func findEquivalentVoice(for voice: VoicePreset, provider: VoiceProvider) -> VoicePreset? {
        // Try to match by gender and style
        let candidates = availableVoices.filter { $0.provider == provider }

        // First try to match gender and style
        if let match = candidates.first(where: { $0.gender == voice.gender && $0.style == voice.style }) {
            return match
        }

        // Then just match gender
        if let match = candidates.first(where: { $0.gender == voice.gender }) {
            return match
        }

        // Default mapping for common providers
        switch provider {
        case .openAI:
            // Map to OpenAI voices
            switch voice.gender {
            case .male:
                return VoicePreset(
                    name: "OpenAI Echo",
                    provider: .openAI,
                    providerVoiceID: "echo",
                    providerModelID: "tts-1-hd",
                    gender: .male,
                    style: voice.style,
                    tier: .premium
                )
            case .female:
                return VoicePreset(
                    name: "OpenAI Nova",
                    provider: .openAI,
                    providerVoiceID: "nova",
                    providerModelID: "tts-1-hd",
                    gender: .female,
                    style: voice.style,
                    tier: .premium
                )
            case .neutral:
                return VoicePreset(
                    name: "OpenAI Alloy",
                    provider: .openAI,
                    providerVoiceID: "alloy",
                    providerModelID: "tts-1-hd",
                    gender: .neutral,
                    style: voice.style,
                    tier: .premium
                )
            }

        case .googleCloud:
            // Map to Google Cloud voices
            return VoicePreset(
                name: "Google WaveNet",
                provider: .googleCloud,
                providerVoiceID: voice.gender == .female ? "en-US-Wavenet-C" : "en-US-Wavenet-A",
                gender: voice.gender,
                style: voice.style,
                tier: .premium
            )

        default:
            return nil
        }
    }

    // MARK: - Voice Fallback

    /// Create an on-device fallback version of a cloud voice preset
    private func createOnDeviceFallback(for preset: VoicePreset) -> VoicePreset {
        // If already an Apple voice, return as-is
        if preset.provider == .apple {
            return preset
        }

        // Get the on-device voice ID from mapping or fall back to default
        let onDeviceVoiceID: String
        if let mapping = preset.onDeviceMapping {
            onDeviceVoiceID = mapping.primaryVoiceID
        } else {
            // Default to Samantha voice
            onDeviceVoiceID = "com.apple.voice.compact.en-US.Samantha"
        }

        print("[TTS] Creating on-device fallback for \(preset.name) -> \(onDeviceVoiceID)")

        // Create a new preset with Apple provider
        return VoicePreset(
            id: preset.id,
            name: preset.name,
            isBuiltIn: preset.isBuiltIn,
            isCharacterVoice: preset.isCharacterVoice,
            provider: .apple,  // Force Apple provider for on-device
            providerVoiceID: onDeviceVoiceID,
            providerModelID: nil,
            onDeviceMapping: preset.onDeviceMapping,
            language: preset.language,
            supportedLanguages: preset.supportedLanguages,
            gender: preset.gender,
            age: preset.age,
            style: preset.style,
            category: preset.category,
            voiceDescription: preset.voiceDescription,
            tier: .free,  // On-device is always free
            requiresDownload: false,
            downloadSizeBytes: nil,
            isDownloaded: true,
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

    // MARK: - Cloud Error Handling

    /// Handle ListenAI cloud errors with user-friendly prompts
    private func handleCloudError(_ error: ListenAICloudError, voice: VoicePreset) {
        switch error {
        case .quotaExceeded(let used, let limit):
            // Show quota exceeded alert with option to use on-device voice
            quotaExceededInfo = QuotaExceededInfo(
                charUsed: used,
                charLimit: limit,
                suggestOnDevice: voice.hasOnDeviceFallback,
                originalVoice: voice
            )
            showQuotaExceededAlert = true
            lastError = .quotaExceeded(remaining: limit - used, required: 0)

        case .tierRequired(let required, let current):
            lastError = .subscriptionRequired(tier: .premium)
            // Store info for display: "This voice requires \(required) tier. Your current tier is \(current)."

        case .unauthorized, .noAuthToken:
            lastError = .invalidConfiguration(reason: "Please sign in to use cloud voices.")

        case .rateLimited(let retryAfter):
            lastError = .rateLimited(retryAfter: retryAfter)

        case .voiceNotFound(let voiceId):
            lastError = .voiceNotAvailable(voiceName: voiceId)

        default:
            lastError = .internalError(reason: error.localizedDescription)
        }
    }

    /// Switch to on-device voice as fallback after quota exceeded
    func switchToOnDeviceVoice() {
        guard let info = quotaExceededInfo,
              let originalVoice = info.originalVoice else { return }

        // Find a matching on-device voice using the voice's on-device mapping
        if let mapping = originalVoice.onDeviceMapping,
           let fallbackVoice = availableVoices.first(where: { $0.providerVoiceID == mapping.primaryVoiceID }) {
            selectVoice(fallbackVoice)
        } else {
            // Default to first Apple voice matching language
            let targetLanguage = originalVoice.language.prefix(2)
            if let appleVoice = availableVoices.first(where: {
                $0.provider == .apple && $0.language.starts(with: String(targetLanguage))
            }) {
                selectVoice(appleVoice)
            } else if let appleVoice = availableVoices.first(where: { $0.provider == .apple }) {
                selectVoice(appleVoice)
            }
        }

        showQuotaExceededAlert = false
        quotaExceededInfo = nil
    }

    /// Dismiss quota exceeded alert without switching voice
    func dismissQuotaExceededAlert() {
        showQuotaExceededAlert = false
        quotaExceededInfo = nil
    }

    // MARK: - Quality-Based Synthesis

    /// Synthesize text using the appropriate provider based on quality preference
    /// - Parameters:
    ///   - text: Text to synthesize
    ///   - voice: Voice preset to use
    ///   - quality: Quality level (.standard uses self-hosted, .premium uses ElevenLabs)
    /// - Returns: URL to the generated audio file
    func synthesizeWithQuality(
        text: String,
        voice: VoicePreset? = nil,
        quality: VoiceQuality? = nil
    ) async throws -> URL {
        // Debug: Log all voice sources to trace selection issue
        let presetManagerVoice = presetManager.selectedPreset
        print("[TTS] Voice sources - param: \(voice?.name ?? "nil"), selectedVoice: \(selectedVoice?.name ?? "nil"), presetManager: \(presetManagerVoice.name)")
        print("[TTS] PresetManager voice details - kokoroID: \(presetManagerVoice.kokoroVoiceID ?? "nil"), provider: \(presetManagerVoice.provider)")

        // Use presetManager.selectedPreset as the authoritative source
        let voiceToUse = voice ?? presetManager.selectedPreset
        let qualityToUse = quality ?? selectedQuality

        print("[TTS] Using voiceToUse: \(voiceToUse.name), kokoroID: \(voiceToUse.kokoroVoiceID ?? "nil")")

        // Check if voice supports the requested quality
        let effectiveQuality: VoiceQuality
        if qualityToUse == .premium && voiceToUse.isPremiumOnly {
            effectiveQuality = .premium
        } else if qualityToUse == .premium && !voiceToUse.supportsPremiumQuality {
            // Voice doesn't support premium, use standard
            effectiveQuality = .standard
        } else if qualityToUse == .standard && !voiceToUse.supportsStandardQuality {
            // Voice is premium-only, must use premium
            if canUsePremiumQuality {
                effectiveQuality = .premium
            } else {
                throw TTSError.voiceNotAvailable(voiceName: voiceToUse.name)
            }
        } else {
            effectiveQuality = qualityToUse
        }

        // Check premium quota if using premium quality
        if effectiveQuality == .premium && !canUsePremiumQuality {
            throw TTSError.quotaExceeded(remaining: remainingPremiumSamples, required: 1)
        }

        print("[TTS] Synthesizing with quality: \(effectiveQuality.displayName), voice: \(voiceToUse.name)")

        // Check cache first
        // Use voice ID (not just name) to avoid cache collisions between voices with same name but different IDs
        let voiceIdentifier = voiceToUse.kokoroVoiceID ?? voiceToUse.providerVoiceID
        let cacheKey = "\(voiceIdentifier)_\(effectiveQuality.rawValue)_\(text.hashValue)"
        if let cachedURL = await cacheManager.getCachedAudio(for: cacheKey) {
            print("[TTS] Using cached audio for voice: \(voiceToUse.name) (\(voiceIdentifier))")
            return cachedURL
        }

        isSynthesizing = true
        defer { isSynthesizing = false }

        // Get cloud service reference outside of do-catch for use in fallback
        let cloudService = TTSServiceFactory.listenAICloudService

        // If backend not configured, fall back to direct SelfHostedTTSService
        if cloudService == nil {
            print("[TTS] Backend not configured, using direct Kokoro")
            guard let kokoroVoiceID = voiceToUse.kokoroVoiceID else {
                throw TTSError.voiceNotAvailable(voiceName: voiceToUse.name)
            }
            let audioData = try await SelfHostedTTSService.shared.synthesize(
                text: text,
                voiceID: kokoroVoiceID,
                speed: defaultSpeed
            )

            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension("wav")
            try audioData.write(to: tempURL)
            return await cacheManager.cacheAudio(at: tempURL, for: cacheKey)
        }

        // cloudService is now guaranteed non-nil
        let service = cloudService!

        do {
            var audioResult: AudioData

            // Check if this is a cloned voice (custom category, selfhosted provider, no kokoroVoiceID)
            let isClonedVoice = !voiceToUse.isBuiltIn &&
                                voiceToUse.category == .custom &&
                                voiceToUse.kokoroVoiceID == nil

            if isClonedVoice {
                // Synthesize using cloned voice via Chatterbox
                let voiceId = voiceToUse.providerVoiceID

                // Fetch the cloned voice details to get the audio URL
                let clonedVoices = try await VoiceCloningService.shared.listClonedVoices()
                guard let clonedVoice = clonedVoices.first(where: { $0.id == voiceId }),
                      let voiceUrl = clonedVoice.audioUrl else {
                    print("[TTS] Cloned voice not found or no audio URL: \(voiceId)")
                    throw TTSError.voiceNotAvailable(voiceName: voiceToUse.name)
                }

                print("[TTS] Synthesizing via Chatterbox with cloned voice: \(voiceId)")
                audioResult = try await service.synthesizeCloned(
                    text: text,
                    voiceId: voiceId,
                    voiceUrl: voiceUrl,
                    speed: Double(defaultSpeed)
                )
            } else {
                // Standard or premium voice synthesis
                switch effectiveQuality {
                case .standard:
                    // Use backend with selfhosted (Kokoro) provider
                    guard let kokoroVoiceID = voiceToUse.kokoroVoiceID else {
                        throw TTSError.voiceNotAvailable(voiceName: voiceToUse.name)
                    }
                    print("[TTS] Synthesizing via backend with Kokoro voice: \(kokoroVoiceID)")
                    audioResult = try await service.synthesize(
                        text: text,
                        voiceId: kokoroVoiceID,
                        provider: ListenAICloudService.TTSProvider.selfhosted,
                        speed: Double(defaultSpeed)
                    )

                case .premium:
                    // Use backend with elevenlabs provider
                    // Backend handles fallback to Kokoro if ElevenLabs throttled
                    print("[TTS] Synthesizing via backend with ElevenLabs voice: \(voiceToUse.providerVoiceID)")
                    audioResult = try await service.synthesize(
                        text: text,
                        voiceId: voiceToUse.providerVoiceID,
                        provider: ListenAICloudService.TTSProvider.elevenlabs,
                        speed: Double(defaultSpeed)
                    )

                    // Increment premium sample count
                    incrementPremiumSampleCount()
                }
            }

            // Use the fileURL from result, or save to temp if not present
            let audioFileURL: URL
            if let url = audioResult.fileURL {
                audioFileURL = url
            } else {
                // Save to temp file with correct extension
                let ext = audioResult.format == "mp3" ? "mp3" : "wav"
                let tempURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString)
                    .appendingPathExtension(ext)
                try audioResult.data.write(to: tempURL)
                audioFileURL = tempURL
            }

            // Cache the audio file
            let cachedURL = await cacheManager.cacheAudio(at: audioFileURL, for: cacheKey)
            return cachedURL

        } catch {
            print("[TTS] Synthesis failed: \(error)")

            // Fallback logic based on what failed
            if effectiveQuality == .standard {
                // Standard (Kokoro) failed - try ElevenLabs as fallback
                print("[TTS] Kokoro synthesis failed, trying ElevenLabs fallback")
                do {
                    let audioResult = try await service.synthesize(
                        text: text,
                        voiceId: voiceToUse.providerVoiceID,
                        provider: ListenAICloudService.TTSProvider.elevenlabs,
                        speed: Double(defaultSpeed)
                    )

                    let audioFileURL: URL
                    if let url = audioResult.fileURL {
                        audioFileURL = url
                    } else {
                        let ext = audioResult.format == "mp3" ? "mp3" : "wav"
                        let tempURL = FileManager.default.temporaryDirectory
                            .appendingPathComponent(UUID().uuidString)
                            .appendingPathExtension(ext)
                        try audioResult.data.write(to: tempURL)
                        audioFileURL = tempURL
                    }

                    print("[TTS] ElevenLabs fallback succeeded")
                    return await cacheManager.cacheAudio(at: audioFileURL, for: cacheKey)
                } catch let fallbackError {
                    print("[TTS] ElevenLabs fallback also failed: \(fallbackError)")
                    throw error  // Throw original error
                }
            } else if effectiveQuality == .premium,
               voiceToUse.supportsStandardQuality,
               let kokoroVoiceID = voiceToUse.kokoroVoiceID {
                // Premium (ElevenLabs) failed - try Kokoro as fallback
                print("[TTS] Falling back to standard quality (Kokoro)")
                do {
                    let audioResult = try await service.synthesize(
                        text: text,
                        voiceId: kokoroVoiceID,
                        provider: ListenAICloudService.TTSProvider.selfhosted,
                        speed: Double(defaultSpeed)
                    )

                    let audioFileURL: URL
                    if let url = audioResult.fileURL {
                        audioFileURL = url
                    } else {
                        let tempURL = FileManager.default.temporaryDirectory
                            .appendingPathComponent(UUID().uuidString)
                            .appendingPathExtension("wav")
                        try audioResult.data.write(to: tempURL)
                        audioFileURL = tempURL
                    }

                    print("[TTS] Kokoro fallback succeeded")
                    return await cacheManager.cacheAudio(at: audioFileURL, for: cacheKey)
                } catch let fallbackError {
                    print("[TTS] Kokoro fallback also failed: \(fallbackError)")
                    throw error  // Throw original error
                }
            }

            throw error
        }
    }

    /// Switch to standard quality (self-hosted Kokoro, unlimited)
    func switchToStandardQuality() {
        selectedQuality = .standard
        print("[TTS] Switched to standard quality (Kokoro)")
    }

    /// Switch to premium quality - disabled, all voices use Kokoro now
    func switchToPremiumQuality() {
        // Premium (ElevenLabs) disabled - all voices use Kokoro for reliability
        print("[TTS] Premium quality disabled - using Kokoro for all synthesis")
        selectedQuality = .standard
    }

    /// Synthesize sections with progress reporting
    func synthesizeSections(
        _ sections: [TextSection],
        voice: VoicePreset? = nil,
        options: SynthesisOptions? = nil
    ) async throws -> SynthesisResult {
        let voiceToUse = voice ?? selectedVoice ?? availableVoices.first!
        var optionsToUse = options ?? .default
        optionsToUse.speed = defaultSpeed
        optionsToUse.pitch = defaultPitch

        isSynthesizing = true
        currentSynthesisProgress = .initial
        lastError = nil

        let taskID = UUID()
        currentTaskID = taskID

        defer {
            isSynthesizing = false
            currentTaskID = nil
        }

        do {
            let result = try await ttsManager.synthesize(
                sections: sections,
                voice: voiceToUse,
                options: optionsToUse
            ) { [weak self] progress in
                Task { @MainActor in
                    self?.currentSynthesisProgress = progress
                }
            }

            return result
        } catch let error as TTSError {
            lastError = error
            throw error
        } catch {
            let ttsError = TTSError.internalError(reason: error.localizedDescription)
            lastError = ttsError
            throw ttsError
        }
    }

    /// Cancel current synthesis
    func cancelSynthesis() {
        guard let taskID = currentTaskID else { return }
        Task {
            await ttsManager.cancelSynthesis(taskID: taskID)
        }
        isSynthesizing = false
        currentSynthesisProgress = nil
    }

    // MARK: - Estimation

    /// Get an estimate for synthesizing text
    func estimate(text: String, voice: VoicePreset? = nil) async -> SynthesisEstimate? {
        let voiceToUse = voice ?? selectedVoice ?? availableVoices.first!
        return await ttsManager.estimate(text: text, voice: voiceToUse)
    }

    // MARK: - Speed Control

    /// Set the default speaking speed
    func setSpeed(_ speed: Float) {
        defaultSpeed = max(0.5, min(3.0, speed))
    }

    /// Increase speed by 0.25x
    func increaseSpeed() {
        setSpeed(defaultSpeed + 0.25)
    }

    /// Decrease speed by 0.25x
    func decreaseSpeed() {
        setSpeed(defaultSpeed - 0.25)
    }

    // MARK: - Cache Management

    /// Clear audio cache
    func clearCache() async {
        await cacheManager.clearCache()
    }

    /// Get cache size in bytes
    func cacheSize() async -> Int64 {
        await cacheManager.currentSizeBytes()
    }
}

// MARK: - Audio Cache Manager

/// Manages caching of generated audio files
actor AudioCacheManager {

    // MARK: - Properties

    private let cacheDirectory: URL
    private let maxCacheSizeBytes: Int64
    private var cacheIndex: [String: CacheEntry] = [:]

    struct CacheEntry: Codable {
        let key: String
        let fileURL: URL
        let createdAt: Date
        let lastAccessedAt: Date
        let sizeBytes: Int64
    }

    // MARK: - Singleton

    static let shared = AudioCacheManager()

    // MARK: - Initialization

    private init() {
        // Use Caches directory
        let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        self.cacheDirectory = cachesDir.appendingPathComponent("AudioCache", isDirectory: true)
        self.maxCacheSizeBytes = 500 * 1024 * 1024 // 500 MB

        // Create cache directory
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)

        // Load cache index
        Task {
            await loadCacheIndex()
        }
    }

    // MARK: - Cache Key Generation

    nonisolated func cacheKey(text: String, voice: VoicePreset, options: SynthesisOptions) -> String {
        let combined = "\(text)|\(voice.id)|\(options.speed)|\(options.pitch)"
        return combined.sha256Hash
    }

    // MARK: - Cache Operations

    func getCachedAudio(for key: String) -> URL? {
        if let entry = cacheIndex[key] {
            // Check if file still exists at the indexed location
            if FileManager.default.fileExists(atPath: entry.fileURL.path) {
                // Update last accessed time
                let updatedEntry = CacheEntry(
                    key: entry.key,
                    fileURL: entry.fileURL,
                    createdAt: entry.createdAt,
                    lastAccessedAt: Date(),
                    sizeBytes: entry.sizeBytes
                )
                cacheIndex[key] = updatedEntry
                return entry.fileURL
            }
            // File not found at indexed location, remove stale entry
            cacheIndex.removeValue(forKey: key)
        }

        // Try to find file with any common audio extension
        let extensions = ["mp3", "m4a", "aac", "wav"]
        for ext in extensions {
            let fileName = "\(key).\(ext)"
            let fileURL = cacheDirectory.appendingPathComponent(fileName)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                print("[Cache] Found file with alternate extension: \(ext)")
                // Re-index the found file
                if let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
                   let size = attributes[.size] as? Int64 {
                    let entry = CacheEntry(
                        key: key,
                        fileURL: fileURL,
                        createdAt: Date(),
                        lastAccessedAt: Date(),
                        sizeBytes: size
                    )
                    cacheIndex[key] = entry
                    saveCacheIndex()
                }
                return fileURL
            }
        }

        return nil
    }

    func cacheAudio(at sourceURL: URL, for key: String) -> URL {
        let fileName = "\(key).\(sourceURL.pathExtension)"
        let destinationURL = cacheDirectory.appendingPathComponent(fileName)

        print("[Cache] Source: \(sourceURL.path)")
        print("[Cache] Source exists: \(FileManager.default.fileExists(atPath: sourceURL.path))")
        print("[Cache] Dest: \(destinationURL.path)")

        // Ensure cache directory exists
        if !FileManager.default.fileExists(atPath: cacheDirectory.path) {
            try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
            print("[Cache] Created cache directory")
        }

        do {
            // Copy file to cache
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.copyItem(at: sourceURL, to: destinationURL)

            print("[Cache] Copy success, dest exists: \(FileManager.default.fileExists(atPath: destinationURL.path))")

            // Get file size
            let attributes = try FileManager.default.attributesOfItem(atPath: destinationURL.path)
            let size = attributes[.size] as? Int64 ?? 0

            // Add to index
            let entry = CacheEntry(
                key: key,
                fileURL: destinationURL,
                createdAt: Date(),
                lastAccessedAt: Date(),
                sizeBytes: size
            )
            cacheIndex[key] = entry

            // Evict if over size limit
            Task {
                await evictIfNeeded()
            }

            // Save index
            saveCacheIndex()

            print("[Cache] Cached audio to: \(destinationURL.lastPathComponent)")
            return destinationURL
        } catch {
            print("[Cache] ERROR: Failed to cache audio: \(error)")
            print("[Cache] Returning original URL: \(sourceURL.path)")
            return sourceURL
        }
    }

    func clearCache() {
        // Remove all cached files
        for (_, entry) in cacheIndex {
            try? FileManager.default.removeItem(at: entry.fileURL)
        }
        cacheIndex.removeAll()
        saveCacheIndex()
    }

    func currentSizeBytes() -> Int64 {
        cacheIndex.values.reduce(0) { $0 + $1.sizeBytes }
    }

    /// Find audio file trying alternate extensions if the original path doesn't exist.
    /// Useful when stored URL has wrong extension.
    nonisolated func findAudioFile(at url: URL) -> URL? {
        // First check if file exists at original URL
        if FileManager.default.fileExists(atPath: url.path) {
            return url
        }

        // Try alternate extensions
        let basePath = url.deletingPathExtension()
        let extensions = ["mp3", "m4a", "aac", "wav"]

        for ext in extensions {
            let altURL = basePath.appendingPathExtension(ext)
            if FileManager.default.fileExists(atPath: altURL.path) {
                print("[Cache] Found audio file with alternate extension: \(ext)")
                return altURL
            }
        }

        return nil
    }

    // MARK: - Private Methods

    private func loadCacheIndex() {
        let indexURL = cacheDirectory.appendingPathComponent("index.json")
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? JSONDecoder().decode([String: CacheEntry].self, from: data) else {
            return
        }
        cacheIndex = index
    }

    private func saveCacheIndex() {
        let indexURL = cacheDirectory.appendingPathComponent("index.json")
        guard let data = try? JSONEncoder().encode(cacheIndex) else { return }
        try? data.write(to: indexURL)
    }

    private func evictIfNeeded() {
        var currentSize = currentSizeBytes()

        guard currentSize > maxCacheSizeBytes else { return }

        // Sort by last accessed (oldest first)
        let sortedEntries = cacheIndex.values.sorted { $0.lastAccessedAt < $1.lastAccessedAt }

        for entry in sortedEntries {
            guard currentSize > maxCacheSizeBytes else { break }

            try? FileManager.default.removeItem(at: entry.fileURL)
            cacheIndex.removeValue(forKey: entry.key)
            currentSize -= entry.sizeBytes
        }

        saveCacheIndex()
    }
}

// MARK: - String Extension for Hashing

extension String {
    var sha256Hash: String {
        let data = Data(self.utf8)
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))

        data.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(buffer.count), &hash)
        }

        return hash.map { String(format: "%02x", $0) }.joined()
    }
}

// CommonCrypto import for SHA256
import CommonCrypto
