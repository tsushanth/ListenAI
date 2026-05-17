import Foundation
import AVFoundation

// MARK: - Self-Hosted TTS Service

/// Service for communicating with our self-hosted TTS backend (Kokoro/XTTS)
/// This provides standard quality voices that are fast and unlimited.
actor SelfHostedTTSService {

    // MARK: - Configuration

    /// Base URL for the self-hosted TTS service
    private let baseURL: URL

    /// URL session for API requests
    private let session: URLSession

    /// Available TTS models
    enum TTSModel: String, Sendable {
        case kokoro = "kokoro"   // Fast, standard quality
        case xtts = "xtts"       // Voice cloning capable
    }

    // MARK: - Initialization

    init(baseURL: URL? = nil) {
        // Default to production URL, can be overridden for testing
        self.baseURL = baseURL ?? URL(string: "https://readaloud-tts.fly.dev")!

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120 // TTS can take time for long text
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
    }

    // MARK: - Public API

    /// Synthesize text to speech using Kokoro model (fast, standard quality)
    /// - Parameters:
    ///   - text: Text to synthesize
    ///   - voiceID: Kokoro voice ID (e.g., "af_nicole", "am_adam")
    ///   - speed: Speaking speed multiplier (0.5-2.0, default 1.0)
    /// - Returns: Audio data as WAV
    func synthesize(
        text: String,
        voiceID: String,
        speed: Float = 1.0
    ) async throws -> Data {
        try await synthesize(text: text, voiceID: voiceID, speed: speed, model: .kokoro)
    }

    /// Synthesize text using a specific model
    /// - Parameters:
    ///   - text: Text to synthesize
    ///   - voiceID: Voice ID for the model
    ///   - speed: Speaking speed multiplier
    ///   - model: TTS model to use (.kokoro or .xtts)
    /// - Returns: Audio data as WAV
    func synthesize(
        text: String,
        voiceID: String,
        speed: Float = 1.0,
        model: TTSModel = .kokoro
    ) async throws -> Data {
        let url = baseURL.appendingPathComponent("synthesize")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = SynthesizeRequest(
            text: text,
            voiceID: voiceID,
            speed: speed,
            model: model.rawValue,
            language: "en"
        )

        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw SelfHostedTTSError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200:
            return data
        case 400:
            throw SelfHostedTTSError.badRequest(parseError(from: data))
        case 429:
            throw SelfHostedTTSError.rateLimited
        case 500...599:
            throw SelfHostedTTSError.serverError(parseError(from: data))
        default:
            throw SelfHostedTTSError.unknownError(httpResponse.statusCode)
        }
    }

    /// Synthesize long text with automatic chunking
    /// Returns audio progressively as chunks are synthesized
    /// - Parameters:
    ///   - text: Long text to synthesize
    ///   - voiceID: Voice ID
    ///   - speed: Speaking speed
    ///   - onChunkReady: Callback for each audio chunk
    func synthesizeLong(
        text: String,
        voiceID: String,
        speed: Float = 1.0,
        onChunkReady: @escaping (Data, Int, Int) async -> Void
    ) async throws {
        let url = baseURL.appendingPathComponent("synthesize-long")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = SynthesizeLongRequest(
            text: text,
            voiceID: voiceID,
            speed: speed,
            model: "kokoro",
            language: "en",
            maxChunkChars: 250
        )

        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw SelfHostedTTSError.invalidResponse
        }

        // Parse the long synthesis response
        let result = try JSONDecoder().decode(LongSynthesisResponse.self, from: data)

        // Process each chunk
        for (index, chunkResult) in result.results.enumerated() {
            if let audioBase64 = chunkResult.audioBase64,
               let audioData = Data(base64Encoded: audioBase64) {
                await onChunkReady(audioData, index, result.totalChunks)
            }
        }
    }

    /// Check service health
    func checkHealth() async throws -> HealthStatus {
        let url = baseURL.appendingPathComponent("health")
        let (data, response) = try await session.data(from: url)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw SelfHostedTTSError.serviceUnavailable
        }

        return try JSONDecoder().decode(HealthStatus.self, from: data)
    }

    /// Get available voices from the service
    func getVoices() async throws -> [VoiceInfo] {
        let url = baseURL.appendingPathComponent("voices")
        let (data, response) = try await session.data(from: url)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw SelfHostedTTSError.invalidResponse
        }

        let result = try JSONDecoder().decode(VoicesResponse.self, from: data)
        return result.voices
    }

    /// Preview text chunking for long documents
    func previewChunks(text: String, maxChunkChars: Int = 250) async throws -> ChunkPreview {
        let url = baseURL.appendingPathComponent("chunk-preview")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["text": text, "max_chunk_chars": maxChunkChars] as [String: Any]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw SelfHostedTTSError.invalidResponse
        }

        return try JSONDecoder().decode(ChunkPreview.self, from: data)
    }

    // MARK: - Private Helpers

    private func parseError(from data: Data) -> String {
        if let json = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
            return json.detail ?? json.error ?? "Unknown error"
        }
        return String(data: data, encoding: .utf8) ?? "Unknown error"
    }
}

