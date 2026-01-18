package com.listenai.data.models

import java.util.UUID

/**
 * Voice provider type
 */
enum class VoiceProvider {
    APPLE,
    ANDROID,
    ELEVENLABS,
    OPENAI,
    GOOGLE_CLOUD,
    AMAZON_POLLY,
    SELF_HOSTED;

    val displayName: String
        get() = when (this) {
            APPLE -> "Apple"
            ANDROID -> "Android"
            ELEVENLABS -> "ElevenLabs"
            OPENAI -> "OpenAI"
            GOOGLE_CLOUD -> "Google Cloud"
            AMAZON_POLLY -> "Amazon Polly"
            SELF_HOSTED -> "ListenAI"
        }

    val isCloud: Boolean
        get() = this != APPLE && this != ANDROID && this != SELF_HOSTED

    val isPremium: Boolean
        get() = this == ELEVENLABS || this == OPENAI
}

/**
 * Voice quality level - Standard (Kokoro) vs Premium (ElevenLabs)
 */
enum class VoiceQuality {
    STANDARD,  // Self-hosted Kokoro - fast, unlimited
    PREMIUM;   // ElevenLabs - highest quality, quota-limited

    val displayName: String
        get() = when (this) {
            STANDARD -> "Standard"
            PREMIUM -> "Premium"
        }

    val description: String
        get() = when (this) {
            STANDARD -> "Fast, natural voices - unlimited usage"
            PREMIUM -> "Ultra-realistic voices - uses daily quota"
        }

    val badgeText: String
        get() = when (this) {
            STANDARD -> "STD"
            PREMIUM -> "PRO"
        }
}

/**
 * Voice tier for access control
 */
enum class VoiceTier {
    FREE,
    PREMIUM,
    ENTERPRISE;

    val displayName: String
        get() = when (this) {
            FREE -> "Free"
            PREMIUM -> "Premium"
            ENTERPRISE -> "Enterprise"
        }
}

/**
 * Voice gender
 */
enum class VoiceGender {
    MALE,
    FEMALE,
    NEUTRAL
}

/**
 * Voice style category
 */
enum class VoiceStyle {
    NEUTRAL,
    NARRATIVE,
    NEWS,
    CONVERSATIONAL,
    EDUCATIONAL,
    CHARACTER,
    CALM,
    EXCITED,
    SERIOUS,
    FRIENDLY,
    DRAMATIC,
    WHIMSICAL
}

/**
 * Voice category
 */
enum class VoiceCategory {
    NARRATOR,
    EDUCATOR,
    CHARACTER,
    NEWS,
    PODCAST,
    MEDITATION,
    AUDIOBOOK,
    CUSTOM
}

/**
 * Voice preset data model
 */
