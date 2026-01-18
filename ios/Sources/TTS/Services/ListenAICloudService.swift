import Foundation

// MARK: - Debug Configuration

/// Debug flags for testing - REMOVE BEFORE PRODUCTION
enum ListenAIDebugConfig {
    /// Set to true to bypass quota checks during testing
    /// The backend must also have ALLOW_QUOTA_BYPASS=true for this to work
    /// TODO: Remove this flag before App Store release
    static let bypassQuotaForTesting = true
}

// MARK: - ListenAI Cloud Service Configuration

/// Configuration for connecting to the ListenAI Cloud Run backend.
struct ListenAICloudConfiguration: Sendable {
    /// Base URL for the Cloud Run backend (e.g., "https://listenai-backend-xxxx.run.app")
    let baseURL: URL

    /// Closure that provides the current Supabase JWT token
    let authTokenProvider: @Sendable () async throws -> String

    /// Request timeout in seconds
    var timeoutInterval: TimeInterval = 30

    /// Number of retry attempts for failed requests
    var retryCount: Int = 3

    /// Delay between retry attempts
    var retryDelay: TimeInterval = 1.0

    init(
        baseURL: URL,
        authTokenProvider: @escaping @Sendable () async throws -> String,
        timeoutInterval: TimeInterval = 30,
        retryCount: Int = 3,
        retryDelay: TimeInterval = 1.0
    ) {
        self.baseURL = baseURL
        self.authTokenProvider = authTokenProvider
        self.timeoutInterval = timeoutInterval
        self.retryCount = retryCount
        self.retryDelay = retryDelay
    }
}

// MARK: - Response Types

/// Simplified usage info returned from GET /api/usage
struct UsageInfo: Codable, Sendable {
    let currentMonth: String
    let charUsed: Int
    let charLimit: Int

    enum CodingKeys: String, CodingKey {
        case currentMonth = "current_month"
        case charUsed = "char_used"
        case charLimit = "char_limit"
    }

    var remainingCharacters: Int {
        max(0, charLimit - charUsed)
    }

    var usagePercentage: Double {
        guard charLimit > 0 else { return 0 }
        return Double(charUsed) / Double(charLimit) * 100
    }

    var isQuotaExceeded: Bool {
        charUsed >= charLimit
    }
}

/// Voice info returned from GET /api/voices
struct VoiceListItem: Codable, Sendable, Identifiable {
    let id: String
    let name: String
    let isPremium: Bool
    let hint: String

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case isPremium = "is_premium"
        case hint
    }
}

/// Response wrapper for voices endpoint
struct VoiceListResponse: Codable, Sendable {
    let voices: [VoiceListItem]
}

/// Audio data result from TTS synthesis
struct AudioData: Sendable {
    /// The audio data (MP3 format)
    let data: Data

    /// Audio format (typically "mp3")
    let format: String

    /// Estimated duration in milliseconds
    let durationMs: Int?

    /// Characters used for this synthesis
    let charactersUsed: Int

    /// File URL if saved to temp directory
    var fileURL: URL?

    init(data: Data, format: String = "mp3", durationMs: Int? = nil, charactersUsed: Int = 0, fileURL: URL? = nil) {
        self.data = data
        self.format = format
        self.durationMs = durationMs
        self.charactersUsed = charactersUsed
        self.fileURL = fileURL
    }

    /// Duration in seconds
    var duration: TimeInterval? {
        guard let ms = durationMs else { return nil }
        return TimeInterval(ms) / 1000.0
    }

    /// Save audio data to a temporary file and return the URL
    func saveToTempFile() throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "listenai_audio_\(UUID().uuidString).\(format)"
        let fileURL = tempDir.appendingPathComponent(fileName)
        try data.write(to: fileURL)
        return fileURL
    }
}

// MARK: - ListenAI Cloud Service Errors

enum ListenAICloudError: LocalizedError, Sendable {
    case unauthorized
    case quotaExceeded(used: Int, limit: Int)
    case voiceNotFound(voiceId: String)
    case tierRequired(required: String, current: String)
    case rateLimited(retryAfter: TimeInterval)
    case networkError(underlying: String)
    case serverError(statusCode: Int, message: String)
    case invalidResponse
    case noAuthToken

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Authentication required. Please sign in."
        case .quotaExceeded(let used, let limit):
            return "Quota exceeded. Used \(used) of \(limit) characters this month."
        case .voiceNotFound(let voiceId):
            return "Voice not found: \(voiceId)"
        case .tierRequired(let required, let current):
            return "This voice requires \(required) tier. Current tier: \(current)"
        case .rateLimited(let retryAfter):
            return "Rate limited. Try again in \(Int(retryAfter)) seconds."
        case .networkError(let underlying):
            return "Network error: \(underlying)"
        case .serverError(let statusCode, let message):
            return "Server error (\(statusCode)): \(message)"
        case .invalidResponse:
            return "Invalid response from server"
        case .noAuthToken:
            return "No authentication token available"
        }
    }
}

