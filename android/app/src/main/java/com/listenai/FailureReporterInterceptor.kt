package com.listenai

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Reports backend 5xx responses. Deliberately ignores 4xx (auth/validation noise) and
 * IOExceptions (a user with no signal is not an app failure). Path only, never the query.
 */
class FailureReporterInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.code >= 500) {
            val url = chain.request().url
            FailureReporter.backendError(
                flow = "${chain.request().method} ${url.encodedPath}",
                message = "HTTP ${response.code} from ${url.host}",
            )
        }
        return response
    }
}
