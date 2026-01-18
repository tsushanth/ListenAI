import Foundation

// MARK: - TTS Service Protocol

/// Protocol defining the interface for text-to-speech synthesis services.
/// Implementations can use on-device synthesis (Apple) or cloud-based APIs.
protocol TTSService: Actor {

    // MARK: - Properties

    /// The voice provider this service uses
    var provider: VoiceProvider { get }

    /// Whether the service is currently available
    var isAvailable: Bool { get async }

    /// Maximum text length supported per synthesis request
    var maxTextLength: Int { get }

    /// Whether the service supports streaming synthesis
    var supportsStreaming: Bool { get }

    /// Whether the service supports SSML input
    var supportsSSML: Bool { get }

    // MARK: - Single Text Synthesis

    /// Synthesize text to an audio file
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - voice: The voice preset to use
    ///   - options: Synthesis options (speed, pitch, format, etc.)
    /// - Returns: The synthesis result containing the audio file URL and metadata
    func synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) async throws -> SynthesisResult

    // MARK: - Sectioned Synthesis with Progress

    /// Synthesize multiple sections with progress reporting
    /// - Parameters:
    ///   - sections: The text sections to synthesize
    ///   - voice: The voice preset to use
    ///   - options: Synthesis options
    ///   - progress: Closure called with progress updates
    /// - Returns: The synthesis result with combined audio and section timestamps
    func synthesize(
        sections: [TextSection],
        voice: VoicePreset,
        options: SynthesisOptions,
        progress: @escaping @Sendable (SynthesisProgress) -> Void
    ) async throws -> SynthesisResult

    // MARK: - Streaming Synthesis

    /// Stream synthesis for real-time playback during generation
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - voice: The voice preset to use
    ///   - options: Synthesis options
    /// - Returns: An async stream of audio chunks
    func synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) -> AsyncThrowingStream<AudioChunk, Error>

    // MARK: - Control

    /// Cancel an ongoing synthesis task
    /// - Parameter taskID: The ID of the task to cancel
    func cancelSynthesis(taskID: UUID) async

    /// Cancel all ongoing synthesis tasks
    func cancelAllSynthesis() async

    // MARK: - Voice Management

    /// Check if a voice is available for use
    /// - Parameter voice: The voice preset to check
    /// - Returns: Whether the voice is ready to use
    func isVoiceAvailable(_ voice: VoicePreset) async -> Bool

    /// Get all available voices from this provider
    /// - Returns: Array of available voice presets
    func availableVoices() async -> [VoicePreset]

    /// Download a voice if it requires download (Apple enhanced voices)
    /// - Parameter voice: The voice to download
    func downloadVoice(_ voice: VoicePreset) async throws

    // MARK: - Estimation

    /// Estimate synthesis cost and duration before processing
    /// - Parameters:
    ///   - text: The text to estimate for
    ///   - voice: The voice preset
    /// - Returns: Estimate including duration, processing time, and cost
    func estimate(text: String, voice: VoicePreset) -> SynthesisEstimate
}

// MARK: - Default Implementations

extension TTSService {

    /// Default implementation for simple text synthesis using sectioned synthesis
    func synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) async throws -> SynthesisResult {
        // Convert to single section
        let section = TextSection(
            index: 0,
            type: .paragraph,
            text: text,
            characterRange: 0..<text.count
        )

        return try await synthesize(
            sections: [section],
            voice: voice,
            options: options,
            progress: { _ in }
        )
    }

    /// Default streaming implementation that throws not supported
    func synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) -> AsyncThrowingStream<AudioChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: TTSError.invalidConfiguration(
                reason: "Streaming not supported by \(provider.displayName)"
            ))
        }
    }

    /// Default voice download that does nothing (for cloud providers)
    func downloadVoice(_ voice: VoicePreset) async throws {
        // No-op for cloud providers
    }
}

// MARK: - TTS Service Factory

/// Factory for creating TTS service instances
enum TTSServiceFactory {

    // MARK: - Shared ListenAI Cloud Service

    /// Shared ListenAI Cloud Service instance (set during app initialization)
    private static var _listenAICloudService: ListenAICloudService?

