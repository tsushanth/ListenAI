package com.listenai.service.tts.chain

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit

/**
 * A voice the ReadAloud API lists. [id] is the id the speech service takes (a public id such as "aria", or a legacy
 * "custom:..." id); [name] is the name the API gives it. [languages] are 2-letter codes this voice speaks (a multilingual
 * voice lists several, a single-language voice only its own); [tier] is the API's quality tier ("live", "studio").
 */
data class CloudVoice(
    val id: String,
    val language: String,
    val gender: String?,
    val name: String? = null,
    val languages: Set<String> = ApiLanguageCode.of(language)?.let { setOf(it) }.orEmpty(),
    val tier: String? = null,
) {
    /** One voice that speaks several languages: it must be told which one with `language_code`. */
    val multilingual: Boolean get() = languages.size > 1
}

/** What the ReadAloud API offers, as the API itself says. Empty when it cannot be reached or does not say. */
interface CloudVoiceCatalog {
    suspend fun voices(): List<CloudVoice>

    /** The API refused a voice or language the list had offered: look at the list again soon. */
    fun invalidate() {}

    object Empty : CloudVoiceCatalog {
        override suspend fun voices(): List<CloudVoice> = emptyList()
    }
}

/**
 * The language code the API takes for a language the app knows by a device or detector code. Two-letter, lower case;
 * regional forms ("es-MX", "pt-BR") become the language; the codes older Android versions still report ("in", "iw", "ji", "jw")
 * become the current ones. Null for "und", blank, or anything that is not a language code, so such text is never sent as a language.
 */
object ApiLanguageCode {
    private val ALIASES = mapOf("in" to "id", "iw" to "he", "ji" to "yi", "jw" to "jv")
    private val NOT_A_LANGUAGE = setOf("und", "zxx", "mul", "mis")

    fun of(raw: String?): String? {
        val base = raw?.trim()?.lowercase()?.replace('_', '-')?.substringBefore('-') ?: return null
        if (base.length !in 2..3 || !base.all { it in 'a'..'z' } || base in NOT_A_LANGUAGE) return null
        return ALIASES[base] ?: base
    }

    fun isEnglish(raw: String?): Boolean = of(raw) == "en"
}

/**
 * Which cloud voice, if any, reads a language other than English, decided from what the API lists and nothing else:
 * a language is read in the cloud only when a listed voice speaks it, so the API's list is the switch for adding or hiding a
 * language (the worker itself does not refuse a language the list leaves out, so the app must). A missing or unreachable
 * catalog leaves the phone's own voices to read it.
 *
 * Voices offered for a language L, in the order the API lists them: first the live-tier voices whose `languages` contain L (the
 * multilingual voices; the first of them is the default), then live-tier single-language voices whose own language is L. The
 * studio tier is English only and never offered here.
 */
object CloudVoicePolicy {
    private fun usableTier(v: CloudVoice) = v.tier == null || v.tier.equals("live", ignoreCase = true)

    /** The voices the picker offers for [language], default first; empty when the cloud does not read it. English never goes through this path. */
    fun voicesFor(language: String, listed: List<CloudVoice>): List<CloudVoice> {
        val lang = ApiLanguageCode.of(language) ?: return emptyList()
        if (lang == "en") return emptyList()
        val speaking = listed.filter { usableTier(it) && lang in it.languages }
        val (multi, single) = speaking.partition { it.multilingual }
        return multi + single
    }

    /**
     * The voice that reads [language]: the user's pick ([preferredId]) when it is still offered for that language, else the first
     * offered voice. Null when the cloud does not read the language.
     */
    fun voiceFor(language: String, listed: List<CloudVoice>, preferredId: String? = null): CloudVoice? {
        val offered = voicesFor(language, listed)
        return offered.firstOrNull { preferredId != null && it.id == preferredId } ?: offered.firstOrNull()
    }

    /** 2-letter codes of the non-English languages the cloud reads now. */
    fun languages(listed: List<CloudVoice>): Set<String> {
        val all = LinkedHashSet<String>()
        for (v in listed) if (usableTier(v)) all += v.languages
        all.remove("en")
        return all.filter { voiceFor(it, listed) != null }.toSet()
    }

