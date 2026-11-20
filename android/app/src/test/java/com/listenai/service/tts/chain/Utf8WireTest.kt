package com.listenai.service.tts.chain

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The text the app puts on the wire for a non-Latin language reaches the worker unchanged, as UTF-8 characters (not escaped, not transliterated, not cut). */
class Utf8WireTest {

    private val live = CloudVoice("aria", "en", "female", "Aria", setOf("en", "ja", "ru"), "live")
    private val mira = CloudVoice("mira", "en", "female", "Mira", setOf("en", "ar", "th", "zh", "sr", "ms"), "studio")

    private val samples = listOf(
        "ja" to "昨日、友達と一緒に新しい映画を見に行きました。",
        "ru" to "Вчера я ходил на рынок за свежими фруктами и овощами.",
        "zh" to "今天上午，市政府召开了新闻发布会。",
        "th" to "วันนี้ฉันไปตลาดตอนเช้าเพื่อซื้อผลไม้",
        "ar" to "ذهبت اليوم إلى السوق في الصباح لشراء الفواكه.",
        "sr" to "Данас сам ујутру отишао на пијацу да купим воће.",
        "ms" to "Hari ini saya pergi ke pasar pada waktu pagi.",
    )

    @Test fun `the synthesize message carries the text unchanged as UTF-8 for live and studio languages, with the plain language code`() = runBlocking {
        FakeWorker().use { w ->
            w.audioSeconds = { it.codePointCount(0, it.length) * 0.1 } // plausible audio for any text, so the studio voice's audio check passes
            val src = w.source(object : CloudVoiceCatalog { override suspend fun voices() = listOf(live, mira) })
            for ((lang, text) in samples) {
                src.synthesize(text, TtsRequest("bella", lang))
                val raw = w.received.poll(5, java.util.concurrent.TimeUnit.SECONDS)!!
                val m = org.json.JSONObject(raw)
                assertEquals(lang, text, m.getString("text"))
                assertEquals(lang, lang, m.getString("language_code"))
                assertEquals("pcm_24000", m.getString("format"))
                // the characters are in the message itself (JSON escapes only control characters, quotes and slashes), and survive an encode/decode
                assertTrue(lang, raw.contains(text))
                assertEquals(lang, raw, String(raw.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
                assertFalse(lang, raw.contains('�') || raw.contains('?'))
                assertEquals(if (lang in setOf("ja", "ru")) "aria" else "mira", m.getString("voice"))
            }
            src.close()
        }
    }
}
