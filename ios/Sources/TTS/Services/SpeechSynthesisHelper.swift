import Foundation
import AVFoundation

// MARK: - Speech Synthesis Helper

/// Helper class for performing AVSpeechSynthesizer.write() operations.
/// Uses a delegate-based approach to detect completion reliably.
final class SpeechSynthesisHelper: NSObject, @unchecked Sendable, AVSpeechSynthesizerDelegate {

    // MARK: - Types

    enum SynthesisError: Error, LocalizedError {
        case noAudioGenerated
        case synthesisTimeout
        case audioSessionFailed(String)
        case synthesisNotSupported
        case synthesisFailed(String)

        var errorDescription: String? {
            switch self {
            case .noAudioGenerated:
                return "No audio was generated during synthesis"
            case .synthesisTimeout:
                return "Synthesis timed out"
            case .audioSessionFailed(let reason):
                return "Audio session setup failed: \(reason)"
            case .synthesisNotSupported:
                return "Speech synthesis is not supported on this device"
            case .synthesisFailed(let reason):
                return "Synthesis failed: \(reason)"
            }
        }
    }

    // MARK: - Properties

    private var synthesizer: AVSpeechSynthesizer?
    private var buffers: [AVAudioPCMBuffer] = []
    private var continuation: CheckedContinuation<(URL, TimeInterval, [WordTimestamp]), Error>?
    private var outputURL: URL?
    private var text: String = ""
    private var sectionIndex: Int = 0
    private var speed: Float = 1.0
    private var timeoutTask: Task<Void, Never>?
    private var completionCheckTask: Task<Void, Never>?
    private var lastBufferTime: Date = Date()
    private let lock = NSLock()

    // MARK: - Static Synthesis Method

    /// Synthesize text to audio file using AVSpeechSynthesizer.write()
    static func synthesize(
        text: String,
        voice: AVSpeechSynthesisVoice,
        rate: Float,
        pitch: Float,
        volume: Float,
        sectionIndex: Int,
        outputURL: URL,
        speed: Float
    ) async throws -> (URL, TimeInterval, [WordTimestamp]) {
        let helper = SpeechSynthesisHelper()
        return try await helper.performSynthesis(
            text: text,
            voice: voice,
            rate: rate,
            pitch: pitch,
            volume: volume,
            sectionIndex: sectionIndex,
            outputURL: outputURL,
            speed: speed
        )
    }

    // MARK: - Instance Synthesis

    private func performSynthesis(
        text: String,
        voice: AVSpeechSynthesisVoice,
        rate: Float,
        pitch: Float,
        volume: Float,
        sectionIndex: Int,
        outputURL: URL,
        speed: Float
    ) async throws -> (URL, TimeInterval, [WordTimestamp]) {
        print("[TTS] Starting synthesis for text of \(text.count) chars")
        print("[TTS] Voice: \(voice.identifier), Rate: \(rate)")

        // Store parameters
        self.text = text
        self.sectionIndex = sectionIndex
        self.speed = speed
        self.outputURL = outputURL
        self.buffers = []

        // Configure audio session
        configureAudioSession()

        // Create utterance
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = rate
        utterance.pitchMultiplier = pitch
        utterance.volume = volume

        // Create synthesizer with delegate
        let synth = AVSpeechSynthesizer()
        synth.delegate = self
        self.synthesizer = synth
        self.lastBufferTime = Date()

        print("[TTS] Starting write...")

        return try await withCheckedThrowingContinuation { [weak self] continuation in
            guard let self = self else {
                print("[TTS] ERROR: self is nil")
                continuation.resume(throwing: SynthesisError.noAudioGenerated)
                return
            }

            self.continuation = continuation

            // Set dynamic timeout based on text length
            // ~5 seconds per 1000 characters, minimum 60 seconds, maximum 10 minutes
            let charCount = text.count
            let estimatedSeconds = max(60, min(600, charCount / 200))
            let timeoutNanos = UInt64(estimatedSeconds) * 1_000_000_000
            print("[TTS] Timeout set to \(estimatedSeconds) seconds for \(charCount) chars")

            self.timeoutTask = Task { [weak self, estimatedSeconds] in
                try? await Task.sleep(nanoseconds: timeoutNanos)
                if !Task.isCancelled {
                    print("[TTS] ERROR: Timeout after \(estimatedSeconds)s")
                    self?.handleTimeout()
                }
            }

            // Start a completion checker - if no buffers arrive for 2 seconds after we have data, we're done
            self.completionCheckTask = Task { [weak self] in
                // Wait a bit for synthesis to start
                try? await Task.sleep(nanoseconds: 500_000_000) // 0.5s

                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 500_000_000) // Check every 0.5s

                    guard let self = self else { break }

                    self.lock.lock()
                    let bufferCount = self.buffers.count
                    let timeSinceLastBuffer = Date().timeIntervalSince(self.lastBufferTime)
                    let hasContinuation = self.continuation != nil
                    self.lock.unlock()

                    // If we have buffers and haven't received one in 1.5 seconds, synthesis is done
                    if bufferCount > 0 && timeSinceLastBuffer > 1.5 && hasContinuation {
                        print("[TTS] No new buffers for 1.5s - assuming synthesis complete")
                        self.finishSynthesis()
                        break
                    }
                }
            }