// MARK: - Request/Response Models

extension SelfHostedTTSService {

    struct SynthesizeRequest: Encodable {
        let text: String
        let voiceID: String
        let speed: Float
        let model: String
        let language: String

        enum CodingKeys: String, CodingKey {
            case text
            case voiceID = "voice_id"
            case speed
            case model
            case language
        }
    }

    struct SynthesizeLongRequest: Encodable {
        let text: String
        let voiceID: String
        let speed: Float
        let model: String
        let language: String
        let maxChunkChars: Int

        enum CodingKeys: String, CodingKey {
            case text
            case voiceID = "voice_id"
            case speed
            case model
            case language
            case maxChunkChars = "max_chunk_chars"
        }
    }

    struct LongSynthesisResponse: Decodable {
        let totalChunks: Int
        let results: [ChunkResult]

        enum CodingKeys: String, CodingKey {
            case totalChunks = "total_chunks"
            case results
        }
    }

    struct ChunkResult: Decodable {
        let chunkIndex: Int
        let text: String
        let audioBase64: String?
        let error: String?

        enum CodingKeys: String, CodingKey {
            case chunkIndex = "chunk_index"
            case text
            case audioBase64 = "audio_base64"
            case error
        }
    }

    struct HealthStatus: Decodable {
        let status: String
        let timestamp: String
        let models: ModelsStatus?
    }

    struct ModelsStatus: Decodable {
        let kokoro: String?
        let xtts: String?
    }

    struct VoicesResponse: Decodable {
        let voices: [VoiceInfo]
    }

    struct VoiceInfo: Decodable, Identifiable {
        let id: String
        let name: String
        let language: String
        let gender: String
        let description: String
    }

    struct ChunkPreview: Decodable {
        let totalChunks: Int
        let totalCharacters: Int
        let chunks: [ChunkInfo]

        enum CodingKeys: String, CodingKey {
            case totalChunks = "total_chunks"
            case totalCharacters = "total_characters"
            case chunks
        }
    }

    struct ChunkInfo: Decodable {
        let index: Int
        let text: String
        let charCount: Int

        enum CodingKeys: String, CodingKey {
            case index
            case text
            case charCount = "char_count"
        }
    }

    struct ErrorResponse: Decodable {
        let detail: String?
        let error: String?
    }
}

// MARK: - Errors

enum SelfHostedTTSError: Error, LocalizedError {
    case invalidResponse
    case badRequest(String)
    case rateLimited
    case serverError(String)
    case serviceUnavailable
    case unknownError(Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from TTS service"
        case .badRequest(let message):
            return "Bad request: \(message)"
        case .rateLimited:
            return "TTS service is busy. Please try again."
        case .serverError(let message):
            return "Server error: \(message)"
        case .serviceUnavailable:
            return "TTS service is currently unavailable"
        case .unknownError(let code):
            return "Unknown error (HTTP \(code))"
        }
    }
}

// MARK: - Shared Instance

extension SelfHostedTTSService {
    /// Shared instance for standard usage
    static let shared = SelfHostedTTSService()
}
