package com.listenai.service

import com.listenai.service.tts.PlatformLanguageSynth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

class PlatformLanguageSynthTest {
    private fun wav(rate: Int, samples: Int, channels: Int = 1, extraChunk: Boolean = false): File {
        val pcm = ByteArray(samples * 2) { 1 }
        val extra = if (extraChunk) 8 + 4 else 0
        val b = ByteBuffer.allocate(44 + extra + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()).putInt(36 + extra + pcm.size).put("WAVE".toByteArray())
        b.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(channels.toShort()).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        if (extraChunk) b.put("LIST".toByteArray()).putInt(4).putInt(0)
        b.put("data".toByteArray()).putInt(pcm.size).put(pcm)
        return File.createTempFile("tmp", ".wav").also { it.writeBytes(b.array()); it.deleteOnExit() }
    }

    @Test fun splitKeepsSentencesAndLimit() {
        val parts = PlatformLanguageSynth.splitText("Uno dos. Tres cuatro! Cinco seis?", 14)
        assertEquals(listOf("Uno dos.", "Tres cuatro!", "Cinco seis?"), parts)
        assertEquals(true, PlatformLanguageSynth.splitText("a".repeat(1000), 300).all { it.length <= 300 })
    }

    // Each piece is voiced by a separate engine call, so a cut inside a word is heard as a gap in the
    // word ("of t" + "hem"; the same defect SpeechTextSplitter fixed for the Kokoro and eSpeak paths).
    @Test fun overlongSentenceIsCutAtSpacesNotInsideAWord() {
        val text = "You have twelve unread emails from this morning and two of them need a reply"
        val parts = PlatformLanguageSynth.splitText(text, 60)
        assertTrue("expected several pieces, got $parts", parts.size > 1)
        assertTrue("a piece is over the cap: $parts", parts.all { it.length <= 60 })
        assertEquals(text.split(" "), parts.flatMap { it.split(" ") })
    }

    @Test fun concatJoinsPcm() {
        val out = File.createTempFile("out", ".wav").also { it.deleteOnExit() }
        val r = PlatformLanguageSynth.concatWavs(listOf(wav(22050, 100), wav(22050, 50, extraChunk = true)), out)
        assertEquals(22050 to 150, r)
        assertEquals(44 + 300, out.length().toInt())
    }

    @Test fun concatRejectsMixedRatesAndStereo() {
        val out = File.createTempFile("out", ".wav").also { it.deleteOnExit() }
        assertNull(PlatformLanguageSynth.concatWavs(listOf(wav(22050, 10), wav(16000, 10)), out))
        assertNull(PlatformLanguageSynth.concatWavs(listOf(wav(22050, 10, channels = 2)), out))
        assertNotNull(PlatformLanguageSynth.concatWavs(listOf(wav(16000, 10)), out))
    }
}
