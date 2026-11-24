package com.listenai.data.remote

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AcceptLanguageInterceptorTest {

    @Test fun `header value is the tag, its language and English as the fallback`() {
        assertEquals("fr-FR, fr;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("fr-FR"))
        assertEquals("de, en;q=0.5", AcceptLanguageInterceptor.headerValue("de"))
        assertEquals("en", AcceptLanguageInterceptor.headerValue("en"))
        assertEquals("en-GB, en;q=0.9", AcceptLanguageInterceptor.headerValue("en-GB"))
        assertEquals("zh-CN, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-CN"))
        assertEquals("en", AcceptLanguageInterceptor.headerValue(" "))
    }

    @Test fun `Chinese scripts reach the server as distinct tags`() {
        assertEquals("zh-TW, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-TW"))
        assertEquals("zh-TW, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-Hant-TW"))
        assertEquals("zh-TW, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-Hant"))
        assertEquals("zh-HK, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-HK"))
        assertEquals("zh-HK, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-Hant-HK"))
        assertEquals("zh-HK, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-Hant-MO"))
        assertEquals("zh-CN, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-Hans-CN"))
        assertEquals("zh-CN, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-Hans"))
        assertEquals("zh-CN, zh;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh-SG"))
        assertEquals("zh, en;q=0.5", AcceptLanguageInterceptor.headerValue("zh"))
        assertEquals("fr-FR, fr;q=0.9, en;q=0.5", AcceptLanguageInterceptor.headerValue("fr-FR"))
    }

    @Test fun `only our own hosts`() {
        assertTrue(AcceptLanguageInterceptor.isOurHost("listenai-backend.fly.dev"))
        assertTrue(AcceptLanguageInterceptor.isOurHost("api.readaloudai.org"))
        assertFalse(AcceptLanguageInterceptor.isOurHost("accounts.google.com"))
        assertFalse(AcceptLanguageInterceptor.isOurHost("evil-listenai-backend.fly.dev"))
    }

    private fun sentHeader(url: String, tag: String, preset: String? = null): String? {
        var seen: Request? = null
        val capture = Interceptor { chain ->
            seen = chain.request()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("{}".toResponseBody()).build()
        }
        val client = OkHttpClient.Builder().addInterceptor(AcceptLanguageInterceptor { tag }).addInterceptor(capture).build()
        val req = Request.Builder().url(url).apply { if (preset != null) header("Accept-Language", preset) }.build()
        client.newCall(req).execute().close()
        return seen!!.header("Accept-Language")
    }

    @Test fun `sends the language to our backend`() {
        assertEquals("ja, en;q=0.5", sentHeader("https://listenai-backend.fly.dev/api/tts/job", "ja"))
    }

    @Test fun `does not send it to third parties`() {
        assertNull(sentHeader("https://www.googleapis.com/gmail/v1/users/me/messages", "ja"))
    }

    @Test fun `keeps a header the caller set`() {
        assertEquals("es", sentHeader("https://listenai-backend.fly.dev/x", "ja", preset = "es"))
    }
}
