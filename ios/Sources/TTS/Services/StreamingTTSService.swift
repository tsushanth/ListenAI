import Foundation
import AVFoundation
import Combine

// MARK: - Streaming TTS Response Types

/// A single chunk from the streaming TTS endpoint
struct TTSStreamChunk: Codable {
    let index: Int
    let total: Int
    let audio: String  // base64-encoded WAV
    let duration_ms: Int
    let synthesis_time_ms: Int?
    let final: Bool
    let error: String?
}

/// Progress information for streaming synthesis
struct StreamingProgress: Sendable {
    let chunksReceived: Int
    let totalChunks: Int
    let totalDurationMs: Int
    let isComplete: Bool
    let error: String?

    var progress: Double {
        guard totalChunks > 0 else { return 0 }
        return Double(chunksReceived) / Double(totalChunks)
    }
}

// MARK: - Streaming TTS Service

/// Service for progressive TTS streaming - plays audio as chunks arrive
/// instead of waiting for the entire synthesis to complete.
/// Also saves combined audio to disk for caching and proper playback integration.
@MainActor
class StreamingTTSService: ObservableObject {

    // MARK: - Published State

    @Published private(set) var isStreaming: Bool = false
    @Published private(set) var progress: StreamingProgress = StreamingProgress(
        chunksReceived: 0,
        totalChunks: 0,
        totalDurationMs: 0,
        isComplete: false,
        error: nil
    )
    @Published private(set) var isPlaying: Bool = false

    /// Current playback time in seconds (for text highlighting)
    @Published private(set) var currentTime: TimeInterval = 0

    /// Total duration in seconds (estimated initially, then updated as chunks arrive)
    @Published private(set) var duration: TimeInterval = 0

    /// Estimated duration based on word count (used for highlighting until actual duration known)
    @Published private(set) var estimatedDuration: TimeInterval = 0

    /// The article ID currently being played (for coordination with ArticleReaderView)
    @Published private(set) var currentArticleID: UUID?

    // MARK: - Private Properties

    private var audioEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var audioFormat: AVAudioFormat?
    private var streamTask: Task<Void, Error>?
    private var pendingBuffers: [AVAudioPCMBuffer] = []
    private var buffersScheduled: Int = 0
    private var hasStartedPlayback: Bool = false

    /// Accumulated raw PCM data for saving to disk
    private var accumulatedPCMData: Data = Data()

    /// Sample rate for the audio (Kokoro uses 24kHz)
    private let sampleRate: Double = 24000

    /// Timer for updating currentTime
    private var playbackTimer: Timer?

    /// Start time of current playback segment
    private var playbackStartTime: Date?

    /// Accumulated time from completed chunks (for pause/resume tracking)
    private var accumulatedTime: TimeInterval = 0

    /// Actual duration accumulated from received chunks (in seconds)
    private var actualDurationFromChunks: TimeInterval = 0

    // Backend configuration
    private var backendURL: URL?
    private var authTokenProvider: (@Sendable () async throws -> String)?

    // Audio session
    private let audioSession = AVAudioSession.sharedInstance()

    // MARK: - Singleton

    static let shared = StreamingTTSService()

    private init() {}

    // MARK: - Configuration

    /// Configure the service with backend URL and auth provider
    func configure(backendURL: URL, authTokenProvider: @escaping @Sendable () async throws -> String) {
        self.backendURL = backendURL
        self.authTokenProvider = authTokenProvider
    }

    // MARK: - Public Methods

