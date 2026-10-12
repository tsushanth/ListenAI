package com.listenai.systemtts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LanguageCodesTest {
    @Test fun commonLanguagesMap() {
        assertEquals("en", LanguageCodes.toIso2("eng"))
        assertEquals("es", LanguageCodes.toIso2("spa"))
        assertEquals("fr", LanguageCodes.toIso2("fra"))
        assertEquals("de", LanguageCodes.toIso2("deu"))
        assertEquals("zh", LanguageCodes.toIso2("zho"))
    }

    @Test fun languagesTheOldTableMissedNowMap() {
        for ((iso3, iso2) in listOf("nld" to "nl", "pol" to "pl", "tur" to "tr", "swe" to "sv", "tam" to "ta",
            "vie" to "vi", "tha" to "th", "heb" to "he", "ind" to "id", "swa" to "sw", "ell" to "el", "ukr" to "uk")) {
            assertEquals(iso2, LanguageCodes.toIso2(iso3))
        }
    }

    @Test fun bibliographicAliasesMap() {
        assertEquals("de", LanguageCodes.toIso2("ger"))
        assertEquals("fr", LanguageCodes.toIso2("fre"))
        assertEquals("zh", LanguageCodes.toIso2("chi"))
        assertEquals("nl", LanguageCodes.toIso2("dut"))
    }

    @Test fun caseAndWhitespaceAreIgnoredAndTwoLetterCodesPassThrough() {
        assertEquals("en", LanguageCodes.toIso2(" ENG "))
        assertEquals("pl", LanguageCodes.toIso2("pl"))
    }

    @Test fun unknownOrEmptyLanguageIsNull() {
        assertNull(LanguageCodes.toIso2("zzz"))
        assertNull(LanguageCodes.toIso2(""))
        assertNull(LanguageCodes.toIso2(null))
    }

    @Test fun countriesMapIncludingTheOnesTheOldTableGotWrong() {
        assertEquals("US", LanguageCodes.countryToIso2("USA"))
        assertEquals("GB", LanguageCodes.countryToIso2("GBR"))
        assertEquals("SA", LanguageCodes.countryToIso2("SAU"))   // was wrongly "AE"
        assertEquals("AE", LanguageCodes.countryToIso2("ARE"))
        assertEquals("CA", LanguageCodes.countryToIso2("CAN"))
        assertEquals("NL", LanguageCodes.countryToIso2("NLD"))
    }

    @Test fun unknownOrEmptyCountryIsNull() {
        assertNull(LanguageCodes.countryToIso2("XXX"))
        assertNull(LanguageCodes.countryToIso2(""))
        assertNull(LanguageCodes.countryToIso2(null))
    }
}
