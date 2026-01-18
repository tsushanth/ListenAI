import XCTest
@testable import ListenAI

// MARK: - Voice Preset Tests

final class VoicePresetTests: XCTestCase {

    // MARK: - Preset Creation Tests

    func testNarratorPreset() {
        let preset = VoicePreset.narrator

        XCTAssertEqual(preset.name, "Narrator")
        XCTAssertEqual(preset.category, .narrator)
        XCTAssertEqual(preset.style, .narrative)
        XCTAssertEqual(preset.tier, .free)
        XCTAssertTrue(preset.hasOnDeviceFallback)
        XCTAssertNotNil(preset.onDeviceMapping)
    }

    func testCalmTeacherPreset() {
        let preset = VoicePreset.calmTeacher

        XCTAssertEqual(preset.name, "Calm Teacher")
        XCTAssertEqual(preset.category, .educator)
        XCTAssertEqual(preset.style, .educational)
        XCTAssertEqual(preset.emotion, .calm)
        XCTAssertLessThan(preset.styleParameters.speakingRate, 1.0)
    }

    func testStoryteller() {
        let preset = VoicePreset.storyteller

        XCTAssertEqual(preset.name, "Josh")
        XCTAssertTrue(preset.isCharacterVoice)
        XCTAssertEqual(preset.category, .audiobook)
        XCTAssertEqual(preset.tier, .free)
        XCTAssertNotNil(preset.kokoroVoiceID)
    }

    func testBrianVoice() {
        let preset = VoicePreset.brian

        XCTAssertEqual(preset.name, "Brian")
        XCTAssertEqual(preset.category, .narrator)
        XCTAssertEqual(preset.style, .narrative)
        XCTAssertEqual(preset.tier, .free)
        XCTAssertNotNil(preset.kokoroVoiceID)
    }

    // MARK: - Style Parameters Tests

    func testDefaultStyleParameters() {
        let params = StyleParameters.default

        XCTAssertEqual(params.speakingRate, 1.0)
        XCTAssertEqual(params.pitch, 1.0)
        XCTAssertEqual(params.volume, 1.0)
    }

    func testNarratorStyleParameters() {
        let params = StyleParameters.narrator

        XCTAssertLessThan(params.speakingRate, 1.0)
        XCTAssertGreaterThan(params.pauseDuration, 1.0)
        XCTAssertGreaterThan(params.expressiveness, 0.5)
    }

    func testCalmTeacherStyleParameters() {
        let params = StyleParameters.calmTeacher

        XCTAssertLessThan(params.speakingRate, 1.0)
        XCTAssertGreaterThan(params.pauseDuration, 1.0)
        XCTAssertGreaterThan(params.warmth, 0.7)
        XCTAssertGreaterThan(params.clarity, 0.8)
    }

    func testEnergeticStyleParameters() {
        let params = StyleParameters.energetic

        XCTAssertGreaterThan(params.speakingRate, 1.0)
        XCTAssertLessThan(params.pauseDuration, 1.0)
        XCTAssertGreaterThan(params.expressiveness, 0.8)
    }

    func testSoothingStyleParameters() {
        let params = StyleParameters.soothing

        XCTAssertLessThan(params.speakingRate, 0.9)
        XCTAssertLessThan(params.volume, 1.0)
        XCTAssertGreaterThan(params.warmth, 0.8)
        XCTAssertLessThan(params.expressiveness, 0.5)
    }

    // MARK: - Cloud Voice Settings Tests

    func testDefaultCloudSettings() {
        let settings = CloudVoiceSettings.default

        XCTAssertEqual(settings.stability, 0.5)
        XCTAssertEqual(settings.similarityBoost, 0.75)
        XCTAssertTrue(settings.useSpeakerBoost)
    }

    func testNarrativeCloudSettings() {
        let settings = CloudVoiceSettings.narrative

        XCTAssertGreaterThan(settings.stability, 0.5)
        XCTAssertGreaterThan(settings.style, 0.0)
    }

    func testCalmCloudSettings() {
        let settings = CloudVoiceSettings.calm

        XCTAssertGreaterThan(settings.stability, 0.8)
        XCTAssertLessThan(settings.style, 0.2)
        XCTAssertFalse(settings.useSpeakerBoost)
    }

    func testEnergeticCloudSettings() {
        let settings = CloudVoiceSettings.energetic

        XCTAssertLessThan(settings.stability, 0.5)
        XCTAssertGreaterThan(settings.style, 0.5)
    }

    // MARK: - Preset Collection Tests

    func testAllBuiltInPresets() {
        let presets = VoicePreset.allBuiltInPresets

        // All built-in presets should have Kokoro support
        XCTAssertGreaterThan(presets.count, 10)
        XCTAssertTrue(presets.allSatisfy { $0.kokoroVoiceID != nil })
        XCTAssertTrue(presets.contains(where: { $0.name == "Adam" }))
        XCTAssertTrue(presets.contains(where: { $0.name == "Bella" }))
        XCTAssertTrue(presets.contains(where: { $0.name == "Brian" }))
    }

