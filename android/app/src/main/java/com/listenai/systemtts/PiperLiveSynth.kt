package com.listenai.systemtts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Singleton wrapping the Piper VITS model for live on-device synthesis.
 *
 * Pipeline: text → IPA via [EspeakBridge] → Piper phoneme IDs via the
 * bundled config's `phoneme_id_map` → VITS forward pass via ORT
 * → 16-bit LE PCM at the model's native sample rate.
 *
 * Used by [ReadAloudTTSService] as the cache-miss path for short
 * text (TalkBack labels, Maps directions, etc.) where Kokoro live
 * synthesis would take 2-3 s and Piper takes ~600-800 ms.
 *
 * Initialized lazily on first synthesize() call. Pixel 9 Pro
 * measured (one-time per process):
 *
 *   Asset extract (60 MB model + 4 KB config):  ~900 ms
 *   ORT session create (CPU EP, 6 threads):     ~7-8 s
 *   Warmup inference:                           ~300 ms
 *   Per-utterance inference (15-40 chars):      600-1900 ms
 *
 * Thread-safe via class-level synchronization. Concurrent calls
 * serialize; cache hits / Kokoro fallback don't go through here.
 */
object PiperLiveSynth {

    private const val TAG = "PiperLive"
    private const val ASSET_MODEL = "piper/model.onnx"
    private const val ASSET_CONFIG = "piper/config.json"

    @Volatile private var initialized: Boolean = false
    @Volatile private var initFailed: Boolean = false
    @Volatile private var session: OrtSession? = null
    @Volatile private var sampleRate: Int = 0
    @Volatile private var scales: FloatArray = floatArrayOf()
    @Volatile private var phonemeMap: JSONObject? = null
    @Volatile private var bosId: Long = 1
    @Volatile private var eosId: Long = 2
    @Volatile private var padId: Long = 0

    fun isReady(): Boolean = initialized && !initFailed && session != null

    fun sampleRate(): Int = sampleRate

    /**
     * Synthesize [text] to int16 LE PCM. Returns empty array on any
     * failure (caller should fall back to Kokoro).
     *
     * Auto-initializes on first call; subsequent calls reuse the
     * loaded session.
     */
    @Synchronized
    fun synthesize(context: Context, text: String): ShortArray {
        if (!ensureInitialized(context)) return ShortArray(0)
        val sess = session ?: return ShortArray(0)
        val pmap = phonemeMap ?: return ShortArray(0)

        // 1. text → IPA via eSpeak
        if (!EspeakBridge.isReady()) return ShortArray(0)
        val ipa = EspeakBridge.phonemize(text)
        if (ipa.isEmpty()) return ShortArray(0)

        // 2. IPA → Piper IDs (BOS, phoneme+pad pairs, EOS)
        val ids = ArrayList<Long>(ipa.length * 2 + 2)
        ids.add(bosId)
        var skipped = 0
        for (ch in ipa) {
            val key = ch.toString()
            if (pmap.has(key)) {
                ids.add(pmap.getJSONArray(key).getLong(0))
                ids.add(padId)
            } else {
                skipped++
            }
        }
        ids.add(eosId)
        val idArr = LongArray(ids.size) { ids[it] }
        Log.i(TAG, "synth '${text.take(40)}' ipa.len=${ipa.length} ids=${idArr.size} skipped=$skipped")

        // 3. ORT inference
        val inferStart = System.currentTimeMillis()
        val audioF32 = try {
            runInference(sess, idArr)
        } catch (t: Throwable) {
            Log.e(TAG, "inference threw: ${t.message}", t)
            return ShortArray(0)
        }
        Log.i(TAG, "synth inference: ${System.currentTimeMillis() - inferStart}ms for ${audioF32.size} samples")

        // 4. FP32 [-1, 1] → int16 LE PCM
        return ShortArray(audioF32.size) {
            (audioF32[it] * 32767f).coerceIn(-32768f, 32767f).toInt().toShort()
        }
    }

