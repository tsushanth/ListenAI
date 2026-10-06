package com.listenai.service.voice

import android.content.Context
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * App-level entry point for consent-gated voice cloning (replaces the legacy `/api/cloned-voices`
 * + `voice_url` path, which the backend now rejects with 410 consent_required).
 *
 * Owns the HTTP client ([VoiceCloneApi]) and a small in-memory voice list that other screens
 * (player, voice picker, TTS coordinator) read. Reference audio is never available on the device
 * after upload and never returned by the API; synthesis is cloud-only by voice id.
 */
class VoiceCloningService private constructor(private val context: Context) {

    companion object {
        /**
         * Reading text for the reference recording. A reference should be 30 to 60 seconds of
         * natural, continuous speech (backend gate: 8 to 120 s). Any speech works; this is a prompt.
         */
        val SAMPLE_PARAGRAPHS = listOf(
            "Welcome to ReadAloud. I'm recording my voice so the app can create a personalized voice that sounds just like me. This feature uses artificial intelligence to capture the unique qualities of my voice.",

            "The technology analyzes the patterns, tone, and rhythm of my speech. It learns how I pronounce different words, the natural pauses I make, and the qualities that make my voice distinctive.",

            "Reading aloud has always been a wonderful way to enjoy content. Whether it's news articles, blog posts, research papers, or even emails, having them read in a familiar voice makes the experience so much more personal and engaging.",

            "I particularly enjoy listening to content during my morning commute, while exercising, or when my eyes need a rest from screens. The ability to have any text converted to natural-sounding speech has changed how I consume information.",

            "With my own voice, I can listen to my favorite content as if I were reading it to myself. It's like having a personal narrator who speaks exactly how I would."
        )

        const val DEFAULT_BACKEND_URL = "https://listenai-backend.fly.dev"

        private const val PREFS = "voice_cloning"
        /** Local cache the legacy implementation wrote; its presence means the user had legacy voices. */
        private const val LEGACY_CACHE_KEY = "com.listenai.clonedVoices"
        private const val LEGACY_NOTICE_SEEN_KEY = "legacy_voices_notice_seen"

        @Volatile
        private var instance: VoiceCloningService? = null

        fun getInstance(context: Context): VoiceCloningService {
            return instance ?: synchronized(this) {
                instance ?: VoiceCloningService(context.applicationContext).also { instance = it }
            }
        }

        /**
         * Pure rule for the one-time "old voices must be re-created" note: show it once, and only to
         * users who actually had legacy voices (the legacy list cache is non-empty).
         */
        fun shouldShowLegacyNotice(legacyCacheJson: String?, alreadySeen: Boolean): Boolean {
            if (alreadySeen) return false
            val json = legacyCacheJson?.trim().orEmpty()
            return json.isNotEmpty() && json != "[]" && json != "null"
        }
    }

    private var baseUrl: String = DEFAULT_BACKEND_URL
    private var auth: VoiceCloneAuth? = null
    @Volatile private var cached: List<ClonedVoice> = emptyList()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        // multipart upload + server-side checks (ASR, speaker match) can take a while
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    @Volatile private var apiInstance: VoiceCloneApi? = null

    /** Wire the backend URL and the token source. Safe to call again (e.g. from DI). */
    fun configure(baseUrl: String, auth: VoiceCloneAuth? = this.auth) {
        this.baseUrl = baseUrl.trimEnd('/')
        this.auth = auth
        apiInstance = null
    }

    val isConfigured: Boolean get() = auth != null

    val authState: VoiceCloneAuth? get() = auth

    val api: VoiceCloneApi
        get() = apiInstance ?: VoiceCloneApi(baseUrl, httpClient) { auth?.accessToken() }.also { apiInstance = it }

    /**
     * The signed-in user's cloned voices. Returns an empty list when signed out (other screens call
     * this opportunistically). Throws [VoiceCloneException] on server/network failures.
     */
    suspend fun listClonedVoices(forceRefresh: Boolean = false): List<ClonedVoice> {
        val auth = auth
        if (auth == null || !auth.isSignedIn.value) {
            cached = emptyList()
            return emptyList()
        }
        if (!forceRefresh && cached.isNotEmpty()) return cached
        val voices = api.listVoices().filter { it.isReady }
        cached = voices
        return voices
    }

    suspend fun deleteClonedVoice(voiceId: String) {
        api.deleteVoice(voiceId)
        cached = cached.filter { it.id != voiceId }
        // Drop locally cached preview audio generated with this voice.
        File(context.cacheDir, "cloned_voice_previews").listFiles { f -> f.name.startsWith("preview_$voiceId.") }
            ?.forEach { it.delete() }
    }

    /** Call after a successful create so other screens see the new voice immediately. */
    fun invalidateCache() {
        cached = emptyList()
    }

    // ---- legacy voices -----------------------------------------------------------------

    fun shouldShowLegacyVoicesNotice(): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return shouldShowLegacyNotice(prefs.getString(LEGACY_CACHE_KEY, null), prefs.getBoolean(LEGACY_NOTICE_SEEN_KEY, false))
    }

    /** Marks the note as seen and drops the stale legacy list (those voices are inert server-side). */
    fun markLegacyVoicesNoticeShown() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(LEGACY_NOTICE_SEEN_KEY, true)
            .remove(LEGACY_CACHE_KEY)
            .apply()
    }
}
