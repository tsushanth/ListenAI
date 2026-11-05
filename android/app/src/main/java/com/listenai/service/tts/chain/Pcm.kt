package com.listenai.service.tts.chain

/** Small PCM and WAV helpers shared by the sources and the file adapter. */
object Pcm {

    /** Linear resample of 16-bit mono PCM. Returns the input when rates match. */
    fun resample(chunk: PcmChunk, toRate: Int): PcmChunk {
        if (chunk.sampleRate == toRate || chunk.pcm.size < 4 || chunk.sampleRate <= 0) return chunk
        val n = chunk.pcm.size / 2
        val outN = (n.toLong() * toRate / chunk.sampleRate).toInt().coerceAtLeast(1)
        val out = ByteArray(outN * 2)
        val step = chunk.sampleRate.toDouble() / toRate
        fun sample(i: Int): Int {
            val j = i.coerceIn(0, n - 1)
            return ((chunk.pcm[2 * j + 1].toInt() shl 8) or (chunk.pcm[2 * j].toInt() and 0xff)).toShort().toInt()
        }
        for (i in 0 until outN) {
            val pos = i * step
            val i0 = pos.toInt()
            val frac = pos - i0
            val v = (sample(i0) * (1 - frac) + sample(i0 + 1) * frac).toInt().coerceIn(-32768, 32767)
            out[2 * i] = v.toByte()
            out[2 * i + 1] = (v shr 8).toByte()
        }
        return PcmChunk(out, toRate)
    }

    /** Parses a 16-bit PCM WAV (any mono/stereo, header chunks in any order). Stereo is mixed down. Null if not PCM16. */
    fun parseWav(b: ByteArray): PcmChunk? {
        if (b.size < 44 || String(b, 0, 4, Charsets.US_ASCII) != "RIFF") return null
        var p = 12
        var rate = 0
        var channels = 0
        var bits = 0
        var fmtTag = 0
        var dataOff = -1
        var dataLen = 0
        while (p + 8 <= b.size) {
            val name = String(b, p, 4, Charsets.US_ASCII)
            val len = le32(b, p + 4)
            val body = p + 8
            if (name == "fmt " && body + 16 <= b.size) {
                fmtTag = le16(b, body); channels = le16(b, body + 2); rate = le32(b, body + 4); bits = le16(b, body + 14)
            } else if (name == "data") {
                dataOff = body
                // Streaming writers may leave the length as 0 or 0xFFFFFFFF: take what is there.
                dataLen = if (len <= 0 || len > b.size - body) b.size - body else len
                break
            }
            if (len < 0) return null
            p = body + len + (len and 1)
        }
        if (dataOff < 0 || fmtTag != 1 || bits != 16 || rate <= 0 || channels !in 1..2) return null
        dataLen -= dataLen % (2 * channels)
        if (channels == 1) return PcmChunk(b.copyOfRange(dataOff, dataOff + dataLen), rate)
        val frames = dataLen / 4
        val out = ByteArray(frames * 2)
        for (i in 0 until frames) {
            val l = (b[dataOff + 4 * i + 1].toInt() shl 8) or (b[dataOff + 4 * i].toInt() and 0xff)
            val r = (b[dataOff + 4 * i + 3].toInt() shl 8) or (b[dataOff + 4 * i + 2].toInt() and 0xff)
            val m = (l.toShort() + r.toShort()) / 2
            out[2 * i] = m.toByte(); out[2 * i + 1] = (m shr 8).toByte()
        }
        return PcmChunk(out, rate)
    }

    fun toWav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream(44 + pcm.size)
        fun w32(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff); out.write((v shr 16) and 0xff); out.write((v shr 24) and 0xff) }
        fun w16(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff) }
        out.write("RIFF".toByteArray()); w32(36 + pcm.size); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); w32(16); w16(1); w16(1); w32(sampleRate); w32(sampleRate * 2); w16(2); w16(16)
        out.write("data".toByteArray()); w32(pcm.size); out.write(pcm)
        return out.toByteArray()
    }

    private fun le16(b: ByteArray, o: Int) = (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8)
    private fun le32(b: ByteArray, o: Int) = le16(b, o) or (le16(b, o + 2) shl 16)
}
