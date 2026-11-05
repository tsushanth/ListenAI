package com.listenai.service.tts.chain

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class TextChunkerTest {
    @Test fun `short text is one chunk`() {
        assertEquals(listOf("Hello there."), TextChunker.split("Hello there.", 280, 140))
    }

    @Test fun `chunks respect the limit and lose no words`() {
        val text = (1..60).joinToString(" ") { "Sentence number $it is here." }
        val parts = TextChunker.split(text, 280, 140)
        assertTrue(parts.size > 3)
        assertTrue(parts.all { it.length <= 280 })
        assertTrue("first chunk is short", parts.first().length <= 140)
        assertEquals(text.split(" ").size, parts.joinToString(" ").split(" ").size)
    }

    @Test fun `a very long sentence is cut at clauses then spaces`() {
        val s = (1..80).joinToString(", ") { "clause $it of a run-on" } + "."
        val parts = TextChunker.split(s, 200, 100)
        assertTrue(parts.all { it.length <= 200 })
        assertEquals(s.replace(",", "").split(" ").filter { it.isNotEmpty() }.size,
            parts.joinToString(" ").replace(",", "").split(" ").filter { it.isNotEmpty() }.size)
    }

    @Test fun `text with no spaces is hard cut`() {
        val parts = TextChunker.split("x".repeat(1000), 300, 150)
        assertTrue(parts.all { it.length <= 300 })
        assertEquals(1000, parts.sumOf { it.length })
    }

    @Test fun `blank and newline-only input gives nothing, newlines split sentences`() {
        assertTrue(TextChunker.split(" \n\n ", 280, 140).isEmpty())
        assertEquals(listOf("Title Para one text"), TextChunker.split("Title\nPara one text", 280, 280))
    }
}

class DiskChunkCacheTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun chunk(n: Int, rate: Int = 24_000) = PcmChunk(ByteArray(n) { (it % 120).toByte() }, rate)

    @Test fun `round trip keeps pcm and rate`() {
        val c = DiskChunkCache(tmp.newFolder(), 1_000_000)
        val k = ChunkCache.key("bella", 1.0f, "Hello")
        assertNull(c.get(k))
        c.put(k, chunk(1000, 22_050))
        val got = c.get(k)!!
        assertEquals(22_050, got.sampleRate)
        assertArrayEquals(chunk(1000).pcm, got.pcm)
    }

    @Test fun `key depends on voice, speed and text and never contains the text`() {
        val a = ChunkCache.key("bella", 1.0f, "Hello world")
        assertNotEquals(a, ChunkCache.key("adam", 1.0f, "Hello world"))
        assertNotEquals(a, ChunkCache.key("bella", 1.25f, "Hello world"))
        assertNotEquals(a, ChunkCache.key("bella", 1.0f, "Hello World"))
        assertEquals(a, ChunkCache.key("bella", 1.0f, "Hello world"))
        assertFalse(a.contains("Hello"))
        assertEquals(64, a.length)
    }

    @Test fun `least recently used entries go when the cap is passed`() {
        val dir = tmp.newFolder()
        val c = DiskChunkCache(dir, 2_500)
        c.put("a", chunk(1000)); dir.resolve("a.pcm").setLastModified(1_000)
        c.put("b", chunk(1000)); dir.resolve("b.pcm").setLastModified(2_000)
        assertNotNull(c.get("a")) // touches a: now newer than b
        c.put("c", chunk(1000))
        assertNull("b was least recently used", c.get("b"))
        assertNotNull(c.get("a")); assertNotNull(c.get("c"))
        assertTrue(c.sizeBytes() <= 2_500)
    }

    @Test fun `an entry bigger than the cap is not stored and a corrupt file is a miss`() {
        val dir = tmp.newFolder()
        val c = DiskChunkCache(dir, 500)
        c.put("big", chunk(2000))
        assertNull(c.get("big"))
        dir.resolve("bad.pcm").writeBytes(byteArrayOf(1, 2))
        assertNull(c.get("bad"))
        assertFalse(dir.resolve("bad.pcm").exists())
    }
}

class PcmTest {
    private fun tone(n: Int, rate: Int): PcmChunk {
        val b = ByteArray(n * 2)
        for (i in 0 until n) { val v = (Math.sin(2 * Math.PI * 440 * i / rate) * 12000).toInt(); b[2 * i] = v.toByte(); b[2 * i + 1] = (v shr 8).toByte() }
        return PcmChunk(b, rate)
    }

    @Test fun `resample keeps duration`() {
        val out = Pcm.resample(tone(22_050, 22_050), 24_000)
        assertEquals(24_000, out.sampleRate)
        assertTrue(out.durationMs in 998..1002)
        assertEquals(tone(100, 24_000).pcm.size, Pcm.resample(tone(100, 24_000), 24_000).pcm.size)
    }

    @Test fun `wav round trip`() {
        val t = tone(2400, 24_000)
        val back = Pcm.parseWav(Pcm.toWav(t.pcm, t.sampleRate))!!
        assertEquals(24_000, back.sampleRate)
        assertArrayEquals(t.pcm, back.pcm)
    }

    @Test fun `parseWav rejects non-PCM16 and garbage, mixes stereo down`() {
        assertNull(Pcm.parseWav(ByteArray(10)))
        val w = Pcm.toWav(tone(100, 8000).pcm, 8000)
        w[34] = 8 // 8 bits
        assertNull(Pcm.parseWav(w))
        // stereo: L=1000, R=3000 -> 2000
        val stereo = Pcm.toWav(ByteArray(8), 16000)
        stereo[22] = 2
        val body = stereo.copyOf(44)
        val data = byteArrayOf(0xE8.toByte(), 0x03, 0xB8.toByte(), 0x0B, 0xE8.toByte(), 0x03, 0xB8.toByte(), 0x0B)
        val s = Pcm.parseWav(body + data)!!
        assertEquals(4, s.pcm.size)
        assertEquals(2000, ((s.pcm[1].toInt() shl 8) or (s.pcm[0].toInt() and 0xff)))
    }
}
