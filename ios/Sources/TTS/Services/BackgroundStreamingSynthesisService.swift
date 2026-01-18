import Foundation
import AVFoundation

// MARK: - Background Streaming Synthesis Service

/// @deprecated This service is deprecated and should not be used.
/// All synthesis now goes through the job-based API (POST /api/tts/job) via TTSJobManager.
/// This direct-to-Kokoro streaming approach bypasses quota tracking and backend caching.
/// Kept for reference but will be removed in a future version.
///
/// Service that pre-synthesizes audio using streaming, collecting chunks into a cached file.
/// Supports starting playback from partial cache while synthesis continues in background.
@available(*, deprecated, message: "Use TTSJobManager with job-based API instead")
@MainActor
final class BackgroundStreamingSynthesisService: ObservableObject {

    // MARK: - Published State

    @Published private(set) var synthesisProgress: [UUID: SynthesisProgressInfo] = [:]

    struct SynthesisProgressInfo {
        let articleId: UUID
        var chunksReceived: Int
        var totalChunks: Int
        var cachedDurationMs: Int
        var isComplete: Bool
        var error: String?
        var cachedAudioURL: URL?

        var progress: Double {
            guard totalChunks > 0 else { return 0 }
            return Double(chunksReceived) / Double(totalChunks)
        }

        var cachedDurationSeconds: TimeInterval {
            TimeInterval(cachedDurationMs) / 1000.0
        }
    }

    // MARK: - Private Properties

    private var activeTasks: [UUID: Task<Void, Never>] = [:]
    private var audioFileHandles: [UUID: FileHandle] = [:]
    private var backendURL: URL?
    private var authTokenProvider: (@Sendable () async throws -> String)?

    // Cache directory for streamed audio
    private let cacheDirectory: URL

    // MARK: - Singleton

    static let shared = BackgroundStreamingSynthesisService()

    // MARK: - Initialization

    private init() {
        let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        self.cacheDirectory = cachesDir.appendingPathComponent("StreamingAudioCache", isDirectory: true)

        // Create cache directory
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    }

    // MARK: - Configuration

    func configure(backendURL: URL, authTokenProvider: @escaping @Sendable () async throws -> String) {
        self.backendURL = backendURL
        self.authTokenProvider = authTokenProvider
    }

    // MARK: - Public API

    /// Start background streaming synthesis for an article.
    /// Audio is progressively cached to disk as chunks arrive.
    func startBackgroundSynthesis(
        articleId: UUID,
        text: String,
        voice: VoicePreset,
        speed: Float = 1.0
    ) {
        // Cancel any existing synthesis for this article
        cancelSynthesis(for: articleId)

        // Initialize progress
        synthesisProgress[articleId] = SynthesisProgressInfo(
            articleId: articleId,
            chunksReceived: 0,
            totalChunks: 0,
            cachedDurationMs: 0,
            isComplete: false,
            error: nil,
            cachedAudioURL: nil
        )

        // Start synthesis task
        let task = Task {
            await performStreamingSynthesis(articleId: articleId, text: text, voice: voice, speed: speed)
        }
        activeTasks[articleId] = task
    }

    /// Cancel ongoing synthesis for an article
    func cancelSynthesis(for articleId: UUID) {
        activeTasks[articleId]?.cancel()
        activeTasks.removeValue(forKey: articleId)

        // Close file handle if open
        try? audioFileHandles[articleId]?.close()
        audioFileHandles.removeValue(forKey: articleId)
    }

    /// Get cached audio URL if available (may be partial)
    func getCachedAudioURL(for articleId: UUID) -> URL? {
        synthesisProgress[articleId]?.cachedAudioURL
    }

    /// Check if synthesis is complete for an article
    func isSynthesisComplete(for articleId: UUID) -> Bool {
        synthesisProgress[articleId]?.isComplete ?? false
    }

    /// Get current progress for an article
    func getProgress(for articleId: UUID) -> SynthesisProgressInfo? {
        synthesisProgress[articleId]
    }

    // MARK: - Private Methods

