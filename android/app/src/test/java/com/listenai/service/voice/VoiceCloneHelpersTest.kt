package com.listenai.service.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceCloneHelpersTest {

    @Test
    fun `mime types are normalised to ones the backend accepts`() {
        assertEquals("audio/wav", AudioClips.normalizeMime("audio/x-wav", "a.wav"))
        assertEquals("audio/mp4", AudioClips.normalizeMime("audio/mp4a-latm", "a.m4a"))
        assertEquals("audio/mp4", AudioClips.normalizeMime("audio/x-m4a", null))
        assertEquals("audio/mpeg", AudioClips.normalizeMime("audio/mpeg; charset=binary", "x"))
        assertEquals("audio/ogg", AudioClips.normalizeMime("application/ogg", null))
        assertEquals("audio/webm", AudioClips.normalizeMime(null, "clip.webm"))
        // generic types from some pickers fall back to the extension
        assertEquals("audio/flac", AudioClips.normalizeMime("application/octet-stream", "voice.FLAC"))
        assertEquals("audio/mpeg", AudioClips.normalizeMime("", "voice.mp3"))
        assertNull(AudioClips.normalizeMime("video/mp4", "movie.mkv"))
        assertNull(AudioClips.normalizeMime(null, null))
    }

    @Test
    fun `legacy notice shows once and only to users who had legacy voices`() {
        assertTrue(VoiceCloningService.shouldShowLegacyNotice("""[{"id":"x","name":"Old"}]""", alreadySeen = false))
        assertFalse("already shown", VoiceCloningService.shouldShowLegacyNotice("""[{"id":"x"}]""", alreadySeen = true))
        assertFalse("no legacy cache", VoiceCloningService.shouldShowLegacyNotice(null, false))
        assertFalse("empty legacy cache", VoiceCloningService.shouldShowLegacyNotice("[]", false))
        assertFalse(VoiceCloningService.shouldShowLegacyNotice("  ", false))
    }
}
