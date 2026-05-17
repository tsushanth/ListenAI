import Foundation
import AVFoundation
import UIKit

#if canImport(FluidAudio)
import FluidAudio
import CoreML
#endif

// MARK: - Kokoro On-Device TTS Service
//
// Runs Kokoro 82M neural TTS entirely on device via the FluidAudio Swift SDK,
// which routes inference to Apple's Neural Engine (ANE) on supported devices and
// gracefully falls back to GPU/CPU on older chips. Same architectural pattern as
// SecureVox (WhisperKit) and ClearVoice (Core ML directly):
//
//   • pure SwiftPM, no C++ glue
//   • Apple Core ML — automatic ANE / GPU / CPU selection
//   • models auto-downloaded from FluidInference HF repo on first use
//
// Eligibility is gated by KokoroModelManager.isDeviceEligible (≥6 GB RAM, iOS 17+).
//
// Voices exposed in UI (matches KokoroVoiceCatalog below):
//   • af_bella    — American Female (warm)
//   • am_michael  — American Male (clear)
//   • bf_emma     — British Female (professional)
//   • bm_george   — British Male (mature)
//
// The FluidAudio package itself handles model lifecycle (download / cache / load).
// `KokoroModelManager` is retained for UI surfacing of download progress and the
// "Offline AI" toggle, but actual file management is delegated to FluidAudio.

