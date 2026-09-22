package com.listenai.service.tts

import com.listenai.data.models.VoicePreset

/**
 * Maps the app's 10 built-in voices (VoicePreset.builtInVoices) to a real, published
 * Piper voice on the realtime-tts platform. Every entry was chosen for locale/gender
 * closeness to the Kokoro voice it replaces, cross-referenced against realtime-tts's
 * voices/catalog.json (see 2026-09-22-android-realtime-tts-production-readiness-design.md,
 * Piece 4, "revised 2026-09-22" note on switching the default engine to Piper).
 * This is a deliberate, reviewed table, not an algorithm - a new VoicePreset needs a new
 * entry added explicitly, not silent reliance on FALLBACK_VOICE_ID.
 */
object PiperVoiceMapping {
    const val FALLBACK_VOICE_ID = "custom:en-us-john"

    private val MAPPING: Map<String, String> = mapOf(
        // Female voices
        "bella" to "custom:en-us-kristin",        // US female, tier A - default voice, safest match
        "charlotte" to "custom:en-us-libritts_r-f383",  // US female, tier A - distinct elegant tone
        "elli" to "custom:en-us-ljspeech",        // US female, tier A - classic clear/calm reference voice
        "matilda" to "custom:en-nz-vctk-p335",    // NZ female, tier B - no Australian female exists in the
                                                    // catalog; New Zealand is the closest Anglophone-Pacific
                                                    // accent available, noted as an approximation
        "dorothy" to "custom:en-ca-vctk-p312",    // Canadian (Hamilton) female, tier B - warm alternate accent
        "rachel" to "custom:en-gb-vctk-p229",     // English (Southern England) female, tier B - clear/neutral,
                                                    // distinct from the US voices already assigned above

        // Male voices
        "adam" to "custom:en-us-john",            // US male, tier A - same voice used as this project's
                                                    // general-purpose default throughout (eval/, benchmarks/)
        "josh" to "custom:en-us-norman",          // US male, tier A - distinct from adam
        "bill" to "custom:en-us-libritts_r-m492", // US male, tier A - distinct authoritative tone
        "brian" to "custom:en-gb-vctk-p232",      // English (Southern England) male, tier B - no tier-A
                                                    // British male exists in the catalog
    )

    internal val MAPPING_FOR_TEST: Map<String, String> get() = MAPPING

    fun resolve(voice: VoicePreset): String {
        return MAPPING[voice.id] ?: FALLBACK_VOICE_ID
    }
}