    /// Configure the shared ListenAI Cloud Service.
    /// Call this during app initialization with your Cloud Run URL and auth provider.
    ///
    /// - Parameters:
    ///   - baseURL: The Cloud Run backend URL
    ///   - authTokenProvider: Closure that returns the current Supabase JWT
    static func configureListenAICloud(
        baseURL: URL,
        authTokenProvider: @escaping @Sendable () async throws -> String
    ) {
        _listenAICloudService = ListenAICloudService(
            baseURL: baseURL,
            authTokenProvider: authTokenProvider
        )

        // Also configure the TTSJobManager for background job polling
        if let cloudService = _listenAICloudService {
            Task { @MainActor in
                TTSJobManager.shared.configure(cloudService: cloudService)
            }
        }
    }

    /// Get the shared ListenAI Cloud Service
    static var listenAICloudService: ListenAICloudService? {
        _listenAICloudService
    }

    // MARK: - ML TTS Preference

    /// Whether to prefer ML-based TTS on capable devices
    private static var _preferMLTTS: Bool = true

    /// Enable or disable ML TTS preference
    static func setPreferMLTTS(_ enabled: Bool) {
        _preferMLTTS = enabled
    }

    /// Check if ML TTS is preferred and available
    static var shouldUseMLTTS: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return _preferMLTTS
        #endif
    }

    // MARK: - Service Creation

    /// Create a TTS service for the given provider
    /// - Parameter provider: The voice provider
    /// - Returns: A TTS service instance
    static func createService(for provider: VoiceProvider) -> any TTSService {
        switch provider {
        case .apple:
            // Use OnDeviceTTSService which provides word-level timestamps
            // MLTTSService can be used for simpler synthesis without timestamps
            return OnDeviceTTSService()
        case .elevenLabs:
            // ElevenLabs synthesis goes through backend (API key is server-side)
            // If backend is not configured, fall back to on-device
            if listenAICloudService != nil {
                return BackendTTSWrapper(provider: .elevenLabs)
            } else {
                print("[TTS] Backend not configured for ElevenLabs, falling back to on-device")
                return OnDeviceTTSService()
            }
        case .openAI:
            // OpenAI also uses backend if available
            if listenAICloudService != nil {
                return BackendTTSWrapper(provider: .openAI)
            } else {
                return OnDeviceTTSService()
            }
        case .googleCloud:
            return CloudTTSService(
                provider: .googleCloud,
                configuration: .googleCloud
            )
        case .amazonPolly:
            return CloudTTSService(
                provider: .amazonPolly,
                configuration: .amazonPolly
            )
        case .selfhosted:
            // Self-hosted uses SelfHostedTTSService actor directly
            // Return a wrapper that conforms to TTSService
            return SelfHostedTTSWrapper()
        }
    }

    /// Create the default on-device service
    static func createOnDeviceService() -> any TTSService {
        OnDeviceTTSService()
    }

    /// Create the legacy AVSpeechSynthesizer-based service
    static func createLegacyOnDeviceService() -> OnDeviceTTSService {
        OnDeviceTTSService()
    }

    /// Create a cloud service for premium voices
    static func createCloudService(
        provider: VoiceProvider,
        apiKey: String? = nil
    ) throws -> CloudTTSService {
        var config = try CloudTTSConfiguration.configuration(for: provider)
        if let apiKey = apiKey {
            config.apiKey = apiKey
        }
        return CloudTTSService(provider: provider, configuration: config)
    }

    // MARK: - Smart Service Selection

    /// Get the appropriate service for a voice, choosing between on-device and cloud
    /// based on the voice configuration and available services.
    ///
    /// - Parameters:
    ///   - voice: The voice preset to use
    ///   - preferCloud: Whether to prefer cloud synthesis when available
    /// - Returns: Tuple of (service, shouldUseCloud)
    static func selectService(
        for voice: VoicePreset,
        preferCloud: Bool = true
    ) -> (service: any TTSService, useCloud: Bool) {
        // For Apple voices, always use on-device
        if voice.provider == .apple {
            return (createOnDeviceService(), false)
        }

        // For cloud voices with on-device fallback
        if voice.hasOnDeviceFallback && !preferCloud {
            // Use on-device with fallback mapping
            return (createOnDeviceService(), false)
        }

        // Use appropriate cloud service
        if let listenAI = _listenAICloudService, preferCloud {
            // ListenAI backend handles all cloud voices
            // The caller should use listenAICloudService directly
            // Return the direct provider service as fallback
            return (createService(for: voice.provider), true)
        }

        // Fall back to direct provider service
        return (createService(for: voice.provider), true)
    }
}

