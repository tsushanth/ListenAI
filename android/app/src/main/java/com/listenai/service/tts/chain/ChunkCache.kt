package com.listenai.service.tts.chain

import java.io.File
import java.security.MessageDigest

interface ChunkCache {
    fun get(key: String): PcmChunk?
    fun put(key: String, chunk: PcmChunk)

    companion object {
        /** Hash of voice + speed + text. The text itself is never stored (the file name is the hash). */
        fun key(voiceId: String, speed: Float, text: String): String {
            val md = MessageDigest.getInstance("SHA-256")
            md.update("v1|$voiceId|${"%.2f".format(java.util.Locale.ROOT, speed)}|".toByteArray())
            md.update(text.toByteArray(Charsets.UTF_8))
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/**
 * One file per chunk (4-byte sample rate, then PCM), least recently used removed when the total passes [maxBytes].
 * Files are written to a temporary name and renamed, so a crash never leaves a half-written entry readable.
 */
class DiskChunkCache(private val dir: File, private val maxBytes: Long) : ChunkCache {

    init { dir.mkdirs() }

    @Synchronized
    override fun get(key: String): PcmChunk? {
        val f = File(dir, "$key.pcm")
        if (!f.isFile) return null
        return try {
            val b = f.readBytes()
            if (b.size <= 4) { f.delete(); return null }
            val rate = (b[0].toInt() and 0xff) or ((b[1].toInt() and 0xff) shl 8) or
                ((b[2].toInt() and 0xff) shl 16) or ((b[3].toInt() and 0xff) shl 24)
            f.setLastModified(System.currentTimeMillis())
            PcmChunk(b.copyOfRange(4, b.size), rate)
        } catch (e: Exception) {
            f.delete()
            null
        }
    }

    @Synchronized
    override fun put(key: String, chunk: PcmChunk) {
        if (chunk.pcm.isEmpty() || chunk.pcm.size + 4L > maxBytes) return
        try {
            val tmp = File(dir, "$key.tmp")
            tmp.outputStream().use { o ->
                val r = chunk.sampleRate
                o.write(byteArrayOf(r.toByte(), (r shr 8).toByte(), (r shr 16).toByte(), (r shr 24).toByte()))
                o.write(chunk.pcm)
            }
            val dest = File(dir, "$key.pcm")
            if (!tmp.renameTo(dest)) { tmp.delete(); return }
            evict()
        } catch (e: Exception) {
            // A cache that cannot write is just a cache that misses.
        }
    }

    private fun evict() {
        val files = dir.listFiles { f -> f.name.endsWith(".pcm") } ?: return
        var total = files.sumOf { it.length() }
        if (total <= maxBytes) return
        for (f in files.sortedBy { it.lastModified() }) {
            if (total <= maxBytes) break
            total -= f.length()
            f.delete()
        }
    }

    @Synchronized
    fun sizeBytes(): Long = dir.listFiles { f -> f.name.endsWith(".pcm") }?.sumOf { it.length() } ?: 0L
}

class MemoryChunkCache : ChunkCache {
    val map = LinkedHashMap<String, PcmChunk>()
    override fun get(key: String): PcmChunk? = map[key]
    override fun put(key: String, chunk: PcmChunk) { map[key] = chunk }
}