    func testFreePresets() {
        let freePresets = VoicePreset.freePresets

        XCTAssertFalse(freePresets.isEmpty)
        XCTAssertTrue(freePresets.allSatisfy { $0.tier == .free })
    }

    func testPremiumPresets() {
        let premiumPresets = VoicePreset.premiumPresets

        XCTAssertFalse(premiumPresets.isEmpty)
        XCTAssertTrue(premiumPresets.allSatisfy { $0.tier == .premium })
    }

    func testCharacterPresets() {
        let characterPresets = VoicePreset.characterPresets

        XCTAssertFalse(characterPresets.isEmpty)
        XCTAssertTrue(characterPresets.allSatisfy { $0.isCharacterVoice })
        XCTAssertTrue(characterPresets.contains(where: { $0.name == "Josh" })) // Storyteller
    }

    func testPresetsByCategory() {
        let narratorPresets = VoicePreset.presets(for: .narrator)
        XCTAssertFalse(narratorPresets.isEmpty)
        XCTAssertTrue(narratorPresets.allSatisfy { $0.category == .narrator })

        let educatorPresets = VoicePreset.presets(for: .educator)
        XCTAssertFalse(educatorPresets.isEmpty)
        XCTAssertTrue(educatorPresets.allSatisfy { $0.category == .educator })
    }

    func testDefaultPreset() {
        let defaultPreset = VoicePreset.defaultPreset

        XCTAssertEqual(defaultPreset.name, "Narrator")
        XCTAssertEqual(defaultPreset.tier, .free)
    }

    // MARK: - On-Device Mapping Tests

    func testOnDeviceMappingExists() {
        let presets = VoicePreset.allBuiltInPresets

        // All presets should have on-device fallback
        for preset in presets {
            XCTAssertTrue(preset.hasOnDeviceFallback, "Preset \(preset.name) should have on-device fallback")
        }
    }

    func testOnDeviceMappingPrimaryVoice() {
        let narrator = VoicePreset.narrator
        let mapping = narrator.onDeviceMapping!

        XCTAssertFalse(mapping.primaryVoiceID.isEmpty)
        XCTAssertEqual(mapping.language, "en-US")
    }

    func testOnDeviceMappingFallbacks() {
        let narrator = VoicePreset.narrator
        let mapping = narrator.onDeviceMapping!

        XCTAssertFalse(mapping.fallbackVoiceIDs.isEmpty)
    }

    // MARK: - Voice Provider Tests

    func testVoiceProviderDisplayNames() {
        XCTAssertEqual(VoiceProvider.apple.displayName, "Apple")
        XCTAssertEqual(VoiceProvider.elevenLabs.displayName, "ElevenLabs")
        XCTAssertEqual(VoiceProvider.openAI.displayName, "OpenAI")
    }

    func testVoiceProviderIsCloudBased() {
        XCTAssertFalse(VoiceProvider.apple.isCloudBased)
        XCTAssertTrue(VoiceProvider.elevenLabs.isCloudBased)
        XCTAssertTrue(VoiceProvider.openAI.isCloudBased)
    }

    // MARK: - Voice Category Tests

    func testVoiceCategoryDisplayNames() {
        XCTAssertEqual(VoiceCategory.narrator.displayName, "Narrators")
        XCTAssertEqual(VoiceCategory.educator.displayName, "Educators")
        XCTAssertEqual(VoiceCategory.character.displayName, "Characters")
    }

    func testVoiceCategoryIcons() {
        XCTAssertEqual(VoiceCategory.narrator.iconName, "book.fill")
        XCTAssertEqual(VoiceCategory.educator.iconName, "graduationcap.fill")
        XCTAssertEqual(VoiceCategory.character.iconName, "theatermasks.fill")
    }

    // MARK: - Voice Style Tests

    func testVoiceStyleDescriptions() {
        XCTAssertFalse(VoiceStyle.neutral.description.isEmpty)
        XCTAssertFalse(VoiceStyle.narrative.description.isEmpty)
        XCTAssertFalse(VoiceStyle.educational.description.isEmpty)
    }

    // MARK: - Preset Modification Tests

    func testWithStyleParameters() {
        let original = VoicePreset.narrator
        let customParams = StyleParameters(speakingRate: 1.5, pitch: 1.2)

        let modified = original.withStyleParameters(customParams)

        XCTAssertEqual(modified.styleParameters.speakingRate, 1.5)
        XCTAssertEqual(modified.styleParameters.pitch, 1.2)
        XCTAssertEqual(modified.name, original.name)
    }

    // MARK: - Computed Properties Tests

    func testDefaultSpeed() {
        let narrator = VoicePreset.narrator
        XCTAssertEqual(narrator.defaultSpeed, narrator.styleParameters.speakingRate)
    }

    func testDefaultPitch() {
        let narrator = VoicePreset.narrator
        XCTAssertEqual(narrator.defaultPitch, narrator.styleParameters.pitch)
    }

