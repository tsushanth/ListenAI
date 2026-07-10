package com.listenai.service.tts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import android.content.Context
import android.util.Log
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Persistent cache for the 4 speaker tensors that the speech_encoder ONNX
 * produces. The encoder is the **largest** model (~563 MB on disk, ~1 GB
 * in RAM) and produces the same outputs every time for the same audio
 * sample. Re-running it per synthesize() call costs ~30-60 seconds of the
 * total budget — caching eliminates that on every synthesis after the first.
 *
 * Storage layout:
 *   chatterbox/speaker_cache/<voiceId>.bin
 *
 * Binary format (little-endian):
 *   [int   magic = 0x53504B52 'SPKR']
 *   [int   version = 1]
 *   [long  source audio file mtime, for invalidation]
 *   [tensor cond_emb  ]   <- float32, rank 3
 *   [tensor prompt_token]  <- int64,   rank 2
 *   [tensor ref_x_vector]  <- float32, rank 2
 *   [tensor prompt_feat ]  <- float32, rank 2
 *
 * Tensor encoding:
 *   [byte dtype: 1=float32, 2=int64]
 *   [int  rank]
 *   [long dim 0 ... dim N-1]
 *   [bytes payload]
 */
class SpeakerCache private constructor(context: Context) {

    private val cacheDir = File(context.filesDir, "chatterbox/speaker_cache").apply { mkdirs() }

    /**
     * Try to load the 4 speaker tensors for [voiceId] from disk. Returns null
     * if the cache is missing OR the source audio's mtime has changed
     * (which means the user re-recorded their voice).
     */
    fun load(env: OrtEnvironment, voiceId: String, sourceAudioMtime: Long): SpeakerConditioning? {
        val file = File(cacheDir, "$voiceId.bin")
        if (!file.exists()) return null
        return try {
            DataInputStream(FileInputStream(file)).use { dis ->
                val magic = dis.readInt()
                val version = dis.readInt()
                val mtime = dis.readLong()
                if (magic != MAGIC || version != VERSION) {
                    Log.w(TAG, "load: bad header for $voiceId (magic=$magic version=$version)")
                    return null
                }
                if (mtime != sourceAudioMtime) {
                    Log.i(TAG, "load: cache for $voiceId is stale (mtime $mtime != current $sourceAudioMtime)")
                    return null
                }
                val condEmb = readFloatTensor(dis, env)
                val promptToken = readLongTensor(dis, env)
                val refXVector = readFloatTensor(dis, env)
                val promptFeat = readFloatTensor(dis, env)
                Log.i(TAG, "load: hit for $voiceId (${file.length() / 1024} KB)")
                SpeakerConditioning(condEmb, promptToken, refXVector, promptFeat)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "load: corrupt cache for $voiceId — ${t.message}")
            file.delete()
            null
        }
    }

    /**
     * Persist the 4 speaker tensors for [voiceId] keyed against
     * [sourceAudioMtime] so a re-recording invalidates them.
     *
     * Re-reads each tensor's raw bytes into memory, then writes them out —
     * the OnnxTensors themselves stay live.
     */
    fun store(voiceId: String, sourceAudioMtime: Long, speaker: SpeakerConditioning) {
        val file = File(cacheDir, "$voiceId.bin")
        val tmp = File(cacheDir, "$voiceId.bin.tmp")
        try {
            DataOutputStream(FileOutputStream(tmp)).use { dos ->
                dos.writeInt(MAGIC)
                dos.writeInt(VERSION)
                dos.writeLong(sourceAudioMtime)
                writeFloatTensor(dos, speaker.condEmb)
                writeLongTensor(dos, speaker.promptToken)
                writeFloatTensor(dos, speaker.refXVector)
                writeFloatTensor(dos, speaker.promptFeat)
            }
            if (!tmp.renameTo(file)) {
                Log.w(TAG, "store: rename failed for $voiceId")
                tmp.delete()
                return
            }
            Log.i(TAG, "store: cached $voiceId (${file.length() / 1024} KB)")
        } catch (t: Throwable) {
            Log.w(TAG, "store: failed for $voiceId — ${t.message}")
            tmp.delete()
        }
    }

    // ----------------------------------------------------------------
    // tensor (de)serialisation
    // ----------------------------------------------------------------