    private func performStreamingSynthesis(
        articleId: UUID,
        text: String,
        voice: VoicePreset,
        speed: Float
    ) async {
        guard let backendURL = backendURL, let authTokenProvider = authTokenProvider else {
            updateProgress(for: articleId) { progress in
                progress.error = "Backend not configured"
            }
            return
        }

        // Create output file for cached audio
        let outputURL = cacheDirectory.appendingPathComponent("\(articleId.uuidString).wav")

        // Remove existing file if present
        try? FileManager.default.removeItem(at: outputURL)

        // We'll collect all PCM data and write a proper WAV file at the end
        var allPCMData = Data()
        let sampleRate: UInt32 = 24000
        let bitsPerSample: UInt16 = 16
        let numChannels: UInt16 = 1

        // Update ArticleStore to inProgress immediately so UI knows synthesis started
        await MainActor.run {
            ArticleStore.shared.updateSynthesisStatus(for: articleId, status: .inProgress(progress: 0))
        }

        do {
            // Get voice ID for streaming (uses Kokoro)
            let voiceId = voice.kokoroVoiceID ?? voice.providerVoiceID

            // Call self-hosted TTS directly (bypassing backend proxy to avoid Cloud Run timeout)
            // The backend proxy has a 300s timeout which isn't enough for long articles
            let selfHostedURL = URL(string: "https://readaloud-tts-917362189743.us-central1.run.app")!
            let streamURL = selfHostedURL.appendingPathComponent("synthesize-stream")
            var request = URLRequest(url: streamURL)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")

            // No auth needed for direct self-hosted TTS call

            // Request body (self-hosted TTS format)
            let body: [String: Any] = [
                "text": text,
                "voice_id": voiceId,
                "language": "en",
                "speed": speed,
                "model": "kokoro",
                "max_chunk_chars": 250
            ]
            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            print("[BackgroundSynthesis] Starting for article \(articleId), \(text.count) chars, voice: \(voiceId), preset: \(voice.name)")

            // Configure session with longer timeout for streaming
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 120
            config.timeoutIntervalForResource = 1800 // 30 minutes for very long articles
            let session = URLSession(configuration: config)

            // Start streaming
            let (bytes, response) = try await session.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                throw NSError(domain: "BackgroundSynthesis", code: -1, userInfo: [NSLocalizedDescriptionKey: "Stream request failed"])
            }

            var totalDurationMs = 0
            var chunksReceived = 0
            var totalChunks = 0

            // Process NDJSON stream
            for try await line in bytes.lines {
                guard !Task.isCancelled else { break }
                guard !line.isEmpty else { continue }

                // Parse chunk
                guard let data = line.data(using: .utf8),
                      let chunk = try? JSONDecoder().decode(TTSStreamChunk.self, from: data) else {
                    continue
                }

                // Check for error
                if let error = chunk.error {
                    throw NSError(domain: "BackgroundSynthesis", code: -1, userInfo: [NSLocalizedDescriptionKey: error])
                }

                totalChunks = chunk.total
                chunksReceived = chunk.index + 1
                totalDurationMs += chunk.duration_ms

                // Decode and collect PCM data from WAV chunk
                if let audioData = Data(base64Encoded: chunk.audio) {
                    if let pcmData = extractPCMFromWAV(audioData) {
                        allPCMData.append(pcmData)
                    }
                }

                // Update progress
                await MainActor.run {
                    self.synthesisProgress[articleId] = SynthesisProgressInfo(
                        articleId: articleId,
                        chunksReceived: chunksReceived,
                        totalChunks: totalChunks,
                        cachedDurationMs: totalDurationMs,
                        isComplete: chunk.final,
                        error: nil,
                        cachedAudioURL: nil // Will set after writing complete file
                    )
                }

                // Update ArticleStore with progress
                await MainActor.run {
                    let progress = Float(chunksReceived) / Float(max(1, totalChunks))
                    ArticleStore.shared.updateSynthesisStatus(for: articleId, status: .inProgress(progress: progress))
                }

                if chunksReceived % 10 == 0 {
                    print("[BackgroundSynthesis] Progress: \(chunksReceived)/\(totalChunks) chunks, \(totalDurationMs)ms")
                }
            }

            // Write complete WAV file
            let wavData = createWAVFile(pcmData: allPCMData, sampleRate: sampleRate, bitsPerSample: bitsPerSample, numChannels: numChannels)
            try wavData.write(to: outputURL)

            print("[BackgroundSynthesis] Completed: \(chunksReceived) chunks, \(totalDurationMs)ms total, file: \(outputURL.lastPathComponent)")

            // Update final progress
            await MainActor.run {
                self.synthesisProgress[articleId] = SynthesisProgressInfo(
                    articleId: articleId,
                    chunksReceived: chunksReceived,
                    totalChunks: totalChunks,
                    cachedDurationMs: totalDurationMs,
                    isComplete: true,
                    error: nil,
                    cachedAudioURL: outputURL
                )

                // Update ArticleStore
                ArticleStore.shared.updateSynthesisStatus(for: articleId, status: .completed, audioURL: outputURL)
            }

        } catch {
            print("[BackgroundSynthesis] Failed: \(error.localizedDescription)")

            await MainActor.run {
                self.updateProgress(for: articleId) { progress in
                    progress.error = error.localizedDescription
                }

                // Update ArticleStore with failure
                ArticleStore.shared.updateSynthesisStatus(for: articleId, status: .failed(message: error.localizedDescription))
            }
        }

