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

    // MARK: - Properties

    private let ttsManager: TTSManager
    private let cacheManager: AudioCacheManager
    private var currentTaskID: UUID?
    private var cancellables = Set<AnyCancellable>()

    // Voice selection state
    @Published var selectedVoice: VoicePreset?
    @Published var defaultSpeed: Float = 1.0
    @Published var defaultPitch: Float = 1.0

    // MARK: - Singleton

    static let shared = TTSCoordinator()

    // MARK: - Initialization

    private init() {
        self.ttsManager = TTSManager.shared
        self.cacheManager = AudioCacheManager.shared

        // Load default voice
        Task {
            await loadAvailableVoices()
        }
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
        voices.append(contentsOf: VoicePreset.allCharacterVoices)

        // Sort by name
        availableVoices = voices.sorted { $0.name < $1.name }

        // Set default voice if not set
        if selectedVoice == nil {
            selectedVoice = availableVoices.first { $0.provider == .apple && $0.language.starts(with: "en") }
        }
    }

    /// Select a voice for synthesis
    func selectVoice(_ voice: VoicePreset) {
        selectedVoice = voice
        defaultSpeed = voice.defaultSpeed
        defaultPitch = voice.defaultPitch
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

    /// Synthesize text to audio
    /// - Parameters:
    ///   - text: The text to synthesize
    ///   - voice: The voice to use (or uses selected voice)
    ///   - options: Synthesis options (or uses defaults)
    /// - Returns: URL to the generated audio file
    func synthesize(
        text: String,
        voice: VoicePreset? = nil,
        options: SynthesisOptions? = nil
    ) async throws -> URL {
        let voiceToUse = voice ?? selectedVoice ?? availableVoices.first!
        var optionsToUse = options ?? .default
        optionsToUse.speed = defaultSpeed
        optionsToUse.pitch = defaultPitch

        // Check cache first
        let cacheKey = cacheManager.cacheKey(text: text, voice: voiceToUse, options: optionsToUse)
        if let cachedURL = await cacheManager.getCachedAudio(for: cacheKey) {
            return cachedURL
        }

        // Synthesize
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
                text: text,
                voice: voiceToUse,
                options: optionsToUse
            )

            // Cache the result
            await cacheManager.cacheAudio(at: result.audioFileURL, for: cacheKey)

            return result.audioFileURL
        } catch let error as TTSError {
            lastError = error
            throw error
        } catch {
            let ttsError = TTSError.internalError(reason: error.localizedDescription)
            lastError = ttsError
            throw ttsError
        }
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
        guard let entry = cacheIndex[key] else { return nil }

        // Check if file still exists
        guard FileManager.default.fileExists(atPath: entry.fileURL.path) else {
            cacheIndex.removeValue(forKey: key)
            return nil
        }

        // Update last accessed time
        var updatedEntry = entry
        updatedEntry = CacheEntry(
            key: entry.key,
            fileURL: entry.fileURL,
            createdAt: entry.createdAt,
            lastAccessedAt: Date(),
            sizeBytes: entry.sizeBytes
        )
        cacheIndex[key] = updatedEntry

        return entry.fileURL
    }

    func cacheAudio(at sourceURL: URL, for key: String) {
        let fileName = "\(key).\(sourceURL.pathExtension)"
        let destinationURL = cacheDirectory.appendingPathComponent(fileName)

        do {
            // Copy file to cache
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.copyItem(at: sourceURL, to: destinationURL)

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
        } catch {
            print("Failed to cache audio: \(error)")
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
