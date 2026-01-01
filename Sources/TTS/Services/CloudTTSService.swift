import Foundation

// MARK: - Cloud TTS Configuration

struct CloudTTSConfiguration: Sendable {
    var apiKey: String?
    var baseURL: URL
    var maxChunkSize: Int
    var maxConcurrentRequests: Int
    var timeoutInterval: TimeInterval
    var retryCount: Int
    var retryDelay: TimeInterval

    // Provider-specific configurations
    static let elevenLabs = CloudTTSConfiguration(
        apiKey: nil,
        baseURL: URL(string: "https://api.elevenlabs.io/v1")!,
        maxChunkSize: 5000,
        maxConcurrentRequests: 3,
        timeoutInterval: 60,
        retryCount: 3,
        retryDelay: 1.0
    )

    static let openAI = CloudTTSConfiguration(
        apiKey: nil,
        baseURL: URL(string: "https://api.openai.com/v1")!,
        maxChunkSize: 4096,
        maxConcurrentRequests: 5,
        timeoutInterval: 30,
        retryCount: 3,
        retryDelay: 1.0
    )

    static let googleCloud = CloudTTSConfiguration(
        apiKey: nil,
        baseURL: URL(string: "https://texttospeech.googleapis.com/v1")!,
        maxChunkSize: 5000,
        maxConcurrentRequests: 10,
        timeoutInterval: 30,
        retryCount: 3,
        retryDelay: 1.0
    )

    static let amazonPolly = CloudTTSConfiguration(
        apiKey: nil,
        baseURL: URL(string: "https://polly.us-east-1.amazonaws.com")!,
        maxChunkSize: 3000,
        maxConcurrentRequests: 5,
        timeoutInterval: 30,
        retryCount: 3,
        retryDelay: 1.0
    )

    static func configuration(for provider: VoiceProvider) -> CloudTTSConfiguration {
        switch provider {
        case .apple:
            fatalError("Apple provider should use OnDeviceTTSService")
        case .elevenLabs:
            return .elevenLabs
        case .openAI:
            return .openAI
        case .googleCloud:
            return .googleCloud
        case .amazonPolly:
            return .amazonPolly
        }
    }
}

// MARK: - Cloud TTS Service

