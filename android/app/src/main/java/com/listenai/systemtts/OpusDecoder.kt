package com.listenai.systemtts

import android.media.MediaCodec
import android.media.MediaDataSource
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import java.io.File
import java.nio.ByteBuffer

/**
 * Decodes an Opus-in-Ogg byte stream into raw signed 16-bit LE PCM
 * via MediaCodec + MediaExtractor. Used by [TalkbackLabelCache] to
 * unpack the compressed cache hits on demand.
 *
 * Two optimizations vs the initial v61 implementation:
 *
 *   1. **Codec reuse.** MediaCodec creation costs ~50-200 ms on
 *      Pixel 9 Pro. Since every cache entry uses the same format
 *      (24 kHz mono Opus 32 kbps), the same decoder can serve every
 *      hit — call flush() between decodes instead of creating a new
 *      codec. v61 measured cache hits at ~500 ms; this brings them
 *      back toward the ~100 ms target.
 *
 *   2. **MediaDataSource.** Skip the tempfile write/read round-trip
 *      by giving MediaExtractor a custom MediaDataSource backed by
 *      the asset byte array directly.
 *
 * Thread safety: `decode` is `@Synchronized` — concurrent cache hits
 * serialize through one codec instance. Cache hits are fast (~150 ms)
 * so serialization is fine for realistic TalkBack/Maps/Kindle rates.
 */
object OpusDecoder {

    private const val TAG = "OpusDecoder"
    private const val TIMEOUT_US = 50_000L

    private var codec: MediaCodec? = null
    private var codecMime: String? = null
    private var codecSampleRate: Int = 0
    private var codecChannels: Int = 0

    data class DecodedPcm(val pcm: ByteArray, val sampleRate: Int, val channels: Int)

    /**
     * Decode Opus bytes → 16-bit LE PCM. Returns null on any decode
     * failure (caller falls back to live synthesis). `cacheDir` is
     * unused now (kept in the signature for back-compat) — we no
     * longer touch the filesystem.
     */
    @Suppress("UNUSED_PARAMETER")
    @Synchronized
    fun decode(opusBytes: ByteArray, cacheDir: File): DecodedPcm? {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(ByteArrayMediaDataSource(opusBytes))
        } catch (t: Throwable) {
            Log.e(TAG, "MediaExtractor.setDataSource failed: ${t.message}")
            extractor.release()
            return null
        }

        var audioTrack = -1
        var format: MediaFormat? = null
        for (i in 0 until extractor.trackCount) {
            val f = extractor.getTrackFormat(i)
            val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("audio/")) {
                audioTrack = i
                format = f
                break
            }
        }
        if (audioTrack < 0 || format == null) {
            Log.w(TAG, "no audio track found")
            extractor.release()
            return null
        }
        extractor.selectTrack(audioTrack)

        val mime = format.getString(MediaFormat.KEY_MIME)!!
        val sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)

        // Decide: reuse existing codec, or create a new one?
        val activeCodec = try {
            ensureCodec(mime, sampleRate, channels, format)
        } catch (t: Throwable) {
            Log.e(TAG, "ensureCodec failed: ${t.message}", t)
            extractor.release()
            return null
        }

        val pcmOut = mutableListOf<ByteArray>()
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var outputDone = false

        try {
            while (!outputDone) {
                if (!inputDone) {
                    val inIdx = activeCodec.dequeueInputBuffer(TIMEOUT_US)
                    if (inIdx >= 0) {
                        val inBuf: ByteBuffer = activeCodec.getInputBuffer(inIdx)!!
                        val sampleSize = extractor.readSampleData(inBuf, 0)
                        if (sampleSize < 0) {
                            activeCodec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            val pts = extractor.sampleTime
                            activeCodec.queueInputBuffer(inIdx, 0, sampleSize, pts, 0)
                            extractor.advance()
                        }
                    }
                }
                val outIdx = activeCodec.dequeueOutputBuffer(info, TIMEOUT_US)
                when {
                    outIdx == MediaCodec.INFO_TRY_AGAIN_LATER -> { /* spin */ }
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> { /* note */ }
                    outIdx >= 0 -> {
                        val outBuf: ByteBuffer = activeCodec.getOutputBuffer(outIdx)!!
                        if (info.size > 0) {
                            val chunk = ByteArray(info.size)
                            outBuf.position(info.offset)
                            outBuf.get(chunk, 0, info.size)
                            pcmOut.add(chunk)
                        }
                        activeCodec.releaseOutputBuffer(outIdx, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                            outputDone = true
                        }
                    }
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "decode loop failed; recreating codec on next call", t)
            // Codec state may be corrupt — drop it so the next call
            // creates a fresh one.
            try { activeCodec.stop() } catch (_: Throwable) {}
            try { activeCodec.release() } catch (_: Throwable) {}
            codec = null
            codecMime = null
            return null
        } finally {
            extractor.release()
            // Reset codec state for the next decode — keeps the codec
            // alive but ready for fresh input.
            try { activeCodec.flush() } catch (_: Throwable) {}
        }

        val total = pcmOut.sumOf { it.size }
        val merged = ByteArray(total)
        var off = 0
        for (c in pcmOut) {
            System.arraycopy(c, 0, merged, off, c.size)
            off += c.size
        }
        return DecodedPcm(merged, sampleRate, channels)
    }

    /**
     * Returns the cached codec if its format matches, otherwise
     * recreates. Must be called holding the class lock (via the
     * @Synchronized on decode()).
     */
    private fun ensureCodec(mime: String, sampleRate: Int, channels: Int, format: MediaFormat): MediaCodec {
        val existing = codec
        if (existing != null && codecMime == mime && codecSampleRate == sampleRate && codecChannels == channels) {
            return existing
        }
        existing?.let {
            try { it.stop() } catch (_: Throwable) {}
            try { it.release() } catch (_: Throwable) {}
        }
        Log.i(TAG, "creating new MediaCodec for $mime ${sampleRate}Hz ${channels}ch")
        val fresh = MediaCodec.createDecoderByType(mime).apply {
            configure(format, null, null, 0)
            start()
        }
        codec = fresh
        codecMime = mime
        codecSampleRate = sampleRate
        codecChannels = channels
        return fresh
    }

    private class ByteArrayMediaDataSource(private val bytes: ByteArray) : MediaDataSource() {
        override fun close() { /* no-op — we hold no resources */ }
        override fun getSize(): Long = bytes.size.toLong()
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (position >= bytes.size) return -1
            val available = (bytes.size - position).toInt()
            val read = minOf(size, available)
            System.arraycopy(bytes, position.toInt(), buffer, offset, read)
            return read
        }
    }
}