    /**
     * The `language_code` to send with [voice] for text in [language]: a multilingual voice takes the plain language code; a
     * single-language voice takes the language as the catalog lists it ("pt-BR" for a Brazilian voice), which is what its own
     * listing says it speaks. Never sent for English (the app's English voices need none).
     */
    fun languageCode(voice: CloudVoice, language: String): String? {
        val lang = ApiLanguageCode.of(language) ?: return null
        if (lang == "en") return null
        return if (voice.multilingual) lang else voice.language.trim().replace('_', '-').ifEmpty { lang }
    }

    /**
     * The API's voice list: `{"voices":[{"voice_id":"aria","name":"Aria","language":"en","languages":["en","es",...],"gender":"female","tier":"live"}, ...]}`
     * (GET /v1/catalog; the older `GET /v1/voices` list has the same voice fields). Entries without an id or any language are
     * dropped, as are entries that name an engine other than Piper (an older listing shape). Ids are kept exactly as listed.
     * Anything unparseable gives an empty list.
     */
    fun parse(json: String): List<CloudVoice> = try {
        val arr = JSONObject(json).optJSONArray("voices")
        buildList {
            if (arr != null) for (i in 0 until arr.length()) {
                val v = arr.optJSONObject(i) ?: continue
                val engine = v.optString("engine", "").trim()
                val id = v.optString("voice_id", "").trim()
                val lang = v.optString("language", "").trim()
                if ((engine.isNotEmpty() && engine != "piper") || id.isEmpty()) continue
                val codes = LinkedHashSet<String>()
                ApiLanguageCode.of(lang)?.let { codes += it }
                v.optJSONArray("languages")?.let { a ->
                    for (j in 0 until a.length()) ApiLanguageCode.of(a.optString(j, ""))?.let { codes += it }
                }
                if (codes.isEmpty()) continue
                add(
                    CloudVoice(
                        id = id,
                        language = lang.ifEmpty { codes.first() },
                        gender = v.optString("gender").takeIf { it.isNotBlank() },
                        name = v.optString("name").takeIf { it.isNotBlank() },
                        languages = codes,
                        tier = v.optString("tier").takeIf { it.isNotBlank() },
                    )
                )
            }
        }
    } catch (e: Exception) {
        emptyList()
    }
}

/**
 * Reads the voice list from the ReadAloud API's public catalog ([catalogUrl], `GET /v1/catalog`: no key, no text, only the IP address is
 * visible; the API says it may be cached for 60 s). In memory only, fetched at most once per [okTtlMs]; after a failure (a 404, a timeout) not again for [failTtlMs]. While a
 * refresh fails the last good list keeps being used for up to [staleMs], so a flaky connection does not switch the cloud voices off.
 * [invalidate] (the API refused a language it had listed) schedules a refresh, at most once per [minRefreshMs].
 * Asked only when a language other than English is read.
 */
class HttpCloudVoiceCatalog(
    http: OkHttpClient,
    private val catalogUrl: String,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val okTtlMs: Long = 60_000L,
    private val failTtlMs: Long = 60_000L,
    private val staleMs: Long = 6 * 60 * 60_000L,
    private val minRefreshMs: Long = 60_000L,
) : CloudVoiceCatalog {
    private val client = http.newBuilder().callTimeout(3, TimeUnit.SECONDS).build()
    @Volatile private var cached: List<CloudVoice> = emptyList()
    @Volatile private var lastGoodAt = 0L
    @Volatile private var lastFetchAt = 0L
    @Volatile private var validUntil = 0L
    // One fetch at a time: callers that arrive while one is running wait for it and then read what it stored.
    private val fetching = Mutex()

    override fun invalidate() {
        if (nowMs() - lastFetchAt >= minRefreshMs) validUntil = 0L
    }

    override suspend fun voices(): List<CloudVoice> {
        if (nowMs() < validUntil) return cached
        return fetching.withLock {
            if (nowMs() < validUntil) return@withLock cached
            val fetched = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { fetch() }
            val now = nowMs()
            lastFetchAt = now
            if (fetched != null && fetched.isNotEmpty()) {
                cached = fetched; lastGoodAt = now; validUntil = now + okTtlMs
            } else {
                // An empty but well-formed list is the API saying "nothing"; a failure keeps the last good list for a while.
                if (fetched != null || now - lastGoodAt > staleMs) cached = emptyList()
                validUntil = now + failTtlMs
            }
            cached
        }
    }

    private fun fetch(): List<CloudVoice>? = try {
        client.newCall(Request.Builder().url(catalogUrl).build())
            .execute().use { r -> if (r.isSuccessful) CloudVoicePolicy.parse(r.body?.string().orEmpty()) else null }
    } catch (e: Exception) {
        null
    }
}
