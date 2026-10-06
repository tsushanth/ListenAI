package com.listenai.service.voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every error code in docs/VOICE_CLONING_CONSENT.md maps to clear text and a recovery action. */
class VoiceCloneErrorsTest {

    private fun ex(status: Int, code: String, details: String? = null) =
        VoiceCloneException(status, code, "server text", details?.let { JSONObject(it) })

    private fun map(status: Int, code: String, details: String? = null) = VoiceCloneErrors.map(ex(status, code, details))

    @Test
    fun `unauthenticated asks to sign in`() {
        val f = map(401, "unauthenticated")
        assertEquals(Recovery.SIGN_IN, f.recovery)
        assertTrue(f.message.contains("Sign in"))
    }

    @Test
    fun `email_unverified and payment_required stop with specific text`() {
        val e = map(403, "email_unverified")
        assertEquals(Recovery.STOP, e.recovery)
        assertTrue(e.message.contains("Verify your email"))
        val p = map(402, "payment_required")
        assertEquals(Recovery.STOP, p.recovery)
        assertTrue(p.message.contains("paid plan"))
    }

    @Test
    fun `503 unavailable says not available yet`() {
        val f = map(503, "unavailable")
        assertEquals("Voice cloning is not available yet.", f.message)
        assertEquals(Recovery.STOP, f.recovery)
        // synthesis routes report the same condition with the global handler code
        assertEquals("Voice cloning is not available yet.", map(503, "CLONING_UNAVAILABLE").message)
    }

    @Test
    fun `service_unavailable and asr_unavailable are retryable`() {
        assertEquals(Recovery.RETRY, map(503, "service_unavailable").recovery)
        assertEquals(Recovery.RETRY, map(503, "asr_unavailable", """{"attemptsLeft":2}""").recovery)
    }

    @Test
    fun `reference_rejected lists every documented failure in plain language`() {
        val codes = listOf("too_short", "too_long", "not_enough_speech", "too_noisy", "clipped", "multiple_speakers", "music_detected")
        val details = """{"failures":[${codes.joinToString(",") { """{"code":"$it","message":"server wording for $it"}""" }}]}"""
        val f = map(422, "reference_rejected", details)
        assertEquals(Recovery.FIX_REFERENCE, f.recovery)
        assertEquals(codes.size, f.problems.size)
        // Client wording is used (not the server's), one distinct line per code.
        assertEquals(codes.size, f.problems.toSet().size)
        assertTrue(f.problems.none { it.startsWith("server wording") })
        codes.forEach { c -> assertTrue("$c must be in the table", VoiceCloneErrors.REFERENCE_MESSAGES.containsKey(c)) }
        assertTrue(f.message.contains(f.problems.first()))
        assertTrue(f.problems[0].contains("8 seconds"))
        assertTrue(f.problems[3].contains("quiet room"))
    }

    @Test
    fun `reference_rejected falls back to server text for unknown failure codes and plain strings`() {
        val f = map(422, "reference_rejected", """{"failures":[{"code":"new_gate","message":"Something new"},"too_short"]}""")
        assertEquals(listOf("Something new", VoiceCloneErrors.REFERENCE_MESSAGES.getValue("too_short")), f.problems)
        val none = map(422, "reference_rejected")
        assertTrue(none.problems.isEmpty())
        assertTrue(none.message.contains("different recording"))
    }

    @Test
    fun `consent_clip_rejected means re-record the phrase`() {
        val f = map(422, "consent_clip_rejected", """{"failures":[{"code":"too_short","message":"x"}]}""")
        assertEquals(Recovery.RERECORD_CONSENT, f.recovery)
        assertTrue(f.problems.single().contains("whole phrase"))
    }

