package com.listenai.service.tts

import android.media.MediaCodec
import android.media.MediaCodec.BufferInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decode an arbitrary audio file (M4A / MP3 / AAC / WAV / OPUS) into raw
 * 16-bit-mono PCM at a target sample rate.
 *
 * Built for the embedding-extraction path in [ChatterboxOnDeviceService]:
 * `VoiceCloningService.downloadPreviewAudio()` returns whatever format the
 * backend stored (usually M4A from `MediaRecorder`); the speech encoder
 * wants 16 kHz mono float. This class bridges that gap.
 *
 * Implementation notes:
 *   - Uses `MediaExtractor` + `MediaCodec` (the standard Android decoder)
 *   - Mixes stereo to mono by averaging channels
 *   - Resamples via linear interpolation (good enough for voice-encoder
 *     conditioning; not for music)
 */
object AudioDecoder {

    private const val TAG = "AudioDecoder"
    private const val TIMEOUT_US = 5_000L

    /**
     * Decode [audioFile] to 16-bit signed PCM at [targetSampleRate], mono.
     *
     * @return a ShortArray of PCM samples, or null if decoding failed
     */
    fun decodeToMonoPcm(audioFile: File, targetSampleRate: Int = 16_000): ShortArray? {
        if (!audioFile.exists() || audioFile.length() == 0L) {
            Log.w(TAG, "decodeToMonoPcm: missing or empty file ${audioFile.absolutePath}")
            return null
        }

        val extractor = MediaExtractor()
        return try {
            extractor.setDataSource(audioFile.absolutePath)
            val trackIdx = (0 until extractor.trackCount).firstOrNull { i ->
                val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: ""
                mime.startsWith("audio/")
            } ?: run {
                Log.w(TAG, "decodeToMonoPcm: no audio track in ${audioFile.name}")
                return null
            }
            extractor.selectTrack(trackIdx)
            val inFormat = extractor.getTrackFormat(trackIdx)
            val inSampleRate = inFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            val inChannels = inFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val mime = inFormat.getString(MediaFormat.KEY_MIME)!!
            Log.i(TAG, "decodeToMonoPcm: ${audioFile.name} mime=$mime " +
                "rate=$inSampleRate ch=$inChannels → target=${targetSampleRate}Hz mono")

            val decoder = MediaCodec.createDecoderByType(mime).apply {
                configure(inFormat, null, null, 0)
                start()
            }

            val rawPcm = decodeAllFrames(extractor, decoder)
            decoder.stop()
            decoder.release()

            val mono = mixToMono(rawPcm, inChannels)
            val resampled = if (inSampleRate == targetSampleRate) mono
                            else resampleLinear(mono, inSampleRate, targetSampleRate)
            Log.i(TAG, "decodeToMonoPcm: produced ${resampled.size} samples (${resampled.size.toFloat() / targetSampleRate}s)")
            resampled
        } catch (t: Throwable) {
            Log.e(TAG, "decodeToMonoPcm: failed for ${audioFile.name}", t)
            null
        } finally {
            extractor.release()
        }
    }

    // ---- internal -----------------------------------------------------

    private fun decodeAllFrames(
        extractor: MediaExtractor,
        decoder: MediaCodec,
    ): ShortArray {
        val out = ArrayList<ShortArray>()
        val info = BufferInfo()
        var inputDone = false
        var outputDone = false

        while (!outputDone) {
            // Feed input.
            if (!inputDone) {
                val inIdx = decoder.dequeueInputBuffer(TIMEOUT_US)
                if (inIdx >= 0) {
                    val buf = decoder.getInputBuffer(inIdx)!!
                    val read = extractor.readSampleData(buf, 0)
                    if (read < 0) {
                        decoder.queueInputBuffer(inIdx, 0, 0, 0,
                            MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        inputDone = true
                    } else {
                        val pts = extractor.sampleTime
                        decoder.queueInputBuffer(inIdx, 0, read, pts, 0)
                        extractor.advance()
                    }
                }
            }

            // Drain output.
            val outIdx = decoder.dequeueOutputBuffer(info, TIMEOUT_US)
            when {
                outIdx >= 0 -> {
                    if (info.size > 0) {
                        val buf = decoder.getOutputBuffer(outIdx)!!
                        val shorts = ShortArray(info.size / 2)
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        buf.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
                        out.add(shorts)
                    }
                    decoder.releaseOutputBuffer(outIdx, false)
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true
                    }
                }
                outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    // No-op; we already captured channels/rate from the input
                    // format.
                }
                outIdx == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                    // brief wait; loop again
                }
            }
        }

        val total = out.sumOf { it.size }
        val flat = ShortArray(total)
        var off = 0
        for (chunk in out) {
            System.arraycopy(chunk, 0, flat, off, chunk.size)
            off += chunk.size
        }
        return flat
    }

    /** Mix N interleaved channels down to a mono ShortArray via simple averaging. */
    private fun mixToMono(interleaved: ShortArray, channels: Int): ShortArray {
        if (channels <= 1) return interleaved
        val frames = interleaved.size / channels
        val mono = ShortArray(frames)
        for (i in 0 until frames) {
            var sum = 0
            for (c in 0 until channels) {
                sum += interleaved[i * channels + c]
            }
            mono[i] = (sum / channels).toShort()
        }
        return mono
    }

    /**
     * Linear-interpolation resampler. Good enough for voice-encoder
     * conditioning where exact reconstruction quality of the source
     * doesn't matter — only that the speaker identity comes through.
     */
    private fun resampleLinear(input: ShortArray, fromRate: Int, toRate: Int): ShortArray {
        if (fromRate == toRate || input.isEmpty()) return input
        val ratio = fromRate.toDouble() / toRate.toDouble()
        val newLen = (input.size / ratio).toInt()
        val out = ShortArray(newLen)
        for (i in 0 until newLen) {
            val srcIdx = i * ratio
            val lo = srcIdx.toInt()
            val hi = (lo + 1).coerceAtMost(input.size - 1)
            val frac = srcIdx - lo
            val sample = input[lo] * (1.0 - frac) + input[hi] * frac
            out[i] = sample.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }
        return out
    }

    /** Convert 16-bit PCM to [-1.0, 1.0] float for ONNX input. */
    fun pcmToFloat(pcm: ShortArray): FloatArray {
        val out = FloatArray(pcm.size)
        for (i in pcm.indices) {
            out[i] = pcm[i] / 32_768.0f
        }
        return out
    }
}