    private fun writeFloatTensor(dos: DataOutputStream, t: OnnxTensor) {
        val shape = t.info.shape
        dos.writeByte(DTYPE_FLOAT32)
        dos.writeInt(shape.size)
        for (d in shape) dos.writeLong(d)
        @Suppress("UNCHECKED_CAST")
        val flat = flattenFloats(t)
        val buf = ByteBuffer.allocate(flat.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (f in flat) buf.putFloat(f)
        dos.write(buf.array())
    }

    private fun writeLongTensor(dos: DataOutputStream, t: OnnxTensor) {
        val shape = t.info.shape
        dos.writeByte(DTYPE_INT64)
        dos.writeInt(shape.size)
        for (d in shape) dos.writeLong(d)
        @Suppress("UNCHECKED_CAST")
        val flat = flattenLongs(t)
        val buf = ByteBuffer.allocate(flat.size * 8).order(ByteOrder.LITTLE_ENDIAN)
        for (v in flat) buf.putLong(v)
        dos.write(buf.array())
    }

    private fun readFloatTensor(dis: DataInputStream, env: OrtEnvironment): OnnxTensor {
        val dtype = dis.readByte().toInt()
        require(dtype == DTYPE_FLOAT32) { "expected float32 tensor, got $dtype" }
        val rank = dis.readInt()
        val shape = LongArray(rank) { dis.readLong() }
        val n = shape.fold(1L) { a, b -> a * b }.toInt()
        val bytes = ByteArray(n * 4)
        dis.readFully(bytes)
        val floatBuf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        val out = FloatArray(n)
        floatBuf.get(out)
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(out), shape)
    }

    private fun readLongTensor(dis: DataInputStream, env: OrtEnvironment): OnnxTensor {
        val dtype = dis.readByte().toInt()
        require(dtype == DTYPE_INT64) { "expected int64 tensor, got $dtype" }
        val rank = dis.readInt()
        val shape = LongArray(rank) { dis.readLong() }
        val n = shape.fold(1L) { a, b -> a * b }.toInt()
        val bytes = ByteArray(n * 8)
        dis.readFully(bytes)
        val longBuf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asLongBuffer()
        val out = LongArray(n)
        longBuf.get(out)
        return OnnxTensor.createTensor(env, LongBuffer.wrap(out), shape)
    }

    // ONNX returns arrays-of-arrays for >1D float tensors. Flatten generically.
    private fun flattenFloats(t: OnnxTensor): FloatArray {
        val v = t.value
        return when (v) {
            is FloatArray -> v
            is Array<*> -> {
                val parts = ArrayList<FloatArray>()
                walkFloats(v, parts)
                val total = parts.sumOf { it.size }
                val out = FloatArray(total)
                var off = 0
                for (p in parts) {
                    System.arraycopy(p, 0, out, off, p.size)
                    off += p.size
                }
                out
            }
            else -> error("unexpected float tensor value type: ${v?.javaClass}")
        }
    }

    private fun walkFloats(arr: Array<*>, out: ArrayList<FloatArray>) {
        for (item in arr) {
            when (item) {
                is FloatArray -> out.add(item)
                is Array<*> -> walkFloats(item, out)
                else -> error("unexpected nested type: ${item?.javaClass}")
            }
        }
    }

    private fun flattenLongs(t: OnnxTensor): LongArray {
        val v = t.value
        return when (v) {
            is LongArray -> v
            is Array<*> -> {
                val parts = ArrayList<LongArray>()
                walkLongs(v, parts)
                val total = parts.sumOf { it.size }
                val out = LongArray(total)
                var off = 0
                for (p in parts) {
                    System.arraycopy(p, 0, out, off, p.size)
                    off += p.size
                }
                out
            }
            else -> error("unexpected long tensor value type: ${v?.javaClass}")
        }
    }

    private fun walkLongs(arr: Array<*>, out: ArrayList<LongArray>) {
        for (item in arr) {
            when (item) {
                is LongArray -> out.add(item)
                is Array<*> -> walkLongs(item, out)
                else -> error("unexpected nested type: ${item?.javaClass}")
            }
        }
    }

    companion object {
        private const val TAG = "SpeakerCache"
        private const val MAGIC = 0x53504B52  // 'SPKR'
        private const val VERSION = 1
        private const val DTYPE_FLOAT32 = 1
        private const val DTYPE_INT64 = 2

        @Volatile
        private var instance: SpeakerCache? = null
        fun getInstance(context: Context): SpeakerCache =
            instance ?: synchronized(this) {
                instance ?: SpeakerCache(context.applicationContext).also { instance = it }
            }
    }
}