/// TTS service implementation for cloud-based providers (ElevenLabs, OpenAI, Google, Amazon).
/// Supports streaming and full file downloads with automatic chunking for long texts.
actor CloudTTSService: TTSService {

    // MARK: - Properties

    let provider: VoiceProvider
    var maxTextLength: Int { configuration.maxChunkSize * 100 } // Allow up to 100 chunks
    let supportsStreaming: Bool = true
    let supportsSSML: Bool = true

    private var configuration: CloudTTSConfiguration
    private let urlSession: URLSession
    private var activeTasks: [UUID: Task<Void, Never>] = [:]
    private var cachedVoices: [VoicePreset]?

    // MARK: - Initialization

    init(provider: VoiceProvider, configuration: CloudTTSConfiguration) {
        self.provider = provider
        self.configuration = configuration

        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = configuration.timeoutInterval
        sessionConfig.waitsForConnectivity = true
        self.urlSession = URLSession(configuration: sessionConfig)
    }

    // MARK: - Configuration

    /// Update the API key
    func setAPIKey(_ key: String) {
        configuration.apiKey = key
    }

    // MARK: - TTSService Protocol

    var isAvailable: Bool {
        get async {
            guard configuration.apiKey != nil else { return false }

            // Try a simple API health check
            do {
                _ = try await validateCredentials()
                return true
            } catch {
                return false
            }
        }
    }

    func synthesize(
        sections: [TextSection],
        voice: VoicePreset,
        options: SynthesisOptions,
        progress: @escaping @Sendable (SynthesisProgress) -> Void
    ) async throws -> SynthesisResult {
        // Validate input
        let totalText = sections.map(\.text).joined(separator: " ")
        guard !totalText.isEmpty else {
            throw TTSError.textEmpty
        }

        guard totalText.count <= maxTextLength else {
            throw TTSError.textTooLong(characterCount: totalText.count, limit: maxTextLength)
        }

        guard configuration.apiKey != nil else {
            throw TTSError.invalidConfiguration(reason: "API key not configured")
        }

        let taskID = UUID()
        let startTime = Date()

        // Create cancellation task
        let synthesisTask = Task<Void, Never> { [weak self] in
            // This task exists just for cancellation tracking
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000) // 0.1s
            }
            await self?.handleTaskCancellation(taskID: taskID)
        }
        activeTasks[taskID] = synthesisTask

        defer {
            synthesisTask.cancel()
            activeTasks.removeValue(forKey: taskID)
        }

        // Report initial progress
        progress(SynthesisProgress(
            overallProgress: 0,
            currentSectionIndex: 0,
            sectionsCompleted: 0,
            totalSections: sections.count,
            estimatedTimeRemaining: nil,
            statusMessage: "Connecting to \(provider.displayName)...",
            charactersProcessed: 0,
            totalCharacters: totalText.count
        ))

        // Chunk the text for API limits
        let chunks = chunkSections(sections, maxChunkSize: configuration.maxChunkSize)

        // Process chunks with concurrency limit
        var chunkResults: [(index: Int, url: URL, duration: TimeInterval)] = []
        var totalCost: Decimal = 0
        var totalCharactersUsed = 0

        // Process in batches
        let batchSize = configuration.maxConcurrentRequests
        for batchStart in stride(from: 0, to: chunks.count, by: batchSize) {
            let batchEnd = min(batchStart + batchSize, chunks.count)
            let batch = Array(chunks[batchStart..<batchEnd])

            // Check for cancellation
            if Task.isCancelled {
                throw TTSError.cancelled
            }

            // Process batch concurrently
            try await withThrowingTaskGroup(of: (Int, URL, TimeInterval, Int).self) { group in
                for (index, chunk) in batch.enumerated() {
                    let absoluteIndex = batchStart + index
                    group.addTask {
                        let (url, duration) = try await self.synthesizeChunk(
                            chunk,
                            voice: voice,
                            options: options
                        )
                        return (absoluteIndex, url, duration, chunk.text.count)
                    }
                }

                for try await (index, url, duration, charCount) in group {
                    chunkResults.append((index, url, duration))
                    totalCharactersUsed += charCount

                    // Update progress
                    let completedChunks = chunkResults.count
                    progress(SynthesisProgress(
                        overallProgress: Float(completedChunks) / Float(chunks.count) * 0.9,
                        currentSectionIndex: min(index, sections.count - 1),
                        sectionsCompleted: completedChunks,
                        totalSections: chunks.count,
                        estimatedTimeRemaining: nil,
                        statusMessage: "Generating audio... \(completedChunks)/\(chunks.count)",
                        charactersProcessed: totalCharactersUsed,
                        totalCharacters: totalText.count
                    ))
                }
            }
        }

        // Sort results by index and extract URLs
        chunkResults.sort { $0.index < $1.index }
        let audioURLs = chunkResults.map(\.url)

        // Calculate cost
        totalCost = calculateCost(characterCount: totalCharactersUsed)

        // Merge audio files
        progress(SynthesisProgress(
            overallProgress: 0.95,
            currentSectionIndex: sections.count - 1,
            sectionsCompleted: chunks.count,
            totalSections: chunks.count,
            estimatedTimeRemaining: nil,
            statusMessage: "Finalizing audio...",
            charactersProcessed: totalText.count,
            totalCharacters: totalText.count
        ))

        let mergedURL = try await mergeAudioFiles(audioURLs, format: options.outputFormat)

        // Clean up chunk files
        for url in audioURLs {
            try? FileManager.default.removeItem(at: url)
        }

        // Calculate section timestamps from chunks
        let sectionTimestamps = calculateSectionTimestamps(
            sections: sections,
            chunkResults: chunkResults
        )

        // Get file size
        let fileAttributes = try FileManager.default.attributesOfItem(atPath: mergedURL.path)
        let fileSize = fileAttributes[.size] as? Int64 ?? 0

        let totalDuration = chunkResults.reduce(0) { $0 + $1.duration }
        let endTime = Date()

        // Report completion
        progress(SynthesisProgress(
            overallProgress: 1.0,
            currentSectionIndex: sections.count - 1,
            sectionsCompleted: sections.count,
            totalSections: sections.count,
            estimatedTimeRemaining: 0,
            statusMessage: "Complete",
            charactersProcessed: totalText.count,
            totalCharacters: totalText.count
        ))

        return SynthesisResult(
            audioFileURL: mergedURL,
            duration: totalDuration,
            sectionTimestamps: sectionTimestamps,
            wordTimestamps: nil, // Cloud APIs typically don't provide word-level timestamps
            fileSizeBytes: fileSize,
            cost: SynthesisCost(
                charactersUsed: totalCharactersUsed,
                costUSD: totalCost,
                quotaUsed: totalCharactersUsed,
                provider: provider.rawValue
            ),
            metadata: SynthesisMetadata(
                voiceID: voice.id,
                voiceName: voice.name,
                provider: provider,
                startedAt: startTime,
                completedAt: endTime,
                inputCharacterCount: totalText.count,
                outputSampleRate: 44100,
                processingTimeSeconds: endTime.timeIntervalSince(startTime)
            )
        )
    }

    func synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) -> AsyncThrowingStream<AudioChunk, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard let apiKey = self.configuration.apiKey else {
                        throw TTSError.invalidConfiguration(reason: "API key not configured")
                    }

                    let request = try self.buildStreamingRequest(
                        text: text,
                        voice: voice,
                        options: options,
                        apiKey: apiKey
                    )

                    let (bytes, response) = try await self.urlSession.bytes(for: request)

                    guard let httpResponse = response as? HTTPURLResponse else {
                        throw TTSError.networkError(underlying: "Invalid response type")
                    }

                    guard httpResponse.statusCode == 200 else {
                        throw TTSError.apiError(
                            provider: self.provider.displayName,
                            code: httpResponse.statusCode,
                            message: "Streaming request failed"
                        )
                    }

                    var chunkIndex = 0
                    var timestamp: TimeInterval = 0
                    let estimatedChunkDuration: TimeInterval = 0.1

                    for try await byte in bytes {
                        // Accumulate bytes into chunks
                        // In real implementation, this would parse the streaming format
                        let chunk = AudioChunk(
                            data: Data([byte]),
                            timestamp: timestamp,
                            isFinal: false,
                            chunkIndex: chunkIndex
                        )

                        continuation.yield(chunk)
                        timestamp += estimatedChunkDuration
                        chunkIndex += 1
                    }

                    // Send final chunk
                    continuation.yield(AudioChunk(
                        data: Data(),
                        timestamp: timestamp,
                        isFinal: true,
                        chunkIndex: chunkIndex
                    ))

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    func cancelSynthesis(taskID: UUID) async {
        activeTasks[taskID]?.cancel()
        activeTasks.removeValue(forKey: taskID)
    }

    func cancelAllSynthesis() async {
        for (_, task) in activeTasks {
            task.cancel()
        }
        activeTasks.removeAll()
    }

    func isVoiceAvailable(_ voice: VoicePreset) async -> Bool {
        guard voice.provider == provider else { return false }
        guard configuration.apiKey != nil else { return false }

        // For now, assume voice is available if API key is set
        // In production, you'd verify against the provider's voice list
        return true
    }

    func availableVoices() async -> [VoicePreset] {
        // Return cached voices if available
        if let cached = cachedVoices {
            return cached
        }

        // In production, fetch from API
        // For now, return mock voices based on provider
        let voices = mockVoicesForProvider()
        cachedVoices = voices
        return voices
    }

    func estimate(text: String, voice: VoicePreset) -> SynthesisEstimate {
        let characterCount = text.count
        let wordCount = text.split(separator: " ").count

        // Estimate duration based on speaking rate (~150 WPM)
        let wordsPerMinute: Double = 150.0 * Double(voice.defaultSpeed)
        let estimatedDuration = (Double(wordCount) / wordsPerMinute) * 60

        // Cloud processing is typically fast
        let estimatedProcessingTime = Double(characterCount) / 1000.0 * 2.0 // ~2s per 1000 chars

        // Calculate cost
        let costPerCharacter = costPerCharacterForProvider()
        let estimatedCost = Decimal(characterCount) * costPerCharacter

        return SynthesisEstimate(
            estimatedDuration: estimatedDuration,
            estimatedProcessingTime: estimatedProcessingTime,
            characterCount: characterCount,
            estimatedCostUSD: estimatedCost,
            quotaImpact: QuotaImpact(
                minutesUsed: Int(estimatedDuration / 60),
                minutesRemaining: 1000, // Would come from subscription service
                percentageOfQuota: Float(estimatedDuration / 60) / 1000.0,
                willExceedQuota: false
            )
        )
    }

    // MARK: - Private Methods

    private func handleTaskCancellation(taskID: UUID) {
        // Clean up any resources for cancelled task
    }

    /// Validate API credentials
    private func validateCredentials() async throws -> Bool {
        guard let apiKey = configuration.apiKey else {
            throw TTSError.invalidConfiguration(reason: "API key not set")
        }

        // Build a simple validation request based on provider
        let request = buildValidationRequest(apiKey: apiKey)

        let (_, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw TTSError.networkError(underlying: "Invalid response")
        }

        switch httpResponse.statusCode {
        case 200...299:
            return true
        case 401:
            throw TTSError.invalidConfiguration(reason: "Invalid API key")
        case 429:
            throw TTSError.rateLimited(retryAfter: 60)
        default:
            throw TTSError.apiError(
                provider: provider.displayName,
                code: httpResponse.statusCode,
                message: "Validation failed"
            )
        }
    }

    /// Build validation request based on provider
    private func buildValidationRequest(apiKey: String) -> URLRequest {
        var request: URLRequest

        switch provider {
        case .elevenLabs:
            request = URLRequest(url: configuration.baseURL.appendingPathComponent("user"))
            request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")

        case .openAI:
            request = URLRequest(url: configuration.baseURL.appendingPathComponent("models"))
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        case .googleCloud:
            var components = URLComponents(url: configuration.baseURL.appendingPathComponent("voices"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "key", value: apiKey)]
            request = URLRequest(url: components.url!)

        case .amazonPolly:
            // AWS requires signature - simplified for mock
            request = URLRequest(url: configuration.baseURL.appendingPathComponent("v1/voices"))
            request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")

        case .apple:
            fatalError("Apple provider should use OnDeviceTTSService")
        }

        request.httpMethod = "GET"
        return request
    }

    /// Chunk text sections to fit within API limits
    private func chunkSections(_ sections: [TextSection], maxChunkSize: Int) -> [TextChunk] {
        var chunks: [TextChunk] = []
        var currentChunk = ""
        var currentChunkStart = 0
        var sectionsInChunk: [Int] = []

        for section in sections {
            let text = section.text

            // If single section exceeds limit, split it
            if text.count > maxChunkSize {
                // Flush current chunk first
                if !currentChunk.isEmpty {
                    chunks.append(TextChunk(
                        text: currentChunk,
                        index: chunks.count,
                        sectionIndices: sectionsInChunk,
                        characterRange: currentChunkStart..<(currentChunkStart + currentChunk.count)
                    ))
                    currentChunkStart += currentChunk.count
                    currentChunk = ""
                    sectionsInChunk = []
                }

                // Split long section at sentence boundaries
                let subChunks = splitTextAtSentences(text, maxSize: maxChunkSize)
                for subChunk in subChunks {
                    chunks.append(TextChunk(
                        text: subChunk,
                        index: chunks.count,
                        sectionIndices: [section.index],
                        characterRange: currentChunkStart..<(currentChunkStart + subChunk.count)
                    ))
                    currentChunkStart += subChunk.count
                }
            } else if currentChunk.count + text.count + 1 > maxChunkSize {
                // Current chunk would exceed limit, flush it
                if !currentChunk.isEmpty {
                    chunks.append(TextChunk(
                        text: currentChunk,
                        index: chunks.count,
                        sectionIndices: sectionsInChunk,
                        characterRange: currentChunkStart..<(currentChunkStart + currentChunk.count)
                    ))
                    currentChunkStart += currentChunk.count
                }
                currentChunk = text
                sectionsInChunk = [section.index]
            } else {
                // Add to current chunk
                if !currentChunk.isEmpty {
                    currentChunk += " "
                }
                currentChunk += text
                sectionsInChunk.append(section.index)
            }
        }

        // Flush remaining chunk
        if !currentChunk.isEmpty {
            chunks.append(TextChunk(
                text: currentChunk,
                index: chunks.count,
                sectionIndices: sectionsInChunk,
                characterRange: currentChunkStart..<(currentChunkStart + currentChunk.count)
            ))
        }

        return chunks
    }

    /// Split text at sentence boundaries
    private func splitTextAtSentences(_ text: String, maxSize: Int) -> [String] {
        var chunks: [String] = []
        var currentChunk = ""

        // Simple sentence splitting by period, question mark, exclamation
        let sentences = text.components(separatedBy: CharacterSet(charactersIn: ".!?"))

        for (index, sentence) in sentences.enumerated() {
            let trimmed = sentence.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            // Add back the punctuation (except for last)
            let punctuation = index < sentences.count - 1 ? "." : ""
            let fullSentence = trimmed + punctuation

            if currentChunk.count + fullSentence.count + 1 > maxSize {
                if !currentChunk.isEmpty {
                    chunks.append(currentChunk)
                }
                currentChunk = fullSentence
            } else {
                if !currentChunk.isEmpty {
                    currentChunk += " "
                }
                currentChunk += fullSentence
            }
        }

        if !currentChunk.isEmpty {
            chunks.append(currentChunk)
        }

        return chunks
    }

    /// Synthesize a single chunk via API
    private func synthesizeChunk(
        _ chunk: TextChunk,
        voice: VoicePreset,
        options: SynthesisOptions
    ) async throws -> (URL, TimeInterval) {
        guard let apiKey = configuration.apiKey else {
            throw TTSError.invalidConfiguration(reason: "API key not configured")
        }

        let request = try buildSynthesisRequest(
            text: chunk.text,
            voice: voice,
            options: options,
            apiKey: apiKey
        )

        // Retry logic
        var lastError: Error?
        for attempt in 0..<configuration.retryCount {
            do {
                let (data, response) = try await urlSession.data(for: request)

                guard let httpResponse = response as? HTTPURLResponse else {
                    throw TTSError.networkError(underlying: "Invalid response type")
                }

                switch httpResponse.statusCode {
                case 200...299:
                    // Success - save audio data to file
                    let outputURL = FileManager.default.temporaryDirectory
                        .appendingPathComponent("chunk_\(chunk.index)_\(UUID().uuidString)")
                        .appendingPathExtension(options.outputFormat.fileExtension)

                    try data.write(to: outputURL)

                    // Estimate duration from file size (rough estimate)
                    // In production, you'd parse the actual audio duration
                    let duration = estimateDurationFromData(data, format: options.outputFormat)

                    return (outputURL, duration)

                case 429:
                    // Rate limited
                    let retryAfter = httpResponse.value(forHTTPHeaderField: "Retry-After")
                        .flatMap { Double($0) } ?? configuration.retryDelay
                    throw TTSError.rateLimited(retryAfter: retryAfter)

                case 401:
                    throw TTSError.invalidConfiguration(reason: "Invalid API key")

                case 402:
                    throw TTSError.quotaExceeded(remaining: 0, required: chunk.text.count)

                default:
                    let message = String(data: data, encoding: .utf8) ?? "Unknown error"
                    throw TTSError.apiError(
                        provider: provider.displayName,
                        code: httpResponse.statusCode,
                        message: message
                    )
                }
            } catch let error as TTSError {
                switch error {
                case .rateLimited(let retryAfter):
                    // Wait and retry
                    try await Task.sleep(nanoseconds: UInt64(retryAfter * 1_000_000_000))
                    lastError = error
                case .cancelled:
                    throw error
                default:
                    lastError = error
                }
            } catch {
                lastError = error
            }

            // Wait before retry
            if attempt < configuration.retryCount - 1 {
                try await Task.sleep(nanoseconds: UInt64(configuration.retryDelay * 1_000_000_000))
            }
        }

        throw lastError ?? TTSError.networkError(underlying: "Unknown error after retries")
    }

    /// Build synthesis request based on provider
    private func buildSynthesisRequest(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        apiKey: String
    ) throws -> URLRequest {
        var request: URLRequest

        switch provider {
        case .elevenLabs:
            request = try buildElevenLabsRequest(text: text, voice: voice, options: options, apiKey: apiKey)

        case .openAI:
            request = try buildOpenAIRequest(text: text, voice: voice, options: options, apiKey: apiKey)

        case .googleCloud:
            request = try buildGoogleCloudRequest(text: text, voice: voice, options: options, apiKey: apiKey)

        case .amazonPolly:
            request = try buildAmazonPollyRequest(text: text, voice: voice, options: options, apiKey: apiKey)

        case .apple:
            fatalError("Apple provider should use OnDeviceTTSService")
        }

        return request
    }

    /// Build streaming request based on provider
    private func buildStreamingRequest(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        apiKey: String
    ) throws -> URLRequest {
        // Most providers use the same endpoint with streaming param
        var request = try buildSynthesisRequest(text: text, voice: voice, options: options, apiKey: apiKey)

        // Add streaming header/param based on provider
        switch provider {
        case .elevenLabs:
            // ElevenLabs uses a different endpoint for streaming
            let streamURL = configuration.baseURL
                .appendingPathComponent("text-to-speech")
                .appendingPathComponent(voice.providerVoiceID)
                .appendingPathComponent("stream")
            request.url = streamURL

        case .openAI:
            // OpenAI doesn't support true streaming for TTS
            break

        default:
            break
        }

        return request
    }

    // MARK: - Provider-Specific Request Builders

    private func buildElevenLabsRequest(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        apiKey: String
    ) throws -> URLRequest {
        let url = configuration.baseURL
            .appendingPathComponent("text-to-speech")
            .appendingPathComponent(voice.providerVoiceID)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")

        let cloudSettings = voice.cloudSettings ?? .default

        let body: [String: Any] = [
            "text": text,
            "model_id": voice.providerModelID ?? "eleven_multilingual_v2",
            "voice_settings": [
                "stability": cloudSettings.stability,
                "similarity_boost": cloudSettings.similarityBoost,
                "style": cloudSettings.style,
                "use_speaker_boost": cloudSettings.useSpeakerBoost
            ]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    private func buildOpenAIRequest(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        apiKey: String
    ) throws -> URLRequest {
        let url = configuration.baseURL.appendingPathComponent("audio/speech")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "model": voice.providerModelID ?? "tts-1-hd",
            "voice": voice.providerVoiceID,
            "input": text,
            "speed": options.speed,
            "response_format": options.outputFormat == .mp3 ? "mp3" : "aac"
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    private func buildGoogleCloudRequest(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        apiKey: String
    ) throws -> URLRequest {
        var components = URLComponents(
            url: configuration.baseURL.appendingPathComponent("text:synthesize"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "key", value: apiKey)]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "input": ["text": text],
            "voice": [
                "languageCode": voice.language,
                "name": voice.providerVoiceID
            ],
            "audioConfig": [
                "audioEncoding": "MP3",
                "speakingRate": options.speed,
                "pitch": (options.pitch - 1.0) * 20 // Google uses semitones (-20 to 20)
            ]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    private func buildAmazonPollyRequest(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        apiKey: String
    ) throws -> URLRequest {
        // Note: Real AWS requests require SigV4 signing
        // This is a simplified mock
        let url = configuration.baseURL.appendingPathComponent("v1/speech")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")

        let body: [String: Any] = [
            "Text": text,
            "VoiceId": voice.providerVoiceID,
            "OutputFormat": "mp3",
            "Engine": "neural"
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    // MARK: - Audio Processing

    /// Merge multiple audio files into one
    private nonisolated func mergeAudioFiles(
        _ urls: [URL],
        format: AudioFormat
    ) async throws -> URL {
        guard !urls.isEmpty else {
            throw TTSError.audioEncodingFailed(reason: "No audio files to merge")
        }

        if urls.count == 1 {
            // Just copy the single file
            let outputURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("merged_\(UUID().uuidString)")
                .appendingPathExtension(format.fileExtension)
            try FileManager.default.copyItem(at: urls[0], to: outputURL)
            return outputURL
        }

        // Concatenate audio data (simple approach for MP3/AAC)
        // For production, use AVAssetExportSession for proper merging
        var combinedData = Data()
        for url in urls {
            let data = try Data(contentsOf: url)
            combinedData.append(data)
        }

        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("merged_\(UUID().uuidString)")
            .appendingPathExtension(format.fileExtension)

        try combinedData.write(to: outputURL)
        return outputURL
    }

    /// Estimate duration from audio data
    private func estimateDurationFromData(_ data: Data, format: AudioFormat) -> TimeInterval {
        // Rough estimate based on typical bitrates
        let bytesPerSecond: Double
        switch format {
        case .mp3:
            bytesPerSecond = 16000 // ~128kbps
        case .m4a, .aac:
            bytesPerSecond = 16000 // ~128kbps
        case .wav:
            bytesPerSecond = 88200 // 44.1kHz, 16-bit mono
        case .opus:
            bytesPerSecond = 8000 // ~64kbps
        }

        return Double(data.count) / bytesPerSecond
    }

    /// Calculate section timestamps from chunk results
    private func calculateSectionTimestamps(
        sections: [TextSection],
        chunkResults: [(index: Int, url: URL, duration: TimeInterval)]
    ) -> [SectionTimestamp] {
        // Simple proportional distribution
        // In production, you'd use actual timing data from the API
        var timestamps: [SectionTimestamp] = []
        var currentTime: TimeInterval = 0

        let totalDuration = chunkResults.reduce(0) { $0 + $1.duration }
        let totalChars = sections.reduce(0) { $0 + $1.text.count }

        for section in sections {
            let proportion = Double(section.text.count) / Double(totalChars)
            let sectionDuration = totalDuration * proportion

            timestamps.append(SectionTimestamp(
                sectionIndex: section.index,
                startTime: currentTime,
                endTime: currentTime + sectionDuration
            ))

            currentTime += sectionDuration
        }

        return timestamps
    }

    // MARK: - Cost Calculation

    private func calculateCost(characterCount: Int) -> Decimal {
        let costPerChar = costPerCharacterForProvider()
        return Decimal(characterCount) * costPerChar
    }

    private func costPerCharacterForProvider() -> Decimal {
        switch provider {
        case .elevenLabs:
            return Decimal(string: "0.00030")! // ~$0.30 per 1K chars
        case .openAI:
            return Decimal(string: "0.000015")! // ~$0.015 per 1K chars (tts-1)
        case .googleCloud:
            return Decimal(string: "0.000016")! // ~$16 per 1M chars
        case .amazonPolly:
            return Decimal(string: "0.000016")! // ~$16 per 1M chars (neural)
        case .apple:
            return Decimal.zero
        }
    }

    // MARK: - Mock Voices

    private func mockVoicesForProvider() -> [VoicePreset] {
        switch provider {
        case .elevenLabs:
            return [
                VoicePreset(
                    name: "Rachel",
                    provider: .elevenLabs,
                    providerVoiceID: "21m00Tcm4TlvDq8ikWAM",
                    providerModelID: "eleven_multilingual_v2",
                    gender: .female,
                    style: .conversational,
                    voiceDescription: "Calm, young American female voice",
                    tier: .premium
                ),
                VoicePreset(
                    name: "Adam",
                    provider: .elevenLabs,
                    providerVoiceID: "pNInz6obpgDQGcFmaJgB",
                    providerModelID: "eleven_multilingual_v2",
                    gender: .male,
                    style: .narrative,
                    voiceDescription: "Deep, mature American male voice",
                    tier: .premium
                ),
                VoicePreset.santa,
                VoicePreset.storyteller,
                VoicePreset.bedtime
            ]

        case .openAI:
            return [
                VoicePreset(
                    name: "Alloy",
                    provider: .openAI,
                    providerVoiceID: "alloy",
                    providerModelID: "tts-1-hd",
                    gender: .neutral,
                    style: .neutral,
                    voiceDescription: "Neutral, balanced voice",
                    tier: .premium
                ),
                VoicePreset(
                    name: "Echo",
                    provider: .openAI,
                    providerVoiceID: "echo",
                    providerModelID: "tts-1-hd",
                    gender: .male,
                    style: .conversational,
                    voiceDescription: "Warm male voice",
                    tier: .premium
                ),
                VoicePreset(
                    name: "Nova",
                    provider: .openAI,
                    providerVoiceID: "nova",
                    providerModelID: "tts-1-hd",
                    gender: .female,
                    style: .friendly,
                    voiceDescription: "Bright, friendly female voice",
                    tier: .premium
                ),
                VoicePreset(
                    name: "Onyx",
                    provider: .openAI,
                    providerVoiceID: "onyx",
                    providerModelID: "tts-1-hd",
                    gender: .male,
                    style: .news,
                    voiceDescription: "Deep, authoritative male voice",
                    tier: .premium
                ),
                VoicePreset.newsAnchor
            ]

        case .googleCloud:
            return [
                VoicePreset(
                    name: "Wavenet A",
                    provider: .googleCloud,
                    providerVoiceID: "en-US-Wavenet-A",
                    gender: .male,
                    style: .neutral,
                    voiceDescription: "Google WaveNet male voice",
                    tier: .premium
                ),
                VoicePreset(
                    name: "Wavenet C",
                    provider: .googleCloud,
                    providerVoiceID: "en-US-Wavenet-C",
                    gender: .female,
                    style: .neutral,
                    voiceDescription: "Google WaveNet female voice",
                    tier: .premium
                )
            ]

        case .amazonPolly:
            return [
                VoicePreset(
                    name: "Joanna",
                    provider: .amazonPolly,
                    providerVoiceID: "Joanna",
                    gender: .female,
                    style: .conversational,
                    voiceDescription: "Amazon Neural female voice",
                    tier: .premium
                ),
                VoicePreset(
                    name: "Matthew",
                    provider: .amazonPolly,
                    providerVoiceID: "Matthew",
                    gender: .male,
                    style: .conversational,
                    voiceDescription: "Amazon Neural male voice",
                    tier: .premium
                )
            ]

        case .apple:
            return [] // Should use OnDeviceTTSService
        }
    }
}

// MARK: - Text Chunk

private struct TextChunk {
    let text: String
    let index: Int
    let sectionIndices: [Int]
    let characterRange: Range<Int>
}