    /// Start streaming synthesis and playback
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - voice: The voice preset to use
    ///   - speed: Playback speed (default 1.0)
    ///   - articleID: Optional article ID for caching and highlighting coordination
    func startStreaming(text: String, voice: VoicePreset, speed: Float = 1.0, articleID: UUID? = nil) async throws {
        guard let backendURL = backendURL, let authTokenProvider = authTokenProvider else {
            throw TTSError.invalidConfiguration(reason: "Backend URL or auth provider not configured")
        }

        // Cancel any existing stream
        stopStreaming()

        // Setup audio session
        try setupAudioSession()

        // Setup audio engine
        try setupAudioEngine()

        // Reset state
        isStreaming = true
        hasStartedPlayback = false
        pendingBuffers = []
        buffersScheduled = 0
        accumulatedPCMData = Data()
        currentTime = 0
        accumulatedTime = 0
        currentArticleID = articleID

        // Estimate duration based on word count (150 words per minute average speaking rate)
        // This allows text highlighting to work before actual duration is known
        let wordCount = text.split(separator: " ").count
        estimatedDuration = Double(wordCount) / 150.0 * 60.0
        duration = estimatedDuration  // Start with estimate, update as chunks arrive
        actualDurationFromChunks = 0
        progress = StreamingProgress(
            chunksReceived: 0,
            totalChunks: 0,
            totalDurationMs: 0,
            isComplete: false,
            error: nil
        )

        // Get voice ID for streaming (always uses Kokoro)
        let voiceId = voice.kokoroVoiceID ?? voice.providerVoiceID

        // Build request
        let streamURL = backendURL.appendingPathComponent("api/tts/stream")
        var request = URLRequest(url: streamURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")

        // Add auth token
        let token = try await authTokenProvider()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Request body
        let body: [String: Any] = [
            "text": text,
            "voice_id": voiceId,
            "provider": "selfhosted",
            "options": ["speed": speed]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        print("[StreamingTTS] Starting stream for \(text.count) chars with voice \(voiceId)")

        // Create a custom URLSession with longer timeout for streaming
        // Large texts can take 30+ seconds before first chunk arrives
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120  // 2 minutes for initial connection
        config.timeoutIntervalForResource = 600 // 10 minutes for entire transfer
        let streamingSession = URLSession(configuration: config)

        // Start streaming
        streamTask = Task {
            do {
                let (bytes, response) = try await streamingSession.bytes(for: request)

                guard let httpResponse = response as? HTTPURLResponse else {
                    throw TTSError.networkError(underlying: "Invalid response")
                }

                guard (200...299).contains(httpResponse.statusCode) else {
                    throw TTSError.apiError(
                        provider: "ListenAI",
                        code: httpResponse.statusCode,
                        message: "Stream request failed"
                    )
                }

                var totalDurationMs = 0
                var chunksReceived = 0
                var totalChunks = 0

                // Process NDJSON stream line by line
                for try await line in bytes.lines {
                    guard !Task.isCancelled else { break }

                    guard !line.isEmpty else { continue }

                    // Parse chunk
                    guard let data = line.data(using: .utf8),
                          let chunk = try? JSONDecoder().decode(TTSStreamChunk.self, from: data) else {
                        print("[StreamingTTS] Failed to parse chunk: \(line.prefix(100))")
                        continue
                    }

                    // Check for error
                    if let error = chunk.error {
                        throw TTSError.apiError(provider: "ListenAI", code: -1, message: error)
                    }

                    totalChunks = chunk.total
                    chunksReceived = chunk.index + 1
                    totalDurationMs += chunk.duration_ms

                    // Decode and schedule audio
                    if let audioData = Data(base64Encoded: chunk.audio) {
                        try await self.scheduleAudioChunk(audioData, isFirst: chunk.index == 0, chunkDurationMs: chunk.duration_ms)
                    }

                    // Update progress
                    await MainActor.run {
                        self.progress = StreamingProgress(
                            chunksReceived: chunksReceived,
                            totalChunks: totalChunks,
                            totalDurationMs: totalDurationMs,
                            isComplete: chunk.final,
                            error: nil
                        )
                    }

                    print("[StreamingTTS] Received chunk \(chunk.index + 1)/\(chunk.total), duration: \(chunk.duration_ms)ms")
                }

                print("[StreamingTTS] Stream complete: \(chunksReceived) chunks, \(totalDurationMs)ms total")

                // Save accumulated audio to disk for caching
                await MainActor.run {
                    if let articleID = self.currentArticleID {
                        if let savedURL = self.saveAccumulatedAudio(for: articleID) {
                            print("[StreamingTTS] Audio cached at: \(savedURL.path)")
                        }
                    }

                    self.isStreaming = false
                    self.progress = StreamingProgress(
                        chunksReceived: chunksReceived,
                        totalChunks: totalChunks,
                        totalDurationMs: totalDurationMs,
                        isComplete: true,
                        error: nil
                    )
                }

            } catch {
                print("[StreamingTTS] Stream error: \(error)")
                await MainActor.run {
                    self.isStreaming = false
                    self.isPlaying = false
                    self.progress = StreamingProgress(
                        chunksReceived: self.progress.chunksReceived,
                        totalChunks: self.progress.totalChunks,
                        totalDurationMs: self.progress.totalDurationMs,
                        isComplete: false,
                        error: error.localizedDescription
                    )
                }
                throw error
            }
        }

        try await streamTask?.value
    }

    /// Stop streaming and playback
    func stopStreaming() {
        streamTask?.cancel()
        streamTask = nil

        playerNode?.stop()
        audioEngine?.stop()

        playbackTimer?.invalidate()
        playbackTimer = nil

        isStreaming = false
        isPlaying = false
        hasStartedPlayback = false
        pendingBuffers = []
        buffersScheduled = 0
        currentArticleID = nil
    }

    /// Get the saved audio URL for an article (if streaming completed and was cached)
    func getSavedAudioURL(for articleID: UUID) -> URL? {
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let audioDir = cacheDir.appendingPathComponent("StreamedAudio", isDirectory: true)
        let audioFile = audioDir.appendingPathComponent("\(articleID.uuidString).wav")

        if FileManager.default.fileExists(atPath: audioFile.path) {
            return audioFile
        }
        return nil
    }

    /// Pause playback
    func pause() {
        playerNode?.pause()
        playbackTimer?.invalidate()
        playbackTimer = nil
        // Save current position for accurate resume
        if let startTime = playbackStartTime {
            accumulatedTime += Date().timeIntervalSince(startTime)
        }
        playbackStartTime = nil
        isPlaying = false
    }

    /// Resume playback
    func resume() {
        playerNode?.play()
        playbackStartTime = Date()
        startPlaybackTimer()
        isPlaying = true
    }

    // MARK: - Private Methods

    private func setupAudioSession() throws {
        try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audioSession.setActive(true)
    }

    private func setupAudioEngine() throws {
        audioEngine = AVAudioEngine()
        playerNode = AVAudioPlayerNode()

        guard let audioEngine = audioEngine, let playerNode = playerNode else {
            throw TTSError.internalError(reason: "Failed to create audio engine")
        }

        // Use Float32 format for the audio engine (required by AVAudioEngine)
        // Kokoro outputs 24kHz mono - we'll convert Int16 WAV data to Float32
        audioFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 24000,
            channels: 1,
            interleaved: false
        )

        guard let format = audioFormat else {
            throw TTSError.internalError(reason: "Failed to create audio format")
        }

        audioEngine.attach(playerNode)
        audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: format)

        try audioEngine.start()
        print("[StreamingTTS] Audio engine started with format: \(format)")
    }

