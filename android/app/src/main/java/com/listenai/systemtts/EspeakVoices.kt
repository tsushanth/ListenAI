package com.listenai.systemtts

import java.util.Locale

/**
 * eSpeak NG voices offered by the system TTS engine.
 *
 * eSpeak is the classic screen-reader voice: it speaks in a few milliseconds, runs entirely on the
 * device, supports very fast speech rates and covers many languages. It sounds robotic, which is
 * what many experienced screen-reader users prefer for speed. Every entry below was verified to
 * produce audio with the bundled espeak-ng-data (see assets/espeak-ng-data).
 */
object EspeakVoices {

    /** [espeakVoice] is eSpeak's own voice name; [tag] the BCP-47 locale Android sees. */
    data class Entry(
        /** The name eSpeak resolves with espeak_SetVoiceByName. It is a voice *file* name, which is not
         *  always the language code (UK English is "en", French is "fr"). */
        val espeakVoice: String,
        val tag: String,
        val displayName: String,
        /** Extra ISO-2 countries this voice is the best match for (for example es-419 for Mexico). */
        val countries: Set<String> = emptySet(),
        /** Stable id used in the Android voice name; defaults to [espeakVoice]. */
        val id: String = espeakVoice
    ) {
        val locale: Locale get() = Locale.forLanguageTag(tag)
        val systemVoiceName: String get() = PREFIX + id
    }

    const val PREFIX = "readaloud-espeak-"

    val all: List<Entry> = listOf(
        Entry("en-us", "en-US", "English (US)", setOf("US", "CA", "PH")),
        Entry("en", "en-GB", "English (UK)", setOf("GB", "AU", "NZ", "IE", "ZA", "IN", "SG"), id = "en-gb"),
        Entry("es", "es-ES", "Spanish (Spain)", setOf()),
        Entry("es-419", "es-MX", "Spanish (Latin America)", setOf("MX", "US", "AR", "CO", "CL", "PE", "VE", "EC", "GT", "CU", "BO", "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR")),
        Entry("fr", "fr-FR", "French", setOf("FR", "CA", "CH", "LU", "MC"), id = "fr-fr"),
        Entry("fr-be", "fr-BE", "French (Belgium)", setOf("BE")),
        Entry("de", "de-DE", "German", setOf()),
        Entry("it", "it-IT", "Italian", setOf()),
        Entry("pt", "pt-PT", "Portuguese (Portugal)", setOf("PT", "AO", "MZ")),
        Entry("pt-br", "pt-BR", "Portuguese (Brazil)", setOf("BR")),
        Entry("cmn", "zh-CN", "Chinese (Mandarin)", setOf("CN", "SG", "TW", "HK")),
        Entry("ja", "ja-JP", "Japanese", setOf()),
        Entry("ko", "ko-KR", "Korean", setOf()),
        Entry("hi", "hi-IN", "Hindi", setOf()),
        Entry("ar", "ar", "Arabic", setOf()),
        Entry("nl", "nl-NL", "Dutch", setOf()),
        Entry("pl", "pl-PL", "Polish", setOf()),
        Entry("tr", "tr-TR", "Turkish", setOf()),
        Entry("sv", "sv-SE", "Swedish", setOf()),
        Entry("da", "da-DK", "Danish", setOf()),
        Entry("nb", "nb-NO", "Norwegian", setOf()),
        Entry("fi", "fi-FI", "Finnish", setOf()),
        Entry("el", "el-GR", "Greek", setOf()),
        Entry("cs", "cs-CZ", "Czech", setOf()),
        Entry("hu", "hu-HU", "Hungarian", setOf()),
        Entry("ro", "ro-RO", "Romanian", setOf()),
        Entry("uk", "uk-UA", "Ukrainian", setOf()),
        Entry("vi", "vi-VN", "Vietnamese", setOf()),
        Entry("th", "th-TH", "Thai", setOf()),
        Entry("id", "id-ID", "Indonesian", setOf()),
        Entry("he", "he-IL", "Hebrew", setOf()),
        Entry("fa", "fa-IR", "Persian", setOf()),
        Entry("bn", "bn-IN", "Bengali", setOf()),
        Entry("ta", "ta-IN", "Tamil", setOf()),
        Entry("te", "te-IN", "Telugu", setOf()),
        Entry("ur", "ur-PK", "Urdu", setOf()),
        Entry("sw", "sw-KE", "Swahili", setOf()),
        Entry("ca", "ca-ES", "Catalan", setOf()),
        Entry("hr", "hr-HR", "Croatian", setOf()),
        Entry("sr", "sr-RS", "Serbian", setOf()),
        Entry("sk", "sk-SK", "Slovak", setOf()),
        Entry("bg", "bg-BG", "Bulgarian", setOf()),
        Entry("lt", "lt-LT", "Lithuanian", setOf()),
        Entry("lv", "lv-LV", "Latvian", setOf()),
        Entry("et", "et-EE", "Estonian", setOf()),
        Entry("sq", "sq-AL", "Albanian", setOf()),
        Entry("gu", "gu-IN", "Gujarati", setOf()),
        Entry("kn", "kn-IN", "Kannada", setOf()),
        Entry("ml", "ml-IN", "Malayalam", setOf()),
        Entry("mr", "mr-IN", "Marathi", setOf()),
        Entry("pa", "pa-IN", "Punjabi", setOf()),
        Entry("ne", "ne-NP", "Nepali", setOf()),
        Entry("si", "si-LK", "Sinhala", setOf()),
        Entry("af", "af-ZA", "Afrikaans", setOf()),
        Entry("cy", "cy-GB", "Welsh", setOf()),
        Entry("ga", "ga-IE", "Irish", setOf()),
        Entry("is", "is-IS", "Icelandic", setOf()),
    )