// MARK: - ListenAI Cloud Service

/// TTS service that connects to the ListenAI Cloud Run backend.
/// Handles authentication, quota management, and audio synthesis via the backend API.
actor ListenAICloudService {

    // MARK: - Properties

    private let configuration: ListenAICloudConfiguration
    private let urlSession: URLSession
    private var cachedUsage: UsageInfo?
    private var usageCacheTime: Date?
    private let usageCacheDuration: TimeInterval = 60 // Cache usage for 60 seconds

    // MARK: - Initialization

    init(configuration: ListenAICloudConfiguration) {
        self.configuration = configuration

        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = configuration.timeoutInterval
        sessionConfig.waitsForConnectivity = true
        self.urlSession = URLSession(configuration: sessionConfig)
    }

    /// Convenience initializer with base URL and auth token provider
    init(
        baseURL: URL,
        authTokenProvider: @escaping @Sendable () async throws -> String
    ) {
        self.init(configuration: ListenAICloudConfiguration(
            baseURL: baseURL,
            authTokenProvider: authTokenProvider
        ))
    }

    // MARK: - Public API

    /// Base URL for the backend - exposed for streaming service
    var baseURL: URL {
        configuration.baseURL
    }

    /// TTS provider enum matching backend schema
    enum TTSProvider: String, Sendable {
        case selfhosted = "selfhosted"
        case elevenlabs = "elevenlabs"
    }

    /// Synthesize text to audio using the Cloud Run backend.
    ///
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - voiceId: The provider-specific voice ID (Kokoro ID like 'am_adam' or ElevenLabs ID)
    ///   - provider: The TTS provider to use (.selfhosted for Kokoro, .elevenlabs for ElevenLabs)
    ///   - speed: Playback speed multiplier (0.5 - 3.0, default 1.0)
    /// - Returns: AudioData containing the synthesized audio
    /// - Throws: ListenAICloudError if synthesis fails
    func synthesize(
        text: String,
        voiceId: String,
        provider: TTSProvider = .selfhosted,
        speed: Double = 1.0
    ) async throws -> AudioData {
        let token = try await getAuthToken()

        // Build request
        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("tts")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")

        let body: [String: Any] = [
            "text": text,
            "voice_id": voiceId,
            "provider": provider.rawValue,
            "options": ["speed": speed]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        // Execute with retry
        return try await executeWithRetry(request: request) { data, response in
            guard let httpResponse = response as? HTTPURLResponse else {
                throw ListenAICloudError.invalidResponse
            }

            // Parse usage headers
            let charactersUsed = Int(httpResponse.value(forHTTPHeaderField: "X-Characters-Used") ?? "0") ?? text.count
            let durationMs = Int(httpResponse.value(forHTTPHeaderField: "X-Audio-Duration-Ms") ?? "0")

            // Update cached usage from headers
            if let dailyUsed = httpResponse.value(forHTTPHeaderField: "X-Monthly-Used"),
               let dailyLimit = httpResponse.value(forHTTPHeaderField: "X-Monthly-Limit") {
                await self.updateCachedUsage(
                    charUsed: Int(dailyUsed) ?? 0,
                    charLimit: Int(dailyLimit) ?? 0
                )
            }

            // Detect actual audio format from Content-Type header
            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type")
            let audioFormat = self.detectAudioFormat(from: contentType)

            // Debug: Log audio data details
            print("[ListenAI] Received audio data: \(data.count) bytes, Content-Type: \(contentType ?? "unknown")")
            if data.count >= 50 {
                let headerBytes = data.prefix(50)
                let headerHex = headerBytes.map { String(format: "%02x", $0) }.joined(separator: " ")
                print("[ListenAI] First 50 bytes (hex): \(headerHex)")

                // Check if it's a valid WAV
                if data.count > 44 {
                    let riffHeader = String(data: data.prefix(4), encoding: .ascii)
                    print("[ListenAI] RIFF header: \(riffHeader ?? "invalid")")

                    // Sample some audio bytes after header
                    let audioSample = data[44..<min(64, data.count)]
                    let sampleHex = audioSample.map { String(format: "%02x", $0) }.joined(separator: " ")
                    print("[ListenAI] Audio sample bytes (44-64): \(sampleHex)")
                }
            }

            // Save to temp file with correct extension
            let tempURL = try self.saveTempAudio(data: data, format: audioFormat)

            return AudioData(
                data: data,
                format: audioFormat,
                durationMs: durationMs,
                charactersUsed: charactersUsed,
                fileURL: tempURL
            )
        }
    }

    /// Fetch current usage quota from the backend.
    ///
    /// - Returns: UsageInfo with current month's usage stats
    /// - Throws: ListenAICloudError if fetch fails
    func fetchUsage() async throws -> UsageInfo {
        // Return cached if fresh
        if let cached = cachedUsage,
           let cacheTime = usageCacheTime,
           Date().timeIntervalSince(cacheTime) < usageCacheDuration {
            return cached
        }

        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("usage")

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        return try await executeWithRetry(request: request) { data, response in
            let usage = try JSONDecoder().decode(UsageInfo.self, from: data)

            // Cache the result
            await self.setCachedUsage(usage)

            return usage
        }
    }

    /// Fetch available voices from the backend.
    /// This endpoint is public and doesn't require authentication.
    ///
    /// - Returns: Array of available voices
    /// - Throws: ListenAICloudError if fetch fails
    func fetchVoices() async throws -> [VoiceListItem] {
        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("voices")

        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        return try await executeWithRetry(request: request) { data, _ in
            let response = try JSONDecoder().decode(VoiceListResponse.self, from: data)
            return response.voices
        }
    }

    /// Preview a voice without charging quota.
    ///
    /// - Parameters:
    ///   - voiceId: The provider-specific voice ID
    ///   - provider: The TTS provider to use
    ///   - text: Optional preview text (uses default if not provided)
    /// - Returns: AudioData containing the preview audio
    func previewVoice(
        voiceId: String,
        provider: TTSProvider = .selfhosted,
        text: String? = nil
    ) async throws -> AudioData {
        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("tts")
            .appendingPathComponent("preview")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "voice_id": voiceId,
            "provider": provider.rawValue
        ]
        if let text = text {
            body["text"] = text
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await executeWithRetry(request: request) { data, response in
            guard let httpResponse = response as? HTTPURLResponse else {
                throw ListenAICloudError.invalidResponse
            }

            // Detect actual audio format from Content-Type header
            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type")
            let audioFormat = self.detectAudioFormat(from: contentType)

            let tempURL = try self.saveTempAudio(data: data, format: audioFormat)
            return AudioData(
                data: data,
                format: audioFormat,
                durationMs: nil,
                charactersUsed: 0,
                fileURL: tempURL
            )
        }
    }

    /// Get an estimate for synthesizing text without actually synthesizing.
    ///
    /// - Parameters:
    ///   - textLength: Number of characters to estimate
    ///   - voiceId: The provider-specific voice ID
    ///   - provider: The TTS provider to use
    ///   - speed: Playback speed multiplier
    /// - Returns: Dictionary with estimate info including whether quota allows synthesis
    func estimate(
        textLength: Int,
        voiceId: String,
        provider: TTSProvider = .selfhosted,
        speed: Double = 1.0
    ) async throws -> [String: Any] {
        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("tts")
            .appendingPathComponent("estimate")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "text_length": textLength,
            "voice_id": voiceId,
            "provider": provider.rawValue,
            "speed": speed
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await executeWithRetry(request: request) { data, _ in
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw ListenAICloudError.invalidResponse
            }
            return json
        }
    }

    /// Clear the usage cache to force a fresh fetch
    func clearUsageCache() {
        cachedUsage = nil
        usageCacheTime = nil
    }

    /// Fetch full usage details including subscription info from the backend.
    ///
    /// - Returns: FullUsageResponse with subscription and usage details
    /// - Throws: ListenAICloudError if fetch fails
    func fetchFullUsage() async throws -> FullUsageResponse {
        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("usage")
            .appendingPathComponent("full")

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        return try await executeWithRetry(request: request) { data, _ in
            let response = try JSONDecoder().decode(FullUsageResponse.self, from: data)
            return response
        }
    }

    /// Sync a StoreKit subscription purchase with the backend.
    ///
    /// - Parameters:
    ///   - productId: The App Store product identifier
    ///   - transactionId: The transaction ID
    ///   - originalTransactionId: The original transaction ID (for renewals)
    ///   - purchaseDate: When the purchase was made
    ///   - expiresDate: When the subscription expires (optional)
    ///   - isTrialPeriod: Whether this is a trial period
    ///   - cancellationDate: When cancelled (optional)
    /// - Returns: SubscriptionSyncResponse with updated subscription info
    /// - Throws: ListenAICloudError if sync fails
    func syncSubscription(
        productId: String,
        transactionId: String,
        originalTransactionId: String,
        purchaseDate: Date,
        expiresDate: Date?,
        isTrialPeriod: Bool = false,
        cancellationDate: Date? = nil
    ) async throws -> SubscriptionSyncResponse {
        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("subscription")
            .appendingPathComponent("sync")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let dateFormatter = ISO8601DateFormatter()

        var body: [String: Any] = [
            "product_id": productId,
            "transaction_id": transactionId,
            "original_transaction_id": originalTransactionId,
            "purchase_date": dateFormatter.string(from: purchaseDate),
            "is_trial_period": isTrialPeriod
        ]

        if let expiresDate = expiresDate {
            body["expires_date"] = dateFormatter.string(from: expiresDate)
        }

        if let cancellationDate = cancellationDate {
            body["cancellation_date"] = dateFormatter.string(from: cancellationDate)
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await executeWithRetry(request: request) { data, _ in
            let response = try JSONDecoder().decode(SubscriptionSyncResponse.self, from: data)
            return response
        }
    }

    // MARK: - Auth Methods

    /// Get auth token - exposed for streaming service
    func getAuthToken() async throws -> String {
        do {
            return try await configuration.authTokenProvider()
        } catch {
            throw ListenAICloudError.noAuthToken
        }
    }

    // MARK: - Private Methods

    private func setCachedUsage(_ usage: UsageInfo) {
        cachedUsage = usage
        usageCacheTime = Date()
    }

    private func updateCachedUsage(charUsed: Int, charLimit: Int) {
        let currentMonth = ISO8601DateFormatter().string(from: Date()).prefix(7)
        cachedUsage = UsageInfo(
            currentMonth: String(currentMonth),
            charUsed: charUsed,
            charLimit: charLimit
        )
        usageCacheTime = Date()
    }

    private nonisolated func saveTempAudio(data: Data, format: String = "wav") throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let ext = format == "mp3" ? "mp3" : "wav"
        let fileName = "listenai_\(UUID().uuidString).\(ext)"
        let fileURL = tempDir.appendingPathComponent(fileName)
        try data.write(to: fileURL)
        return fileURL
    }

    /// Detect audio format from Content-Type header
    private nonisolated func detectAudioFormat(from contentType: String?) -> String {
        guard let contentType = contentType?.lowercased() else { return "wav" }
        if contentType.contains("mpeg") || contentType.contains("mp3") {
            return "mp3"
        }
        return "wav"
    }

    private func executeWithRetry<T>(
        request: URLRequest,
        handler: @Sendable (Data, URLResponse) async throws -> T
    ) async throws -> T {
        var lastError: Error = ListenAICloudError.networkError(underlying: "Unknown error")

        for attempt in 0..<configuration.retryCount {
            do {
                let (data, response) = try await urlSession.data(for: request)

                guard let httpResponse = response as? HTTPURLResponse else {
                    throw ListenAICloudError.invalidResponse
                }

                // Handle HTTP status codes
                switch httpResponse.statusCode {
                case 200...299:
                    return try await handler(data, response)

                case 401:
                    throw ListenAICloudError.unauthorized

                case 402:
                    // Quota exceeded - parse response for details
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let quotaDetails = json["quota"] as? [String: Any],
                       let used = quotaDetails["monthly_used"] as? Int,
                       let limit = quotaDetails["monthly_limit"] as? Int {
                        throw ListenAICloudError.quotaExceeded(used: used, limit: limit)
                    }
                    throw ListenAICloudError.quotaExceeded(used: 0, limit: 0)

                case 403:
                    // Tier required - parse response for details
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let required = json["required_tier"] as? String,
                       let current = json["current_tier"] as? String {
                        throw ListenAICloudError.tierRequired(required: required, current: current)
                    }
                    throw ListenAICloudError.tierRequired(required: "premium", current: "free")

                case 404:
                    throw ListenAICloudError.voiceNotFound(voiceId: "unknown")

                case 429:
                    let retryAfter = httpResponse.value(forHTTPHeaderField: "Retry-After")
                        .flatMap { Double($0) } ?? configuration.retryDelay
                    throw ListenAICloudError.rateLimited(retryAfter: retryAfter)

                default:
                    let message = String(data: data, encoding: .utf8) ?? "Unknown error"
                    throw ListenAICloudError.serverError(statusCode: httpResponse.statusCode, message: message)
                }

            } catch let error as ListenAICloudError {
                switch error {
                case .rateLimited(let retryAfter):
                    // Wait and retry for rate limiting
                    try await Task.sleep(nanoseconds: UInt64(retryAfter * 1_000_000_000))
                    lastError = error
                case .unauthorized, .quotaExceeded, .tierRequired:
                    // Don't retry auth/quota errors
                    throw error
                default:
                    lastError = error
                }
            } catch {
                lastError = ListenAICloudError.networkError(underlying: error.localizedDescription)
            }

            // Wait before retry
            if attempt < configuration.retryCount - 1 {
                try await Task.sleep(nanoseconds: UInt64(configuration.retryDelay * 1_000_000_000))
            }
        }

        throw lastError
    }
}

