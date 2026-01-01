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

    /// Create a TTS service for the given provider
    /// - Parameter provider: The voice provider
    /// - Returns: A TTS service instance
    static func createService(for provider: VoiceProvider) -> any TTSService {
        switch provider {
        case .apple:
            return OnDeviceTTSService()
        case .elevenLabs:
            return CloudTTSService(
                provider: .elevenLabs,
                configuration: .elevenLabs
            )
        case .openAI:
            return CloudTTSService(
                provider: .openAI,
                configuration: .openAI
            )
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
        }
    }

    /// Create the default on-device service
    static func createOnDeviceService() -> OnDeviceTTSService {
        OnDeviceTTSService()
    }

    /// Create a cloud service for premium voices
    static func createCloudService(
        provider: VoiceProvider,
        apiKey: String? = nil
    ) -> CloudTTSService {
        var config = CloudTTSConfiguration.configuration(for: provider)
        if let apiKey = apiKey {
            config.apiKey = apiKey
        }
        return CloudTTSService(provider: provider, configuration: config)
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
