package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NumberNormalizationTest {
    @Test fun `policy table`() {
        for (l in listOf("de", "fr", "it", "es")) assertEquals(l, NumberPolicy.ALWAYS, NumberNormalization.policyFor(l))
        assertEquals(NumberPolicy.DEVANAGARI_DIGITS, NumberNormalization.policyFor("hi"))
        for (l in listOf("en", "pt", "ja", "ru", "cs", "tr", "pl", "xx", "und", "", null)) assertEquals(l, NumberPolicy.NONE, NumberNormalization.policyFor(l))
    }

    @Test fun `device forms of a code use the language's policy`() {
        assertTrue(NumberNormalization.send("es_MX", "1"))
        assertTrue(NumberNormalization.send("de-AT", "1"))
        assertFalse(NumberNormalization.send("pt-BR", "1"))
    }

    @Test fun `Devanagari digit range`() {
        assertTrue(NumberNormalization.send("hi", "०"))
        assertTrue(NumberNormalization.send("hi", "x ९"))
        assertFalse(NumberNormalization.send("hi", "॥"))
        assertFalse(NumberNormalization.send("hi", "॰"))
        assertFalse(NumberNormalization.send("hi", "123"))
    }
}
