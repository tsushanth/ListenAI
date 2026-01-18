import Foundation
import AVFoundation

// MARK: - Voice Cloning Service

/// Service for creating and managing cloned voices using ElevenLabs instant voice cloning.
actor VoiceCloningService {

    // MARK: - Types

    /// Status of a voice cloning job
    enum CloningStatus: String, Codable, Sendable {
        case pending
        case processing
        case completed
        case failed
    }

    /// Result of creating a cloned voice
    struct ClonedVoiceResult: Codable, Sendable {
        let voiceId: String
        let name: String
        let status: CloningStatus
        let createdAt: Date?
        let previewUrl: String?
    }

    /// Cloned voice metadata
    struct ClonedVoice: Codable, Sendable, Identifiable {
        let id: String
        let name: String
        let status: CloningStatus
        let createdAt: Date
        let labels: [String: String]?

        var isReady: Bool {
            status == .completed
        }
    }

    /// Error types for voice cloning
    enum VoiceCloningError: LocalizedError, Sendable {
        case notConfigured
        case audioFileTooShort(minimumSeconds: Int)
        case audioFileTooLong(maximumSeconds: Int)
        case invalidAudioFormat
        case uploadFailed(String)
        case cloningFailed(String)
        case voiceNotFound
        case networkError(String)
        case unauthorized

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "Voice cloning service is not configured"
            case .audioFileTooShort(let minSeconds):
                return "Audio must be at least \(minSeconds) seconds long"
            case .audioFileTooLong(let maxSeconds):
                return "Audio must be no longer than \(maxSeconds) seconds"
            case .invalidAudioFormat:
                return "Invalid audio format. Please use M4A, MP3, or WAV"
            case .uploadFailed(let reason):
                return "Failed to upload audio: \(reason)"
            case .cloningFailed(let reason):
                return "Voice cloning failed: \(reason)"
            case .voiceNotFound:
                return "Cloned voice not found"
            case .networkError(let message):
                return "Network error: \(message)"
            case .unauthorized:
                return "Please sign in to use voice cloning"
            }
        }
    }

    // MARK: - Configuration

    /// Minimum audio duration for cloning (in seconds)
    static let minimumAudioDuration: TimeInterval = 30

    /// Maximum audio duration for cloning (in seconds)
    static let maximumAudioDuration: TimeInterval = 300 // 5 minutes

    /// Supported audio formats
    static let supportedFormats = ["m4a", "mp3", "wav", "aac", "mp4"]

    // MARK: - Sample Texts

    /// Sample texts for users to read when recording voice samples.
    /// These cover various phonemes and speech patterns for better cloning.
    static let sampleTexts: [String] = [
        """
        The rainbow shimmers across the misty valley as morning sunlight breaks through heavy clouds. \
        Birds sing their cheerful melodies while a gentle breeze rustles through autumn leaves. \
        In the distance, church bells ring to mark the hour, their sounds echoing across the peaceful countryside. \
        A friendly dog barks playfully, chasing butterflies through the meadow.
        """,

        """
        Welcome to this wonderful journey of discovery. Today we explore the fascinating world of technology \
        and innovation. From the smallest microchip to the vast reaches of artificial intelligence, \
        human creativity knows no bounds. Let us embrace these changes with curiosity and wisdom, \
        always remembering that the future is shaped by the choices we make today.
        """,

        """
        The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. \
        How vexingly quick daft zebras jump! The five boxing wizards jump quickly. \
        Sphinx of black quartz, judge my vow. Two driven jocks help fax my big quiz. \
        The job requires extra pluck and zeal from every young wage earner.
        """
    ]

    // MARK: - Singleton

    static let shared = VoiceCloningService()

    // MARK: - Properties

    private var baseURL: URL?
    private var userId: String?

    /// Key for storing cloned voices in UserDefaults
    private let clonedVoicesKey = "com.listenai.clonedVoices"

    // MARK: - Initialization

    private init() {}

    // MARK: - Configuration

    /// Configure the voice cloning service with backend URL.
    func configure(baseURL: URL, userId: String? = nil) {
        self.baseURL = baseURL
        self.userId = userId
    }

    /// Check if the service is configured
    var isConfigured: Bool {
        baseURL != nil
    }

    // MARK: - Public Methods

    /// Create an instant voice clone from an audio sample.
    ///
    /// - Parameters:
    ///   - name: The name for the cloned voice
    ///   - audioSampleURL: URL to the audio file containing the voice sample
    /// - Returns: The created cloned voice result
    func createInstantClone(name: String, audioSampleURL: URL) async throws -> ClonedVoiceResult {
        guard isConfigured else {
            throw VoiceCloningError.notConfigured
        }

        // Validate audio file
        try await validateAudioFile(at: audioSampleURL)

        // Read audio data
        let audioData = try Data(contentsOf: audioSampleURL)

        // Get file extension
        let fileExtension = audioSampleURL.pathExtension.lowercased()

        // Upload and create clone via backend
        let result = try await uploadAndClone(
            name: name,
            audioData: audioData,
            fileExtension: fileExtension
        )

        // Save to local storage
        let clonedVoice = ClonedVoice(
            id: result.voiceId,
            name: result.name,
            status: .completed,
            createdAt: Date(),
            labels: nil
        )
        saveClonedVoiceLocally(clonedVoice)

        return result
    }

    /// List all cloned voices for the current user (from local storage).
    func listClonedVoices(forceRefresh: Bool = false) async throws -> [ClonedVoice] {
        // Load from local storage - no network call needed
        return loadClonedVoicesFromLocal()
    }

    /// Delete a cloned voice.
    func deleteClonedVoice(_ voiceId: String) async throws {
        guard isConfigured else {
            throw VoiceCloningError.notConfigured
        }

        // Delete from ElevenLabs
        try await deleteVoice(voiceId: voiceId)

        // Remove from local storage
        removeClonedVoiceLocally(voiceId)
    }

    /// Preview a cloned voice by synthesizing a short sample.
    func previewClonedVoice(_ voiceId: String, text: String = "Hello, this is a preview of your cloned voice.") async throws -> URL {
        guard isConfigured else {
            throw VoiceCloningError.notConfigured
        }

        return try await synthesizePreview(voiceId: voiceId, text: text)
    }

    /// Get a random sample text for voice recording.
    func getRandomSampleText() -> String {
        Self.sampleTexts.randomElement() ?? Self.sampleTexts[0]
    }

    // MARK: - Private Methods

    private func validateAudioFile(at url: URL) async throws {
        // Check file extension
        let ext = url.pathExtension.lowercased()
        guard Self.supportedFormats.contains(ext) else {
            throw VoiceCloningError.invalidAudioFormat
        }

        // Check file exists
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw VoiceCloningError.uploadFailed("Audio file not found")
        }

        // Get audio duration
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let durationSeconds = CMTimeGetSeconds(duration)

        if durationSeconds < Self.minimumAudioDuration {
            throw VoiceCloningError.audioFileTooShort(minimumSeconds: Int(Self.minimumAudioDuration))
        }

        if durationSeconds > Self.maximumAudioDuration {
            throw VoiceCloningError.audioFileTooLong(maximumSeconds: Int(Self.maximumAudioDuration))
        }
    }

    private func uploadAndClone(
        name: String,
        audioData: Data,
        fileExtension: String
    ) async throws -> ClonedVoiceResult {
        // Create multipart form data request to backend
        let boundary = UUID().uuidString

        var request = try createRequest(
            endpoint: "/api/voice-clone",
            method: "POST"
        )

        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        // Build multipart body
        var body = Data()

        // Add name field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"name\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(name)\r\n".data(using: .utf8)!)

        // Add user_id field if available
        if let userId = userId {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"user_id\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(userId)\r\n".data(using: .utf8)!)
        }

        // Add audio file
        let mimeType = mimeTypeForExtension(fileExtension)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"sample.\(fileExtension)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(audioData)
        body.append("\r\n".data(using: .utf8)!)

        // Close boundary
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        // Send request
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        switch httpResponse.statusCode {
        case 200, 201:
            // Debug: print raw response
            if let jsonString = String(data: data, encoding: .utf8) {
                print("Voice clone response: \(jsonString)")
            }

            do {
                let result = try JSONDecoder().decode(CloneResponse.self, from: data)
                return ClonedVoiceResult(
                    voiceId: result.voiceId,
                    name: result.name,
                    status: .completed,
                    createdAt: Date(),
                    previewUrl: result.previewUrl
                )
            } catch {
                print("JSON decode error: \(error)")
                // Try to provide more detail
                if let jsonString = String(data: data, encoding: .utf8) {
                    print("Raw response was: \(jsonString)")
                }
                throw VoiceCloningError.cloningFailed("Failed to parse response: \(error.localizedDescription)")
            }

        case 401:
            throw VoiceCloningError.unauthorized

        case 400:
            if let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw VoiceCloningError.cloningFailed(errorResponse.error)
            }
            throw VoiceCloningError.cloningFailed("Invalid request")

        default:
            if let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw VoiceCloningError.cloningFailed(errorResponse.error)
            }
            throw VoiceCloningError.networkError("Status code: \(httpResponse.statusCode)")
        }
    }

    // MARK: - Local Storage

    /// Load cloned voices from local storage
    private func loadClonedVoicesFromLocal() -> [ClonedVoice] {
        guard let data = UserDefaults.standard.data(forKey: clonedVoicesKey) else {
            return []
        }

        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode([ClonedVoice].self, from: data)
        } catch {
            print("Failed to decode cloned voices: \(error)")
            return []
        }
    }

    /// Save a cloned voice to local storage
    private func saveClonedVoiceLocally(_ voice: ClonedVoice) {
        var voices = loadClonedVoicesFromLocal()
        // Remove existing voice with same ID if any
        voices.removeAll { $0.id == voice.id }
        voices.insert(voice, at: 0) // Add new voice at the beginning

        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(voices)
            UserDefaults.standard.set(data, forKey: clonedVoicesKey)
        } catch {
            print("Failed to save cloned voice: \(error)")
        }
    }

    /// Remove a cloned voice from local storage
    private func removeClonedVoiceLocally(_ voiceId: String) {
        var voices = loadClonedVoicesFromLocal()
        voices.removeAll { $0.id == voiceId }

        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(voices)
            UserDefaults.standard.set(data, forKey: clonedVoicesKey)
        } catch {
            print("Failed to remove cloned voice: \(error)")
        }
    }

    // MARK: - Network Helpers

    private func deleteVoice(voiceId: String) async throws {
        var endpoint = "/api/voice-clone/\(voiceId)"
        if let userId = userId {
            endpoint += "?user_id=\(userId)"
        }
        let request = try createRequest(
            endpoint: endpoint,
            method: "DELETE"
        )

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        switch httpResponse.statusCode {
        case 200, 204:
            return

        case 401:
            throw VoiceCloningError.unauthorized

        case 404:
            throw VoiceCloningError.voiceNotFound

        default:
            if let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw VoiceCloningError.cloningFailed(errorResponse.error)
            }
            throw VoiceCloningError.networkError("Status code: \(httpResponse.statusCode)")
        }
    }

    private func synthesizePreview(voiceId: String, text: String) async throws -> URL {
        var request = try createRequest(
            endpoint: "/api/voice-clone/\(voiceId)/preview",
            method: "POST"
        )

        let body = PreviewRequestBody(text: text, userId: userId)
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            if httpResponse.statusCode == 401 {
                throw VoiceCloningError.unauthorized
            }
            throw VoiceCloningError.networkError("Status code: \(httpResponse.statusCode)")
        }

        // Save audio data to temp file
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("preview_\(voiceId)_\(UUID().uuidString).mp3")

        try data.write(to: tempURL)

        return tempURL
    }

    private func mimeTypeForExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "mp3":
            return "audio/mpeg"
        case "m4a", "aac":
            return "audio/mp4"
        case "wav":
            return "audio/wav"
        case "mp4":
            return "audio/mp4"
        default:
            return "application/octet-stream"
        }
    }

    /// Create a request for voice cloning endpoints.
    private func createRequest(endpoint: String, method: String) throws -> URLRequest {
        guard let baseURL = baseURL else {
            throw VoiceCloningError.notConfigured
        }

        // Build URL string properly to avoid encoding issues with appendingPathComponent
        var urlString = baseURL.absoluteString
        if urlString.hasSuffix("/") {
            urlString.removeLast()
        }
        if !endpoint.hasPrefix("/") {
            urlString += "/"
        }
        urlString += endpoint

        guard let url = URL(string: urlString) else {
            throw VoiceCloningError.networkError("Invalid URL: \(urlString)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 60

        return request
    }

    // MARK: - Response Types

    private struct CloneResponse: Codable {
        let voiceId: String
        let name: String
        let previewUrl: String?

        enum CodingKeys: String, CodingKey {
            case voiceId = "voice_id"
            case name
            case previewUrl = "preview_url"
        }
    }

    private struct ErrorResponse: Codable {
        let error: String
    }

    private struct PreviewRequestBody: Codable {
        let text: String
        let userId: String?

        enum CodingKeys: String, CodingKey {
            case text
            case userId = "user_id"
        }
    }
}

