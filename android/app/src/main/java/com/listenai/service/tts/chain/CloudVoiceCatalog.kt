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
    /**
     * For a studio-tier voice: the catalog said its WebSocket route is ready (`tiers.studio.ws` is true). A studio voice without it is
     * listed but never offered or used (see [CloudVoicePolicy]). Not meaningful for other tiers.
     */
    val studioRoute: Boolean = true,
) {
    /** One voice that speaks several languages: it must be told which one with `language_code`. */
    val multilingual: Boolean get() = languages.size > 1

    /** The API's studio tier (Beta): slower to start after idle, used for another language only when no live voice speaks it. */
    val studio: Boolean get() = tier.equals("studio", ignoreCase = true)

    /** A studio voice the app may offer and use: its tier is studio and the catalog says the route is ready. */
    val studioUsable: Boolean get() = studio && studioRoute

    /** The API labels a voice it holds back as a default with "(Experimental)" in its name; the picker shows the name as it comes. */
    val experimental: Boolean get() = name?.contains("(experimental)", ignoreCase = true) == true
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
 * become the current ones; Norwegian Bokmal and Nynorsk ("nb", "nn", what a phone or a document may say) become "no", the code the API lists. Null for "und", blank, or anything that is not a language code, so such text is never sent as a language.
 */
object ApiLanguageCode {
    private val ALIASES = mapOf("in" to "id", "iw" to "he", "ji" to "yi", "jw" to "jv", "nb" to "no", "nn" to "no")
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
 * language (the worker itself does not refuse an unlisted language, and answers an unknown voice id with audio from a default
 * voice, so the app checks both against the list). A missing or unreachable catalog leaves the phone's own voices to read it.
 *
 * Voices offered for a language L, in this order: live-tier single-language voices whose own language is L (native voices of
 * that language), in the API's order; then live-tier voices whose `languages` contain L (the multilingual voices), in the API's
 * order; then, only when the API's catalog says its studio route is ready (`tiers.studio.ws` is true, see [parseStrict]), the studio-tier
 * voices that speak L, in the API's order. Last, a stable re-sort moves every voice whose name contains "(experimental)" after all the
 * others. The first one is the default. Without the `ws` flag no studio voice is offered, so this is exactly the live-only behaviour.
 * Portuguese: the app knows only "pt" (the language detector does not tell Brazilian from European text), so "pt" is read by a
 * voice the API lists for Portuguese, which today is a Brazilian one.
 */
object CloudVoicePolicy {
    private fun liveTier(v: CloudVoice) = v.tier == null || v.tier.equals("live", ignoreCase = true)

    /** The voices the picker offers for [language], default first; empty when the cloud does not read it. English never goes through this path. */
    fun voicesFor(language: String, listed: List<CloudVoice>): List<CloudVoice> {
        val lang = ApiLanguageCode.of(language) ?: return emptyList()
        if (lang == "en") return emptyList()
        val speaking = listed.filter { liveTier(it) && lang in it.languages }
        val (multi, single) = speaking.partition { it.multilingual }
        // Then the studio tier's voices (Beta) that speak the language, in the API's order.
        val studio = listed.filter { it.studioUsable && lang in it.languages }
        // A voice the API names "(Experimental)" is an opt-in pick: it goes after every other voice, whatever its tier (stable sort).
        return (single + multi + studio).sortedBy { it.experimental }
    }

    /**
     * The voice that reads [language]: the user's pick ([preferredId]) when it is still offered for that language, else the first
     * offered voice. Null when the cloud does not read the language.
     */
    fun voiceFor(language: String, listed: List<CloudVoice>, preferredId: String? = null): CloudVoice? {
        val offered = voicesFor(language, listed)
        return offered.firstOrNull { preferredId != null && it.id == preferredId } ?: offered.firstOrNull()
    }

    /** 2-letter codes of the non-English languages the cloud reads now (live voices, and studio voices for languages without a live one). Read from what each voice speaks, never from voice counts. */
    fun languages(listed: List<CloudVoice>): Set<String> {
        val all = LinkedHashSet<String>()
        for (v in listed) if (liveTier(v) || v.studioUsable) all += v.languages
        all.remove("en")
        return all.filter { voiceFor(it, listed) != null }.toSet()
    }

    /**
     * The `language_code` to send with [voice] for text in [language]: a multilingual voice takes the plain language code; a
     * single-language voice takes the language as the catalog lists it ("pt-BR" for a Brazilian voice), which is what its own
     * listing says it speaks. A studio voice always takes the plain code (its listed `language` is its home language, not the one asked for). Never sent for English (the app's English voices need none).
     */
    fun languageCode(voice: CloudVoice, language: String): String? {
        val lang = ApiLanguageCode.of(language) ?: return null
        if (lang == "en") return null
        return if (voice.multilingual || voice.studio) lang else voice.language.trim().replace('_', '-').ifEmpty { lang }
    }

    /**
     * The API's voice list: `{"voices":[{"voice_id":"aria","name":"Aria","language":"en","languages":["en","es",...],"gender":"female","tier":"live"}, ...]}`
     * (GET /v1/catalog; the older `GET /v1/voices` list has the same voice fields). Entries without an id or any language are
     * dropped, as are entries that name an engine other than Piper (an older listing shape). Ids are kept exactly as listed.
     * Studio-tier entries are marked usable only when `tiers.studio.ws` is true (the server's switch for the studio route; absent or false = ignored).
     * Anything unparseable gives an empty list.
     */
    fun parse(json: String): List<CloudVoice> = parseStrict(json).orEmpty()

    /** The voice ids the authorize call takes for the studio route (the backend ignores any other). */
    val STUDIO_VOICE_ID = Regex("^[a-z0-9._-]{1,64}$")

    /** `tiers.studio.ws` of the catalog: true only when it is the JSON boolean true. Absent, false or anything else means the studio tier is not served over the app's WebSocket route yet. */
    fun studioRouteReady(root: JSONObject): Boolean = root.optJSONObject("tiers")?.optJSONObject("studio")?.opt("ws") == true

    /**
     * Like [parse], but tells "the API sent a voice list" apart from "something else came back": null when the body is not a JSON
     * object with a `voices` array (a captive-portal page, a truncated body, `{}`), or when the array has entries but none is a
     * usable voice. A well-formed `{"voices":[]}` is an empty list: the API saying it offers nothing.
     */
    fun parseStrict(json: String): List<CloudVoice>? = try {
        val root = JSONObject(json)
        val arr = root.optJSONArray("voices")
        if (arr == null) null
        else {
            val parsed = buildList {
                for (i in 0 until arr.length()) {
                    val v = arr.optJSONObject(i) ?: continue
                    val engine = v.optString("engine", "").trim()
                    val id = v.optString("voice_id", "").trim()
                    val lang = v.optString("language", "").trim()
                    if ((engine.isNotEmpty() && engine != "piper") || id.isEmpty()) continue
                    // The studio route names its voice by public id; an id the authorize call would not accept is never offered.
                    if (v.optString("tier").equals("studio", ignoreCase = true) && !STUDIO_VOICE_ID.matches(id)) continue
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
            if (parsed.isEmpty() && arr.length() > 0) null
            // The studio tier is used only while the API says its WebSocket route is ready; otherwise its voices stay listed but are never offered.
            else if (studioRouteReady(root)) parsed else parsed.map { if (it.studio) it.copy(studioRoute = false) else it }
        }
    } catch (e: Exception) {
        null
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
        client.newCall(Request.Builder().url(catalogUrl).build()).execute().use { r ->
            // Only a 200 JSON voice list counts. A captive portal's HTML page, a truncated body or `{}` is a failed read, so the last good list stays.
            val type = r.header("Content-Type").orEmpty()
            if (!r.isSuccessful || (type.isNotEmpty() && !type.contains("json", ignoreCase = true))) null
            else CloudVoicePolicy.parseStrict(r.body?.string().orEmpty())
        }
    } catch (e: Exception) {
        null
    }
}
