package com.listenai.systemtts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.app.Activity
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer
import kotlin.concurrent.thread

/**
 * End-to-end Piper TTS on Pixel: text → IPA via [EspeakBridge] → Piper
 * phoneme IDs via the voice config's `phoneme_id_map` → VITS inference
 * via ONNX Runtime → 16-bit PCM → AudioTrack.
 *
 * This is the full live pipeline — no pre-computed IDs, no hardcoded
 * phonemes. The eSpeak bridge and Piper model are bundled in APK
 * assets; on first launch both are extracted to cache dir so
 * MediaExtractor / ORT can mmap them.
 *
 * Launch (any text):
 *   adb shell am start -n com.listenai/.systemtts.PiperBenchmarkActivity \
 *     --es text "your text here"
 *
 * Logs: `adb logcat -s PiperBench:I PiperBench:E EspeakBridge:I espeak_bridge:I`
 *
 * Timing breakdown emitted:
 *   T_LOAD_START         activity onCreate + thread start
 *   T_ESPEAK_READY       eSpeak NG initialized
 *   T_MODEL_COPY_DONE    Piper model extracted to cache
 *   T_SESSION_READY      ORT session created
 *   T_PHONEMIZE_DONE     text → IPA
 *   T_IDS_DONE           IPA → Piper IDs
 *   T_WARMUP_DONE        throwaway 5-token inference (JIT)
 *   T_INFER_DONE         real timed inference (with RTF)
 *   T_PLAY_DONE          AudioTrack drained
 */
class PiperBenchmarkActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent.getStringExtra("text")
            ?: "Hello world. This is Piper running live on a Pixel."
        val status = TextView(this).apply {
            setText("Piper LIVE benchmark\ntext (${text.length} chars):\n$text\n\nSee `adb logcat -s PiperBench:I`")
            textSize = 14f
            setPadding(48, 96, 48, 48)
        }
        setContentView(status)

        thread(start = true, name = "PiperLive") {
            try { runBenchmark(text) { status.post { status.setText(it) } } }
            catch (t: Throwable) {
                Log.e(TAG, "benchmark threw", t)
                status.post { status.setText("ERROR: ${t.message}") }
            }
        }
    }

    private fun runBenchmark(text: String, onStatus: (String) -> Unit) {
        Log.i(TAG, "T_LOAD_START=${System.currentTimeMillis()} text='${text.take(60)}…'")

        // 1) Initialize eSpeak NG (one-time per process, then ~free)
        val espeakStart = System.currentTimeMillis()
        val sr = EspeakBridge.ensureInitialized(applicationContext)
        if (sr <= 0 || !EspeakBridge.isReady()) {
            Log.e(TAG, "eSpeak init failed (sr=$sr) — bailing")
            onStatus("eSpeak init FAILED (sr=$sr)")
            return
        }
        Log.i(TAG, "T_ESPEAK_READY=${System.currentTimeMillis()} dt=${System.currentTimeMillis() - espeakStart}ms")

        // 2) Extract Piper model + config from assets to cache (one-time)
        val cacheRoot = File(cacheDir, "piper")
        cacheRoot.mkdirs()
        val modelFile = File(cacheRoot, "model.onnx")
        val configFile = File(cacheRoot, "config.json")
        val copyStart = System.currentTimeMillis()
        if (!modelFile.exists() || modelFile.length() == 0L) {
            assets.open("piper/model.onnx").use { input ->
                modelFile.outputStream().use { out -> input.copyTo(out) }
            }
        }
        if (!configFile.exists() || configFile.length() == 0L) {
            assets.open("piper/config.json").use { input ->
                configFile.outputStream().use { out -> input.copyTo(out) }
            }
        }
        Log.i(TAG, "T_MODEL_COPY_DONE=${System.currentTimeMillis()} dt=${System.currentTimeMillis() - copyStart}ms")

        // 3) Parse config to get phoneme_id_map + scales + sample_rate
        val config = JSONObject(configFile.readText())
        val piperSampleRate = config.getJSONObject("audio").getInt("sample_rate")
        val infCfg = config.getJSONObject("inference")
        val scales = floatArrayOf(
            infCfg.getDouble("noise_scale").toFloat(),
            infCfg.getDouble("length_scale").toFloat(),
            infCfg.getDouble("noise_w").toFloat(),
        )
        val phonemeMap = config.getJSONObject("phoneme_id_map")
        val bosId = phonemeMap.getJSONArray("^").getLong(0)
        val eosId = phonemeMap.getJSONArray("$").getLong(0)
        val padId = phonemeMap.getJSONArray("_").getLong(0)

        // 4) Phonemize via eSpeak
        val phonStart = System.currentTimeMillis()
        val ipa = EspeakBridge.phonemize(text)
        Log.i(TAG, "T_PHONEMIZE_DONE=${System.currentTimeMillis()} dt=${System.currentTimeMillis() - phonStart}ms ipa='$ipa'")

        // 5) Map IPA chars → Piper phoneme IDs.
        //    Piper convention: BOS, then for each IPA codepoint emit id + pad, then EOS.
        val idsStart = System.currentTimeMillis()
        val ids = mutableListOf(bosId)
        var skipped = 0
        for (ch in ipa) {
            val key = ch.toString()
            if (phonemeMap.has(key)) {
                ids.add(phonemeMap.getJSONArray(key).getLong(0))
                ids.add(padId)
            } else {
                skipped++
            }
        }
        ids.add(eosId)
        val idArr = ids.toLongArray()
        Log.i(TAG, "T_IDS_DONE=${System.currentTimeMillis()} dt=${System.currentTimeMillis() - idsStart}ms ids=${idArr.size} skipped=$skipped")

        // 6) ORT session (CPU EP — NNAPI hangs on Piper per 2026-06-22 sweep)
        val sessStart = System.currentTimeMillis()
        val env = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions().apply { setIntraOpNumThreads(6) }
        val sess = env.createSession(modelFile.absolutePath, opts)
        Log.i(TAG, "T_SESSION_READY=${System.currentTimeMillis()} dt=${System.currentTimeMillis() - sessStart}ms")

        // 7) Warmup with tiny synthetic ids to JIT the graph
        runInference(env, sess, longArrayOf(bosId, padId, 14, padId, eosId), scales)
        Log.i(TAG, "T_WARMUP_DONE=${System.currentTimeMillis()}")

        // 8) Real inference
        val inferStart = System.currentTimeMillis()
        val audio = runInference(env, sess, idArr, scales)
        val inferMs = System.currentTimeMillis() - inferStart
        val audioSec = audio.size.toDouble() / piperSampleRate
        val rtf = inferMs / 1000.0 / audioSec
        Log.i(TAG, "T_INFER_DONE=${System.currentTimeMillis()} dt=${inferMs}ms audio=${audio.size}samples=${"%.2f".format(audioSec)}s rtf=${"%.3f".format(rtf)}x")

        onStatus(
            "Piper LIVE benchmark — DONE\n" +
                    "text: ${text.length} chars\n" +
                    "IPA chars: ${ipa.length}\n" +
                    "Piper IDs: ${idArr.size} (skipped=$skipped)\n" +
                    "Inference: ${inferMs} ms\n" +
                    "Audio: ${"%.2f".format(audioSec)}s @ ${piperSampleRate}Hz\n" +
                    "RTF: ${"%.3f".format(rtf)}x\n\n" +
                    "Playing through AudioTrack…"
        )

        playPcm(audio, piperSampleRate)
    }

    private fun runInference(env: OrtEnvironment, sess: OrtSession, ids: LongArray, scales: FloatArray): FloatArray {
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
                        // Piper outputs [1, 1, 1, samples] — strip wrapping arrays
                        var cur: Any = raw
                        while (cur is Array<*>) cur = (cur as Array<*>)[0]!!
                        cur as FloatArray
                    }
                    else -> throw IllegalStateException("unexpected audio type: ${raw?.javaClass}")
                }
            }
        } finally {
            input.close(); lengths.close(); scaleTensor.close()
        }
    }

    private fun playPcm(audio: FloatArray, sampleRate: Int) {
        val pcm = ShortArray(audio.size) { (audio[it] * 32767f).coerceIn(-32768f, 32767f).toInt().toShort() }
        val bytes = ByteArray(pcm.size * 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm)
        val minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack(
            AudioManager.STREAM_MUSIC, sampleRate, AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, bytes.size), AudioTrack.MODE_STATIC,
        )
        track.write(bytes, 0, bytes.size)
        track.play()
        Thread.sleep((audio.size * 1000L / sampleRate) + 200)
        Log.i(TAG, "T_PLAY_DONE=${System.currentTimeMillis()}")
        track.release()
    }

    companion object { private const val TAG = "PiperBench" }
}