    private func scheduleAudioChunk(_ wavData: Data, isFirst: Bool, chunkDurationMs: Int) async throws {
        guard let format = audioFormat else {
            throw TTSError.internalError(reason: "Audio format not initialized")
        }

        // Parse WAV and extract PCM data, also get raw PCM bytes for caching
        guard let (pcmBuffer, rawPCMData) = try parseWAVToPCMBufferAndData(wavData, format: format) else {
            print("[StreamingTTS] Failed to parse WAV data")
            return
        }

        // Accumulate raw PCM data for saving later
        accumulatedPCMData.append(rawPCMData)

        // Track actual duration from chunks
        let chunkDuration = Double(chunkDurationMs) / 1000.0
        actualDurationFromChunks += chunkDuration

        // Keep duration as the running total of actual audio received
        // This allows highlighting to track actual playback progress
        duration = actualDurationFromChunks

        await MainActor.run {
            // Schedule buffer for playback
            self.playerNode?.scheduleBuffer(pcmBuffer) { [weak self] in
                Task { @MainActor in
                    self?.buffersScheduled -= 1
                    // Check if playback is complete
                    if self?.buffersScheduled == 0 && self?.progress.isComplete == true {
                        self?.isPlaying = false
                        self?.playbackTimer?.invalidate()
                        self?.playbackTimer = nil
                    }
                }
            }
            self.buffersScheduled += 1

            // Start playback on first chunk
            if isFirst && !self.hasStartedPlayback {
                self.playerNode?.play()
                self.hasStartedPlayback = true
                self.isPlaying = true
                self.playbackStartTime = Date()
                self.startPlaybackTimer()
                print("[StreamingTTS] Playback started on first chunk")
            }
        }
    }

