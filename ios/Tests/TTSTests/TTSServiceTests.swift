import XCTest
@testable import ListenAI

final class TTSServiceTests: XCTestCase {

    // MARK: - VoicePreset Tests

    func testVoicePresetCreation() {
        let voice = VoicePreset(
            name: "Test Voice",
            provider: .apple,
            providerVoiceID: "com.apple.voice.test",
            language: "en-US",
            gender: .female,
            tier: .free
        )

        XCTAssertEqual(voice.name, "Test Voice")
        XCTAssertEqual(voice.provider, .apple)
        XCTAssertEqual(voice.tier, .free)
        XCTAssertFalse(voice.isCharacterVoice)
    }

    func testCharacterVoicePresets() {
        let storyteller = VoicePreset.storyteller

        XCTAssertEqual(storyteller.name, "Josh")
        XCTAssertTrue(storyteller.isCharacterVoice)
        XCTAssertEqual(storyteller.characterID, "storyteller")
        XCTAssertEqual(storyteller.tier, .free)
        XCTAssertNotNil(storyteller.kokoroVoiceID)
    }

    func testAllCharacterVoices() {
        let characters = VoicePreset.characterPresets

        XCTAssertFalse(characters.isEmpty)
        XCTAssertTrue(characters.allSatisfy { $0.isCharacterVoice })
    }

    // MARK: - SynthesisOptions Tests

    func testDefaultSynthesisOptions() {
        let options = SynthesisOptions.default

        XCTAssertEqual(options.speed, 1.0)
        XCTAssertEqual(options.pitch, 1.0)
        XCTAssertEqual(options.volume, 1.0)
        XCTAssertEqual(options.outputFormat, .m4a)
    }

    func testSynthesisOptionsWithSpeed() {
        let options = SynthesisOptions.withSpeed(1.5)

        XCTAssertEqual(options.speed, 1.5)
        XCTAssertEqual(options.pitch, 1.0) // Default
    }

    // MARK: - CloudVoiceSettings Tests

    func testDefaultCloudSettings() {
        let settings = CloudVoiceSettings.default

        XCTAssertEqual(settings.stability, 0.5)
        XCTAssertEqual(settings.similarityBoost, 0.75)
        XCTAssertTrue(settings.useSpeakerBoost)
    }

    func testNarrativeCloudSettings() {
        let settings = CloudVoiceSettings.narrative

        XCTAssertEqual(settings.stability, 0.7)
        XCTAssertGreaterThan(settings.style, 0)
    }

    // MARK: - TTSError Tests

    func testErrorDescriptions() {
        let voiceError = TTSError.voiceNotAvailable(voiceName: "Test")
        XCTAssertTrue(voiceError.errorDescription?.contains("Test") ?? false)

        let quotaError = TTSError.quotaExceeded(remaining: 100, required: 500)
        XCTAssertTrue(quotaError.errorDescription?.contains("100") ?? false)

        let cancelledError = TTSError.cancelled
        XCTAssertEqual(cancelledError.errorDescription, "Synthesis was cancelled.")
    }

    // MARK: - SectionType Tests

    func testSectionTypePauses() {
        XCTAssertGreaterThan(SectionType.title.pauseAfterSeconds, SectionType.paragraph.pauseAfterSeconds)
        XCTAssertGreaterThan(SectionType.heading.pauseAfterSeconds, SectionType.listItem.pauseAfterSeconds)
    }

    func testSectionTypeShouldSpeak() {
        XCTAssertTrue(SectionType.paragraph.shouldSpeak)
        XCTAssertTrue(SectionType.title.shouldSpeak)
        XCTAssertFalse(SectionType.codeBlock.shouldSpeak)
    }

    // MARK: - TextSection Tests

    func testTextSectionCreation() {
        let section = TextSection(
            index: 0,
            type: .paragraph,
            text: "Hello, world!",
            characterRange: 0..<13
        )

        XCTAssertEqual(section.index, 0)
        XCTAssertEqual(section.text, "Hello, world!")
        XCTAssertEqual(section.type, .paragraph)
    }

    // MARK: - SynthesisEstimate Tests

    func testSynthesisEstimate() {
        let estimate = SynthesisEstimate(
            estimatedDuration: 60.0,
            estimatedProcessingTime: 5.0,
            characterCount: 1000,
            estimatedCostUSD: Decimal(string: "0.30"),
            quotaImpact: QuotaImpact(
                minutesUsed: 1,
                minutesRemaining: 99,
                percentageOfQuota: 0.01,
                willExceedQuota: false
            )
        )

        XCTAssertEqual(estimate.estimatedDuration, 60.0)
        XCTAssertEqual(estimate.characterCount, 1000)
        XCTAssertFalse(estimate.quotaImpact?.willExceedQuota ?? true)
    }

    // MARK: - VoiceProvider Tests

    func testVoiceProviderDisplayNames() {
        XCTAssertEqual(VoiceProvider.apple.displayName, "Apple")
        XCTAssertEqual(VoiceProvider.elevenLabs.displayName, "ElevenLabs")
        XCTAssertEqual(VoiceProvider.openAI.displayName, "OpenAI")
    }

    func testVoiceProviderIsCloudBased() {
        XCTAssertFalse(VoiceProvider.apple.isCloudBased)
        XCTAssertTrue(VoiceProvider.elevenLabs.isCloudBased)
        XCTAssertTrue(VoiceProvider.openAI.isCloudBased)
        XCTAssertTrue(VoiceProvider.googleCloud.isCloudBased)
    }

    // MARK: - AudioFormat Tests

    func testAudioFormatMimeTypes() {
        XCTAssertEqual(AudioFormat.mp3.mimeType, "audio/mpeg")
        XCTAssertEqual(AudioFormat.m4a.mimeType, "audio/mp4")
        XCTAssertEqual(AudioFormat.wav.mimeType, "audio/wav")
    }

    func testAudioFormatExtensions() {
        XCTAssertEqual(AudioFormat.mp3.fileExtension, "mp3")
        XCTAssertEqual(AudioFormat.m4a.fileExtension, "m4a")
    }
}

// MARK: - Mock Tests

final class MockTTSServiceTests: XCTestCase {

    func testOnDeviceServiceProvider() async {
        let service = OnDeviceTTSService()
        let provider = await service.provider

        XCTAssertEqual(provider, .apple)
    }

    func testOnDeviceServiceAvailability() async {
        let service = OnDeviceTTSService()
        let available = await service.isAvailable

        XCTAssertTrue(available)
    }

    func testOnDeviceServiceSupportsStreaming() async {
        let service = OnDeviceTTSService()
        let streaming = await service.supportsStreaming

        XCTAssertFalse(streaming)
    }

    func testCloudServiceConfiguration() async {
        let service = CloudTTSService(
            provider: .elevenLabs,
            configuration: .elevenLabs
        )

        let provider = await service.provider
        XCTAssertEqual(provider, .elevenLabs)

        let streaming = await service.supportsStreaming
        XCTAssertTrue(streaming)
    }

    func testEstimation() async {
        let service = OnDeviceTTSService()
        let voice = VoicePreset(
            name: "Test",
            provider: .apple,
            providerVoiceID: "test",
            tier: .free
        )

        let text = String(repeating: "word ", count: 150) // ~150 words
        let estimate = await service.estimate(text: text, voice: voice)

        XCTAssertGreaterThan(estimate.estimatedDuration, 0)
        XCTAssertGreaterThan(estimate.characterCount, 0)
        XCTAssertNil(estimate.estimatedCostUSD) // Free for on-device
    }
}
