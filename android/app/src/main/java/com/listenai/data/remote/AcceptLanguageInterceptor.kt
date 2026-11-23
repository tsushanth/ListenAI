package com.listenai.data.remote

import androidx.appcompat.app.AppCompatDelegate
import okhttp3.Interceptor
import okhttp3.Response
import java.util.Locale

/**
 * Tells our own servers which language the user reads the app in (per-app language when set, else the system
 * language), so server-side text can follow it. Error bodies also carry a stable `code` that the app translates
 * itself (see [ServerErrorText]); this header is how the server knows what was asked for.
 *
 * Only sent to our own hosts: third parties (Google, Supabase, model hosts) do not need the user's language.
 */
class AcceptLanguageInterceptor(
    private val languageTag: () -> String = ::currentLanguageTag
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header("Accept-Language") != null || !isOurHost(request.url.host)) return chain.proceed(request)
        return chain.proceed(request.newBuilder().header("Accept-Language", headerValue(languageTag())).build())
    }

    companion object {
        private val OUR_HOSTS = listOf("listenai-backend.fly.dev", "api.listenai.app", "api.readaloudai.org")

        fun isOurHost(host: String): Boolean = OUR_HOSTS.any { host == it }

        /** "fr-FR" -> "fr-FR, fr;q=0.9, en;q=0.5". English is the fallback the server text is written in. */
        fun headerValue(tag: String): String {
            val clean = tag.trim().ifEmpty { "en" }
            val base = clean.substringBefore('-')
            return buildString {
                append(clean)
                if (base != clean) append(", ").append(base).append(";q=0.9")
                if (base != "en") append(", en;q=0.5")
            }
        }

        /** The per-app language when the user picked one, otherwise the system language. Never throws. */
        fun currentLanguageTag(): String = runCatching {
            val app = AppCompatDelegate.getApplicationLocales()
            val locale = if (!app.isEmpty) app[0] else null
            (locale ?: Locale.getDefault()).toLanguageTag().takeIf { it.isNotBlank() && it != "und" } ?: "en"
        }.getOrDefault("en")
    }
}
