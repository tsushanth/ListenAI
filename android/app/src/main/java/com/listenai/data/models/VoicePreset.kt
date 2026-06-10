package com.listenai.data.models

import java.util.UUID

/**
 * Voice provider type
 */
enum class VoiceProvider {
    APPLE,
    ANDROID,
    SELF_HOSTED,        // Kokoro running on the Fly cloud worker (listenai-tts-worker)
    KOKORO_ON_DEVICE;   // Kokoro running locally via ONNX Runtime — Android v2 path

    val displayName: String
        get() = when (this) {
            APPLE -> "Apple"
            ANDROID -> "Android"
            SELF_HOSTED -> "ReadAloud AI"
            KOKORO_ON_DEVICE -> "Kokoro (on-device)"
        }

    val isCloud: Boolean
        get() = this == SELF_HOSTED

    val isPremium: Boolean
        get() = false  // All voices are now free tier
}

/**
 * Voice quality level - All voices now use Kokoro (GPU-accelerated, unlimited)
 */
enum class VoiceQuality {
    STANDARD;  // Self-hosted Kokoro - fast, unlimited, high quality

    val displayName: String
        get() = "High Quality"

    val description: String
        get() = "GPU-accelerated, natural voices - unlimited usage"

    val badgeText: String
        get() = "HD"
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
    val characterIconUrl: String? = null,

    // Avatar emoji for voice picker UI (like iOS)
    val avatarEmoji: String? = null,

