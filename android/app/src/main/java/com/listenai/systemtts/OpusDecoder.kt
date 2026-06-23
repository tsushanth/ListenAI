package com.listenai.systemtts

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer

/**
 * Decodes an Opus-in-Ogg file (.opus) into raw signed 16-bit LE PCM
 * via MediaCodec + MediaExtractor. Used by [TalkbackLabelCache] to
 * unpack the compressed cache hits on demand.
 *
 * Synchronous (the cache lookup path needs to return bytes inline so
 * SynthesisCallback.audioAvailable can be called from
 * ReadAloudTTSService.servePcmFromCache).
 *
 * Typical decode time on Pixel 9 Pro for a 1-2s clip: 5-20 ms.
 * Acceptable inside the cache hit path which already accepts <100 ms.
 *
 * Implementation notes:
 *  - MediaExtractor cannot read bytes directly; it needs a file path
 *    or a MediaDataSource (API 23+). For simplicity we write the asset
 *    bytes to a one-shot temp file in cacheDir, decode, delete.
 *  - We return the FULL decoded buffer; the cache hits are short
 *    (<2 s at 24 kHz = <100 KB) so streaming output isn't needed.
 *  - Only single audio track is supported; stereo would be folded
 *    silently (Kokoro renders are mono so we never hit this).
 */
object OpusDecoder {

    private const val TAG = "OpusDecoder"
    private const val TIMEOUT_US = 50_000L  // 50 ms per buffer wait

    /**
     * Decode the Opus bytes into PCM bytes (16-bit LE) + sample rate.
     * Returns null on any decode failure — caller should fall back to
     * live synthesis.
     */
    fun decode(opusBytes: ByteArray, cacheDir: File): DecodedPcm? {
        val tmp = File(cacheDir, "opus_decode_${System.nanoTime()}.opus")
        try {
            FileOutputStream(tmp).use { it.write(opusBytes) }
            return decodeFile(tmp)
        } catch (t: Throwable) {
            Log.e(TAG, "decode failed", t)
            return null
        } finally {
            tmp.delete()
        }
    }

    data class DecodedPcm(val pcm: ByteArray, val sampleRate: Int, val channels: Int)

    private fun decodeFile(file: File): DecodedPcm? {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
        } catch (t: Throwable) {
            Log.e(TAG, "MediaExtractor.setDataSource failed: ${t.message}")
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

        val sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        val mime = format.getString(MediaFormat.KEY_MIME)!!

        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(format, null, null, 0)
        codec.start()

        val info = MediaCodec.BufferInfo()
        val pcmOut = mutableListOf<ByteArray>()
        var inputDone = false
        var outputDone = false

        try {
            while (!outputDone) {
                if (!inputDone) {
                    val inIdx = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (inIdx >= 0) {
                        val inBuf: ByteBuffer = codec.getInputBuffer(inIdx)!!
                        val sampleSize = extractor.readSampleData(inBuf, 0)
                        if (sampleSize < 0) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            val pts = extractor.sampleTime
                            codec.queueInputBuffer(inIdx, 0, sampleSize, pts, 0)
                            extractor.advance()
                        }
                    }
                }

                val outIdx = codec.dequeueOutputBuffer(info, TIMEOUT_US)
                when {
                    outIdx == MediaCodec.INFO_TRY_AGAIN_LATER -> { /* wait next loop */ }
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        // sample rate / channel count finalized here on some codecs
                    }
                    outIdx >= 0 -> {
                        val outBuf: ByteBuffer = codec.getOutputBuffer(outIdx)!!
                        if (info.size > 0) {
                            val chunk = ByteArray(info.size)
                            outBuf.position(info.offset)
                            outBuf.get(chunk, 0, info.size)
                            pcmOut.add(chunk)
                        }
                        codec.releaseOutputBuffer(outIdx, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                            outputDone = true
                        }
                    }
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "decode loop failed", t)
            return null
        } finally {
            try { codec.stop() } catch (_: Throwable) {}
            codec.release()
            extractor.release()
        }

        // Concat PCM chunks
        val total = pcmOut.sumOf { it.size }
        val merged = ByteArray(total)
        var off = 0
        for (c in pcmOut) {
            System.arraycopy(c, 0, merged, off, c.size)
            off += c.size
        }
        return DecodedPcm(merged, sampleRate, channels)
    }
}
