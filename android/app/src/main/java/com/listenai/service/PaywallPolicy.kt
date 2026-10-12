package com.listenai.service

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Tunable paywall limits. Defaults are used until (and unless) the server supplies values. */
data class PaywallConfig(
    /** Sessions (cold starts) a user must have, after their first listen, before the paywall can appear. */
    val minOpensAfterFirstListen: Int = 2,
    /** A user who has never listened still sees the paywall once they pass this many sessions. */
    val openLimitWithoutListen: Int = 3,
    /** Minimum gap between two paywall appearances. */
    val cooldownHours: Int = 24
)

object PaywallPolicy {

    /**
     * Whether to show the paywall on this cold start.
     *
     * Never for premium users; only after the user has had a chance to get value (a first
     * listen) or has opened the app many times without one; and at most once per cooldown.
     */
    fun shouldShow(
        openCount: Int,
        hasListened: Boolean,
        lastShownAtMs: Long,
        nowMs: Long,
        isPremium: Boolean,
        config: PaywallConfig = PaywallConfig()
    ): Boolean {
        if (isPremium) return false
        val eligible = (hasListened && openCount >= config.minOpensAfterFirstListen) ||
            openCount > config.openLimitWithoutListen
        if (!eligible) return false
        val cooldownMs = config.cooldownHours * 60L * 60L * 1000L
        return lastShownAtMs <= 0L || nowMs - lastShownAtMs >= cooldownMs
    }
}

/**
 * Optional server-side overrides for [PaywallConfig], fetched from `GET /api/config` in the
 * background and cached. The new values apply from the next app start. If the server does not
 * send a `paywall` block (or is unreachable) the defaults above are used.
 */
object PaywallRemoteConfig {
    private const val TAG = "PaywallRemoteConfig"
    private const val PREFS = "paywall_remote_config"
    // The app's real backend (api.listenai.app does not resolve).
    private const val URL = "${com.listenai.ListenAIApplication.BACKEND_URL}/api/config"

    fun current(context: Context): PaywallConfig {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val d = PaywallConfig()
        return PaywallConfig(
            minOpensAfterFirstListen = p.getInt("minOpensAfterFirstListen", d.minOpensAfterFirstListen),
            openLimitWithoutListen = p.getInt("openLimitWithoutListen", d.openLimitWithoutListen),
            cooldownHours = p.getInt("cooldownHours", d.cooldownHours)
        )
    }

    /** Blocking; call from a background thread. Never throws. */
    fun refresh(context: Context) {
        try {
            val client = OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS)
                .build()
            client.newCall(Request.Builder().url(URL).build()).execute().use { resp ->
                if (!resp.isSuccessful) return
                val paywall = JSONObject(resp.body?.string().orEmpty()).optJSONObject("paywall") ?: return
                val edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                if (paywall.has("minOpensAfterFirstListen"))
                    edit.putInt("minOpensAfterFirstListen", paywall.getInt("minOpensAfterFirstListen").coerceIn(1, 20))
                if (paywall.has("openLimitWithoutListen"))
                    edit.putInt("openLimitWithoutListen", paywall.getInt("openLimitWithoutListen").coerceIn(0, 50))
                if (paywall.has("cooldownHours"))
                    edit.putInt("cooldownHours", paywall.getInt("cooldownHours").coerceIn(1, 720))
                edit.apply()
            }
        } catch (e: Exception) {
            Log.d(TAG, "Config refresh skipped: ${e.message}")
        }
    }
}