// MARK: - Callback-based API (for compatibility)

extension ListenAICloudService {

    /// Synthesize text to audio using completion handler pattern.
    nonisolated func synthesize(
        text: String,
        voiceId: String,
        provider: TTSProvider = .selfhosted,
        speed: Double = 1.0,
        completion: @escaping @Sendable (Result<AudioData, Error>) -> Void
    ) {
        Task {
            do {
                let audioData = try await self.synthesize(text: text, voiceId: voiceId, provider: provider, speed: speed)
                completion(.success(audioData))
            } catch {
                completion(.failure(error))
            }
        }
    }

    /// Fetch usage using completion handler pattern.
    nonisolated func fetchUsage(
        completion: @escaping @Sendable (Result<UsageInfo, Error>) -> Void
    ) {
        Task {
            do {
                let usage = try await self.fetchUsage()
                completion(.success(usage))
            } catch {
                completion(.failure(error))
            }
        }
    }
}

// MARK: - Latency Tracking

extension ListenAICloudService {

    /// Response from latency estimate endpoint
    struct LatencyEstimateResponse: Codable, Sendable {
        let estimatedSeconds: Int
        let confidence: String  // "high", "medium", "low"
        let bucket: String
        let sampleCount: Int

        enum CodingKeys: String, CodingKey {
            case estimatedSeconds = "estimated_seconds"
            case confidence
            case bucket
            case sampleCount = "sample_count"
        }