    @Test
    fun `phrase_mismatch retries with attempts left and then requires a new challenge`() {
        val retry = map(422, "phrase_mismatch", """{"attemptsLeft":2}""")
        assertEquals(Recovery.RERECORD_CONSENT, retry.recovery)
        assertEquals(2, retry.attemptsLeft)
        assertTrue(retry.message.contains("2 attempts left"))
        assertTrue(retry.message.contains("exactly"))

        val last = map(422, "phrase_mismatch", """{"attemptsLeft":1}""")
        assertTrue(last.message.contains("1 attempt left"))

        val out = map(422, "phrase_mismatch", """{"attemptsLeft":0}""")
        assertEquals(Recovery.NEW_CHALLENGE, out.recovery)
        assertEquals(0, out.attemptsLeft)
    }

    @Test
    fun `speaker_mismatch shows attemptsLeft and retries until exhausted`() {
        val retry = map(422, "speaker_mismatch", """{"attemptsLeft":2}""")
        assertEquals(Recovery.RERECORD_CONSENT, retry.recovery)
        assertEquals(2, retry.attemptsLeft)
        assertTrue(retry.message.contains("only clone your own voice"))
        assertTrue(retry.message.contains("2 attempts left"))

        val out = map(422, "speaker_mismatch", """{"attemptsLeft":0}""")
        assertEquals(Recovery.NEW_CHALLENGE, out.recovery)
        assertTrue(out.message.contains("out of attempts"))

        // Missing details must not crash and must still allow a retry.
        val bare = map(422, "speaker_mismatch")
        assertNull(bare.attemptsLeft)
        assertEquals(Recovery.RERECORD_CONSENT, bare.recovery)
    }

    @Test
    fun `daily_limit mentions the limit`() {
        val f = map(429, "daily_limit", """{"limit":3,"used":3}""")
        assertEquals(Recovery.STOP, f.recovery)
        assertTrue(f.message.contains("3 cloned voices per 24 hours"))
        assertTrue(map(429, "daily_limit").message.contains("today"))
    }

    @Test
    fun `challenge problems all lead to a new phrase`() {
        listOf("challenge_expired" to 410, "challenge_used" to 409, "challenge_not_found" to 404, "challenge_attempts_exhausted" to 429).forEach { (code, status) ->
            assertEquals(code, Recovery.NEW_CHALLENGE, map(status, code).recovery)
        }
        assertTrue(map(410, "challenge_expired").message.contains("expired"))
    }

    @Test
    fun `creation_in_progress and rate limits stop`() {
        assertEquals(Recovery.STOP, map(429, "creation_in_progress").recovery)
        assertEquals(Recovery.STOP, map(429, "rate_limited").recovery)
        assertEquals(Recovery.STOP, map(429, "something_else").recovery)
    }

    @Test
    fun `upload problems`() {
        assertEquals(Recovery.FIX_REFERENCE, map(400, "audio_required").recovery)
        val big = map(413, "upload_error")
        assertTrue(big.message.contains("25 MB"))
        assertEquals(Recovery.FIX_REFERENCE, big.recovery)
        assertEquals(Recovery.RETRY, map(400, "upload_error").recovery)
    }

    @Test
    fun `voice level errors from delete and synthesis`() {
        assertEquals(Recovery.RETRY, map(502, "deletion_pending").recovery)
        assertTrue(map(502, "deletion_pending").message.contains("retry", ignoreCase = true))
        assertTrue(map(404, "voice_not_found").message.contains("no longer exists"))
        assertTrue(map(403, "voice_disabled").message.contains("disabled"))
        assertTrue(map(409, "voice_unavailable").message.contains("being deleted"))
    }

    @Test
    fun `network and unknown errors`() {
        assertEquals(Recovery.RETRY, VoiceCloneErrors.map(VoiceCloneException.network(RuntimeException("boom"))).recovery)
        assertEquals(Recovery.RETRY, map(500, "internal").recovery)
        assertEquals(Recovery.SIGN_IN, map(401, "token_expired").recovery)
        val unknown = map(418, "teapot")
        assertNotNull(unknown.message)
        assertTrue(unknown.message.contains("teapot"))
    }

    @Test
    fun `no reference or consent failure text asks for a file upload as the only fix for consent`() {
        // consent must be live: the consent table never suggests uploading
        VoiceCloneErrors.CONSENT_CLIP_MESSAGES.values.forEach { assertTrue(!it.contains("upload", ignoreCase = true)) }
    }
}