actor KokoroOnDeviceTTSService: TTSService {

    // MARK: - Singleton

    /// Shared instance — used by both TTSManager (for synthesis) and Settings UI
    /// (for the "Offline AI" toggle's prepare/download trigger). Sharing keeps the
    /// loaded `KokoroTtsManager` (and its compiled Core ML graphs) resident so we
    /// don't pay download/compile cost twice.
    static let shared = KokoroOnDeviceTTSService()

    // MARK: - TTSService Protocol

    let provider: VoiceProvider = .kokoroOnDevice
    let maxTextLength: Int = 50_000
    let supportsStreaming: Bool = false
    let supportsSSML: Bool = true   // FluidAudio supports <phoneme>, <sub>, <say-as>

    private var manager: KokoroManagerHandle? = nil
    private var activeTaskIDs: Set<UUID> = []

    // MARK: - Availability

    var isAvailable: Bool {
        get async {
            guard KokoroModelManager.isDeviceEligible else { return false }
            return manager != nil
        }
    }

    // MARK: - Sectioned Synthesis

    func synthesize(
        sections: [TextSection],
        voice: VoicePreset,
        options: SynthesisOptions,
        progress: @escaping @Sendable (SynthesisProgress) -> Void
    ) async throws -> SynthesisResult {

        let totalText = sections.map(\.text).joined(separator: " ")
        guard !totalText.isEmpty else { throw TTSError.textEmpty }
        guard totalText.count <= maxTextLength else {
            throw TTSError.textTooLong(characterCount: totalText.count, limit: maxTextLength)
        }

        try await ensureReady()
        guard let handle = manager else { throw KokoroError.modelNotReady }
        let voiceID = mapVoiceID(voice)

        let taskID = UUID()
        activeTaskIDs.insert(taskID)
        defer { activeTaskIDs.remove(taskID) }

        let startedAt = Date()
        var sectionTimestamps: [SectionTimestamp] = []
        var allSamples: [Int16] = []
        var sampleRate: Int = 24_000
        var cursorTime: TimeInterval = 0
        var charactersProcessed = 0

        progress(SynthesisProgress(
            overallProgress: 0,
            currentSectionIndex: 0,
            sectionsCompleted: 0,
            totalSections: sections.count,
            estimatedTimeRemaining: nil,
            statusMessage: "Synthesizing on device...",
            charactersProcessed: 0,
            totalCharacters: totalText.count
        ))

        for (index, section) in sections.enumerated() {
            try Task.checkCancellation()
            let trimmed = section.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            // Pre-chunk sentence-by-sentence so each FluidAudio call stays under
            // the 71-token short-variant threshold. Empirical ratio in real
            // English content is closer to ~1 char per phoneme token (the
            // tokenizer counts spaces, punctuation, and individual phonemes),
            // so 70 chars ≈ 70 tokens — just inside the short capacity. This
            // keeps us in the 5 s variant, avoids the on-demand 15 s download,
            // and keeps memory low enough for 4 GB devices.
            // 40-char limit. Empirical: number words ("forty-four million four
            // hundred forty thousand four hundred fourteen") tokenize at ~1.07
            // tokens/char, so a 69-char chunk hit 74 tokens — just over the 5s
            // model's 71-token threshold — and got promoted to 15s which OOMs
            // on iPhone 12 (3.6 GB). 40 chars keeps tokens ≤ ~50 even for
            // pathological number-heavy text, with safety margin under 71.
            let chunks = Self.splitIntoSafeChunks(section.text, maxChars: 40)

            let sectionStartTime = cursorTime
            for (chunkIdx, chunk) in chunks.enumerated() {
                try Task.checkCancellation()

                // Per-chunk fault isolation. Earlier behavior: a single chunk
                // throwing aborted the whole article — typical on PDFs where
                // one weird sequence (numerals, foreign chars, very long
                // tokens) trips FluidAudio's tokenizer or OOMs the 15 s
                // variant on low-RAM devices. Now we log + insert ~250 ms of
                // silence so the user keeps hearing the rest of the article
                // instead of getting stuck mid-playback.
                do {
                    let result = try await handle.synthesize(text: chunk, voice: voiceID, speed: options.speed)
                    sampleRate = result.sampleRate
                    allSamples.append(contentsOf: result.samples)
                    let chunkDur = TimeInterval(result.samples.count) / TimeInterval(sampleRate)
                    cursorTime += chunkDur
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    print("[KokoroOnDevice] Chunk \(chunkIdx + 1)/\(chunks.count) failed (len=\(chunk.count)): \(error.localizedDescription) — inserting silence and continuing")
                    let silenceSamples = Array(repeating: Int16(0), count: sampleRate / 4)
                    allSamples.append(contentsOf: silenceSamples)
                    cursorTime += 0.25
                }

                charactersProcessed += chunk.count

                progress(SynthesisProgress(
                    overallProgress: Float(index) / Float(sections.count) + Float(chunkIdx + 1) / Float(max(1, chunks.count) * sections.count),
                    currentSectionIndex: index,
                    sectionsCompleted: index,
                    totalSections: sections.count,
                    estimatedTimeRemaining: nil,
                    statusMessage: "Synthesizing… (section \(index + 1)/\(sections.count), chunk \(chunkIdx + 1)/\(chunks.count))",
                    charactersProcessed: charactersProcessed,
                    totalCharacters: totalText.count
                ))
            }

            sectionTimestamps.append(SectionTimestamp(
                sectionIndex: section.index,
                startTime: sectionStartTime,
                endTime: cursorTime
            ))
            cursorTime += section.type.pauseAfterSeconds

            progress(SynthesisProgress(
                overallProgress: Float(index + 1) / Float(sections.count),
                currentSectionIndex: index,
                sectionsCompleted: index + 1,
                totalSections: sections.count,
                estimatedTimeRemaining: nil,
                statusMessage: "Synthesized \(index + 1) of \(sections.count)",
                charactersProcessed: charactersProcessed,
                totalCharacters: totalText.count
            ))
        }

        let outputURL = try writeWAV(samples: allSamples, sampleRate: sampleRate)
        let attrs = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        let fileSize = (attrs[.size] as? Int64) ?? 0

        progress(SynthesisProgress(
            overallProgress: 1.0,
            currentSectionIndex: max(0, sections.count - 1),
            sectionsCompleted: sections.count,
            totalSections: sections.count,
            estimatedTimeRemaining: 0,
            statusMessage: "Complete",
            charactersProcessed: totalText.count,
            totalCharacters: totalText.count
        ))

        return SynthesisResult(
            audioFileURL: outputURL,
            duration: cursorTime,
            sectionTimestamps: sectionTimestamps,
            wordTimestamps: nil,
            fileSizeBytes: fileSize,
            cost: nil,
            metadata: SynthesisMetadata(
                voiceID: voice.id,
                voiceName: voice.name,
                provider: .kokoroOnDevice,
                startedAt: startedAt,
                completedAt: Date(),
                inputCharacterCount: totalText.count,
                outputSampleRate: sampleRate,
                processingTimeSeconds: Date().timeIntervalSince(startedAt)
            )
        )
    }

    // MARK: - Streaming (not supported by Kokoro single-pass model)

    nonisolated func synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions
    ) -> AsyncThrowingStream<AudioChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: TTSError.internalError(reason: "Streaming not supported by on-device Kokoro service"))
        }
    }

    // MARK: - Cancellation

    func cancelSynthesis(taskID: UUID) async {
        activeTaskIDs.remove(taskID)
    }

    func cancelAllSynthesis() async {
        activeTaskIDs.removeAll()
    }

    // MARK: - Voices

    func isVoiceAvailable(_ voice: VoicePreset) async -> Bool {
        guard voice.provider == .kokoroOnDevice else { return false }
        return await isAvailable
    }

    func availableVoices() async -> [VoicePreset] {
        // Voice presets for Kokoro are seeded by VoicePresetManager using
        // KokoroVoiceCatalog. This method returns an empty list; the picker
        // uses the catalogue directly to construct the full presets.
        return []
    }

    func downloadVoice(_ voice: VoicePreset) async throws {
        // FluidAudio handles model download internally on first synthesize().
        // Trigger initialization to kick off the download.
        try await ensureReady()
    }

    nonisolated func estimate(text: String, voice: VoicePreset) -> SynthesisEstimate {
        let charCount = text.count
        let estDuration = TimeInterval(max(1, charCount)) / 14.0
        // Kokoro on Apple Silicon Core ML ANE: ~25× realtime factor (M-series).
        // iPhone A14+ should be ~10-15× realtime.
        return SynthesisEstimate(
            estimatedDuration: estDuration,
            estimatedProcessingTime: estDuration * 0.08,
            characterCount: charCount,
            estimatedCostUSD: 0,
            quotaImpact: nil
        )
    }

    // MARK: - Internal

    private func ensureReady() async throws {
        guard KokoroModelManager.isDeviceEligible else {
            await MainActor.run { KokoroModelManager.shared.markFailed("Device not eligible — requires iOS 17 or later") }
            throw KokoroError.deviceIneligible
        }
        if manager != nil { return }

        let ramGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824.0
        var sys = utsname()
        uname(&sys)
        let model = withUnsafePointer(to: &sys.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
        }
        print("[Kokoro] Initializing on device: model=\(model) RAM=\(String(format: "%.1f", ramGB)) GB iOS=\(UIDevice.current.systemVersion)")

        await MainActor.run { KokoroModelManager.shared.markPreparing() }
        do {
            let t0 = Date()
            manager = try await KokoroManagerHandle.create()
            let elapsed = Date().timeIntervalSince(t0)
            print("[Kokoro] Model ready in \(String(format: "%.1f", elapsed))s on \(model)")
            await MainActor.run { KokoroModelManager.shared.markReady() }
        } catch {
            let detail = "Init failed on \(model) (\(String(format: "%.1f", ramGB)) GB RAM): \(error.localizedDescription)"
            print("[Kokoro] ❌ \(detail)")
            await MainActor.run { KokoroModelManager.shared.markFailed(detail) }
            throw error
        }
    }

    private func mapVoiceID(_ voice: VoicePreset) -> String {
        if let id = voice.kokoroVoiceID, !id.isEmpty, KokoroVoiceCatalog.allIDs.contains(id) {
            return id
        }
        if KokoroVoiceCatalog.allIDs.contains(voice.providerVoiceID) {
            return voice.providerVoiceID
        }
        return "af_bella"
    }

    /// Sentence-aware chunker. Greedy: glue sentences together up to `maxChars`,
    /// hard-split anything that doesn't fit into ≤maxChars windows on word
    /// boundaries (then on character boundaries as a last resort). Each emitted
    /// chunk should produce ≤71 phoneme tokens for typical English so FluidAudio
    /// keeps using its 5 s short-variant Core ML graph (no parallel TaskGroup).
    nonisolated static func splitIntoSafeChunks(_ text: String, maxChars: Int) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        if trimmed.count <= maxChars { return [trimmed] }

        // Split on sentence-terminating punctuation, keeping the punctuation.
        var sentences: [String] = []
        var current = ""
        for ch in trimmed {
            current.append(ch)
            if ch == "." || ch == "!" || ch == "?" || ch == "\n" {
                let s = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !s.isEmpty { sentences.append(s) }
                current = ""
            }
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { sentences.append(tail) }

        var chunks: [String] = []
        var buf = ""
        for s in sentences {
            // If a single sentence is itself too big, hard-split it on words.
            if s.count > maxChars {
                if !buf.isEmpty { chunks.append(buf); buf = "" }
                chunks.append(contentsOf: hardSplit(s, maxChars: maxChars))
                continue
            }
            if buf.isEmpty {
                buf = s
            } else if buf.count + 1 + s.count <= maxChars {
                buf += " " + s
            } else {
                chunks.append(buf)
                buf = s
            }
        }
        if !buf.isEmpty { chunks.append(buf) }
        return chunks
    }

    nonisolated private static func hardSplit(_ s: String, maxChars: Int) -> [String] {
        var out: [String] = []
        var buf = ""
        for word in s.split(separator: " ") {
            let w = String(word)
            if w.count > maxChars {
                if !buf.isEmpty { out.append(buf); buf = "" }
                // Last-resort character split.
                var idx = w.startIndex
                while idx < w.endIndex {
                    let next = w.index(idx, offsetBy: maxChars, limitedBy: w.endIndex) ?? w.endIndex
                    out.append(String(w[idx..<next]))
                    idx = next
                }
                continue
            }
            if buf.isEmpty {
                buf = w
            } else if buf.count + 1 + w.count <= maxChars {
                buf += " " + w
            } else {
                out.append(buf)
                buf = w
            }
        }
        if !buf.isEmpty { out.append(buf) }
        return out
    }

    /// Write 16-bit PCM samples to a WAV file in the temp directory.
    private func writeWAV(samples: [Int16], sampleRate: Int) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kokoro-\(UUID().uuidString).wav")

        var data = Data()
        let dataSize = samples.count * 2
        let chunkSize = 36 + dataSize

        data.append(contentsOf: Array("RIFF".utf8))
        data.append(contentsOf: UInt32(chunkSize).leBytes)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.append(contentsOf: UInt32(16).leBytes)
        data.append(contentsOf: UInt16(1).leBytes)              // PCM
        data.append(contentsOf: UInt16(1).leBytes)              // Mono
        data.append(contentsOf: UInt32(sampleRate).leBytes)
        data.append(contentsOf: UInt32(sampleRate * 2).leBytes) // byte rate
        data.append(contentsOf: UInt16(2).leBytes)              // block align
        data.append(contentsOf: UInt16(16).leBytes)             // bits per sample
        data.append(contentsOf: Array("data".utf8))
        data.append(contentsOf: UInt32(dataSize).leBytes)
        samples.withUnsafeBufferPointer { ptr in
            data.append(UnsafeBufferPointer(start: ptr.baseAddress, count: ptr.count))
        }
        try data.write(to: url)
        return url
    }
}

