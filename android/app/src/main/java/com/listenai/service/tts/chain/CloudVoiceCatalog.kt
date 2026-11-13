package com.listenai.service.tts.chain

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit

/** A voice the ReadAloud API lists. [id] is the id the Piper worker takes, for example "custom:es-pilot-f". */
data class CloudVoice(val id: String, val language: String, val gender: String?)

/** What the ReadAloud API offers, as the API itself says. Empty when it cannot be reached or does not say. */
interface CloudVoiceCatalog {
    suspend fun voices(): List<CloudVoice>

    object Empty : CloudVoiceCatalog {
        override suspend fun voices(): List<CloudVoice> = emptyList()
    }
}

/**
 * Which cloud voice, if any, reads a language other than English. The cloud source used to refuse every
 * non-English language. It now accepts a language only when the catalog lists a voice that is on [PREFERRED], so
 * a language the API does not actually serve (or a voice we have not vetted) is never tried, and a missing or
 * unreachable catalog simply leaves the phone's own voices to read it.
 */
object CloudVoicePolicy {
    /**
     * Language -> house voice, one per language. Only voices whose licence and provenance were audited for selling
     * (tier A in realtime-tts voices/LICENSES.md) belong here; never "the first voice listed".
     * es-pilot-f: CC BY 4.0 (CML-TTS, Oliveira et al. 2023; LibriTTS-R). Pilot model; see docs/tts-sources.md.
     */
    val PREFERRED: Map<String, String> = mapOf("es" to "custom:es-pilot-f")

    fun voiceFor(language: String, listed: List<CloudVoice>): CloudVoice? {
        val lang = LanguageKey.of(language)
        val wanted = PREFERRED[lang] ?: return null
        return listed.firstOrNull { it.id == wanted && LanguageKey.of(it.language) == lang }
    }

    /** Languages (2-letter) that have a vetted voice in [listed]. */
    fun languages(listed: List<CloudVoice>): Set<String> = PREFERRED.keys.filter { voiceFor(it, listed) != null }.toSet()

    /**
     * `{"voices":[{"voice_id":"custom:es-pilot-f","language":"es","gender":"female","engine":"piper"}, ...]}`, the
     * gateway's GET /v1/voices shape. Entries that are not Piper voices or lack an id or language are dropped; a
     * bare id gets the "custom:" prefix. Anything unparseable gives an empty list.
     */
    fun parse(json: String): List<CloudVoice> = try {
        val arr = JSONObject(json).optJSONArray("voices")
        buildList {
            if (arr != null) for (i in 0 until arr.length()) {
                val v = arr.optJSONObject(i) ?: continue
                val engine = v.optString("engine", "piper")
                val id = v.optString("voice_id", "").trim()
                val lang = v.optString("language", "").trim()
                if (engine != "piper" || id.isEmpty() || lang.isEmpty()) continue
                add(CloudVoice(if (id.startsWith("custom:")) id else "custom:$id", lang, v.optString("gender").takeIf { it.isNotBlank() }))
            }
        }
    } catch (e: Exception) {
        emptyList()
    }
}

/**
 * Reads the catalog from the app's backend (`GET /api/realtime-tts/voices`, which holds the platform key). In memory only,
 * fetched at most once per [okTtlMs] and, after a failure (including 404 from a backend that does not have the route yet),
 * not again for [failTtlMs]. Asked only when a language other than English is read.
 */
class HttpCloudVoiceCatalog(
    http: OkHttpClient,
    private val backendBaseUrl: String,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val okTtlMs: Long = 6 * 60 * 60_000L,
    private val failTtlMs: Long = 30 * 60_000L,
) : CloudVoiceCatalog {
    private val client = http.newBuilder().callTimeout(3, TimeUnit.SECONDS).build()
    @Volatile private var cached: List<CloudVoice> = emptyList()
    @Volatile private var validUntil = 0L
    // One fetch at a time: callers that arrive while one is running wait for it and then read what it stored.
    private val fetching = Mutex()

    override suspend fun voices(): List<CloudVoice> {
        if (nowMs() < validUntil) return cached
        return fetching.withLock {
            if (nowMs() < validUntil) return@withLock cached
            val fetched = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { fetch() }
            cached = fetched ?: emptyList()
            validUntil = nowMs() + if (fetched != null && fetched.isNotEmpty()) okTtlMs else failTtlMs
            cached
        }
    }

    private fun fetch(): List<CloudVoice>? = try {
        client.newCall(Request.Builder().url("$backendBaseUrl/api/realtime-tts/voices").header("Authorization", "Bearer ").build())
            .execute().use { r -> if (r.isSuccessful) CloudVoicePolicy.parse(r.body?.string().orEmpty()) else null }
    } catch (e: Exception) {
        null
    }
}