            // Start synthesis - the callback will be called multiple times
            synth.write(utterance) { [weak self] buffer in
                self?.handleBuffer(buffer)
            }
        }
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        print("[TTS] Delegate: didFinish called")
        finishSynthesis()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        print("[TTS] Delegate: didCancel called")
        lock.lock()
        let cont = continuation
        continuation = nil
        lock.unlock()

        cont?.resume(throwing: SynthesisError.synthesisFailed("Synthesis was cancelled"))
    }

    // MARK: - Buffer Handling

    private func handleBuffer(_ buffer: AVAudioBuffer?) {
        if let pcmBuffer = buffer as? AVAudioPCMBuffer, pcmBuffer.frameLength > 0 {
            lock.lock()
            buffers.append(pcmBuffer)
            lastBufferTime = Date()
            let count = buffers.count
            lock.unlock()

            // Log every 100 buffers to reduce noise
            if count % 100 == 0 {
                print("[TTS] Progress: \(count) buffers received...")
            }
        } else {
            // Nil or empty buffer signals completion
            lock.lock()
            let count = buffers.count
            lock.unlock()
            print("[TTS] Received nil/empty buffer - \(count) total buffers")
            finishSynthesis()
        }
    }

    private func finishSynthesis() {
        // Cancel tasks
        timeoutTask?.cancel()
        timeoutTask = nil
        completionCheckTask?.cancel()
        completionCheckTask = nil

        lock.lock()
        let cont = continuation
        continuation = nil
        let buffersCopy = buffers
        lock.unlock()

        guard let continuation = cont else {
            print("[TTS] finishSynthesis called but no continuation (already finished)")
            return
        }

        if buffersCopy.isEmpty {
            print("[TTS] ERROR: No buffers were generated")
            continuation.resume(throwing: SynthesisError.noAudioGenerated)
            return
        }

        print("[TTS] Saving \(buffersCopy.count) buffers to file...")
        do {
            let result = try saveBuffersToFile()
            print("[TTS] SUCCESS: Saved audio file, duration: \(result.1)s")
            continuation.resume(returning: result)
        } catch {
            print("[TTS] ERROR saving file: \(error)")
            continuation.resume(throwing: error)
        }
    }

    private func handleTimeout() {
        lock.lock()
        let cont = continuation
        continuation = nil
        let bufferCount = buffers.count
        lock.unlock()

        completionCheckTask?.cancel()
        completionCheckTask = nil
        timeoutTask = nil

        // If we have buffers, try to save what we have instead of failing
        if bufferCount > 0 {
            print("[TTS] Timeout but have \(bufferCount) buffers - attempting to save")
            guard let cont = cont else { return }
            do {
                let result = try saveBuffersToFile()
                print("[TTS] SUCCESS: Saved partial audio, duration: \(result.1)s")
                cont.resume(returning: result)
            } catch {
                print("[TTS] ERROR saving partial file: \(error)")
                cont.resume(throwing: error)
            }
            return
        }

        synthesizer?.stopSpeaking(at: .immediate)
        cont?.resume(throwing: SynthesisError.synthesisTimeout)
    }

    // MARK: - Audio Session Configuration

    private func configureAudioSession() {
        #if os(iOS)
        let audioSession = AVAudioSession.sharedInstance()
        do {
            // Use playback category for synthesis
            try audioSession.setCategory(.playback, mode: .spokenAudio, options: [])
            try audioSession.setActive(true)
        } catch {
            print("Audio session warning: \(error.localizedDescription)")
        }
        #endif
    }

    // MARK: - Save Buffers to File

    private func saveBuffersToFile() throws -> (URL, TimeInterval, [WordTimestamp]) {
        guard let outputURL = outputURL,
              let firstBuffer = buffers.first else {
            throw TTSError.audioEncodingFailed(reason: "No buffers to save")
        }

        let format = firstBuffer.format

        // Calculate total frame count
        let totalFrames = buffers.reduce(0) { sum, buffer in
            sum + Int(buffer.frameLength)
        }

        // Create output file
        let audioFile = try AVAudioFile(
            forWriting: outputURL,
            settings: format.settings,
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )

        // Write all buffers
        for buffer in buffers {
            try audioFile.write(from: buffer)
        }

        // Calculate duration
        let duration = Double(totalFrames) / format.sampleRate

        // Generate word timestamps
        let wordTimestamps = generateWordTimestamps(duration: duration)

        return (outputURL, duration, wordTimestamps)
    }

    private func generateWordTimestamps(duration: TimeInterval) -> [WordTimestamp] {
        let words = text.split(separator: " ").map(String.init)
        guard !words.isEmpty else { return [] }

        let timePerWord = duration / Double(words.count)

        var timestamps: [WordTimestamp] = []
        var currentTime: TimeInterval = 0
        var currentCharIndex = 0

        for word in words {
            let startIndex = currentCharIndex
            let endIndex = startIndex + word.count

            timestamps.append(WordTimestamp(
                word: word,
                startTime: currentTime,
                endTime: currentTime + timePerWord,
                sectionIndex: sectionIndex,
                characterRange: startIndex..<endIndex
            ))

            currentTime += timePerWord
            currentCharIndex = endIndex + 1
        }

        return timestamps
    }
}