// MARK: - Unified TTS Manager

/// Manages multiple TTS services and routes requests to the appropriate one
actor TTSManager {

    // MARK: - Properties

    private var services: [VoiceProvider: any TTSService] = [:]
    private var activeTasks: [UUID: VoiceProvider] = [:]

    // MARK: - Singleton

    static let shared = TTSManager()

    private init() {
        // Initialize with on-device service by default
        services[.apple] = OnDeviceTTSService()
    }

    // MARK: - Service Management

    /// Register a TTS service for a provider
    func registerService(_ service: any TTSService, for provider: VoiceProvider) {
        services[provider] = service
    }

    /// Get the service for a voice preset
    func service(for voice: VoicePreset) -> (any TTSService)? {
        // Lazily create services as needed
        if services[voice.provider] == nil {
            services[voice.provider] = TTSServiceFactory.createService(for: voice.provider)
        }
        return services[voice.provider]
    }

    // MARK: - Synthesis

    /// Synthesize text using the appropriate service for the voice
    func synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions = .default
    ) async throws -> SynthesisResult {
        guard let service = service(for: voice) else {
            throw TTSError.invalidConfiguration(reason: "No service for provider \(voice.provider)")
        }

        return try await service.synthesize(text: text, voice: voice, options: options)
    }

    /// Synthesize sections using the appropriate service
    func synthesize(
        sections: [TextSection],
        voice: VoicePreset,
        options: SynthesisOptions = .default,
        progress: @escaping @Sendable (SynthesisProgress) -> Void
    ) async throws -> SynthesisResult {
        guard let service = service(for: voice) else {
            throw TTSError.invalidConfiguration(reason: "No service for provider \(voice.provider)")
        }

        return try await service.synthesize(
            sections: sections,
            voice: voice,
            options: options,
            progress: progress
        )
    }

    /// Get estimate for synthesis
    func estimate(text: String, voice: VoicePreset) async -> SynthesisEstimate? {
        guard let service = service(for: voice) else { return nil }
        return await service.estimate(text: text, voice: voice)
    }

    /// Get all available voices across all providers
    func allAvailableVoices() async -> [VoicePreset] {
        var voices: [VoicePreset] = []

        for (_, service) in services {
            let providerVoices = await service.availableVoices()
            voices.append(contentsOf: providerVoices)
        }

        return voices.sorted { $0.name < $1.name }
    }

    /// Cancel a synthesis task
    func cancelSynthesis(taskID: UUID) async {
        guard let provider = activeTasks[taskID],
              let service = services[provider] else { return }
        await service.cancelSynthesis(taskID: taskID)
        activeTasks.removeValue(forKey: taskID)
    }

    /// Cancel all synthesis tasks
    func cancelAllSynthesis() async {
        for (_, service) in services {
            await service.cancelAllSynthesis()
        }
        activeTasks.removeAll()
    }
}

// MARK: - Self-Hosted TTS Wrapper

