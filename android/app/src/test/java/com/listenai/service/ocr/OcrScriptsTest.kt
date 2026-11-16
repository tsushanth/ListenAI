package com.listenai.service.ocr

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class OcrScriptsTest {

    private val chinese = "出口请勿吸烟前方施工请绕行谢谢您的配合"
    private val japanese = "駅の改札口を出て右に曲がるとすぐ見えます"
    private val korean = "출구 앞 공사 중입니다 우회해 주세요"
    private val hindi = "कृपया कतार में प्रतीक्षा करें धन्यवाद"
    private val english = "Please keep to the right and wait for the next available agent"

    private fun run(ui: String?, answers: Map<OcrScript, Result<String>>): Pair<String, List<OcrScript>> {
        val asked = ArrayList<OcrScript>()
        val text = runBlocking { OcrScripts.recognize(ui) { s -> asked += s; answers[s] ?: Result.success("") } }
        return text to asked
    }

    @Test fun `a phone set to a CJK language or Hindi tries its own script first, then Latin`() {
        assertEquals(listOf(OcrScript.KOREAN, OcrScript.LATIN), OcrScripts.order("ko").take(2))
        assertEquals(listOf(OcrScript.JAPANESE, OcrScript.LATIN), OcrScripts.order("ja").take(2))
        assertEquals(listOf(OcrScript.CHINESE, OcrScript.LATIN), OcrScripts.order("zh-CN").take(2))
        assertEquals(listOf(OcrScript.DEVANAGARI, OcrScript.LATIN), OcrScripts.order("hi").take(2))
        assertEquals(OcrScript.LATIN, OcrScripts.order("de").first())
        assertEquals(OcrScript.LATIN, OcrScripts.order(null).first())
        assertEquals(5, OcrScripts.order("ko").toSet().size)
    }

    @Test fun `English text stops at the Latin model`() {
        val (text, asked) = run("en", mapOf(OcrScript.LATIN to Result.success(english)))
        assertEquals(english, text)
        assertEquals(listOf(OcrScript.LATIN), asked)
    }

    @Test fun `Japanese text read as junk by Latin is taken from the Japanese model`() {
        val (text, asked) = run("en", mapOf(
            OcrScript.LATIN to Result.success("I l 1"),
            OcrScript.CHINESE to Result.success("駅の改札口を出て右に曲"),
            OcrScript.JAPANESE to Result.success(japanese),
        ))
        assertEquals(japanese, text) // the Chinese model's 7 kanji do not reach the threshold; the Japanese model's 20 characters do
        assertTrue(OcrScript.JAPANESE in asked)
    }

    @Test fun `Korean and Hindi photos are found by their models`() {
        assertEquals(korean, run("en", mapOf(OcrScript.KOREAN to Result.success(korean))).first)
        assertEquals(hindi, run("en", mapOf(OcrScript.DEVANAGARI to Result.success(hindi))).first)
    }

    @Test fun `a Korean phone reading English text asks Korean then Latin and keeps the English`() {
        val (text, asked) = run("ko", mapOf(OcrScript.KOREAN to Result.success(english), OcrScript.LATIN to Result.success(english)))
        assertEquals(english, text)
        assertEquals(listOf(OcrScript.KOREAN, OcrScript.LATIN), asked)
    }

    @Test fun `a script whose model is not downloaded yet is skipped`() {
        val (text, _) = run("en", mapOf(
            OcrScript.LATIN to Result.success(""),
            OcrScript.CHINESE to Result.failure(IllegalStateException("model is being downloaded")),
            OcrScript.JAPANESE to Result.success(japanese),
        ))
        assertEquals(japanese, text)
    }

    @Test fun `when every model fails the first error is thrown`() {
        try {
            runBlocking { OcrScripts.recognize("en") { s -> Result.failure(IllegalStateException("fail ${s.name}")) } }
            fail("expected an exception")
        } catch (e: IllegalStateException) {
            assertEquals("fail LATIN", e.message)
        }
    }

    @Test fun `no text anywhere gives an empty result, not an error`() {
        assertEquals("", run("en", emptyMap()).first)
    }

    @Test fun `short text of a non-Latin script wins over Latin junk`() {
        val (text, _) = run("en", mapOf(OcrScript.LATIN to Result.success("1l"), OcrScript.CHINESE to Result.success("出口")))
        assertEquals("出口", text)
    }

    @Test fun `script counts`() {
        assertEquals(chinese.length, OcrScripts.count(OcrScript.CHINESE, chinese))
        assertEquals(0, OcrScripts.count(OcrScript.CHINESE, english))
        assertTrue(OcrScripts.count(OcrScript.JAPANESE, japanese) > OcrScripts.count(OcrScript.CHINESE, japanese))
        assertEquals(korean.count { it in '가'..'힣' }, OcrScripts.count(OcrScript.KOREAN, korean))
        assertTrue(OcrScripts.count(OcrScript.DEVANAGARI, hindi) > 20)
    }

    @Test fun `language hint from the script for text too short to detect`() {
        assertEquals("zh", OcrScripts.languageHint("出口"))
        assertEquals("ja", OcrScripts.languageHint("出口です"))
        assertEquals("ja", OcrScripts.languageHint("カフェ"))
        assertEquals("ko", OcrScripts.languageHint("출구"))
        assertEquals("th", OcrScripts.languageHint("ทางออก"))
        assertEquals("hi", OcrScripts.languageHint("निकास"))
        assertEquals("el", OcrScripts.languageHint("Έξοδος"))
        assertEquals("ar", OcrScripts.languageHint("مخرج"))
        assertEquals("ru", OcrScripts.languageHint("Выход"))
        assertEquals("uk", OcrScripts.languageHint("Вихід їжі"))
        assertEquals(null, OcrScripts.languageHint("Exit"))
        assertEquals(null, OcrScripts.languageHint("123 !?"))
    }
}