        var confidenceLevel: ConfidenceLevel {
            switch confidence {
            case "high": return .high
            case "medium": return .medium
            default: return .low
            }
        }

        enum ConfidenceLevel {
            case high, medium, low
        }
    }

    /// Report latency metric after audio playback starts.
    /// Call this after successfully synthesizing and starting playback.
    ///
    /// - Parameters:
    ///   - textLength: Number of characters in the synthesized text
    ///   - latencyMs: Time in milliseconds from request to first audio play
    ///   - provider: The TTS provider used
    ///   - voiceId: The voice ID used (optional)
    func reportLatency(
        textLength: Int,
        latencyMs: Int,
        provider: TTSProvider = .selfhosted,
        voiceId: String? = nil
    ) async {
        do {
            let token = try await getAuthToken()

            let url = configuration.baseURL
                .appendingPathComponent("api")
                .appendingPathComponent("latency")
                .appendingPathComponent("report")

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            var body: [String: Any] = [
                "text_length": textLength,
                "latency_ms": latencyMs,
                "provider": provider.rawValue
            ]
            if let voiceId = voiceId {
                body["voice_id"] = voiceId
            }

            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (_, response) = try await urlSession.data(for: request)

            if let httpResponse = response as? HTTPURLResponse,
               (200...299).contains(httpResponse.statusCode) {
                print("[Latency] Reported: \(textLength) chars, \(latencyMs)ms")
            }
        } catch {
            // Latency reporting is non-critical, just log and continue
            print("[Latency] Failed to report: \(error.localizedDescription)")
        }
    }

