package com.listenai.systemtts

import java.util.Locale

/**
 * ISO 639-2 / ISO 3166 three-letter codes to the two-letter codes the rest of the engine uses.
 *
 * The Android TTS framework sends three-letter codes ("eng", "USA") to `onIsLanguageAvailable`,
 * `onLoadLanguage` and in every synthesis request. The tables are built from the platform's own locale
 * data so every language Android knows maps correctly, not a hand-picked few.
 */
object LanguageCodes {

    // ISO 639-2/T codes come from Locale; some callers still send the older "bibliographic" (B) form.
    private val BIBLIOGRAPHIC_ALIASES = mapOf(
        "ger" to "de", "fre" to "fr", "chi" to "zh", "dut" to "nl", "gre" to "el", "cze" to "cs",
        "rum" to "ro", "slo" to "sk", "per" to "fa", "baq" to "eu", "mac" to "mk", "may" to "ms",
        "mao" to "mi", "wel" to "cy", "ice" to "is", "alb" to "sq", "arm" to "hy", "geo" to "ka",
        "tib" to "bo", "bur" to "my",
    )

    private val languages: Map<String, String> by lazy {
        val map = HashMap<String, String>()
        for (iso2 in Locale.getISOLanguages()) {
            val iso3 = runCatching { Locale(iso2).isO3Language }.getOrNull()
            if (!iso3.isNullOrEmpty()) map.putIfAbsent(iso3.lowercase(), iso2)
        }
        map.putAll(BIBLIOGRAPHIC_ALIASES)
        map
    }

    private val countries: Map<String, String> by lazy {
        val map = HashMap<String, String>()
        for (iso2 in Locale.getISOCountries()) {
            val iso3 = runCatching { Locale("", iso2).isO3Country }.getOrNull()
            if (!iso3.isNullOrEmpty()) map.putIfAbsent(iso3.uppercase(), iso2)
        }
        map
    }

    /** "eng" -> "en"; also accepts an already two-letter code. Null if unknown. */
    fun toIso2(iso3: String?): String? {
        val code = iso3?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (code.length == 2) return code
        return languages[code]
    }

    /** "USA" -> "US"; also accepts an already two-letter code. Null if empty or unknown. */
    fun countryToIso2(iso3: String?): String? {
        val code = iso3?.trim()?.uppercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (code.length == 2) return code
        return countries[code]
    }
}
