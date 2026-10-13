package com.listenai.systemtts

import com.listenai.systemtts.TextNormalizer.Kind
import com.listenai.systemtts.TextNormalizer.SpanInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TextNormalizerTest {

    @Test fun aLoneLetterIsReadByItsName() {
        assertEquals("ay", TextNormalizer.normalize("a", english = true))
        assertEquals("ay", TextNormalizer.normalize("A", english = true))
        assertEquals("double you", TextNormalizer.normalize("w", english = true))
        assertEquals("eye", TextNormalizer.normalize(" i ", english = true))
    }

    @Test fun aLoneSymbolOrDigitIsReadByItsName() {
        assertEquals("dot", TextNormalizer.normalize(".", english = true))
        assertEquals("comma", TextNormalizer.normalize(",", english = true))
        assertEquals("at", TextNormalizer.normalize("@", english = true))
        assertEquals("hash", TextNormalizer.normalize("#", english = true))
        assertEquals("five", TextNormalizer.normalize("5", english = true))
    }

    @Test fun nonEnglishVoicesLeaveSingleCharactersToTheirOwnEngine() {
        assertEquals("a", TextNormalizer.normalize("a", english = false))
        assertEquals(".", TextNormalizer.normalize(".", english = false))
    }

    @Test fun ordinaryTextIsUnchanged() {
        assertEquals("Hello world", TextNormalizer.normalize("Hello world", english = true))
        assertEquals("a b", TextNormalizer.normalize("a b", english = true))
        assertEquals("It is 5.", TextNormalizer.normalize("It is 5.", english = true))
    }

    @Test fun emptyAndNullGiveEmpty() {
        assertEquals("", TextNormalizer.normalize(null, english = true))
        assertEquals("", TextNormalizer.normalize("", english = true))
    }

    @Test fun verbatimSpansAreSpelledOut() {
        val out = TextNormalizer.applySpans("code ab1 end", listOf(SpanInfo(5, 8, Kind.VERBATIM)), english = true)
        assertEquals("code ay bee one end", out)
    }

    @Test fun digitSpansAreReadDigitByDigit() {
        val out = TextNormalizer.applySpans("PIN 4821 ok", listOf(SpanInfo(4, 8, Kind.DIGITS)), english = true)
        assertEquals("PIN 4 8 2 1 ok", out)
    }

    @Test fun telephoneSpansPauseAtSeparators() {
        val out = TextNormalizer.applySpans("call 555-123-4567 now", listOf(SpanInfo(5, 17, Kind.TELEPHONE)), english = true)
        assertEquals("call 5 5 5, 1 2 3, 4 5 6 7 now", out)
    }

    @Test fun electronicSpansSpeakTheSeparators() {
        val out = TextNormalizer.applySpans("mail me@site.com please", listOf(SpanInfo(5, 16, Kind.ELECTRONIC)), english = true)
        assertEquals("mail me at site dot com please", out)
    }

    @Test fun overlappingOrOutOfRangeSpansDoNotCrash() {
        val out = TextNormalizer.applySpans("short", listOf(SpanInfo(3, 99, Kind.DIGITS), SpanInfo(-2, 1, Kind.VERBATIM)), english = true)
        assertEquals(true, out.isNotEmpty())
    }

    @Test fun ssmlTagsAreNotReadAloud() {
        assertEquals("Hello, world", TextNormalizer.stripSsml("<speak>Hello<break time=\"500ms\"/> world</speak>").replace(" ,", ","))
        assertEquals("Fish & chips", TextNormalizer.stripSsml("<speak>Fish &amp; chips</speak>"))
    }

    @Test fun normalizeStripsSsmlEnvelope() {
        assertEquals("Hello there", TextNormalizer.normalize("<speak>Hello <emphasis>there</emphasis></speak>", english = true))
    }

    @Test fun singleCharacterLookupRejectsLongerText() {
        assertNull(TextNormalizer.speakSingleCharacter("ab"))
        assertNull(TextNormalizer.speakSingleCharacter(""))
    }
}