    /// Get estimated processing time for a given text length.
    /// Uses server-side cached metrics for accurate estimates.
    ///
    /// - Parameter textLength: Number of characters in the text to synthesize
    /// - Returns: LatencyEstimateResponse with estimated time and confidence
    func getLatencyEstimate(textLength: Int) async throws -> LatencyEstimateResponse {
        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("latency")
            .appendingPathComponent("estimate")

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "text_length", value: String(textLength))]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"

        // This endpoint doesn't require auth
        let (data, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw ListenAICloudError.invalidResponse
        }

        return try JSONDecoder().decode(LatencyEstimateResponse.self, from: data)
    }

    /// Get estimated processing time with fallback to local calculation.
    /// Returns estimated seconds as a user-friendly string.
    ///
    /// - Parameter textLength: Number of characters in the text to synthesize
    /// - Returns: Estimated time string like "~5 seconds" or "~30 seconds"
    func getEstimatedTimeString(textLength: Int) async -> String {
        do {
            let estimate = try await getLatencyEstimate(textLength: textLength)
            let seconds = estimate.estimatedSeconds

            if seconds < 10 {
                return "~\(seconds) seconds"
            } else if seconds < 60 {
                let rounded = (seconds / 5) * 5  // Round to nearest 5
                return "~\(rounded) seconds"
            } else {
                let minutes = seconds / 60
                return "~\(minutes) minute\(minutes == 1 ? "" : "s")"
            }
        } catch {
            // Fallback to local estimate based on text length
            return localEstimateString(textLength: textLength)
        }
    }

    /// Local fallback estimate when server is unavailable.
    private nonisolated func localEstimateString(textLength: Int) -> String {
        // Rough estimate: ~2 seconds base + 1 second per 500 chars
        let seconds = 2 + (textLength / 500)

        if seconds < 10 {
            return "~\(seconds) seconds"
        } else if seconds < 60 {
            let rounded = (seconds / 5) * 5
            return "~\(rounded) seconds"
        } else {
            let minutes = seconds / 60
            return "~\(minutes) minute\(minutes == 1 ? "" : "s")"
        }
    }
}

