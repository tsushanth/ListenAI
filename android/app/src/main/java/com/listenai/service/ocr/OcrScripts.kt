package com.listenai.service.ocr

import java.util.Locale

/** The scripts the on-device text recognizer has a separate model for (ML Kit Text Recognition v2). */
enum class OcrScript { LATIN, CHINESE, JAPANESE, KOREAN, DEVANAGARI }

/**
 * Pure decisions for reading text from a photo in more than one script. ML Kit has no model for Cyrillic, Greek, Arabic
 * or Thai; those photos are not recognised, whatever is tried here.
 *
 * The models are tried one after another, the one that fits the phone's language first, and the walk stops as soon as a
 * model finds enough letters of its own script. A photo of Japanese text read by the Latin model gives little or junk, so
 * the next model is tried; a photo of English text stops at the Latin model.
 */
object OcrScripts {

    /** Letters of a model's own script that count as "this is the right model". */
    const val ENOUGH = 10

    private val DEFAULT_ORDER = listOf(OcrScript.LATIN, OcrScript.CHINESE, OcrScript.JAPANESE, OcrScript.KOREAN, OcrScript.DEVANAGARI)

    /** The order to try the models in for a phone set to [uiLanguage] (2-letter code, may be null): its own script first, then Latin, then the rest. */
    fun order(uiLanguage: String?): List<OcrScript> {
        val own = when (uiLanguage?.lowercase(Locale.ROOT)?.substringBefore('-')?.substringBefore('_')) {
            "zh" -> OcrScript.CHINESE
            "ja" -> OcrScript.JAPANESE
            "ko" -> OcrScript.KOREAN
            "hi", "mr", "ne" -> OcrScript.DEVANAGARI
            else -> return DEFAULT_ORDER
        }
        return listOf(own) + DEFAULT_ORDER.filter { it != own }
    }

    /** How many letters of [script]'s own writing [text] has. Japanese counts kana and kanji, so kana tip a tie with Chinese. */
    fun count(script: OcrScript, text: String): Int {
        var n = 0
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            val s = Character.UnicodeScript.of(cp)
            val hit = when (script) {
                OcrScript.LATIN -> s == Character.UnicodeScript.LATIN && Character.isLetter(cp)
                OcrScript.CHINESE -> s == Character.UnicodeScript.HAN
                OcrScript.JAPANESE -> s == Character.UnicodeScript.HAN || s == Character.UnicodeScript.HIRAGANA || s == Character.UnicodeScript.KATAKANA
                OcrScript.KOREAN -> s == Character.UnicodeScript.HANGUL
                OcrScript.DEVANAGARI -> s == Character.UnicodeScript.DEVANAGARI
            }
            if (hit) n++
        }
        return n
    }

    /**
     * Runs [recognize] per script in [order] and returns the best text. [recognize] returns a failed Result when that model
     * could not run (for example its model is still being downloaded). If every model failed the first failure is thrown;
     * if some ran and found nothing, the result is "".
     */
    suspend fun recognize(uiLanguage: String?, recognize: suspend (OcrScript) -> Result<String>): String {
        var bestScore = -1
        var best = ""
        var firstFailure: Throwable? = null
        var anyRan = false
        for (script in order(uiLanguage)) {
            val r = recognize(script)
            val text = r.getOrElse { if (firstFailure == null) firstFailure = it; continue }
            anyRan = true
            val score = count(script, text)
            // Text from a model that found none of its own script still beats nothing (digits, a few Latin words).
            if (score > bestScore || (bestScore <= 0 && best.isBlank() && text.isNotBlank())) { bestScore = score; best = text }
            if (score >= ENOUGH) break
        }
        if (!anyRan) throw firstFailure ?: IllegalStateException("no text recognition model")
        return best
    }

    /**
     * A language to speak [text] in when the language detector could not decide (it needs about 20 characters): from the
     * script of the letters. Null for Latin script and when there are no letters, so the caller keeps its default.
     * Han letters alone are Chinese; with kana they are Japanese.
     */
    fun languageHint(text: String): String? {
        val counts = HashMap<Character.UnicodeScript, Int>()
        var uk = false
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            if (!Character.isLetter(cp)) continue
            if (cp == 0x0457 || cp == 0x0454 || cp == 0x0491 || cp == 0x0407 || cp == 0x0404 || cp == 0x0490) uk = true // ї є ґ: Ukrainian only
            val s = Character.UnicodeScript.of(cp)
            counts[s] = (counts[s] ?: 0) + 1
        }
        val kana = (counts[Character.UnicodeScript.HIRAGANA] ?: 0) + (counts[Character.UnicodeScript.KATAKANA] ?: 0)
        if (kana > 0) return "ja"
        val top = counts.maxByOrNull { it.value }?.key ?: return null
        return when (top) {
            Character.UnicodeScript.HAN -> "zh"
            Character.UnicodeScript.HANGUL -> "ko"
            Character.UnicodeScript.THAI -> "th"
            Character.UnicodeScript.DEVANAGARI -> "hi"
            Character.UnicodeScript.GREEK -> "el"
            Character.UnicodeScript.ARABIC -> "ar"
            Character.UnicodeScript.CYRILLIC -> if (uk) "uk" else "ru"
            else -> null
        }
    }
}
