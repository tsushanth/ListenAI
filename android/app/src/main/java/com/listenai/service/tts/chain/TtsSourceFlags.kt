package com.listenai.service.tts.chain

import android.content.Context
import android.util.Log
import com.listenai.BuildConfig
import com.listenai.ListenAIApplication
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Where speech comes from by default. Three layers, first that is set wins:
 *  1. a local override (set by the debug benchmark / adb, never by users),
 *  2. the remote value from `GET /api/config` -> `tts.apiEnabled` / `tts.engineApiEnabled`, cached from the last fetch,
 *  3. the build default (`BuildConfig.TTS_API_DEFAULT`, `TTS_ENGINE_API_DEFAULT`; the first true, the engine one FALSE for privacy).
 * Off means "the on-device model first, then the system engine", the way it was before the API path.
 * A new remote value applies from the next read, because it is looked up per session.
 */
object TtsSourceFlags {
    private const val TAG = "TtsSourceFlags"
    private const val PREFS = "tts_source_flags"
    private const val REFRESH_EVERY_MS = 6 * 60 * 60 * 1000L

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun opt(c: Context, key: String): Boolean? = prefs(c).takeIf { it.contains(key) }?.getBoolean(key, false)

    fun apiEnabled(c: Context): Boolean =
        TtsFlagLogic.resolve(opt(c, "override_api"), opt(c, "remote_api"), BuildConfig.TTS_API_DEFAULT)

    /**
     * Whether the ReadAloud system TTS engine (other apps' speech) tries the API first. Off unless explicitly enabled:
     * that text can be private. Even when on, screen readers are never routed ([EngineCallerPolicy]).
     */
    fun engineApiEnabled(c: Context): Boolean =
        TtsFlagLogic.resolve(opt(c, "override_engine_api"), opt(c, "remote_engine_api"), BuildConfig.TTS_ENGINE_API_DEFAULT)

    fun setOverride(c: Context, api: Boolean?, engineApi: Boolean? = null) {
        prefs(c).edit().apply {
            if (api == null) remove("override_api") else putBoolean("override_api", api)
            if (engineApi == null) remove("override_engine_api") else putBoolean("override_engine_api", engineApi)
        }.apply()
    }

    /** Blocking; call from a background thread. Never throws. At most once every six hours. */
    fun refreshRemote(c: Context, force: Boolean = false) {
        try {
            val p = prefs(c)
            if (!force && System.currentTimeMillis() - p.getLong("fetched_at", 0) < REFRESH_EVERY_MS) return
            val client = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).build()
            client.newCall(Request.Builder().url("${ListenAIApplication.BACKEND_URL}/api/config").build()).execute().use { resp ->
                if (!resp.isSuccessful) return
                val remote = TtsFlagLogic.parseRemote(resp.body?.string().orEmpty())
                p.edit().apply {
                    // An absent field clears the remote value, so removing it server-side returns the app to its build default.
                    if (remote.apiEnabled == null) remove("remote_api") else putBoolean("remote_api", remote.apiEnabled)
                    if (remote.engineApiEnabled == null) remove("remote_engine_api") else putBoolean("remote_engine_api", remote.engineApiEnabled)
                    putLong("fetched_at", System.currentTimeMillis())
                }.apply()
            }
        } catch (e: Exception) {
            Log.d(TAG, "Remote TTS flags skipped: ${e.message}")
        }
    }
}
