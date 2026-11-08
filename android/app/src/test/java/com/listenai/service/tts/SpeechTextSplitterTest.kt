package com.listenai.service.tts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Text that is cut into pieces for synthesis must never be cut inside a word: each piece is voiced
 * separately, so a cut inside "reply" is heard as "r ... eply" (ReadAloud system engine, 2026-11-07).
 */
class SpeechTextSplitterTest {

    private fun words(s: String) = s.replace(",", " ").split(Regex("\\s+")).filter { it.isNotEmpty() }

    @Test
    fun `streaming chunks never cut a long comma-free sentence inside a word`() {
        // 75 chars, no comma: the old hard cut at 60 landed inside "reply" ("...need a r" + "eply").
        val text = "You have twelve unread emails from this morning and two of them need a reply"
        val chunks = SpeechTextSplitter.chunkForModel(text, charCap = 60)
        assertTrue("expected several chunks, got $chunks", chunks.size > 1)
        assertEquals(words(text), chunks.flatMap { words(it) })
        assertTrue(chunks.all { it.length <= 60 })
    }

    @Test
    fun `comma sentence from the bug report splits at the comma, not in a word`() {
        val text = "You have two emails that need a reply, one looks time-sensitive."
        val chunks = SpeechTextSplitter.chunkForModel(text, charCap = 60)
        assertEquals(listOf("You have two emails that need a reply", "one looks time-sensitive."), chunks)
    }

    @Test
    fun `short text stays one chunk`() {
        assertEquals(listOf("Hello there."), SpeechTextSplitter.chunkForModel("  Hello there.  ", charCap = 60))
        assertTrue(SpeechTextSplitter.chunkForModel("   ", charCap = 60).isEmpty())
    }

    @Test
    fun `sentences are packed up to the cap and split on sentence ends`() {
        val chunks = SpeechTextSplitter.chunkForModel("One two. Three four. Five six seven eight nine ten eleven twelve.", charCap = 30)
        assertEquals(listOf("One two. Three four.", "Five six seven eight nine ten", "eleven twelve."), chunks)
    }

    @Test
    fun `a clause with commas whose parts are each over the cap is split at spaces`() {
        val part = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo"
        val text = "$part, $part"
        val chunks = SpeechTextSplitter.chunkForModel(text, charCap = 40)
        assertEquals(words(text), chunks.flatMap { words(it) })
        assertTrue(chunks.all { it.length <= 40 })
    }

    @Test
    fun `a single word longer than the cap is the only thing that may be cut`() {
        val word = "a".repeat(130)
        val chunks = SpeechTextSplitter.chunkForModel(word, charCap = 60)
        assertEquals(word, chunks.joinToString(""))
        assertTrue(chunks.all { it.length <= 60 })
    }

    @Test
    fun `overlong word is not cut between the halves of a surrogate pair`() {
        val text = "a" + "😀".repeat(100) // odd offsets put the cap inside a pair
        for (chunk in SpeechTextSplitter.chunkForModel(text, charCap = 60)) {
            assertFalse("chunk ends with a lone high surrogate", Character.isHighSurrogate(chunk.last()))
            assertFalse("chunk starts with a lone low surrogate", Character.isLowSurrogate(chunk.first()))
        }
    }

    @Test
    fun `espeak pieces break at spaces and keep every word whole`() {
        val text = (1..200).joinToString(" ") { "word$it" } // one 1.4k char sentence with no punctuation
        val pieces = SpeechTextSplitter.splitForEspeak(text, maxPiece = 300)
        assertTrue(pieces.size > 1)
        assertTrue(pieces.all { it.length <= 300 })
        assertEquals(words(text), pieces.flatMap { words(it) })
    }

    @Test
    fun `espeak splits on sentence ends but not inside decimals`() {
        assertEquals(
            listOf("It costs 3.14 dollars.", "Really?", "Yes!"),
            SpeechTextSplitter.splitForEspeak("It costs 3.14 dollars. Really? Yes!", maxPiece = 300),
        )
        assertEquals(listOf("one", "two"), SpeechTextSplitter.splitForEspeak("one\n\ntwo", maxPiece = 300))
        assertEquals(listOf("你好。", "再见。"), SpeechTextSplitter.splitForEspeak("你好。再见。", maxPiece = 300))
    }

    @Test
    fun `espeak overlong unbroken run is cut without splitting a surrogate pair`() {
        val text = "a" + "😀".repeat(400)
        val pieces = SpeechTextSplitter.splitForEspeak(text, maxPiece = 300)
        assertTrue(pieces.size > 1)
        assertEquals(text, pieces.joinToString(""))
        for (p in pieces) assertFalse(Character.isHighSurrogate(p.last()))
    }
}
