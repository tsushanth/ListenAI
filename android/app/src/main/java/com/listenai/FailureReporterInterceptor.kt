package com.listenai

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Reports 5xx answers from our own services. Deliberately ignores 4xx (auth/validation noise) and IOExceptions (a user
 * with no signal is not an app failure), and other people's hosts (a web page the user imports is not our failure).
 * Route only, with ids replaced: never the query.
 *
 * Every OkHttpClient that talks to our services adds this (guarded by FailureReporterInterceptorTest).
 */
class FailureReporterInterceptor(
    private val report: (flow: String, message: String) -> Unit = { flow, message -> FailureReporter.backendError(flow, message) },
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.code >= 500) {
            val url = chain.request().url
            if (isOwnHost(url.host)) {
                report("${chain.request().method} ${routeOf(url.encodedPath)}", "HTTP ${response.code} from ${url.host}")
            }
        }
        return response
    }

    companion object {
        private val OWN_HOSTS = setOf("readaloudai.org", "listenai-backend.fly.dev", "listenai-tts-worker.fly.dev", "piper-tts-sjc.fly.dev")
        private val OWN_SUFFIXES = listOf(".readaloudai.org", ".supabase.co", ".modal.run")

        /** An id inside a path: at least 8 characters and at least one digit (uuids, job ids, voice ids). */
        private val ID_SEGMENT = Regex("^(?=.*[0-9])[0-9A-Za-z_-]{8,}$")

        fun isOwnHost(host: String): Boolean = host in OWN_HOSTS || OWN_SUFFIXES.any { host.endsWith(it) }

        fun routeOf(path: String): String = path.split('/').joinToString("/") { if (ID_SEGMENT.matches(it)) ":id" else it }
    }
}
