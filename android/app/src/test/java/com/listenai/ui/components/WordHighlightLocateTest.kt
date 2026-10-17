package com.listenai.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WordHighlightLocateTest {

    private val spoken = "Intro line. First paragraph here. Second one follows."
    private val blocks = listOf("Intro line.", "First paragraph here.", "Second one follows.")

    @Test fun `blocks are located in order in the spoken text`() {
        val spans = locateBlocksInSpokenText(blocks, spoken)
        assertEquals(listOf(0..10, 12..32, 34..52), spans)
    }

    @Test fun `no spoken text means nothing is located`() {
        assertEquals(listOf(null, null, null), locateBlocksInSpokenText(blocks, null))
        assertEquals(listOf(null, null, null), locateBlocksInSpokenText(blocks, ""))
    }

    @Test fun `a block that is not in the spoken text is skipped and does not move the cursor`() {
        val spans = locateBlocksInSpokenText(listOf("Intro line.", "**Bold** thing", "Second one follows."), spoken)
        assertEquals(0..10, spans[0]); assertNull(spans[1]); assertEquals(34..52, spans[2])
    }

    @Test fun `blank blocks are not located`() {
        assertNull(locateBlocksInSpokenText(listOf("  ", "Intro line."), spoken)[0])
    }

    @Test fun `repeated text is matched in order, not all to the first occurrence`() {
        val s = "Yes. Yes."
        assertEquals(listOf(0..3, 5..8), locateBlocksInSpokenText(listOf("Yes.", "Yes."), s))
    }

    @Test fun `blockForWord finds the block containing the word start`() {
        val spans = locateBlocksInSpokenText(blocks, spoken)
        assertEquals(0, blockForWord(spans, 0..4))
        assertEquals(1, blockForWord(spans, 12..16))
        assertEquals(2, blockForWord(spans, 41..43))
        assertNull(blockForWord(spans, 11..11))      // the separator between blocks
        assertNull(blockForWord(spans, null))
        assertNull(blockForWord(listOf(null, null), 3..5))
    }

    @Test fun `wordRangeInBlock translates to block-local offsets`() {
        val spans = locateBlocksInSpokenText(blocks, spoken)
        assertEquals(6..14, wordRangeInBlock(spans[1], 18..26))   // "paragraph" inside "First paragraph here."
        assertNull(wordRangeInBlock(spans[1], 5..8))              // word before the block
        assertNull(wordRangeInBlock(null, 1..2))
    }
}