    func testIsCloudVoice() {
        let elevenLabsPreset = VoicePreset.narrator
        XCTAssertTrue(elevenLabsPreset.isCloudVoice)

        // Create an Apple-only preset
        let applePreset = VoicePreset(
            name: "Test",
            provider: .apple,
            providerVoiceID: "test"
        )
        XCTAssertFalse(applePreset.isCloudVoice)
    }

    // MARK: - Voice Tier Tests

    func testVoiceTierDisplayNames() {
        XCTAssertEqual(VoiceTier.free.displayName, "Free")
        XCTAssertEqual(VoiceTier.premium.displayName, "Premium")
    }

    func testVoiceTierBadgeColors() {
        XCTAssertFalse(VoiceTier.free.badgeColor.isEmpty)
        XCTAssertFalse(VoiceTier.premium.badgeColor.isEmpty)
    }

    // MARK: - Voice Mode Tests

    func testVoiceModeDisplayNames() {
        XCTAssertEqual(VoiceMode.automatic.displayName, "Automatic")
        XCTAssertEqual(VoiceMode.cloudOnly.displayName, "Cloud Only")
        XCTAssertEqual(VoiceMode.onDeviceOnly.displayName, "On-Device Only")
    }

    func testVoiceModeDescriptions() {
        XCTAssertFalse(VoiceMode.automatic.description.isEmpty)
        XCTAssertFalse(VoiceMode.cloudOnly.description.isEmpty)
        XCTAssertFalse(VoiceMode.onDeviceOnly.description.isEmpty)
    }
}

// MARK: - Style Parameters Encoding Tests

final class StyleParametersEncodingTests: XCTestCase {

    func testStyleParametersEncodeDecode() throws {
        let original = StyleParameters(
            speakingRate: 1.2,
            pitch: 0.9,
            volume: 0.8,
            emphasis: 0.7,
            pauseDuration: 1.5,
            expressiveness: 0.6,
            warmth: 0.8,
            clarity: 0.9
        )

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(StyleParameters.self, from: encoded)

        XCTAssertEqual(decoded.speakingRate, original.speakingRate)
        XCTAssertEqual(decoded.pitch, original.pitch)
        XCTAssertEqual(decoded.volume, original.volume)
        XCTAssertEqual(decoded.emphasis, original.emphasis)
        XCTAssertEqual(decoded.pauseDuration, original.pauseDuration)
        XCTAssertEqual(decoded.expressiveness, original.expressiveness)
        XCTAssertEqual(decoded.warmth, original.warmth)
        XCTAssertEqual(decoded.clarity, original.clarity)
    }
}

// MARK: - Cloud Voice Settings Encoding Tests

final class CloudVoiceSettingsEncodingTests: XCTestCase {

    func testCloudVoiceSettingsEncodeDecode() throws {
        let original = CloudVoiceSettings(
            stability: 0.7,
            similarityBoost: 0.8,
            style: 0.5,
            useSpeakerBoost: true,
            modelID: "test-model"
        )

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(CloudVoiceSettings.self, from: encoded)

        XCTAssertEqual(decoded.stability, original.stability)
        XCTAssertEqual(decoded.similarityBoost, original.similarityBoost)
        XCTAssertEqual(decoded.style, original.style)
        XCTAssertEqual(decoded.useSpeakerBoost, original.useSpeakerBoost)
        XCTAssertEqual(decoded.modelID, original.modelID)
    }
}

// MARK: - Voice Preset Encoding Tests

final class VoicePresetEncodingTests: XCTestCase {

    func testVoicePresetEncodeDecode() throws {
        let original = VoicePreset.narrator

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(VoicePreset.self, from: encoded)

        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.name, original.name)
        XCTAssertEqual(decoded.provider, original.provider)
        XCTAssertEqual(decoded.category, original.category)
        XCTAssertEqual(decoded.tier, original.tier)
    }
}

// MARK: - Resolved Voice Tests

final class ResolvedVoiceTests: XCTestCase {

    func testResolvedVoiceOnDevice() {
        let preset = VoicePreset.narrator

        let resolved = ResolvedVoice(
            preset: preset,
            useCloud: false,
            provider: .apple,
            voiceID: "test-voice",
            modelID: nil,
            appleVoice: nil,
            styleParameters: preset.styleParameters,
            cloudSettings: nil
        )

        XCTAssertTrue(resolved.isOnDevice)
        XCTAssertFalse(resolved.useCloud)
        XCTAssertEqual(resolved.provider, .apple)
    }

    func testResolvedVoiceCloud() {
        let preset = VoicePreset.narrator

        let resolved = ResolvedVoice(
            preset: preset,
            useCloud: true,
            provider: .elevenLabs,
            voiceID: preset.providerVoiceID,
            modelID: preset.providerModelID,
            appleVoice: nil,
            styleParameters: preset.styleParameters,
            cloudSettings: preset.cloudSettings
        )

        XCTAssertFalse(resolved.isOnDevice)
        XCTAssertTrue(resolved.useCloud)
        XCTAssertEqual(resolved.provider, .elevenLabs)
        XCTAssertNotNil(resolved.cloudSettings)
    }
}
