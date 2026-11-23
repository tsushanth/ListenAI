package com.listenai.ui.marketplace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class MarketplaceTagsTest {
    @Test fun `every tag a user can pick or filter by has a translated label`() {
        val missing = (MarketplaceTags.SHARE_TAGS + MarketplaceTags.FILTER_TAGS).distinct().filter { MarketplaceTags.labelRes(it) == null }
        assertEquals(emptyList<String>(), missing)
    }

    @Test fun `a custom tag has no label and is shown as written`() {
        assertNull(MarketplaceTags.labelRes("my-own-tag"))
        assertNotNull(MarketplaceTags.labelRes("CALM"))
    }
}