data class VoicePreset(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val isBuiltIn: Boolean = false,
    val isCharacterVoice: Boolean = false,

    // Provider info
    val provider: VoiceProvider,
    val providerVoiceId: String,
    val providerModelId: String? = null,

    // Quality & Kokoro mapping
    val quality: VoiceQuality = VoiceQuality.STANDARD,
    val kokoroVoiceId: String? = null,  // Mapped Kokoro voice for standard quality

    // Characteristics
    val gender: VoiceGender = VoiceGender.NEUTRAL,
    val style: VoiceStyle = VoiceStyle.NEUTRAL,
    val category: VoiceCategory = VoiceCategory.NARRATOR,

    // Access control
    val tier: VoiceTier = VoiceTier.FREE,

    // Language support
    val languageCode: String = "en-US",
    val supportedLanguages: List<String> = listOf("en-US"),

    // Sample
    val sampleAudioUrl: String? = null,
    val sampleText: String = "Hello! This is a sample of my voice.",

    // Character voice extras
    val characterDescription: String? = null,
    val characterIconUrl: String? = null
) {
    /**
     * Whether this voice supports premium quality (ElevenLabs)
     */
    val supportsPremium: Boolean
        get() = provider == VoiceProvider.ELEVENLABS || provider == VoiceProvider.OPENAI

    /**
     * Get the appropriate voice ID for the selected quality
     */
    fun getVoiceIdForQuality(quality: VoiceQuality): String {
        return when (quality) {
            VoiceQuality.STANDARD -> kokoroVoiceId ?: getDefaultKokoroVoice()
            VoiceQuality.PREMIUM -> providerVoiceId
        }
    }

    /**
     * Get default Kokoro voice based on gender
     */
    private fun getDefaultKokoroVoice(): String {
        return when (gender) {
            VoiceGender.FEMALE -> "af_nicole"
            VoiceGender.MALE -> "am_adam"
            VoiceGender.NEUTRAL -> "af_sarah"
        }
    }
    companion object {
        // Kokoro voice mappings
        private object KokoroVoices {
            const val NICOLE = "af_nicole"      // Female, American
            const val SARAH = "af_sarah"        // Female, American
            const val BELLA = "af_bella"        // Female, American
            const val ADAM = "am_adam"          // Male, American
            const val MICHAEL = "am_michael"    // Male, American
            const val SKY = "af_sky"            // Female, narrative
            const val HEART = "af_heart"        // Female, warm
        }

        // Built-in voice presets with Kokoro mappings
        val narrator = VoicePreset(
            id = "narrator",
            name = "Narrator",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.ADAM,
            kokoroVoiceId = KokoroVoices.ADAM,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.MALE,
            style = VoiceStyle.NARRATIVE,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE
        )

        val calmTeacher = VoicePreset(
            id = "calm_teacher",
            name = "Calm Teacher",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.SARAH,
            kokoroVoiceId = KokoroVoices.SARAH,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.CALM,
            category = VoiceCategory.EDUCATOR,
            tier = VoiceTier.FREE
        )

        val nicole = VoicePreset(
            id = "nicole",
            name = "Nicole",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.NICOLE,
            kokoroVoiceId = KokoroVoices.NICOLE,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.CONVERSATIONAL,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE
        )

        val storyteller = VoicePreset(
            id = "storyteller",
            name = "Storyteller",
            isBuiltIn = true,
            provider = VoiceProvider.ELEVENLABS,
            providerVoiceId = "21m00Tcm4TlvDq8ikWAM",  // Rachel voice
            kokoroVoiceId = KokoroVoices.SKY,
            quality = VoiceQuality.PREMIUM,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.DRAMATIC,
            category = VoiceCategory.AUDIOBOOK,
            tier = VoiceTier.PREMIUM
        )

        val newsAnchor = VoicePreset(
            id = "news_anchor",
            name = "News Anchor",
            isBuiltIn = true,
            provider = VoiceProvider.ELEVENLABS,
            providerVoiceId = "pNInz6obpgDQGcFmaJgB",  // Adam voice
            kokoroVoiceId = KokoroVoices.MICHAEL,
            quality = VoiceQuality.PREMIUM,
            gender = VoiceGender.MALE,
            style = VoiceStyle.NEWS,
            category = VoiceCategory.NEWS,
            tier = VoiceTier.PREMIUM
        )

        val warmNarrator = VoicePreset(
            id = "warm_narrator",
            name = "Warm Narrator",
            isBuiltIn = true,
            provider = VoiceProvider.ELEVENLABS,
            providerVoiceId = "EXAVITQu4vr4xnSDxMaL",  // Bella voice
            kokoroVoiceId = KokoroVoices.HEART,
            quality = VoiceQuality.PREMIUM,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.CALM,
            category = VoiceCategory.AUDIOBOOK,
            tier = VoiceTier.PREMIUM
        )

        // All built-in voices
        val builtInVoices = listOf(narrator, calmTeacher, nicole, storyteller, newsAnchor, warmNarrator)

        // Standard quality voices (free, unlimited)
        val standardVoices = builtInVoices.filter { it.quality == VoiceQuality.STANDARD }

        // Premium quality voices (quota-limited)
        val premiumVoices = builtInVoices.filter { it.quality == VoiceQuality.PREMIUM }
    }
}
