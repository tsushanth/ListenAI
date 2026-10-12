package com.listenai.service

import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.languageid.LanguageIdentificationOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import kotlin.coroutines.resume

/**
 * On-device language detection for imported content (ML Kit language-id, bundled model, no network).
 * Returns an ISO 639-1 code such as "es", or "en" when the text is too short or too ambiguous to call,
 * so a wrong guess never sends English text to a foreign-language voice.
 */
object LanguageDetector {

    const val DEFAULT = "en"
    private const val SAMPLE_CHARS = 1500
    private const val MIN_CHARS = 20
    internal const val MIN_CONFIDENCE = 0.6f

    /** Pure decision logic: the best candidate at or above [minConfidence], as a 2-letter code. */
    internal fun pickLanguage(candidates: List<Pair<String, Float>>, minConfidence: Float = MIN_CONFIDENCE): String? {
        val best = candidates.maxByOrNull { it.second } ?: return null
        if (best.second < minConfidence) return null
        return normalize(best.first)
    }

    /** "und" (undetermined) becomes null; "zh-Latn" and "ja-Latn" style tags drop the script. */
    internal fun normalize(tag: String): String? {
        val t = tag.trim().lowercase(Locale.ROOT)
        if (t.isEmpty() || t == "und") return null
        return t.substringBefore('-')
    }

    /** A sample from the start and middle, since front matter (a title page, a licence) is often not the body language. */
    internal fun sample(text: String): String {
        val t = text.trim()
        if (t.length <= SAMPLE_CHARS) return t
        val half = SAMPLE_CHARS / 2
        val mid = t.length / 2
        return t.take(half) + "\n" + t.substring(mid, mid + half)
    }

    suspend fun detect(text: String): String {
        val sample = sample(text)
        if (sample.length < MIN_CHARS) return DEFAULT
        return runCatching { identify(sample) }.getOrNull() ?: DEFAULT
    }

    private suspend fun identify(sample: String): String? = suspendCancellableCoroutine { cont ->
        val client = LanguageIdentification.getClient(
            LanguageIdentificationOptions.Builder().setConfidenceThreshold(0.01f).build()
        )
        client.identifyPossibleLanguages(sample)
            .addOnSuccessListener { list ->
                client.close()
                if (cont.isActive) cont.resume(pickLanguage(list.map { it.languageTag to it.confidence }))
            }
            .addOnFailureListener {
                client.close()
                if (cont.isActive) cont.resume(null)
            }
        cont.invokeOnCancellation { client.close() }
    }

    /** Human-readable name in the user's UI language, for example "Spanish". */
    fun displayName(code: String?): String? {
        if (code.isNullOrBlank()) return null
        val name = Locale.forLanguageTag(code).getDisplayLanguage(Locale.getDefault())
        return name.takeIf { it.isNotBlank() && !it.equals(code, ignoreCase = true) }
            ?.replaceFirstChar { it.titlecase(Locale.getDefault()) }
    }
}
