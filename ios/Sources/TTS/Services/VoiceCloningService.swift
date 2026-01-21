import Foundation
import AVFoundation
import UIKit

// MARK: - Voice Cloning Service

/// Service for creating and managing cloned voices using Chatterbox TTS.
/// Voices are stored in Supabase Storage and can be used with the GPU TTS service.
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
        let description: String?
        let durationSec: Double?
        let exaggeration: Double?
        let isDefault: Bool?
        let usageCount: Int?
        let createdAt: Date?
        let audioUrl: String?

        // Legacy fields from old ElevenLabs-based implementation
        let status: CloningStatus?
        let labels: [String: String]?

        var isReady: Bool {
            durationSec != nil && durationSec! > 0
        }

        enum CodingKeys: String, CodingKey {
            case id
            case name
            case description
            case durationSec = "duration_sec"
            case exaggeration
            case isDefault = "is_default"
            case usageCount = "usage_count"
            case createdAt = "created_at"
            case audioUrl = "audio_url"
            case status
            case labels
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
    /// Chatterbox can work with shorter samples than ElevenLabs
    static let minimumAudioDuration: TimeInterval = 5

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

    /// Key for storing cloned voices in UserDefaults (local cache)
    private let clonedVoicesKey = "com.listenai.clonedVoices"

    // MARK: - Initialization

    private init() {}

    // MARK: - Configuration

    /// Configure the voice cloning service with backend URL.
    /// Authentication uses device ID header instead of user auth tokens.
    func configure(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Check if the service is configured
    var isConfigured: Bool {
        baseURL != nil
    }

    // MARK: - Public Methods

    /// Create an instant voice clone from an audio sample.
    ///
    /// Flow:
    /// 1. Create voice record in backend, get signed upload URL
    /// 2. Upload audio directly to Supabase Storage
    /// 3. Confirm upload with audio metadata
    ///
    /// - Parameters:
    ///   - name: The name for the cloned voice
    ///   - audioSampleURL: URL to the audio file containing the voice sample
    ///   - description: Optional description for the voice
    ///   - exaggeration: Emotion/style exaggeration (0.0-1.0, default 0.5)
    /// - Returns: The created cloned voice result
    func createInstantClone(
        name: String,
        audioSampleURL: URL,
        description: String? = nil,
        exaggeration: Double = 0.5
    ) async throws -> ClonedVoiceResult {
        guard isConfigured else {
            throw VoiceCloningError.notConfigured
        }

        // Validate audio file
        let (durationSec, fileSizeBytes) = try await validateAudioFile(at: audioSampleURL)

        // Read audio data
        let audioData = try Data(contentsOf: audioSampleURL)

        // Step 1: Create voice record and get upload URL
        let createResponse = try await createVoiceRecord(
            name: name,
            description: description,
            exaggeration: exaggeration
        )

        // Step 2: Upload audio to Supabase Storage
        try await uploadAudioToStorage(
            audioData: audioData,
            uploadUrl: createResponse.uploadUrl
        )

        // Step 3: Confirm upload with metadata
        let voice = try await confirmVoiceUpload(
            voiceId: createResponse.id,
            durationSec: durationSec,
            fileSizeBytes: fileSizeBytes
        )

        // Save to local cache
        saveClonedVoiceLocally(voice)

        return ClonedVoiceResult(
            voiceId: voice.id,
            name: voice.name,
            status: .completed,
            createdAt: voice.createdAt,
            previewUrl: voice.audioUrl
        )
    }

    /// List all cloned voices for the current user.
    /// Fetches from backend and updates local cache.
    func listClonedVoices(forceRefresh: Bool = false) async throws -> [ClonedVoice] {
        guard isConfigured else {
            // Return local cache if not configured
            return loadClonedVoicesFromLocal()
        }

        if !forceRefresh {
            // Return local cache first, refresh in background
            let cached = loadClonedVoicesFromLocal()
            if !cached.isEmpty {
                // Refresh in background
                Task {
                    try? await fetchAndCacheVoices()
                }
                return cached
            }
        }

        return try await fetchAndCacheVoices()
    }

    /// Fetch voices from backend and update local cache
    private func fetchAndCacheVoices() async throws -> [ClonedVoice] {
        var request = try await createRequest(
            endpoint: "/api/cloned-voices?include_audio_urls=true",
            method: "GET"
        )

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

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let listResponse = try decoder.decode(VoicesListResponse.self, from: data)

        // Update local cache
        saveClonedVoicesToLocal(listResponse.voices)

        return listResponse.voices
    }

    /// Delete a cloned voice.
    func deleteClonedVoice(_ voiceId: String) async throws {
        guard isConfigured else {
            throw VoiceCloningError.notConfigured
        }

        let request = try await createRequest(
            endpoint: "/api/cloned-voices/\(voiceId)",
            method: "DELETE"
        )

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        switch httpResponse.statusCode {
        case 200, 204:
            // Remove from local cache
            removeClonedVoiceLocally(voiceId)
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

    /// Update a cloned voice (name, description, exaggeration, or set as default)
    func updateClonedVoice(
        _ voiceId: String,
        name: String? = nil,
        description: String? = nil,
        exaggeration: Double? = nil,
        isDefault: Bool? = nil
    ) async throws -> ClonedVoice {
        guard isConfigured else {
            throw VoiceCloningError.notConfigured
        }

        var request = try await createRequest(
            endpoint: "/api/cloned-voices/\(voiceId)",
            method: "PATCH"
        )

        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var updates: [String: Any] = [:]
        if let name = name { updates["name"] = name }
        if let description = description { updates["description"] = description }
        if let exaggeration = exaggeration { updates["exaggeration"] = exaggeration }
        if let isDefault = isDefault { updates["is_default"] = isDefault }

        request.httpBody = try JSONSerialization.data(withJSONObject: updates)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            if httpResponse.statusCode == 401 {
                throw VoiceCloningError.unauthorized
            }
            if httpResponse.statusCode == 404 {
                throw VoiceCloningError.voiceNotFound
            }
            throw VoiceCloningError.networkError("Status code: \(httpResponse.statusCode)")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let voice = try decoder.decode(ClonedVoice.self, from: data)

        // Update local cache
        updateClonedVoiceLocally(voice)

        return voice
    }

    /// Get a random sample text for voice recording.
    func getRandomSampleText() -> String {
        Self.sampleTexts.randomElement() ?? Self.sampleTexts[0]
    }

    /// Preview a cloned voice by playing its reference audio.
    /// Returns the URL to the audio file (downloaded to temp directory).
    func previewClonedVoice(_ voiceId: String) async throws -> URL {
        guard isConfigured else {
            throw VoiceCloningError.notConfigured
        }

        // Get the voice details with audio URL
        let request = try await createRequest(
            endpoint: "/api/cloned-voices/\(voiceId)",
            method: "GET"
        )

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            if httpResponse.statusCode == 401 {
                throw VoiceCloningError.unauthorized
            }
            if httpResponse.statusCode == 404 {
                throw VoiceCloningError.voiceNotFound
            }
            throw VoiceCloningError.networkError("Status code: \(httpResponse.statusCode)")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let voice = try decoder.decode(ClonedVoice.self, from: data)

        guard let audioUrlString = voice.audioUrl, let audioUrl = URL(string: audioUrlString) else {
            throw VoiceCloningError.voiceNotFound
        }

        // Download the audio to a temp file
        let (audioData, _) = try await URLSession.shared.data(from: audioUrl)

        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("preview_\(voiceId)_\(UUID().uuidString).wav")

        try audioData.write(to: tempURL)

        return tempURL
    }

    // MARK: - Private Methods - API Calls

    /// Step 1: Create voice record in backend
    private func createVoiceRecord(
        name: String,
        description: String?,
        exaggeration: Double
    ) async throws -> CreateVoiceResponse {
        var request = try await createRequest(
            endpoint: "/api/cloned-voices",
            method: "POST"
        )

        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "name": name,
            "exaggeration": exaggeration
        ]
        if let description = description {
            body["description"] = description
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        switch httpResponse.statusCode {
        case 200, 201:
            return try JSONDecoder().decode(CreateVoiceResponse.self, from: data)

        case 401:
            throw VoiceCloningError.unauthorized

        default:
            if let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw VoiceCloningError.cloningFailed(errorResponse.error)
            }
            throw VoiceCloningError.networkError("Status code: \(httpResponse.statusCode)")
        }
    }

    /// Step 2: Upload audio directly to Supabase Storage via signed URL
    private func uploadAudioToStorage(audioData: Data, uploadUrl: String) async throws {
        guard let url = URL(string: uploadUrl) else {
            throw VoiceCloningError.uploadFailed("Invalid upload URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.httpBody = audioData
        request.timeoutInterval = 120 // 2 minutes for upload

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.uploadFailed("Invalid response")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw VoiceCloningError.uploadFailed("Status code: \(httpResponse.statusCode)")
        }
    }

    /// Step 3: Confirm upload with metadata
    private func confirmVoiceUpload(
        voiceId: String,
        durationSec: Double,
        fileSizeBytes: Int
    ) async throws -> ClonedVoice {
        var request = try await createRequest(
            endpoint: "/api/cloned-voices/\(voiceId)/confirm",
            method: "POST"
        )

        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "duration_sec": durationSec,
            "file_size_bytes": fileSizeBytes
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceCloningError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            if httpResponse.statusCode == 401 {
                throw VoiceCloningError.unauthorized
            }
            throw VoiceCloningError.uploadFailed("Status code: \(httpResponse.statusCode)")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        return try decoder.decode(ClonedVoice.self, from: data)
    }

    // MARK: - Private Methods - Validation

    private func validateAudioFile(at url: URL) async throws -> (durationSec: Double, fileSizeBytes: Int) {
        // Check file extension
        let ext = url.pathExtension.lowercased()
        guard Self.supportedFormats.contains(ext) else {
            throw VoiceCloningError.invalidAudioFormat
        }

        // Check file exists
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw VoiceCloningError.uploadFailed("Audio file not found")
        }

        // Get file size
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let fileSizeBytes = (attributes[.size] as? Int) ?? 0

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

        return (durationSec: durationSeconds, fileSizeBytes: fileSizeBytes)
    }

    // MARK: - Local Storage

    /// Load cloned voices from local cache
    private func loadClonedVoicesFromLocal() -> [ClonedVoice] {
        guard let data = UserDefaults.standard.data(forKey: clonedVoicesKey) else {
            return []
        }

        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode([ClonedVoice].self, from: data)
        } catch {
            print("Failed to decode cloned voices: \(error). Clearing cache.")
            // Clear corrupted cache data
            UserDefaults.standard.removeObject(forKey: clonedVoicesKey)
            return []
        }
    }

    /// Save cloned voices to local cache
    private func saveClonedVoicesToLocal(_ voices: [ClonedVoice]) {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(voices)
            UserDefaults.standard.set(data, forKey: clonedVoicesKey)
        } catch {
            print("Failed to save cloned voices: \(error)")
        }
    }

    /// Save a single cloned voice to local cache
    private func saveClonedVoiceLocally(_ voice: ClonedVoice) {
        var voices = loadClonedVoicesFromLocal()
        // Remove existing voice with same ID if any
        voices.removeAll { $0.id == voice.id }
        voices.insert(voice, at: 0) // Add new voice at the beginning
        saveClonedVoicesToLocal(voices)
    }

    /// Update a cloned voice in local cache
    private func updateClonedVoiceLocally(_ voice: ClonedVoice) {
        var voices = loadClonedVoicesFromLocal()
        if let index = voices.firstIndex(where: { $0.id == voice.id }) {
            voices[index] = voice
        } else {
            voices.insert(voice, at: 0)
        }
        saveClonedVoicesToLocal(voices)
    }

    /// Remove a cloned voice from local cache
    private func removeClonedVoiceLocally(_ voiceId: String) {
        var voices = loadClonedVoicesFromLocal()
        voices.removeAll { $0.id == voiceId }
        saveClonedVoicesToLocal(voices)
    }

    // MARK: - Network Helpers

    /// Get a stable device identifier for this device.
    /// Uses identifierForVendor which persists across app reinstalls on the same device.
    private func getDeviceId() -> String {
        // Try to get cached device ID first
        if let cachedId = UserDefaults.standard.string(forKey: "com.listenai.deviceId"), !cachedId.isEmpty {
            return cachedId
        }

        // Generate or retrieve device ID
        let deviceId: String
        if let vendorId = UIDevice.current.identifierForVendor?.uuidString {
            deviceId = vendorId
        } else {
            // Fallback: generate a UUID and persist it
            deviceId = UUID().uuidString
        }

        // Cache the device ID
        UserDefaults.standard.set(deviceId, forKey: "com.listenai.deviceId")
        return deviceId
    }

    /// Create a request for the backend with device ID header.
    private func createRequest(endpoint: String, method: String) async throws -> URLRequest {
        guard let baseURL = baseURL else {
            throw VoiceCloningError.notConfigured
        }

        // Build URL string properly to avoid encoding issues
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

        // Add device ID header (required by backend)
        request.setValue(getDeviceId(), forHTTPHeaderField: "X-Device-ID")

        return request
    }

    // MARK: - Response Types

    private struct CreateVoiceResponse: Codable {
        let id: String
        let name: String
        let uploadUrl: String
        let expiresAt: String

        enum CodingKeys: String, CodingKey {
            case id
            case name
            case uploadUrl = "upload_url"
            case expiresAt = "expires_at"
        }
    }

    private struct VoicesListResponse: Codable {
        let voices: [ClonedVoice]
    }

    private struct ErrorResponse: Codable {
        let error: String
    }
}