    private fun ensureInitialized(context: Context): Boolean {
        if (initialized) return !initFailed
        // Already synchronized at the method level
        if (initialized) return !initFailed
        try {
            val sr = EspeakBridge.ensureInitialized(context.applicationContext)
            if (sr <= 0) {
                Log.e(TAG, "eSpeak init failed (sr=$sr) — Piper unusable")
                initFailed = true
                initialized = true
                return false
            }
            val ctx = context.applicationContext
            val cacheRoot = File(ctx.cacheDir, "piper").apply { mkdirs() }
            val modelFile = File(cacheRoot, "model.onnx")
            val configFile = File(cacheRoot, "config.json")
            if (!modelFile.exists() || modelFile.length() == 0L) {
                ctx.assets.open(ASSET_MODEL).use { input ->
                    modelFile.outputStream().use { out -> input.copyTo(out) }
                }
                Log.i(TAG, "model extracted to cache (${modelFile.length()} bytes)")
            }
            if (!configFile.exists() || configFile.length() == 0L) {
                ctx.assets.open(ASSET_CONFIG).use { input ->
                    configFile.outputStream().use { out -> input.copyTo(out) }
                }
            }
            val config = JSONObject(configFile.readText())
            sampleRate = config.getJSONObject("audio").getInt("sample_rate")
            val infCfg = config.getJSONObject("inference")
            scales = floatArrayOf(
                infCfg.getDouble("noise_scale").toFloat(),
                infCfg.getDouble("length_scale").toFloat(),
                infCfg.getDouble("noise_w").toFloat(),
            )
            val pmap = config.getJSONObject("phoneme_id_map")
            bosId = pmap.getJSONArray("^").getLong(0)
            eosId = pmap.getJSONArray("$").getLong(0)
            padId = pmap.getJSONArray("_").getLong(0)
            phonemeMap = pmap

            val env = OrtEnvironment.getEnvironment()
            // CPU EP only — the 2026-06-22 EP sweep confirmed NNAPI
            // hangs on Piper VITS and XNNPACK is marginal at best.
            val opts = OrtSession.SessionOptions().apply { setIntraOpNumThreads(6) }
            val sessStart = System.currentTimeMillis()
            val sess = env.createSession(modelFile.absolutePath, opts)
            Log.i(TAG, "session created in ${System.currentTimeMillis() - sessStart}ms")

            // Warmup with tiny synthetic IDs to JIT the graph before
            // any user-facing synth call.
            try { runInference(sess, longArrayOf(bosId, padId, 14, padId, eosId)) }
            catch (t: Throwable) { Log.w(TAG, "warmup inference threw (non-fatal): ${t.message}") }

            session = sess
            initialized = true
            initFailed = false
            Log.i(TAG, "init complete: sr=$sampleRate")
            return true
        } catch (t: Throwable) {
            Log.e(TAG, "init threw: ${t.message}", t)
            initFailed = true
            initialized = true
            return false
        }
    }

    private fun runInference(sess: OrtSession, ids: LongArray): FloatArray {
        val env = OrtEnvironment.getEnvironment()
        val input = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), longArrayOf(1, ids.size.toLong()))
        val lengths = OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(ids.size.toLong())), longArrayOf(1))
        val scaleTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(scales), longArrayOf(scales.size.toLong()))
        try {
            sess.run(mapOf("input" to input, "input_lengths" to lengths, "scales" to scaleTensor)).use { res ->
                val raw = res.get(0).value
                @Suppress("UNCHECKED_CAST")
                return when (raw) {
                    is FloatArray -> raw
                    is Array<*> -> {
                        var cur: Any = raw
                        while (cur is Array<*>) cur = (cur as Array<*>)[0]!!
                        cur as FloatArray
                    }
                    else -> throw IllegalStateException("unexpected audio tensor type: ${raw?.javaClass}")
                }
            }
        } finally {
            input.close(); lengths.close(); scaleTensor.close()
        }
    }
}