/// Wrapper around SelfHostedTTSService to conform to the TTSService protocol.
/// Used for service factory pattern compatibility.
actor SelfHostedTTSWrapper: TTSService {

    var provider: VoiceProvider { .selfhosted }

    var isAvailable: Bool {
        get async {
            do {
                let health = try await SelfHostedTTSService.shared.checkHealth()
                return health.status == "ok" || health.status == "healthy"
            } catch {
                return false
            }
        }
    }

    var maxTextLength: Int { 50_000 }
    var supportsStreaming: Bool { false }
    var supportsSSML: Bool { false }

    func synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) async throws -> SynthesisResult {
        guard let kokoroVoiceID = voice.kokoroVoiceID else {
            throw SelfHostedTTSError.badRequest("Voice \(voice.name) not supported for self-hosted TTS")
        }

        let audioData = try await SelfHostedTTSService.shared.synthesize(
            text: text,
            voiceID: kokoroVoiceID,
            speed: options.speed
        )

        // Write to temp file
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("wav")
        try audioData.write(to: tempURL)

        // Estimate duration: ~750 chars per minute
        let estimatedDuration = TimeInterval(text.count) / 750.0 * 60.0

        let now = Date()
        let metadata = SynthesisMetadata(
            voiceID: voice.id,
            voiceName: voice.name,
            provider: .selfhosted,
            startedAt: now,
            completedAt: now,
            inputCharacterCount: text.count,
            outputSampleRate: 24000,
            processingTimeSeconds: 0
        )

        return SynthesisResult(
            audioFileURL: tempURL,
            duration: estimatedDuration,
            sectionTimestamps: [],
            wordTimestamps: nil,
            fileSizeBytes: Int64(audioData.count),
            cost: nil,
            metadata: metadata
        )
    }

    func synthesize(
        sections: [TextSection],
        voice: VoicePreset,
        options: SynthesisOptions,
        progress: @escaping @Sendable (SynthesisProgress) -> Void
    ) async throws -> SynthesisResult {
        // Combine all sections and synthesize as one
        let combinedText = sections.map(\.text).joined(separator: " ")
        return try await synthesize(text: combinedText, voice: voice, options: options)
    }

    func synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) -> AsyncThrowingStream<AudioChunk, Error> {
        // Not supported - return empty stream
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: SelfHostedTTSError.badRequest("Streaming not supported"))
        }
    }

    func cancelSynthesis(taskID: UUID) async {
        // No-op - single request based
    }

    func cancelAllSynthesis() async {
        // No-op
    }

    func isVoiceAvailable(_ voice: VoicePreset) async -> Bool {
        voice.kokoroVoiceID != nil
    }

    func availableVoices() async -> [VoicePreset] {
        VoicePreset.allBuiltInPresets.filter { $0.kokoroVoiceID != nil }
    }

    func downloadVoice(_ voice: VoicePreset) async throws {
        // No download needed - cloud service
    }

    func estimate(
        text: String,
        voice: VoicePreset
    ) -> SynthesisEstimate {
        let charCount = text.count
        // Kokoro is fast: ~6 seconds for short text
        let processingTime = TimeInterval(charCount) / 1000.0 * 2.0
        let duration = TimeInterval(charCount) / 750.0 * 60.0

        return SynthesisEstimate(
            estimatedDuration: duration,
            estimatedProcessingTime: processingTime,
            characterCount: charCount,
            estimatedCostUSD: nil, // Self-hosted is free
            quotaImpact: nil
        )
    }
}

// MARK: - Backend TTS Wrapper

