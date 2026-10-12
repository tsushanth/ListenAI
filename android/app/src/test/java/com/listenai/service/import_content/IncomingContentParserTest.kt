package com.listenai.service.import_content

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingContentParserTest {

    @Test
    fun bareUrlIsALink() {
        assertEquals(
            IncomingContent.Link("https://example.com/a?b=1"),
            IncomingContentParser.classifyText("  https://example.com/a?b=1 ")
        )
    }

    @Test
    fun browserShareWithTitleCaptionIsALink() {
        val shared = "Why the sky is blue - Science Daily\nhttps://sciencedaily.example/sky"
        assertEquals(
            IncomingContent.Link("https://sciencedaily.example/sky"),
            IncomingContentParser.classifyText(shared)
        )
    }

    @Test
    fun trailingPunctuationIsNotPartOfTheUrl() {
        assertEquals(
            IncomingContent.Link("https://example.com/x"),
            IncomingContentParser.classifyText("see https://example.com/x.")
        )
    }

    @Test
    fun longArticleThatMentionsALinkStaysText() {
        val article = "word ".repeat(100) + "https://example.com"
        assertTrue(IncomingContentParser.classifyText(article) is IncomingContent.Text)
    }

    @Test
    fun plainSelectionIsText() {
        assertEquals(IncomingContent.Text("Hello there."), IncomingContentParser.classifyText("Hello there."))
    }

    @Test
    fun blankOrNullIsIgnored() {
        assertNull(IncomingContentParser.classifyText(null))
        assertNull(IncomingContentParser.classifyText("   \n "))
    }
}