// MARK: - Audio Cloud Storage

extension ListenAICloudService {

    /// Response from audio exists check
    struct AudioExistsResponse: Codable {
        let exists: Bool
        let `extension`: String?
    }

    /// Response from audio download URL request
    struct AudioDownloadResponse: Codable {
        let downloadURL: String
        let `extension`: String
    }

    /// Upload synthesized audio to cloud storage for backup.
    func uploadAudio(articleId: String, audioData: Data, mimeType: String = "audio/mpeg") async throws {
        let url = configuration.baseURL.appendingPathComponent("api/audio/upload")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let token = try await configuration.authTokenProvider()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "articleId": articleId,
            "audioData": audioData.base64EncodedString(),
            "mimeType": mimeType
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 60 // Longer timeout for uploads

        let (_, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw ListenAICloudError.serverError(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Upload failed")
        }

        print("[CloudStorage] Audio uploaded for article: \(articleId)")
    }

    /// Check if audio exists in cloud storage.
    func audioExists(articleId: String) async throws -> (exists: Bool, extension: String?) {
        let url = configuration.baseURL.appendingPathComponent("api/audio/\(articleId)/exists")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let token = try await configuration.authTokenProvider()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            return (false, nil)
        }

        let result = try JSONDecoder().decode(AudioExistsResponse.self, from: data)
        return (result.exists, result.extension)
    }

    /// Get a download URL for audio from cloud storage.
    func getAudioDownloadURL(articleId: String) async throws -> URL? {
        let url = configuration.baseURL.appendingPathComponent("api/audio/\(articleId)")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let token = try await configuration.authTokenProvider()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            return nil
        }

        if httpResponse.statusCode == 404 {
            return nil
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            return nil
        }

        let result = try JSONDecoder().decode(AudioDownloadResponse.self, from: data)
        return URL(string: result.downloadURL)
    }

    /// Download audio from cloud storage and save to local cache.
    func downloadAudio(articleId: String) async throws -> URL? {
        guard let downloadURL = try await getAudioDownloadURL(articleId: articleId) else {
            return nil
        }

        print("[CloudStorage] Downloading audio from: \(downloadURL)")

        // Download the audio file
        let (data, response) = try await urlSession.data(from: downloadURL)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            return nil
        }

        // Determine extension from content type or URL
        var fileExtension = "mp3"
        if let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") {
            if contentType.contains("m4a") || contentType.contains("mp4") {
                fileExtension = "m4a"
            }
        }

        // Save to cache directory
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("AudioCache", isDirectory: true)

        // Ensure cache directory exists
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

        let fileName = "cloud_\(articleId).\(fileExtension)"
        let localURL = cacheDir.appendingPathComponent(fileName)

        try data.write(to: localURL)

        print("[CloudStorage] Audio downloaded to: \(localURL.path)")
        return localURL
    }
}

// MARK: - AI Summary

extension ListenAICloudService {

    /// Action types for AI summarization
    enum AISummaryAction: String, Sendable {
        case summarize = "summarize"
        case keyPoints = "key_points"
        case explain = "explain"
        case custom = "custom"
    }

    /// Response from AI summarize endpoint
    struct AISummaryResponse: Codable, Sendable {
        let success: Bool
        let response: String
        let action: String
        let metadata: AISummaryMetadata?
    }

    struct AISummaryMetadata: Codable, Sendable {
        let model: String?
        let responseTimeMs: Int?
        let inputLength: Int?
        let wasTruncated: Bool?

        enum CodingKeys: String, CodingKey {
            case model
            case responseTimeMs = "response_time_ms"
            case inputLength = "input_length"
            case wasTruncated = "was_truncated"
        }
    }