    /// Start a timer to update currentTime for text highlighting
    private func startPlaybackTimer() {
        playbackTimer?.invalidate()
        playbackTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, self.isPlaying, let startTime = self.playbackStartTime else { return }
                let elapsed = Date().timeIntervalSince(startTime)
                self.currentTime = self.accumulatedTime + elapsed
            }
        }
    }

    /// Save accumulated audio to disk as WAV file
    private func saveAccumulatedAudio(for articleID: UUID) -> URL? {
        guard !accumulatedPCMData.isEmpty else {
            print("[StreamingTTS] No audio data to save")
            return nil
        }

        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let audioDir = cacheDir.appendingPathComponent("StreamedAudio", isDirectory: true)

        // Create directory if needed
        try? FileManager.default.createDirectory(at: audioDir, withIntermediateDirectories: true)

        let audioFile = audioDir.appendingPathComponent("\(articleID.uuidString).wav")

        // Create WAV file with header
        let wavData = createWAVFile(from: accumulatedPCMData)

        do {
            try wavData.write(to: audioFile)
            print("[StreamingTTS] Saved audio to: \(audioFile.path) (\(wavData.count) bytes)")
            return audioFile
        } catch {
            print("[StreamingTTS] Failed to save audio: \(error)")
            return nil
        }
    }

    /// Create a complete WAV file from raw PCM Int16 data
    private func createWAVFile(from pcmData: Data) -> Data {
        var wavData = Data()

        let sampleRate: UInt32 = 24000
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate: UInt32 = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign: UInt16 = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(pcmData.count)
        let fileSize = 36 + dataSize

        // RIFF header
        wavData.append("RIFF".data(using: .ascii)!)
        wavData.append(withUnsafeBytes(of: fileSize.littleEndian) { Data($0) })
        wavData.append("WAVE".data(using: .ascii)!)

        // fmt chunk
        wavData.append("fmt ".data(using: .ascii)!)
        wavData.append(withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) }) // chunk size
        wavData.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) })  // audio format (PCM)
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

    /// Parse WAV data and convert to AVAudioPCMBuffer (Float32 format)
    /// Returns both the buffer for playback and raw PCM data for caching
    private func parseWAVToPCMBufferAndData(_ wavData: Data, format: AVAudioFormat) throws -> (AVAudioPCMBuffer, Data)? {
        // WAV header is typically 44 bytes
        guard wavData.count > 44 else {
            print("[StreamingTTS] WAV data too short: \(wavData.count) bytes")
            return nil
        }

        // Verify RIFF header
        guard String(data: wavData.prefix(4), encoding: .ascii) == "RIFF" else {
            print("[StreamingTTS] Invalid WAV header")
            return nil
        }

        // Find data chunk
        var dataOffset = 12  // Skip RIFF header
        var dataSize = 0

        while dataOffset < wavData.count - 8 {
            let chunkID = String(data: wavData[dataOffset..<dataOffset+4], encoding: .ascii)
            let chunkSize = wavData.withUnsafeBytes { buffer -> Int in
                let ptr = buffer.baseAddress!.advanced(by: dataOffset + 4)
                return Int(ptr.assumingMemoryBound(to: UInt32.self).pointee)
            }

            if chunkID == "data" {
                dataOffset += 8  // Skip chunk header
                dataSize = min(chunkSize, wavData.count - dataOffset)
                break
            }

            dataOffset += 8 + chunkSize
            if chunkSize % 2 == 1 { dataOffset += 1 }  // Padding
        }

        guard dataSize > 0 else {
            print("[StreamingTTS] No data chunk found in WAV")
            return nil
        }

        // Create PCM buffer with Float32 format
        let sampleCount = dataSize / 2  // 16-bit samples = 2 bytes each
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount)) else {
            print("[StreamingTTS] Failed to create PCM buffer")
            return nil
        }

        buffer.frameLength = AVAudioFrameCount(sampleCount)

        // Get raw PCM data (Int16) for caching
        let rawPCMData = Data(wavData[dataOffset..<dataOffset + dataSize])

        // Convert Int16 PCM data to Float32
        var maxAmplitude: Float = 0
        rawPCMData.withUnsafeBytes { sourceBytes in
            guard let sourcePtr = sourceBytes.baseAddress?.assumingMemoryBound(to: Int16.self),
                  let destPtr = buffer.floatChannelData?[0] else {
                return
            }

            // Convert each Int16 sample to Float32 (normalized to -1.0 to 1.0)
            for i in 0..<sampleCount {
                let sample = Float(sourcePtr[i]) / Float(Int16.max)
                destPtr[i] = sample
                maxAmplitude = max(maxAmplitude, abs(sample))
            }
        }

        // Log if chunk appears silent (very low amplitude)
        if maxAmplitude < 0.001 {
            print("[StreamingTTS] WARNING: Silent chunk detected (max amplitude: \(maxAmplitude), samples: \(sampleCount))")
        } else {
            print("[StreamingTTS] Chunk parsed: \(sampleCount) samples, max amplitude: \(String(format: "%.3f", maxAmplitude))")
        }

        return (buffer, rawPCMData)
    }
}

// MARK: - Convenience Extension

extension StreamingTTSService {

    /// Check if streaming synthesis is available
    var isConfigured: Bool {
        backendURL != nil && authTokenProvider != nil
    }

    /// Get estimated time remaining based on current progress
    var estimatedTimeRemainingMs: Int? {
        guard progress.chunksReceived > 0, progress.totalChunks > 0 else { return nil }
        let avgDurationPerChunk = progress.totalDurationMs / progress.chunksReceived
        let remainingChunks = progress.totalChunks - progress.chunksReceived
        return avgDurationPerChunk * remainingChunks
    }
}
