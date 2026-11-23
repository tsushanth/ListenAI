package com.listenai.service

import com.listenai.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ServerErrorTextTest {

    @Test fun `new body keeps the English message, lower-cases the code and ignores the category in error`() {
        val e = ServerErrorText.parse(400, """{"error":"VALIDATION_ERROR","message":"This voice is already shared to the marketplace","code":"voice_already_shared"}""")
        assertEquals("voice_already_shared", e.code)
        assertEquals("This voice is already shared to the marketplace", e.message)
        assertEquals(400, e.httpStatus)
    }

    @Test fun `old body with English text in error only`() {
        val e = ServerErrorText.parse(400, """{"error":"X-Device-ID header is required"}""")
        assertNull(e.code)
        assertEquals("X-Device-ID header is required", e.message)
    }

    @Test fun `a category in error is never shown as the message`() {
        val e = ServerErrorText.parse(400, """{"error":"VALIDATION_ERROR"}""")
        assertNull(e.message)
    }

    @Test fun `details are exposed`() {
        val e = ServerErrorText.parse(402, """{"error":"QUOTA_EXCEEDED","message":"x","code":"quota_daily_exceeded","details":{"daily_limit":5,"daily_used":5}}""")
        assertEquals(5, e.details!!.getInt("daily_limit"))
    }

    @Test fun `junk and empty bodies do not throw`() {
        assertNull(ServerErrorText.parse(400, "<html>nope</html>").message)
        assertNull(ServerErrorText.parse(400, null).message)
        assertNull(ServerErrorText.parse(400, "").code)
    }

    @Test fun `an old server without a code still gets a translated code for transport-level statuses`() {
        assertEquals("service_unavailable", ServerErrorText.parse(503, "Service Unavailable").code)
        assertEquals("service_unavailable", ServerErrorText.parse(500, null).code)
        assertEquals("rate_limited", ServerErrorText.parse(429, """{"error":"RATE_LIMITED","message":"Too many requests"}""").code)
        assertEquals("timeout", ServerErrorText.parse(504, "").code)
        assertEquals("unauthenticated", ServerErrorText.parse(401, "").code)
        assertNull(ServerErrorText.parse(400, "{}").code)
    }

    @Test fun `known codes map to resources, unknown ones to null so the server text is the fallback`() {
        assertEquals(R.string.marketplace_err_already_shared, ServerErrorText.resFor("voice_already_shared"))
        assertEquals(R.string.srv_err_quota_daily, ServerErrorText.resFor("QUOTA_DAILY_EXCEEDED"))
        assertEquals(R.string.srv_err_synthesis_failed, ServerErrorText.resFor("SYNTHESIS_FAILED")) // job records send upper case
        assertNull(ServerErrorText.resFor("some_code_from_the_future"))
        assertNull(ServerErrorText.resFor(null))
    }

    /** The backend's code list is the contract: every code it can send must be translated here, or listed as fallback-only. */
    @Test fun `every code the backend can send is translated by the app`() {
        val file = listOf(File("../../backend/src/lib/errorCodes.ts"), File("../backend/src/lib/errorCodes.ts"))
            .firstOrNull { it.isFile } ?: return // module checked out on its own: nothing to compare
        val text = file.readText()
        val list = text.substringAfter("export const ERROR_CODES = [").substringBefore("] as const")
        val codes = Regex("'([a-z_]+)'").findAll(list).map { it.groupValues[1] }.toList()
        assertTrue("found ${codes.size} backend codes", codes.size > 20)
        val fallbackOnly = setOf("unknown_error") // shown with the server's own text on purpose
        val missing = codes.filter { it !in fallbackOnly && ServerErrorText.resFor(it) == null }
        assertEquals("backend codes the app does not translate", emptyList<String>(), missing)
    }
}
