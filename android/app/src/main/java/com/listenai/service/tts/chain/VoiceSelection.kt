package com.listenai.service.tts.chain

/**
 * One voice of the phone's speech engine, reduced to plain data (see `TextToSpeech.getVoices()`), so choosing between
 * voices is unit tested without Android.
 */
data class SystemVoiceInfo(
    /** The engine's own id, for example "es-es-x-eea-local". Stable, used to store the user's pick. */
    val name: String,
    /** 2-letter language, lower case. */
    val language: String,
    /** Region, for example "ES" or "MX"; empty when the voice is not regional. */
    val region: String,
    /** The engine's rating: 100 very low, 200 low, 300 normal, 400 high, 500 very high. */
    val quality: Int,
    val networkRequired: Boolean,
    /** False when the voice is listed but its data is not downloaded. */
    val installed: Boolean,
)

/**
 * Which system voice reads a language. The rule, in order: a voice that works now (installed, and either on the
 * device or we are online), then one that runs on the device over one that needs the network, then the engine's
 * higher quality rating (Google's neural voices report high or very high), then the region of the phone
 * (es-MX on a phone set to Mexico), then the name so the result never flips between runs.
 */
object VoiceSelection {
    const val QUALITY_HIGH = 400

    enum class Status {
        /** The engine lists no voices for this language (it may still speak it with its default voice). */
        NONE_LISTED,
        /** There are voices, none of which works now: not downloaded, or network-only while offline. */
        NOT_USABLE,
        USABLE,
    }

    fun isUsable(v: SystemVoiceInfo, online: Boolean): Boolean = v.installed && (!v.networkRequired || online)

    fun forLanguage(voices: List<SystemVoiceInfo>, language: String): List<SystemVoiceInfo> {
        val lang = LanguageKey.of(language)
        return voices.filter { it.language == lang }
    }

    /** Best first. Includes voices that do not work now, at the end. */
    fun ranked(voices: List<SystemVoiceInfo>, language: String, online: Boolean, deviceRegion: String? = null): List<SystemVoiceInfo> {
        val region = deviceRegion?.uppercase().orEmpty()
        return forLanguage(voices, language).sortedWith(
            compareByDescending<SystemVoiceInfo> { isUsable(it, online) }
                .thenBy { it.networkRequired }
                .thenByDescending { it.quality }
                .thenByDescending { region.isNotEmpty() && it.region.equals(region, ignoreCase = true) }
                .thenBy { it.name }
        )
    }

    /** Only the voices that work now, best first: what the voice picker lists. */
    fun usable(voices: List<SystemVoiceInfo>, language: String, online: Boolean, deviceRegion: String? = null): List<SystemVoiceInfo> =
        ranked(voices, language, online, deviceRegion).filter { isUsable(it, online) }

    /** The user's stored pick when it still works, otherwise the best voice. Null when nothing works. */
    fun choose(
        voices: List<SystemVoiceInfo>,
        language: String,
        preferredName: String?,
        online: Boolean,
        deviceRegion: String? = null,
    ): SystemVoiceInfo? {
        val usable = usable(voices, language, online, deviceRegion)
        return usable.firstOrNull { it.name == preferredName } ?: usable.firstOrNull()
    }

    enum class PickState {
        /** The user has not picked a voice for this language. */
        NONE,
        /** The picked voice is installed and works now. */
        VALID,
        /** The picked voice exists but cannot be used at the moment (network voice while offline, data not downloaded), or the engine could not be asked. Keep the pick. */
        UNUSABLE_NOW,
        /** The engine lists voices but not this one any more (uninstalled, engine changed): the pick is stale and should be cleared. */
        GONE,
    }

    /** Whether the stored pick [preferredName] still refers to a voice for [language]. Nothing listed at all is "cannot tell", not "gone". */
    fun pickState(voices: List<SystemVoiceInfo>, language: String, preferredName: String?, online: Boolean): PickState {
        if (preferredName.isNullOrBlank()) return PickState.NONE
        if (voices.isEmpty()) return PickState.UNUSABLE_NOW
        val mine = forLanguage(voices, language).firstOrNull { it.name == preferredName } ?: return PickState.GONE
        return if (isUsable(mine, online)) PickState.VALID else PickState.UNUSABLE_NOW
    }

    fun status(voices: List<SystemVoiceInfo>, language: String, online: Boolean): Status {
        val forLang = forLanguage(voices, language)
        return when {
            forLang.isEmpty() -> Status.NONE_LISTED
            forLang.any { isUsable(it, online) } -> Status.USABLE
            else -> Status.NOT_USABLE
        }
    }

    /** Languages with at least one voice that works now. */
    fun speakableLanguages(voices: List<SystemVoiceInfo>, online: Boolean): Set<String> =
        voices.filter { isUsable(it, online) }.map { it.language }.toSet()
}

/** Whether the phone can speak a language right now, and if not, how far from it is. */
enum class LanguageVoiceState {
    /** A voice works now. */
    USABLE,
    /** The engine lists voices for the language but none works now: data not downloaded, or network-only while offline. */
    LISTED_UNUSABLE,
    /** The engine has nothing for the language. */
    MISSING,
    /** No speech engine at all. */
    NO_ENGINE;

    companion object {
        /**
         * [languageAvailable] is `isLanguageAvailable(locale) >= LANG_AVAILABLE`; [status] is [VoiceSelection.status]
         * over the engine's voices. A language the engine calls available with no voices listed is trusted (USABLE).
         */
        fun from(hasEngine: Boolean, languageAvailable: Boolean, status: VoiceSelection.Status): LanguageVoiceState = when {
            !hasEngine -> NO_ENGINE
            status == VoiceSelection.Status.NOT_USABLE -> LISTED_UNUSABLE
            !languageAvailable -> MISSING
            else -> USABLE
        }
    }
}

internal object LanguageKey {
    /** "es-MX" and "ES" become "es". */
    fun of(code: String): String = code.trim().lowercase().replace('_', '-').substringBefore('-')
}
