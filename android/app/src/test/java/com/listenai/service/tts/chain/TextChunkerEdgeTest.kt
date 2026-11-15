package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TextChunkerEdgeTest {

    private fun assertWhole(text: String, chunks: List<String>) {
        assertEquals(text.replace(" ", ""), chunks.joinToString("").replace(" ", ""))
        for (c in chunks) {
            assertTrue("never starts inside a pair: ${c.take(3)}", !Character.isLowSurrogate(c.first()))
            assertTrue("never ends inside a pair", !Character.isHighSurrogate(c.last()))
            assertTrue("never starts with a joiner or mark", Character.getType(c.first()) != Character.NON_SPACING_MARK.toInt() && c.first() != '‍' && c.first() !in '︀'..'️')
            assertTrue("never ends with a joiner", c.last() != '‍')
        }
    }

    @Test fun `a hard cut never splits a surrogate pair`() {
        // 'a' then supplementary-plane CJK with no spaces, so the only way to cut is a hard cut
        for (offset in 0..3) {
            val text = "a".repeat(offset) + "𣀀".repeat(120)
            val chunks = TextChunker.split(text, 90, 60)
            assertTrue(chunks.size > 1)
            assertTrue(chunks.all { it.length <= 91 })
            assertWhole(text, chunks)
        }
    }

    @Test fun `a hard cut never splits a base letter from its combining mark`() {
        for (offset in 0..2) {
            val text = "x".repeat(offset) + "é".repeat(150)
            val chunks = TextChunker.split(text, 90, 60)
            assertWhole(text, chunks)
        }
    }

    @Test fun `a hard cut never splits an emoji joined sequence or a skin tone`() {
        val family = "👨‍👩‍👧"
        val wave = "👋🏽"
        for (unit in listOf(family, wave, "❤️")) {
            val text = unit.repeat(60)
            val chunks = TextChunker.split(text, 40, 25)
            assertTrue(chunks.size > 1)
            assertWhole(text, chunks)
            // every chunk is a whole number of units
            assertTrue(chunks.all { it.replace(" ", "").length % unit.length == 0 })
        }
    }

    @Test fun `Devanagari vowel signs stay with their consonant at a hard cut`() {
        val text = "कि".repeat(120) // consonant + vowel sign, no spaces
        val chunks = TextChunker.split(text, 50, 30)
        assertTrue(chunks.all { !it.startsWith("ि") && !it.startsWith("ि") })
        assertWhole(text, chunks)
    }

    @Test fun `no chunk is only punctuation`() {
        val text = "Wait. ... Then we go. — Yes. !! Done."
        val chunks = TextChunker.split(text, 20, 10)
        assertTrue(chunks.all { c -> c.any { it.isLetterOrDigit() } })
        assertTrue(chunks.joinToString(" ").contains("..."))
    }

    @Test fun `text that starts with punctuation keeps it with the next sentence`() {
        val chunks = TextChunker.split("... Hello there. Again.", 200, 100)
        assertEquals(1, chunks.size)
        assertTrue(chunks[0].startsWith("..."))
    }

    @Test fun `a closing quote that a sentence split left at the start of the next sentence goes back`() {
        val s = TextChunker.glueStrays(listOf("« Va.", "» Il partit.", "“Go.”", "she said."))
        assertEquals(listOf("« Va.»", "Il partit.", "“Go.”", "she said."), s)
        val chunks = TextChunker.split("« Va. » Il partit. Elle resta.", 24, 12)
        assertTrue(chunks.none { it.startsWith("»") })
        assertFalse(chunks.joinToString(" ").contains(" »"))
    }

    @Test fun `an opening straight quote is not mistaken for a closing one`() {
        val s = TextChunker.glueStrays(listOf("He said \"Go.\" and left.", "\"Now,\" she said."))
        assertEquals(listOf("He said \"Go.\" and left.", "\"Now,\" she said."), s)
        // an unmatched quote before it makes the next sentence's first quote a closing one
        val t = TextChunker.glueStrays(listOf("He said \"Wait.", "\" Then he went."))
        assertEquals(listOf("He said \"Wait.\"", "Then he went."), t)
    }

    @Test fun `plain text is split as before`() {
        val text = (1..14).joinToString(" ") { "This is sentence number $it of the test paragraph." }
        val chunks = TextChunker.split(text, 280, 140)
        assertEquals(text.split(" "), chunks.joinToString(" ").split(" "))
        assertTrue(chunks.all { it.length <= 280 })
    }
}
