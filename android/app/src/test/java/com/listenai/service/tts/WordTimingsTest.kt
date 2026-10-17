package com.listenai.service.tts

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class WordTimingsTest {

    private val text = "Hello there. How are you?"

    private fun meta(t0: Double, vararg w: String) =
        JSONObject("""{"type":"chunk_meta","t0":$t0,"words":[${w.joinToString(",")}]}""")

    private fun word(cs: Int, ce: Int, s: Double?, e: Double?) =
        """{"start_char":$cs,"end_char":$ce,"start":${s ?: "null"},"end":${e ?: "null"}}"""

    private fun twoChunks(): WordTimings {
        val c = WordTimings.Collector()
        c.add(meta(0.0, word(0, 5, 0.08, 0.40), word(6, 12, 0.45, 1.00)))
        c.add(meta(1.20, word(13, 16, 0.08, 0.25), word(17, 20, 0.28, 0.40), word(21, 25, 0.42, 0.90)))
        return c.build(text)!!
    }

    @Test fun `collector makes chunk-relative times absolute using t0`() {
        val t = twoChunks()
        assertEquals(5, t.words.size)
        assertEquals(1.28, t.words[2].start, 1e-9)   // 1.20 + 0.08
        assertEquals(2.10, t.words[4].end, 1e-9)     // 1.20 + 0.90
    }

    @Test fun `indexAt returns the word being spoken, the first word before it starts, the last after the end`() {
        val t = twoChunks()
        assertEquals(0, t.indexAt(0.0))          // lead-in silence: highlight does not disappear
        assertEquals(0, t.indexAt(0.30))
        assertEquals(1, t.indexAt(0.45))
        assertEquals(1, t.indexAt(1.10))         // pause between sentences still shows the last word
        assertEquals(2, t.indexAt(1.28))
        assertEquals(4, t.indexAt(99.0))
        assertNull(WordTimings(text, emptyList()).indexAt(1.0))
    }

    @Test fun `indexAt is monotonic over time`() {
        val t = twoChunks()
        var prev = -1
        var s = 0.0
        while (s < 3.0) { val i = t.indexAt(s)!!; assertTrue(i >= prev); prev = i; s += 0.01 }
    }

    @Test fun `collector skips untimed and malformed words and chunks without t0`() {
        val c = WordTimings.Collector()
        c.add(meta(0.0, word(0, 5, null, null), word(6, 12, 0.5, 0.4), word(-1, 3, 0.1, 0.2), word(6, 6, 0.1, 0.2), word(6, 12, 0.5, 1.0)))
        c.add(JSONObject("""{"type":"chunk_meta","words":[${word(13, 16, 0.1, 0.2)}]}"""))      // no t0
        c.add(JSONObject("""{"type":"chunk_meta"}"""))                                          // no words (an old worker)
        val t = c.build(text)!!
        assertEquals(1, t.words.size)
        assertEquals(6, t.words[0].startChar)
    }

    @Test fun `build is null when nothing arrived or offsets do not fit the text`() {
        assertNull(WordTimings.Collector().build(text))
        val c = WordTimings.Collector()
        c.add(meta(0.0, word(0, 99, 0.1, 0.2)))
        assertNull(c.build(text))
    }

    @Test fun `json round trip keeps everything and rejects corrupt or wrong-version data`() {
        val t = twoChunks()
        val back = WordTimings.fromJson(t.toJson())!!
        assertEquals(t.spokenText, back.spokenText)
        assertEquals(t.words, back.words)
        assertNull(WordTimings.fromJson("not json"))
        assertNull(WordTimings.fromJson("""{"v":2,"text":"a","words":[]}"""))
        assertNull(WordTimings.fromJson("""{"v":1,"text":"a","words":[[0,5,0.0,1.0]]}"""))   // offset past the text
    }

    @Test fun `save and load use a sidecar file next to the audio and a missing file is null`() {
        val dir = File(System.getProperty("java.io.tmpdir"), "wt-" + System.nanoTime()).apply { mkdirs() }
        val audio = File(dir, "tts_x.wav").apply { writeBytes(byteArrayOf(0)) }
        assertNull(WordTimings.load(audio.path))
        WordTimings.save(audio, twoChunks())
        assertTrue(File(audio.path + ".words.json").isFile)
        assertNotNull(WordTimings.load(audio.path))
        assertEquals(5, WordTimings.load(audio.path)!!.words.size)
        File(audio.path + ".words.json").writeText("{broken")
        assertNull(WordTimings.load(audio.path))
        dir.deleteRecursively()
    }

    @Test fun `toWordTimestamps maps words to the existing result model with section indexes`() {
        val t = twoChunks()
        val ts = t.toWordTimestamps(listOf(0, 13))   // two sections starting at 0 and 13
        assertEquals("Hello", ts[0].word)
        assertEquals(0, ts[0].sectionIndex)
        assertEquals("How", ts[2].word)
        assertEquals(1, ts[2].sectionIndex)
        assertEquals(13 until 16, ts[2].characterRange)
        assertFalse(ts.any { it.endTime < it.startTime })
    }
}