    private val byVoiceName: Map<String, Entry> = all.associateBy { it.systemVoiceName }

    fun isEspeakVoiceName(name: String?): Boolean = name != null && name.startsWith(PREFIX)

    fun fromVoiceName(name: String?): Entry? = name?.let { byVoiceName[it] }

    fun supportsLanguage(lang2: String?): Boolean =
        lang2 != null && all.any { it.locale.language.equals(lang2, ignoreCase = true) }

    /** Best voice for a locale: exact country, then a voice that lists the country, then the language's first voice. */
    fun forLocale(lang2: String?, country2: String?): Entry? {
        if (lang2.isNullOrBlank()) return null
        val sameLang = all.filter { it.locale.language.equals(lang2, ignoreCase = true) }
        if (sameLang.isEmpty()) return null
        val c = country2?.uppercase().orEmpty()
        if (c.isNotEmpty()) {
            sameLang.firstOrNull { it.locale.country.equals(c, ignoreCase = true) }?.let { return it }
            sameLang.firstOrNull { c in it.countries }?.let { return it }
        }
        return sameLang.first()
    }

    /** True if some voice matches both language and country exactly or by alias. */
    fun supportsLanguageCountry(lang2: String?, country2: String?): Boolean {
        if (lang2.isNullOrBlank() || country2.isNullOrBlank()) return false
        val c = country2.uppercase()
        return all.any {
            it.locale.language.equals(lang2, ignoreCase = true) &&
                (it.locale.country.equals(c, ignoreCase = true) || c in it.countries)
        }
    }

    /** Android speech rate (100 = normal) to eSpeak words per minute (175 = normal, 450 max). */
    fun rateToWpm(androidRate: Int): Int = (175.0 * androidRate / 100.0).toInt().coerceIn(80, 450)

    /** Android pitch (100 = normal) to eSpeak pitch (0..100, 50 = normal). */
    fun pitchToEspeak(androidPitch: Int): Int = (androidPitch / 2).coerceIn(0, 100)
}
