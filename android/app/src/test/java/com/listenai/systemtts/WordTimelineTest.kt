package com.listenai.systemtts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WordTimelineTest {

    @Test fun everyWordGetsARangeInOrder() {
        val text = "The quick brown fox"
        val words = WordTimeline.compute(text, totalFrames = 44_100)
        assertEquals(4, words.size)
        assertEquals("The", text.substring(words[0].startChar, words[0].endChar))
        assertEquals("fox", text.substring(words[3].startChar, words[3].endChar))
        assertEquals(0, words[0].startFrame)
        assertTrue(words.zipWithNext().all { (a, b) -> a.startFrame < b.startFrame })
        assertTrue(words.last().startFrame < 44_100)
    }

    @Test fun longerWordsGetMoreTime() {
        val words = WordTimeline.compute("a extraordinarily b", totalFrames = 30_000)
        val firstSpan = words[1].startFrame - words[0].startFrame
        val secondSpan = words[2].startFrame - words[1].startFrame
        assertTrue(secondSpan > firstSpan)
    }

    @Test fun sentenceEndsGetALongerPause() {
        val words = WordTimeline.compute("Stop. Go on", totalFrames = 20_000)
        val afterStop = words[1].startFrame - words[0].startFrame
        val plain = WordTimeline.compute("Stop Go on", totalFrames = 20_000)
        assertTrue(afterStop > plain[1].startFrame - plain[0].startFrame)
    }

    @Test fun textOffsetShiftsCharacterPositions() {
        val words = WordTimeline.compute("hello there", totalFrames = 1000, textOffset = 50)
        assertEquals(50, words[0].startChar)
        assertEquals(55, words[0].endChar)
        assertEquals(56, words[1].startChar)
    }

    @Test fun blankTextOrNoAudioGivesNothing() {
        assertTrue(WordTimeline.compute("   ", 100).isEmpty())
        assertTrue(WordTimeline.compute("hello", 0).isEmpty())
    }

    @Test fun extraWhitespaceDoesNotCreateEmptyWords() {
        val words = WordTimeline.compute("  one   two  ", 1000)
        assertEquals(2, words.size)
    }

    @Test fun chunkWordsAreLocatedInTheOriginalText() {
        val original = "First sentence. Second one, with commas. Third."
        val (first, cursor) = WordTimeline.locate(original, "First sentence.", 10_000, 0)
        assertEquals(2, first.size)
        assertEquals("sentence.", original.substring(first[1].startChar, first[1].endChar))
        val (second, _) = WordTimeline.locate(original, "Second one with commas.", 10_000, cursor)
        // "with" and "commas." are found after the cursor even though the chunk dropped the comma
        assertEquals("Second", original.substring(second[0].startChar, second[0].endChar))
        assertEquals("with", original.substring(second[2].startChar, second[2].endChar))
    }

    @Test fun wordsMissingFromTheOriginalAreSkipped() {
        val (words, _) = WordTimeline.locate("hello world", "hello zzz world", 1000, 0)
        assertEquals(2, words.size)
    }
}