    /// Generate AI summary of article text.
    ///
    /// - Parameters:
    ///   - text: The article text to summarize
    ///   - action: The type of summary to generate
    ///   - title: Optional article title for context
    ///   - customPrompt: Custom prompt for 'custom' action
    /// - Returns: AI-generated summary response
    /// - Throws: ListenAICloudError if request fails
    func summarize(
        text: String,
        action: AISummaryAction = .summarize,
        title: String? = nil,
        customPrompt: String? = nil
    ) async throws -> String {
        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("ai")
            .appendingPathComponent("summarize")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60 // AI requests may take longer

        var body: [String: Any] = [
            "text": text,
            "action": action.rawValue
        ]

        if let title = title {
            body["title"] = title
        }

        if let customPrompt = customPrompt, action == .custom {
            body["custom_prompt"] = customPrompt
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        print("[AI] Requesting \(action.rawValue) for \(text.count) chars")

        return try await executeWithRetry(request: request) { data, response in
            guard let httpResponse = response as? HTTPURLResponse else {
                throw ListenAICloudError.invalidResponse
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                let message = String(data: data, encoding: .utf8) ?? "Unknown error"
                throw ListenAICloudError.serverError(statusCode: httpResponse.statusCode, message: message)
            }

            let summaryResponse = try JSONDecoder().decode(AISummaryResponse.self, from: data)

            print("[AI] Received response: \(summaryResponse.response.prefix(100))...")

            return summaryResponse.response
        }
    }

    /// Check if AI features are available on the backend.
    ///
    /// - Returns: True if AI features are configured and available
    func isAIAvailable() async -> Bool {
        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("ai")
            .appendingPathComponent("status")

        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        do {
            let (data, response) = try await urlSession.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                return false
            }

            struct StatusResponse: Codable {
                let available: Bool
            }

            let status = try JSONDecoder().decode(StatusResponse.self, from: data)
            return status.available
        } catch {
            return false
        }
    }
}

// MARK: - Job-Based TTS API

extension ListenAICloudService {

    /// Request TTS synthesis via job-based API.
    ///
    /// This is the new job-based API that supports:
    /// - Immediate return for short texts (status: ready)
    /// - Async processing for longer texts (status: processing)
    /// - Preview audio while full synthesis completes
    ///
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - voiceId: The provider-specific voice ID
    ///   - provider: The TTS provider to use
    ///   - speed: Playback speed multiplier (0.5 - 3.0, default 1.0)
    /// Purpose of TTS request for quota and priority handling
    enum TTSPurpose: String {
        case play = "play"       // User pressed play, expects immediate response
        case prewarm = "prewarm" // Background pre-synthesis on import
    }