    // Accent color hex for voice picker
    val accentColorHex: String? = null
) {
    /**
     * Whether this voice supports high quality synthesis
     */
    val supportsHighQuality: Boolean
        get() = provider == VoiceProvider.SELF_HOSTED

    /**
     * Get the voice ID for synthesis (always uses Kokoro)
     */
    fun getVoiceIdForQuality(quality: VoiceQuality): String {
        return kokoroVoiceId ?: getDefaultKokoroVoice()
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
        // Kokoro voice mappings (must match iOS exactly)
        object KokoroVoices {
            const val NICOLE = "af_nicole"      // Female, American - Rachel maps to this
            const val SARAH = "af_sarah"        // Female, American
            const val BELLA = "af_bella"        // Female, American
            const val ADAM = "am_adam"          // Male, American
            const val MICHAEL = "am_michael"    // Male, American
            const val SKY = "af_sky"            // Female, narrative
            const val HEART = "af_heart"        // Female, warm
            const val GEORGE = "bm_george"      // Male, British
            const val EMMA = "bf_emma"          // Female, British
            const val LEWIS = "bm_lewis"        // Male, British
            const val ISABELLA = "bf_isabella"  // Female, British
        }

        // Rachel - Clear, warm female voice (most popular - maps to Nicole in Kokoro)
        val rachel = VoicePreset(
            id = "rachel",
            name = "Rachel",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.NICOLE,
            kokoroVoiceId = KokoroVoices.NICOLE,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.CONVERSATIONAL,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83D\uDC69\u200D\uD83E\uDDB0",  // 👩‍🦰
            accentColorHex = "#EC4899",
            sampleText = "Hello! I'm Rachel. I have a clear and warm voice that's perfect for bringing your stories to life."
        )

        // Adam - Professional narrator (male)
        val adam = VoicePreset(
            id = "adam",
            name = "Adam",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.ADAM,
            kokoroVoiceId = KokoroVoices.ADAM,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.MALE,
            style = VoiceStyle.NARRATIVE,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83D\uDC68\u200D\uD83D\uDCBC",  // 👨‍💼
            accentColorHex = "#3B82F6",
            sampleText = "Welcome to today's article. Let me guide you through this fascinating story with clarity and engagement."
        )

        // Bella - Calm teacher (female)
        val bella = VoicePreset(
            id = "bella",
            name = "Bella",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.BELLA,
            kokoroVoiceId = KokoroVoices.BELLA,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.EDUCATIONAL,
            category = VoiceCategory.EDUCATOR,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83D\uDC69\u200D\uD83C\uDFEB",  // 👩‍🏫
            accentColorHex = "#10B981",
            sampleText = "Let's explore this concept together. Take your time to absorb each idea as we go through this material."
        )

        // Josh - Storyteller (male)
        val josh = VoicePreset(
            id = "josh",
            name = "Josh",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.MICHAEL,
            kokoroVoiceId = KokoroVoices.MICHAEL,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.MALE,
            style = VoiceStyle.DRAMATIC,
            category = VoiceCategory.AUDIOBOOK,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83E\uDDD9\u200D\u2642\uFE0F",  // 🧙‍♂️
            accentColorHex = "#8B5CF6",
            sampleText = "Once upon a time, in a land far, far away, there lived a hero whose destiny would change the world forever..."
        )

        // Brian - Deep British male
        val brian = VoicePreset(
            id = "brian",
            name = "Brian",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.GEORGE,
            kokoroVoiceId = KokoroVoices.GEORGE,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.MALE,
            style = VoiceStyle.NARRATIVE,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83E\uDDD4",  // 🧔
            accentColorHex = "#1E3A8A",
            sampleText = "Good day. I'm Brian, and I'll be your guide through this fascinating journey."
        )

        // Charlotte - Elegant female
        val charlotte = VoicePreset(
            id = "charlotte",
            name = "Charlotte",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.EMMA,
            kokoroVoiceId = KokoroVoices.EMMA,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.CONVERSATIONAL,
            category = VoiceCategory.PODCAST,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83D\uDC69\u200D\uD83D\uDCBC",  // 👩‍💼
            accentColorHex = "#7C3AED",
            sampleText = "Hello, I'm Charlotte. Let me take you through this content with clarity and elegance."
        )

        // Elli - Bedtime reader (female)
        val elli = VoicePreset(
            id = "elli",
            name = "Elli",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.SARAH,
            kokoroVoiceId = KokoroVoices.SARAH,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.CALM,
            category = VoiceCategory.MEDITATION,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83E\uDDD8\u200D\u2640\uFE0F",  // 🧘‍♀️
            accentColorHex = "#6366F1",
            sampleText = "Close your eyes and let your thoughts drift away. Tonight, I'll take you on a peaceful journey through dreamland..."
        )

        // Bill - Authoritative male
        val bill = VoicePreset(
            id = "bill",
            name = "Bill",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.MICHAEL,
            kokoroVoiceId = KokoroVoices.MICHAEL,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.MALE,
            style = VoiceStyle.SERIOUS,
            category = VoiceCategory.NEWS,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83E\uDDD1\u200D\u2696\uFE0F",  // 🧑‍⚖️
            accentColorHex = "#1F2937",
            sampleText = "Good evening. I'm Bill, bringing you the latest news and in-depth analysis."
        )

        // Matilda - Australian female
        val matilda = VoicePreset(
            id = "matilda",
            name = "Matilda",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.SKY,
            kokoroVoiceId = KokoroVoices.SKY,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.FRIENDLY,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83D\uDC71\u200D\u2640\uFE0F",  // 👱‍♀️
            accentColorHex = "#F97316",
            sampleText = "G'day! I'm Matilda. Let me take you through this with a friendly touch."
        )

        // Dorothy - Friendly female
        val dorothy = VoicePreset(
            id = "dorothy",
            name = "Dorothy",
            isBuiltIn = true,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = KokoroVoices.HEART,
            kokoroVoiceId = KokoroVoices.HEART,
            quality = VoiceQuality.STANDARD,
            gender = VoiceGender.FEMALE,
            style = VoiceStyle.FRIENDLY,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.FREE,
            avatarEmoji = "\uD83D\uDC75",  // 👵
            accentColorHex = "#A855F7",
            sampleText = "Hello there! I'm Dorothy. I just love sharing wonderful stories with you!"
        )

        // All built-in voices - Bella is default (calm teacher voice)
        val builtInVoices = listOf(
            bella,     // Default - calm teacher (good quality)
            adam,      // Default male narrator
            brian,     // British male
            charlotte, // Elegant female
            josh,      // Storyteller
            matilda,   // Australian female
            bill,      // News anchor
            elli,      // Bedtime reader
            dorothy,   // Friendly grandmother
            rachel     // Moved to end
        )

        // Legacy names for backward compatibility
        val narrator = adam
        val calmTeacher = bella
        val nicole = rachel
        val storyteller = josh
        val newsAnchor = bill
        val warmNarrator = dorothy

        // All voices are now standard quality (free, unlimited)
        val standardVoices = builtInVoices
    }
}