// MARK: - Voice Catalog

enum KokoroVoiceCatalog {
    struct Entry {
        let id: String
        let displayName: String
        let language: String
        let region: String
        let isFemale: Bool
    }

    static let entries: [Entry] = [
        .init(id: "af_bella",   displayName: "Bella (US)",   language: "en-US", region: "US", isFemale: true),
        .init(id: "am_michael", displayName: "Michael (US)", language: "en-US", region: "US", isFemale: false),
        .init(id: "bf_emma",    displayName: "Emma (UK)",    language: "en-GB", region: "GB", isFemale: true),
        .init(id: "bm_george",  displayName: "George (UK)",  language: "en-GB", region: "GB", isFemale: false),
    ]

    static let allIDs: Set<String> = Set(entries.map(\.id))

    static func entry(for id: String) -> Entry? {
        entries.first { $0.id == id }
    }
}

// MARK: - FluidAudio Wrapper
//
// Isolated so the rest of the codebase compiles cleanly even when the
// FluidAudio SwiftPM package is not yet linked. Real inference runs only
// when `canImport(FluidAudio)` is true; otherwise create() throws.

struct PCMResult {
    let samples: [Int16]
    let sampleRate: Int
}

actor KokoroManagerHandle {

    #if canImport(FluidAudio)

    private let manager: KokoroTtsManager

    init(manager: KokoroTtsManager) {
        self.manager = manager
    }

    static func create() async throws -> KokoroManagerHandle {
        // The ANE compiler bug "Cannot retrieve vector from IRValue format int32"
        // surfaces on both iOS 18 (iPhone 12 / A14) and iOS 26+. Use .cpuAndGPU
        // unconditionally — Apple Neural Engine path is too unreliable across
        // OS versions for this model and was producing silent audio on iPhone 12.
        // The perf hit on newer Apple Silicon is acceptable given the alternative.
        let computeUnits: MLComputeUnits = .cpuAndGPU

        // One-time migration: earlier builds downloaded the 15s variant which
        // OOMs on iPhone 11/12/13/SE3 (~3.6 GB usable). Remove cached 15s files
        // so FluidAudio doesn't try to load them. Idempotent — does nothing if
        // already cleaned. Only runs once per device per app version.
        cleanup15sVariantIfNeeded()

        // Only download the 5s short variant. The 15s variant fits in 8 GB+
        // devices but OOMs on iPhone 11/12/13/SE3 (4 GB RAM, ~3.6 GB after
        // system reservation). We aggressively chunk text in
        // `splitIntoSafeChunks` (max 50 chars) to keep tokens under the 5s
        // model's 71-token short threshold so promotion never happens.
        let progressHandler: DownloadUtils.ProgressHandler = { snapshot in
            Task { @MainActor in
                KokoroModelManager.shared.updateProgress(snapshot.fractionCompleted)
            }
        }
        let models = try await TtsModels.download(
            variants: [.fiveSecond],
            computeUnits: computeUnits,
            progressHandler: progressHandler
        )
        let m = KokoroTtsManager(computeUnits: computeUnits)
        try await m.initialize(models: models)
        return KokoroManagerHandle(manager: m)
    }

    func synthesize(text: String, voice: String, speed: Float) async throws -> PCMResult {
        // FluidAudio returns 24 kHz 16-bit PCM as Data.
        let audioData: Data = try await manager.synthesize(
            text: text,
            voice: voice,
            voiceSpeed: speed
        )

        // Strip RIFF/WAV header if present and read raw int16 samples.
        let samples = audioData.toInt16PCMSamples()
        return PCMResult(samples: samples, sampleRate: 24_000)
    }

    /// Remove cached 15s variant files left over from earlier builds.
    /// FluidAudio caches under Library/Caches/fluidaudio/Models/kokoro.
    /// Files for the 15s variant include "15s" in their name. Idempotent:
    /// guarded by a UserDefaults flag so it runs once per app version.
    private static func cleanup15sVariantIfNeeded() {
        let flagKey = "ReadAloud.kokoroCache.cleaned15s.v1"
        if UserDefaults.standard.bool(forKey: flagKey) { return }

        let fm = FileManager.default
        guard let cacheDir = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let kokoroDir = cacheDir.appendingPathComponent("fluidaudio/Models/kokoro", isDirectory: true)
        guard fm.fileExists(atPath: kokoroDir.path) else {
            // No cache yet → nothing to clean. Mark done so we don't keep checking.
            UserDefaults.standard.set(true, forKey: flagKey)
            return
        }

        var removed = 0
        if let enumerator = fm.enumerator(at: kokoroDir, includingPropertiesForKeys: nil) {
            for case let url as URL in enumerator where url.lastPathComponent.contains("15s") {
                try? fm.removeItem(at: url)
                removed += 1
            }
        }
        UserDefaults.standard.set(true, forKey: flagKey)
        if removed > 0 {
            print("[Kokoro] Cleaned \(removed) stale 15s-variant file(s) from cache")
        }
    }

    #else

    static func create() async throws -> KokoroManagerHandle {
        throw KokoroError.inferenceFailed("FluidAudio SwiftPM package not linked. Add https://github.com/FluidInference/FluidAudio as a dependency.")
    }

    func synthesize(text: String, voice: String, speed: Float) async throws -> PCMResult {
        throw KokoroError.inferenceFailed("FluidAudio SwiftPM package not linked")
    }

    #endif
}

// MARK: - Helpers

private extension UInt32 {
    var leBytes: [UInt8] {
        withUnsafeBytes(of: self.littleEndian) { Array($0) }
    }
}

private extension UInt16 {
    var leBytes: [UInt8] {
        withUnsafeBytes(of: self.littleEndian) { Array($0) }
    }
}

#if canImport(FluidAudio)
private extension Data {
    /// Decode a WAV/RIFF blob (or raw PCM) into 16-bit signed mono samples.
    /// Best-effort: skips a 44-byte RIFF header if detected, otherwise treats
    /// the whole buffer as raw PCM little-endian int16.
    func toInt16PCMSamples() -> [Int16] {
        var payload = self
        if payload.count > 44, payload.starts(with: Array("RIFF".utf8)) {
            payload = payload.dropFirst(44)
        }
        let count = payload.count / 2
        var samples = [Int16](repeating: 0, count: count)
        payload.withUnsafeBytes { rawBuf in
            guard let base = rawBuf.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0..<count { samples[i] = Int16(littleEndian: base[i]) }
        }
        return samples
    }
}
#endif