    /// - Returns: TTSJobStartResponse with job ID and initial status
    /// - Throws: TTSJobError for quota, rate limit, or other errors
    func requestTTS(
        text: String,
        voiceId: String,
        provider: TTSProvider = .selfhosted,
        speed: Double = 1.0,
        purpose: TTSPurpose = .play
    ) async throws -> TTSJobStartResponse {
        let token = try await getAuthToken()

        // Use the job-based API endpoint for async TTS with seconds-based quota
        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("tts")
            .appendingPathComponent("job")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 30

        // Debug: Add quota bypass header for testing (TODO: Remove before production)
        if ListenAIDebugConfig.bypassQuotaForTesting {
            request.setValue("true", forHTTPHeaderField: "X-Debug-Bypass-Quota")
            print("[TTS Job] DEBUG: Quota bypass header added")
        }

        // Job API uses different field structure
        var body: [String: Any] = [
            "text": text,
            "voice_id": voiceId,
            "options": ["speed": speed]
        ]

        // Add purpose field (supported by backend since 2025-01)
        // Safe to include - backend schema has default('play')
        body["purpose"] = purpose.rawValue

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        print("[TTS Job] POST /api/tts/job - \(text.count) chars, voice: \(voiceId), purpose: \(purpose.rawValue)")

        do {
            let (data, response) = try await urlSession.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw TTSJobError.unknown(message: "Invalid response type")
            }

            // Check for error responses
            guard (200...299).contains(httpResponse.statusCode) else {
                // Extract headers for retry-after
                var headers: [String: String] = [:]
                for (key, value) in httpResponse.allHeaderFields {
                    if let keyStr = key as? String, let valueStr = value as? String {
                        headers[keyStr] = valueStr
                    }
                }

                // Log error response for debugging
                if let errorBody = String(data: data, encoding: .utf8) {
                    print("[TTS Job] Error response (\(httpResponse.statusCode)): \(errorBody)")
                }

                throw TTSJobError.fromHTTPResponse(
                    statusCode: httpResponse.statusCode,
                    body: data,
                    headers: headers
                )
            }

            // Decode successful response
            let jobResponse = try JSONDecoder().decode(TTSJobStartResponse.self, from: data)

            print("[TTS Job] Response: status=\(jobResponse.status.rawValue), jobId=\(jobResponse.jobId)")

            return jobResponse

        } catch let error as TTSJobError {
            throw error
        } catch let error as DecodingError {
            print("[TTS Job] Decoding error: \(error)")
            throw TTSJobError.unknown(message: "Failed to parse response: \(error.localizedDescription)")
        } catch {
            print("[TTS Job] Network error: \(error)")
            throw TTSJobError.networkError(underlying: error.localizedDescription)
        }
    }

    /// Fetch the current status of a TTS job.
    ///
    /// Poll this endpoint to track job progress and get audio URLs when ready.
    /// Recommended polling interval: 2 seconds.
    ///
    /// - Parameter jobId: The job identifier from requestTTS()
    /// - Returns: TTSJobStatusResponse with current status and audio URLs
    /// - Throws: TTSJobError for not found, failed jobs, or network errors
    func fetchJobStatus(jobId: String) async throws -> TTSJobStatusResponse {
        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("tts")
            .appendingPathComponent("job")
            .appendingPathComponent(jobId)

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        do {
            let (data, response) = try await urlSession.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw TTSJobError.unknown(message: "Invalid response type")
            }

            // Check for error responses
            guard (200...299).contains(httpResponse.statusCode) else {
                var headers: [String: String] = [:]
                for (key, value) in httpResponse.allHeaderFields {
                    if let keyStr = key as? String, let valueStr = value as? String {
                        headers[keyStr] = valueStr
                    }
                }

                throw TTSJobError.fromHTTPResponse(
                    statusCode: httpResponse.statusCode,
                    body: data,
                    headers: headers
                )
            }

            // Decode successful response
            let statusResponse = try JSONDecoder().decode(TTSJobStatusResponse.self, from: data)

            print("[TTS Job] Status for \(jobId): \(statusResponse.status.rawValue)")

            // Check if job failed
            if statusResponse.status == .failed {
                if let error = TTSJobError.fromJobStatus(statusResponse) {
                    throw error
                }
            }

            return statusResponse

        } catch let error as TTSJobError {
            throw error
        } catch let error as DecodingError {
            print("[TTS Job] Decoding error: \(error)")
            throw TTSJobError.unknown(message: "Failed to parse status: \(error.localizedDescription)")
        } catch {
            print("[TTS Job] Network error: \(error)")
            throw TTSJobError.networkError(underlying: error.localizedDescription)
        }
    }

    /// Download audio from a job URL and save to local cache.
    ///
    /// - Parameters:
    ///   - urlString: The audio URL from job status response
    ///   - jobId: The job ID (used for cache filename)
    ///   - isPreview: Whether this is preview audio (affects filename)
    /// - Returns: Local file URL where audio was saved
    /// - Throws: TTSJobError for download failures
    func downloadJobAudio(
        urlString: String,
        jobId: String,
        isPreview: Bool = false
    ) async throws -> URL {
        guard let audioURL = URL(string: urlString) else {
            throw TTSJobError.badRequest(message: "Invalid audio URL")
        }

        print("[TTS Job] Downloading audio from: \(urlString)")

        do {
            let (data, response) = try await urlSession.data(from: audioURL)

            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                throw TTSJobError.serverError(statusCode: statusCode, message: "Download failed")
            }

            // Determine file extension from content type or URL
            var fileExtension = "mp3"
            if let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") {
                if contentType.contains("wav") {
                    fileExtension = "wav"
                } else if contentType.contains("m4a") || contentType.contains("mp4") {
                    fileExtension = "m4a"
                }
            }

            // Save to cache directory
            let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                .appendingPathComponent("TTSJobAudio", isDirectory: true)

            // Ensure cache directory exists
            try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

            let suffix = isPreview ? "_preview" : ""
            let fileName = "job_\(jobId)\(suffix).\(fileExtension)"
            let localURL = cacheDir.appendingPathComponent(fileName)

            try data.write(to: localURL)

            print("[TTS Job] Audio saved to: \(localURL.lastPathComponent) (\(data.count) bytes)")

            return localURL

        } catch let error as TTSJobError {
            throw error
        } catch {
            throw TTSJobError.networkError(underlying: error.localizedDescription)
        }
    }

    /// Cancel a pending or processing TTS job.
    ///
    /// - Parameter jobId: The job identifier to cancel
    /// - Throws: TTSJobError if cancellation fails
    func cancelJob(jobId: String) async throws {
        let token = try await getAuthToken()

        let url = configuration.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("tts")
            .appendingPathComponent("job")
            .appendingPathComponent(jobId)
            .appendingPathComponent("cancel")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await urlSession.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw TTSJobError.unknown(message: "Invalid response type")
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                throw TTSJobError.fromHTTPResponse(
                    statusCode: httpResponse.statusCode,
                    body: data,
                    headers: [:]
                )
            }

            print("[TTS Job] Cancelled job: \(jobId)")

        } catch let error as TTSJobError {
            throw error
        } catch {
            throw TTSJobError.networkError(underlying: error.localizedDescription)
        }
    }
}
