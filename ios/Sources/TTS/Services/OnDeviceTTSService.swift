import Foundation
import AVFoundation

// MARK: - On-Device TTS Service

/// TTS service implementation using Apple's AVSpeechSynthesizer.
/// Provides free, on-device text-to-speech with no network dependency.
actor OnDeviceTTSService: TTSService {

    // MARK: - Properties

    let provider: VoiceProvider = .apple
    let maxTextLength: Int = 100_000 // Practical limit for on-device
    let supportsStreaming: Bool = false
    let supportsSSML: Bool = false

    private var synthesizer: AVSpeechSynthesizer?
    private var delegate: WordTrackingDelegate?
    private var activeTasks: [UUID: SynthesisTask] = [:]
    private var cachedVoices: [VoicePreset]?

    // MARK: - Initialization

    init() {
        // Synthesizer will be created lazily when needed
        // Pre-warm the voice system to avoid delays on first synthesis
        Task {
            await prewarmVoiceSystem()
        }
    }

    /// Pre-warm the voice system to load voice data
    private func prewarmVoiceSystem() {
        // Touch the voice list to ensure system loads voice data
        _ = AVSpeechSynthesisVoice.speechVoices()
    }

    // MARK: - TTSService Protocol

    var isAvailable: Bool {
        get async {
            // On-device is always available
            true
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

        // Check voice availability
        guard await isVoiceAvailable(voice) else {
            if voice.requiresDownload && !voice.isDownloaded {
                throw TTSError.voiceDownloadRequired(
                    voiceName: voice.name,
                    sizeBytes: voice.downloadSizeBytes ?? 0
                )
            }
            throw TTSError.voiceNotAvailable(voiceName: voice.name)
        }

        let taskID = UUID()
        let startTime = Date()

        // Create task tracking
        let task = SynthesisTask(
            id: taskID,
            voice: voice,
            options: options,
            sections: sections,
            isCancelled: false
        )
        activeTasks[taskID] = task

        defer {
            activeTasks.removeValue(forKey: taskID)
        }

        // Report initial progress
        progress(SynthesisProgress(
            overallProgress: 0,
            currentSectionIndex: 0,
            sectionsCompleted: 0,
            totalSections: sections.count,
            estimatedTimeRemaining: nil,
            statusMessage: "Preparing synthesis...",
            charactersProcessed: 0,
            totalCharacters: totalText.count
        ))

        // Synthesize each section
        var sectionAudioURLs: [URL] = []
        var sectionTimestamps: [SectionTimestamp] = []
        var allWordTimestamps: [WordTimestamp] = []
        var currentTime: TimeInterval = 0
        var charactersProcessed = 0

        for (index, section) in sections.enumerated() {
            // Check for cancellation
            if activeTasks[taskID]?.isCancelled == true {
                // Clean up any generated files
                for url in sectionAudioURLs {
                    try? FileManager.default.removeItem(at: url)
                }
                throw TTSError.cancelled
            }

            // Skip empty sections
            guard !section.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                continue
            }

            // Report section progress
            progress(SynthesisProgress(
                overallProgress: Float(index) / Float(sections.count),
                currentSectionIndex: index,
                sectionsCompleted: index,
                totalSections: sections.count,
                estimatedTimeRemaining: nil,
                statusMessage: "Synthesizing section \(index + 1) of \(sections.count)...",
                charactersProcessed: charactersProcessed,
                totalCharacters: totalText.count
            ))

            // Synthesize this section
            let (audioURL, duration, wordTimestamps) = try await synthesizeSection(
                section,
                voice: voice,
                options: options,
                baseTime: currentTime
            )

            sectionAudioURLs.append(audioURL)

            // Record section timestamp
            let sectionTimestamp = SectionTimestamp(
                sectionIndex: section.index,
                startTime: currentTime,
                endTime: currentTime + duration
            )
            sectionTimestamps.append(sectionTimestamp)

            // Adjust word timestamps to absolute time
            let adjustedWordTimestamps = wordTimestamps.map { wt in
                WordTimestamp(
                    word: wt.word,
                    startTime: wt.startTime + currentTime,
                    endTime: wt.endTime + currentTime,
                    sectionIndex: section.index,
                    characterRange: wt.characterRange
                )
            }
            allWordTimestamps.append(contentsOf: adjustedWordTimestamps)

            currentTime += duration
            charactersProcessed += section.text.count

            // Add pause between sections
            currentTime += section.type.pauseAfterSeconds
        }

        // Merge all section audio files into one
        progress(SynthesisProgress(
            overallProgress: 0.95,
            currentSectionIndex: sections.count - 1,
            sectionsCompleted: sections.count,
            totalSections: sections.count,
            estimatedTimeRemaining: nil,
            statusMessage: "Finalizing audio...",
            charactersProcessed: totalText.count,
            totalCharacters: totalText.count
        ))

        let mergedURL = try await mergeAudioFiles(sectionAudioURLs, format: options.outputFormat)

        // Clean up section files (but not if the merged file IS a section file)
        for url in sectionAudioURLs {
            if url != mergedURL {
                try? FileManager.default.removeItem(at: url)
            }
        }

        // Get file size
        let fileAttributes = try FileManager.default.attributesOfItem(atPath: mergedURL.path)
        let fileSize = fileAttributes[.size] as? Int64 ?? 0

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
            duration: currentTime,
            sectionTimestamps: sectionTimestamps,
            wordTimestamps: options.generateWordTimestamps ? allWordTimestamps : nil,
            fileSizeBytes: fileSize,
            cost: nil, // On-device is free
            metadata: SynthesisMetadata(
                voiceID: voice.id,
                voiceName: voice.name,
                provider: .apple,
                startedAt: startTime,
                completedAt: endTime,
                inputCharacterCount: totalText.count,
                outputSampleRate: 22050
            )
        )
    }

    func cancelSynthesis(taskID: UUID) async {
        activeTasks[taskID]?.isCancelled = true
        synthesizer?.stopSpeaking(at: .immediate)
    }

    func cancelAllSynthesis() async {
        for taskID in activeTasks.keys {
            activeTasks[taskID]?.isCancelled = true
        }
        synthesizer?.stopSpeaking(at: .immediate)
    }

    func isVoiceAvailable(_ voice: VoicePreset) async -> Bool {
        guard voice.provider == .apple else { return false }

        // Check if the voice exists in available voices
        let availableVoices = AVSpeechSynthesisVoice.speechVoices()

        // First try exact match
        if availableVoices.contains(where: { $0.identifier == voice.providerVoiceID }) {
            return true
        }

        // Fall back to any voice for the language
        if AVSpeechSynthesisVoice(language: voice.language) != nil {
            return true
        }

        // Last resort - any English voice
        if AVSpeechSynthesisVoice(language: "en-US") != nil {
            return true
        }

        return false
    }

    func availableVoices() async -> [VoicePreset] {
        // Return cached voices if available
        if let cached = cachedVoices {
            return cached
        }

        let systemVoices = AVSpeechSynthesisVoice.speechVoices()
        let presets = systemVoices.map { VoicePreset.fromAppleVoice($0) }

        cachedVoices = presets
        return presets
    }

    func downloadVoice(_ voice: VoicePreset) async throws {
        // Apple doesn't provide a programmatic way to download voices
        // Users must download via Settings > Accessibility > Spoken Content > Voices
        throw TTSError.invalidConfiguration(
            reason: "Please download enhanced voices from Settings > Accessibility > Spoken Content > Voices"
        )
    }

    func estimate(text: String, voice: VoicePreset) -> SynthesisEstimate {
        // Estimate based on average speaking rate
        // Average speaking rate is ~150 words per minute
        let wordCount = text.split(separator: " ").count
        let wordsPerMinute: Double = 150.0 * Double(voice.defaultSpeed)
        let estimatedMinutes = Double(wordCount) / wordsPerMinute
        let estimatedDuration = estimatedMinutes * 60

        // Processing is roughly real-time for on-device
        let estimatedProcessingTime = estimatedDuration * 0.3

        return SynthesisEstimate(
            estimatedDuration: estimatedDuration,
            estimatedProcessingTime: estimatedProcessingTime,
            characterCount: text.count,
            estimatedCostUSD: nil, // Free
            quotaImpact: nil // No quota
        )
    }

    // MARK: - Private Methods

    /// Synthesize a single section to audio
    private func synthesizeSection(
        _ section: TextSection,
        voice: VoicePreset,
        options: SynthesisOptions,
        baseTime: TimeInterval
    ) async throws -> (URL, TimeInterval, [WordTimestamp]) {
        // Create output URL
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("section_\(section.id.uuidString)")
            .appendingPathExtension("caf") // Core Audio Format for raw output

        // Get the AVSpeechSynthesisVoice - try exact match first, then fallbacks
        print("[TTS] Looking for voice: \(voice.name), providerVoiceID: \(voice.providerVoiceID)")
        let avVoice: AVSpeechSynthesisVoice
        if let exactVoice = AVSpeechSynthesisVoice(identifier: voice.providerVoiceID) {
            print("[TTS] Found exact voice match: \(exactVoice.identifier)")
            avVoice = exactVoice
        } else if let languageVoice = AVSpeechSynthesisVoice(language: voice.language) {
            print("[TTS] Using language fallback voice: \(languageVoice.identifier)")
            avVoice = languageVoice
        } else if let englishVoice = AVSpeechSynthesisVoice(language: "en-US") {
            print("[TTS] Using en-US fallback voice: \(englishVoice.identifier)")
            avVoice = englishVoice
        } else {
            throw TTSError.voiceNotAvailable(voiceName: voice.name)
        }

        // Try synthesis with retries for transient errors
        var lastError: Error?
        for attempt in 1...3 {
            do {
                let result = try await performSynthesis(
                    text: section.text,
                    voice: avVoice,
                    options: options,
                    voicePreset: voice,
                    sectionIndex: section.index,
                    outputURL: outputURL
                )
                return result
            } catch {
                lastError = error
                print("Synthesis attempt \(attempt) failed: \(error)")

                // Wait briefly before retry (voice system may need time to initialize)
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: UInt64(200_000_000 * attempt)) // 200ms, 400ms
                }
            }
        }

        throw lastError ?? TTSError.audioEncodingFailed(reason: "Synthesis failed after retries")
    }

    /// Perform the actual synthesis using AVSpeechSynthesizer.write()
    private func performSynthesis(
        text: String,
        voice: AVSpeechSynthesisVoice,
        options: SynthesisOptions,
        voicePreset: VoicePreset,
        sectionIndex: Int,
        outputURL: URL
    ) async throws -> (URL, TimeInterval, [WordTimestamp]) {
        // Run synthesis on main thread to avoid actor isolation issues with AVSpeechSynthesizer
        // The write() callback needs to run without actor hop deadlocks
        let speed = options.speed * voicePreset.defaultSpeed
        let pitch = options.pitch * voicePreset.defaultPitch
        let volume = options.volume * voicePreset.defaultVolume

        return try await SpeechSynthesisHelper.synthesize(
            text: text,
            voice: voice,
            rate: mapSpeedToAVSpeechRate(speed),
            pitch: pitch,
            volume: volume,
            sectionIndex: sectionIndex,
            outputURL: outputURL,
            speed: options.speed
        )
    }

    /// Save audio buffers to a file
    private nonisolated func saveBuffersToFile(
        _ buffers: [AVAudioBuffer],
        to url: URL
    ) throws -> (url: URL, duration: TimeInterval) {
        guard let firstBuffer = buffers.first as? AVAudioPCMBuffer else {
            throw TTSError.audioEncodingFailed(reason: "No audio buffers to save")
        }

        let format = firstBuffer.format

        // Calculate total frame count
        let totalFrames = buffers.reduce(0) { sum, buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return sum }
            return sum + Int(pcm.frameLength)
        }

        // Create output file
        let audioFile = try AVAudioFile(
            forWriting: url,
            settings: format.settings,
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )

        // Write all buffers
        for buffer in buffers {
            guard let pcmBuffer = buffer as? AVAudioPCMBuffer else { continue }
            try audioFile.write(from: pcmBuffer)
        }

        // Calculate duration
        let duration = Double(totalFrames) / format.sampleRate

        return (url, duration)
    }

    /// Merge multiple audio files into one
    private nonisolated func mergeAudioFiles(
        _ urls: [URL],
        format: AudioFormat
    ) async throws -> URL {
        guard !urls.isEmpty else {
            throw TTSError.audioEncodingFailed(reason: "No audio files to merge")
        }

        // If only one file, just convert it
        if urls.count == 1 {
            return try await convertAudioFile(urls[0], to: format)
        }

        // Create composition
        let composition = AVMutableComposition()
        guard let compositionTrack = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            throw TTSError.audioEncodingFailed(reason: "Could not create composition track")
        }

        var currentTime = CMTime.zero

        for url in urls {
            let asset = AVURLAsset(url: url)

            guard let assetTrack = try await asset.loadTracks(withMediaType: .audio).first else {
                continue
            }

            let duration = try await asset.load(.duration)

            try compositionTrack.insertTimeRange(
                CMTimeRange(start: .zero, duration: duration),
                of: assetTrack,
                at: currentTime
            )

            currentTime = CMTimeAdd(currentTime, duration)
        }

        // Export merged audio
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("merged_\(UUID().uuidString)")
            .appendingPathExtension(format.fileExtension)

        guard let exportSession = AVAssetExportSession(
            asset: composition,
            presetName: AVAssetExportPresetAppleM4A
        ) else {
            throw TTSError.audioEncodingFailed(reason: "Could not create export session")
        }

        exportSession.outputURL = outputURL
        exportSession.outputFileType = .m4a

        await exportSession.export()

        switch exportSession.status {
        case .completed:
            return outputURL
        case .failed:
            throw TTSError.audioEncodingFailed(
                reason: exportSession.error?.localizedDescription ?? "Export failed"
            )
        case .cancelled:
            throw TTSError.cancelled
        default:
            throw TTSError.audioEncodingFailed(reason: "Unknown export status")
        }
    }

    /// Convert audio file to specified format
    private nonisolated func convertAudioFile(_ url: URL, to format: AudioFormat) async throws -> URL {
        print("[TTS] Converting \(url.lastPathComponent) to \(format.fileExtension)...")

        // For .caf files from AVSpeechSynthesizer, AVAudioPlayer can play them directly
        // Skip conversion and just return the original file - it's more reliable
        if url.pathExtension.lowercased() == "caf" {
            print("[TTS] Using .caf file directly (AVAudioPlayer supports it)")
            return url
        }

        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("converted_\(UUID().uuidString)")
            .appendingPathExtension(format.fileExtension)

        let asset = AVURLAsset(url: url)

        guard let exportSession = AVAssetExportSession(
            asset: asset,
            presetName: AVAssetExportPresetAppleM4A
        ) else {
            print("[TTS] Warning: Could not create export session, using original file")
            return url
        }

        exportSession.outputURL = outputURL
        exportSession.outputFileType = .m4a

        await exportSession.export()

        switch exportSession.status {
        case .completed:
            print("[TTS] Conversion successful: \(outputURL.lastPathComponent)")
            return outputURL
        case .failed:
            print("[TTS] Conversion failed: \(exportSession.error?.localizedDescription ?? "unknown"), using original file")
            // Return original file as fallback - AVAudioPlayer can handle .caf
            return url
        case .cancelled:
            throw TTSError.cancelled
        default:
            print("[TTS] Unknown conversion status, using original file")
            return url
        }
    }

    /// Map our speed (0.5-3.0) to AVSpeech rate (0.0-1.0)
    private func mapSpeedToAVSpeechRate(_ speed: Float) -> Float {
        // AVSpeechUtteranceDefaultSpeechRate is ~0.5
        // AVSpeechUtteranceMinimumSpeechRate is 0.0
        // AVSpeechUtteranceMaximumSpeechRate is 1.0

        // Map our 1.0 to AVSpeech's default (~0.5)
        // Map our 0.5 to AVSpeech's ~0.25
        // Map our 3.0 to AVSpeech's ~0.75

        let defaultRate = AVSpeechUtteranceDefaultSpeechRate
        let minRate = AVSpeechUtteranceMinimumSpeechRate
        let maxRate = AVSpeechUtteranceMaximumSpeechRate

        if speed <= 1.0 {
            // Scale from min to default
            let ratio = speed / 1.0
            return minRate + (defaultRate - minRate) * ratio
        } else {
            // Scale from default to max
            let ratio = (speed - 1.0) / 2.0 // 1.0-3.0 maps to 0-1
            return defaultRate + (maxRate - defaultRate) * min(ratio, 1.0)
        }
    }
}

// MARK: - Synthesis Task

private struct SynthesisTask {
    let id: UUID
    let voice: VoicePreset
    let options: SynthesisOptions
    let sections: [TextSection]
    var isCancelled: Bool
}

// MARK: - Word Tracking Delegate

private final class WordTrackingDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let onWordBoundary: (NSRange) -> Void

    init(onWordBoundary: @escaping (NSRange) -> Void) {
        self.onWordBoundary = onWordBoundary
        super.init()
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        onWordBoundary(characterRange)
    }
}

// MARK: - SynthesisMetadata Extension

extension SynthesisMetadata {
    init(
        voiceID: UUID,
        voiceName: String,
        provider: VoiceProvider,
        startedAt: Date,
        completedAt: Date,
        inputCharacterCount: Int,
        outputSampleRate: Int
    ) {
        self.init(
            voiceID: voiceID,
            voiceName: voiceName,
            provider: provider,
            startedAt: startedAt,
            completedAt: completedAt,
            inputCharacterCount: inputCharacterCount,
            outputSampleRate: outputSampleRate,
            processingTimeSeconds: completedAt.timeIntervalSince(startedAt)
        )
    }
}
