package com.listenai.systemtts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.providers.NNAPIFlags
import android.app.Activity
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import com.listenai.service.tts.KokoroG2P
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.util.EnumSet
import kotlin.concurrent.thread

/**
 * Tests whether alternative Kokoro v1.0 ONNX variants
 * (model_quantized.onnx, model_uint8.onnx, etc) actually engage NNAPI
 * on the Pixel Tensor SOC, or fall back to CPU like the q8f16 model
 * does (per the 2026-06-22 NNAPI sweep).
 *
 * If any variant runs materially faster on NNAPI than on CPU,
 * **Warren's TalkBack short-utterance complaint can be fixed by
 * swapping the shipped model file** — no Piper integration, no eSpeak
 * NDK, no architecture change.
 *
 * Launch:
 *   adb shell am start -n com.listenai/.systemtts.KokoroVariantBenchmarkActivity \
 *     --es variant kokoro_quantized --es ep NNAPI_FP16
 *
 * Variants are read from APK assets (`kokoro_<name>.onnx`) and copied to
 * cache dir on first launch. Uses the existing KokoroG2P for tokenization
 * + voice embeddings — only the model file changes between runs.
 *
 * Logs (`adb logcat -s KokoroVarBench:I`):
 *   T_BENCH_START
 *   T_MODEL_COPY_DONE
 *   T_SESSION_READY     ep / model
 *   T_WARMUP_DONE       throwaway 5-token inference
 *   T_INFER_DONE        real inference, with dt and rtf
 *   T_PLAY_DONE
 */
class KokoroVariantBenchmarkActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val variant = intent.getStringExtra("variant") ?: "kokoro_quantized"
        val epName = intent.getStringExtra("ep") ?: "CPU"
        val benchText = intent.getStringExtra("text") ?: "The quick brown fox jumps over the lazy dog."

        val status = TextView(this).apply {
            text = "Kokoro variant benchmark\nvariant=$variant\nep=$epName\n\nSee `adb logcat -s KokoroVarBench:I`"
            textSize = 14f
            setPadding(48, 96, 48, 48)
        }
        setContentView(status)

        thread(start = true, name = "KokoroVarBench") {
            try { runBenchmark(variant, epName, benchText) { status.post { status.text = it } } }
            catch (t: Throwable) {
                Log.e(TAG, "benchmark threw", t)
                status.post { status.text = "ERROR: ${t.message}" }
            }
        }
    }

    private fun runBenchmark(variant: String, epName: String, text: String, onStatus: (String) -> Unit) {
        Log.i(TAG, "T_BENCH_START=${System.currentTimeMillis()} variant=$variant ep=$epName chars=${text.length}")

        // Copy model from assets to cache on first launch (assets aren't
        // memory-mappable for ORT — needs a real file).
        val modelFile = File(cacheDir, "$variant.onnx")
        if (!modelFile.exists() || modelFile.length() == 0L) {
            val t0 = System.currentTimeMillis()
            assets.open("$variant.onnx").use { input ->
                modelFile.outputStream().use { out -> input.copyTo(out) }
            }
            Log.i(TAG, "T_MODEL_COPY_DONE=${System.currentTimeMillis()} dt=${System.currentTimeMillis() - t0}ms size=${modelFile.length()}")
        } else {
            Log.i(TAG, "model already in cache: ${modelFile.length()}B")
        }

        // Build session with requested EP.
        val env = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions().apply {
            try {
                when (epName) {
                    "NNAPI" -> { addNnapi(); Log.i(TAG, "ep=NNAPI attached") }
                    "NNAPI_FP16" -> { addNnapi(EnumSet.of(NNAPIFlags.USE_FP16)); Log.i(TAG, "ep=NNAPI+USE_FP16 attached") }
                    "NNAPI_FP16_NO_CPU" -> { addNnapi(EnumSet.of(NNAPIFlags.USE_FP16, NNAPIFlags.CPU_DISABLED)); Log.i(TAG, "ep=NNAPI+USE_FP16+CPU_DISABLED attached") }
                    "XNNPACK" -> { addXnnpack(emptyMap()); Log.i(TAG, "ep=XNNPACK attached") }
                    else -> Log.i(TAG, "ep=CPU (default)")
                }
            } catch (t: Throwable) {
                Log.w(TAG, "EP attach failed: ${t.message}")
            }
            setIntraOpNumThreads(6)
        }
        val sessStart = System.currentTimeMillis()
        val sess = env.createSession(modelFile.absolutePath, opts)
        Log.i(TAG, "T_SESSION_READY=${System.currentTimeMillis()} dt=${System.currentTimeMillis() - sessStart}ms")

        // Use existing G2P (same one KokoroOnDeviceService uses).
        val g2p = KokoroG2P(applicationContext)
        g2p.prewarm()
        val tokens = g2p.tokenize(text)
        val style = g2p.voiceEmbedding("af_heart", tokens.size - 1)
        Log.i(TAG, "tokens=${tokens.size} style=${style.size}")

        // Warmup
        runInference(env, sess, intArrayOf(0, 1, 2, 0), style, 1.0f)
        Log.i(TAG, "T_WARMUP_DONE=${System.currentTimeMillis()}")

        // Real run
        val inferStart = System.currentTimeMillis()
        val audio = runInference(env, sess, tokens, style, 1.0f)
        val inferMs = System.currentTimeMillis() - inferStart
        val audioSeconds = audio.size.toDouble() / 24_000
        val rtf = inferMs / 1000.0 / audioSeconds
        Log.i(TAG, "T_INFER_DONE=${System.currentTimeMillis()} dt=${inferMs}ms audio=${audio.size}samples=${"%.2f".format(audioSeconds)}s rtf=${"%.3f".format(rtf)}x")

        onStatus(
            "variant=$variant ep=$epName\n" +
                    "Session: ${System.currentTimeMillis() - sessStart}ms\n" +
                    "Inference: ${inferMs}ms\n" +
                    "Audio: ${"%.2f".format(audioSeconds)}s @ 24kHz\n" +
                    "RTF: ${"%.3f".format(rtf)}x\n\n" +
                    "Playing…"
        )
        playPcm(audio, 24_000)
    }

    private fun runInference(env: OrtEnvironment, sess: OrtSession, tokens: IntArray, style: FloatArray, speed: Float): FloatArray {
        val tokenLongs = LongArray(tokens.size) { tokens[it].toLong() }
        val tokenTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(tokenLongs), longArrayOf(1, tokens.size.toLong()))
        val styleTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(style), longArrayOf(1, style.size.toLong()))
        val speedTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(floatArrayOf(speed)), longArrayOf(1))
        try {
            sess.run(mapOf("input_ids" to tokenTensor, "style" to styleTensor, "speed" to speedTensor)).use { res ->
                val raw = res.get(0).value
                @Suppress("UNCHECKED_CAST")
                return when (raw) {
                    is FloatArray -> raw
                    is Array<*> -> raw[0] as FloatArray
                    else -> throw IllegalStateException("unexpected audio type: ${raw?.javaClass}")
                }
            }
        } finally {
            tokenTensor.close(); styleTensor.close(); speedTensor.close()
        }
    }

    private fun playPcm(audio: FloatArray, sampleRate: Int) {
        val pcm = ShortArray(audio.size) { (audio[it] * 32767f).coerceIn(-32768f, 32767f).toInt().toShort() }
        val bytes = ByteArray(pcm.size * 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm)
        val minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack(AudioManager.STREAM_MUSIC, sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, bytes.size), AudioTrack.MODE_STATIC)
        track.write(bytes, 0, bytes.size)
        track.play()
        Thread.sleep((audio.size * 1000L / sampleRate) + 200)
        Log.i(TAG, "T_PLAY_DONE=${System.currentTimeMillis()}")
        track.release()
    }

    companion object { private const val TAG = "KokoroVarBench" }
}