        // Cleanup
        activeTasks.removeValue(forKey: articleId)
    }

    /// Extract raw PCM data from a WAV chunk (skipping header)
    private nonisolated func extractPCMFromWAV(_ wavData: Data) -> Data? {
        guard wavData.count > 44 else { return nil }

        // Verify RIFF header
        guard String(data: wavData.prefix(4), encoding: .ascii) == "RIFF" else { return nil }

        // Find data chunk
        var dataOffset = 12
        var dataSize = 0

        while dataOffset < wavData.count - 8 {
            let chunkID = String(data: wavData[dataOffset..<dataOffset+4], encoding: .ascii)
            let chunkSize = wavData.withUnsafeBytes { buffer -> Int in
                let ptr = buffer.baseAddress!.advanced(by: dataOffset + 4)
                return Int(ptr.assumingMemoryBound(to: UInt32.self).pointee)
            }

            if chunkID == "data" {
                dataOffset += 8
                dataSize = min(chunkSize, wavData.count - dataOffset)
                break
            }

            dataOffset += 8 + chunkSize
            if chunkSize % 2 == 1 { dataOffset += 1 }
        }

        guard dataSize > 0 else { return nil }

        return wavData[dataOffset..<dataOffset + dataSize]
    }

    /// Create a complete WAV file from PCM data
    private nonisolated func createWAVFile(pcmData: Data, sampleRate: UInt32, bitsPerSample: UInt16, numChannels: UInt16) -> Data {
        var wavData = Data()

        let byteRate = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(pcmData.count)
        let fileSize = 36 + dataSize

        // RIFF header
        wavData.append("RIFF".data(using: .ascii)!)
        wavData.append(withUnsafeBytes(of: fileSize.littleEndian) { Data($0) })
        wavData.append("WAVE".data(using: .ascii)!)

        // fmt chunk
        wavData.append("fmt ".data(using: .ascii)!)
        wavData.append(withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) }) // chunk size
        wavData.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) }) // PCM format
        wavData.append(withUnsafeBytes(of: numChannels.littleEndian) { Data($0) })
        wavData.append(withUnsafeBytes(of: sampleRate.littleEndian) { Data($0) })
        wavData.append(withUnsafeBytes(of: byteRate.littleEndian) { Data($0) })
        wavData.append(withUnsafeBytes(of: blockAlign.littleEndian) { Data($0) })
        wavData.append(withUnsafeBytes(of: bitsPerSample.littleEndian) { Data($0) })

        // data chunk
        wavData.append("data".data(using: .ascii)!)
        wavData.append(withUnsafeBytes(of: dataSize.littleEndian) { Data($0) })
        wavData.append(pcmData)

        return wavData
    }

    private func updateProgress(for articleId: UUID, update: (inout SynthesisProgressInfo) -> Void) {
        guard var progress = synthesisProgress[articleId] else { return }
        update(&progress)
        synthesisProgress[articleId] = progress
    }
}

// MARK: - Stream Chunk Model (reuse from StreamingTTSService)

// TTSStreamChunk is already defined in StreamingTTSService.swift