/// Wrapper that routes TTS synthesis through the ListenAI backend.
/// This keeps API keys server-side for security and proper quota management.
actor BackendTTSWrapper: TTSService {

    let provider: VoiceProvider
    var maxTextLength: Int { 100_000 }
    var supportsStreaming: Bool { false }
    var supportsSSML: Bool { false }

    init(provider: VoiceProvider) {
        self.provider = provider
    }

    var isAvailable: Bool {
        get async {
            TTSServiceFactory.listenAICloudService != nil
        }
    }

    func synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) async throws -> SynthesisResult {
        guard let cloudService = TTSServiceFactory.listenAICloudService else {
            throw TTSError.invalidConfiguration(reason: "Backend not configured for \(provider.displayName)")
        }

        let startTime = Date()

        // Use the backend to synthesize (API keys are server-side)
        // Note: This wrapper is mainly used for premium ElevenLabs synthesis.
        // Standard Kokoro synthesis goes directly through synthesizeWithQuality().
        let (voiceId, ttsProvider): (String, ListenAICloudService.TTSProvider) = {
            switch voice.provider {
            case .elevenLabs:
                return (voice.providerVoiceID, .elevenlabs)
            case .selfhosted:
                return (voice.kokoroVoiceID ?? voice.providerVoiceID, .selfhosted)
            default:
                // For other providers, use Kokoro as backend fallback
                if let kokoroId = voice.kokoroVoiceID {
                    return (kokoroId, .selfhosted)
                }
                return (voice.providerVoiceID, .selfhosted)
            }
        }()

        let audioResult = try await cloudService.synthesize(
            text: text,
            voiceId: voiceId,
            provider: ttsProvider,
            speed: Double(options.speed)
        )

        // Get or create file URL
        let fileURL: URL
        if let existingURL = audioResult.fileURL {
            fileURL = existingURL
        } else {
            fileURL = try audioResult.saveToTempFile()
        }

        let endTime = Date()
        let duration = audioResult.duration ?? (TimeInterval(text.count) / 750.0 * 60.0)

        // Build metadata
        let metadata = SynthesisMetadata(
            voiceID: voice.id,
            voiceName: voice.name,
            provider: provider,
            startedAt: startTime,
            completedAt: endTime,
            inputCharacterCount: text.count,
            outputSampleRate: 44100,
            processingTimeSeconds: endTime.timeIntervalSince(startTime)
        )

        // Build cost info
        let cost = SynthesisCost(
            charactersUsed: audioResult.charactersUsed,
            costUSD: Decimal(audioResult.charactersUsed) * Decimal(string: "0.00030")!, // ElevenLabs rate
            quotaUsed: audioResult.charactersUsed,
            provider: provider.rawValue
        )

        return SynthesisResult(
            audioFileURL: fileURL,
            duration: duration,
            sectionTimestamps: [],
            wordTimestamps: nil,
            fileSizeBytes: Int64(audioResult.data.count),
            cost: cost,
            metadata: metadata
        )
    }

    func synthesize(
        sections: [TextSection],
        voice: VoicePreset,
        options: SynthesisOptions,
        progress: @escaping @Sendable (SynthesisProgress) -> Void
    ) async throws -> SynthesisResult {
        // Combine all sections and synthesize as one
        let combinedText = sections.map(\.text).joined(separator: " ")

        progress(SynthesisProgress(
            overallProgress: 0.1,
            currentSectionIndex: 0,
            sectionsCompleted: 0,
            totalSections: sections.count,
            estimatedTimeRemaining: nil,
            statusMessage: "Connecting to server...",
            charactersProcessed: 0,
            totalCharacters: combinedText.count
        ))

        let result = try await synthesize(text: combinedText, voice: voice, options: options)

        progress(SynthesisProgress(
            overallProgress: 1.0,
            currentSectionIndex: sections.count - 1,
            sectionsCompleted: sections.count,
            totalSections: sections.count,
            estimatedTimeRemaining: 0,
            statusMessage: "Complete",
            charactersProcessed: combinedText.count,
            totalCharacters: combinedText.count
        ))

        return result
    }

    func synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) -> AsyncThrowingStream<AudioChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: TTSError.invalidConfiguration(reason: "Streaming not supported via backend"))
        }
    }

    func cancelSynthesis(taskID: UUID) async {
        // No-op - backend handles this
    }

    func cancelAllSynthesis() async {
        // No-op
    }

    func isVoiceAvailable(_ voice: VoicePreset) async -> Bool {
        voice.provider == provider && TTSServiceFactory.listenAICloudService != nil
    }

    func availableVoices() async -> [VoicePreset] {
        VoicePreset.allBuiltInPresets.filter { $0.provider == provider }
    }

    func downloadVoice(_ voice: VoicePreset) async throws {
        // No download needed - server-side
    }

    func estimate(text: String, voice: VoicePreset) -> SynthesisEstimate {
        let charCount = text.count
        // Cloud processing: ~2s per 1000 chars
        let processingTime = TimeInterval(charCount) / 1000.0 * 2.0
        let duration = TimeInterval(charCount) / 750.0 * 60.0

        // ElevenLabs cost
        let costPerChar = provider == .elevenLabs ? Decimal(string: "0.00030")! : Decimal(string: "0.000015")!
        let estimatedCost = Decimal(charCount) * costPerChar

        return SynthesisEstimate(
            estimatedDuration: duration,
            estimatedProcessingTime: processingTime,
            characterCount: charCount,
            estimatedCostUSD: estimatedCost,
            quotaImpact: nil
        )
    }
}
