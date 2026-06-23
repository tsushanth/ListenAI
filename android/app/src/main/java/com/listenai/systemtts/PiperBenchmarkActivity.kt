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
 * Pixel-side validation of the 2026-06-22 Piper spike.
 *
 * Loads en_US-amy-low.onnx (60MB Piper VITS model) + a pre-dumped
 * phoneme ID array (same 170-char benchmark text as KokoroOnDeviceTTS,
 * pre-phonemized on Mac via espeak-ng to skip the on-device phonemizer
 * dependency). Runs a single forward pass, measures wall-clock per
 * stage, then plays the output through AudioTrack.
 *
 * Files expected at /sdcard/Android/data/com.listenai/files/piper/:
 *   en_US-amy-low.onnx
 *   phoneme_ids.json   (text/ids/scales/sample_rate)
 *
 * Launch:
 *   adb shell am start -n com.listenai/.systemtts.PiperBenchmarkActivity
 *
 * Logs (filter with `adb logcat -s PiperBench:I`):
 *   T_LOAD_START
 *   T_SESSION_READY      session created
 *   T_WARMUP_DONE        warmup inference done (tiny synthetic, JITs kernels)
 *   T_INFER_DONE         real benchmark inference done
 *   T_PLAY_START         AudioTrack.play() called
 *   T_PLAY_DONE          last sample written
 *
 * Whole activity is throwaway — exists only to validate that Piper on
 * Pixel hardware is fast enough to justify the full integration work
 * (eSpeak NG NDK build, PiperOnDeviceService, voice catalog, routing
 * for short utterances). If inference is >1.5s here we kill the idea
 * cleanly; if <800ms we go.
 */
class PiperBenchmarkActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val status = TextView(this).apply {
            text = "Piper benchmark running… see `adb logcat -s PiperBench:I`"
            textSize = 16f
            setPadding(48, 96, 48, 48)
        }
        setContentView(status)

        thread(start = true, name = "PiperBench") {
            try {
                runBenchmark { status.post { status.text = it } }
            } catch (t: Throwable) {
                Log.e(TAG, "benchmark threw", t)
                status.post { status.text = "ERROR: ${t.message}" }
            }
        }
    }

    private fun runBenchmark(onStatus: (String) -> Unit) {
        // Throwaway-spike approach: model is bundled in APK assets and
        // copied to cache dir on first launch. (For real product use
        // it'd be downloaded via WorkManager like Kokoro.)
        val cacheRoot = File(cacheDir, "piper")
        cacheRoot.mkdirs()
        val modelFile = File(cacheRoot, "model.onnx")
        val idsFile = File(cacheRoot, "ids.json")
        if (!modelFile.exists() || modelFile.length() == 0L) {
            Log.i(TAG, "copying model from assets…")
            assets.open("piper/model.onnx").use { input ->
                modelFile.outputStream().use { out -> input.copyTo(out) }
            }
            Log.i(TAG, "model copied (${modelFile.length()} bytes)")
        }
        if (!idsFile.exists()) {
            assets.open("piper/ids.json").use { input ->
                idsFile.outputStream().use { out -> input.copyTo(out) }
            }
        }

        val payload = JSONObject(idsFile.readText())
        // Allow `--es ids "1,35,0,..."` to override the bundled ids for ad-hoc
        // short-utterance experiments without re-bundling the APK.
        val idsOverride = intent.getStringExtra("ids")
        val ids: LongArray = if (idsOverride != null) {
            idsOverride.split(",").map { it.trim().toLong() }.toLongArray()
        } else {
            val arr = payload.getJSONArray("ids")
            LongArray(arr.length()) { arr.getLong(it) }
        }
        val scalesArray = payload.getJSONArray("scales")
        val scales = FloatArray(scalesArray.length()) { scalesArray.getDouble(it).toFloat() }
        val sampleRate = payload.getInt("sample_rate")
        Log.i(TAG, "loaded ${ids.size} phoneme ids (override=${idsOverride != null}), sample_rate=$sampleRate")

        val loadStart = System.currentTimeMillis()
        Log.i(TAG, "T_LOAD_START=$loadStart")
        val env = OrtEnvironment.getEnvironment()
        val epName = intent.getStringExtra("ep") ?: "CPU"
        val opts = OrtSession.SessionOptions().apply {
            when (epName) {
                "NNAPI" -> {
                    try { addNnapi(); Log.i(TAG, "ep=NNAPI attached") }
                    catch (t: Throwable) { Log.w(TAG, "NNAPI unavailable: ${t.message}") }
                }
                "NNAPI_FP16" -> {
                    try {
                        addNnapi(java.util.EnumSet.of(ai.onnxruntime.providers.NNAPIFlags.USE_FP16))
                        Log.i(TAG, "ep=NNAPI+USE_FP16 attached")
                    } catch (t: Throwable) { Log.w(TAG, "NNAPI+FP16 unavailable: ${t.message}") }
                }
                "XNNPACK" -> {
                    try { addXnnpack(emptyMap()); Log.i(TAG, "ep=XNNPACK attached") }
                    catch (t: Throwable) { Log.w(TAG, "XNNPACK unavailable: ${t.message}") }
                }
                else -> Log.i(TAG, "ep=CPU (default)")
            }
            setIntraOpNumThreads(6)
        }
        val sess = env.createSession(modelFile.absolutePath, opts)
        val sessionReady = System.currentTimeMillis()
        Log.i(TAG, "T_SESSION_READY=$sessionReady dt=${sessionReady - loadStart}ms")

        // Warmup with a tiny realistic-ish shape (~10 ids) to JIT-compile
        // kernels before timing the real run.
        runInference(env, sess, longArrayOf(1, 0, 14, 0, 18, 0, 21, 0, 2), scales)
        val warmupDone = System.currentTimeMillis()
        Log.i(TAG, "T_WARMUP_DONE=$warmupDone dt=${warmupDone - sessionReady}ms")

        // Real timed inference
        val inferStart = System.currentTimeMillis()
        val audio = runInference(env, sess, ids, scales)
        val inferDone = System.currentTimeMillis()
        val inferMs = inferDone - inferStart
        val audioSeconds = audio.size.toDouble() / sampleRate
        val rtf = inferMs / 1000.0 / audioSeconds
        Log.i(TAG, "T_INFER_DONE=$inferDone dt=${inferMs}ms audio=${audio.size}samples=${"%.2f".format(audioSeconds)}s rtf=${"%.3f".format(rtf)}x")

        onStatus(
            "Piper benchmark done\n\n" +
                    "Phonemes: ${ids.size}\n" +
                    "Inference: ${inferMs}ms\n" +
                    "Audio: ${"%.2f".format(audioSeconds)}s @ ${sampleRate}Hz\n" +
                    "RTF: ${"%.3f".format(rtf)}x\n\n" +
                    "Playing through AudioTrack…"
        )

        // Play through AudioTrack so we can hear quality on device (scrcpy
        // can also capture it for spectrogram analysis).
        playPcm(audio, sampleRate)
    }

    private fun runInference(env: OrtEnvironment, sess: OrtSession, ids: LongArray, scales: FloatArray): FloatArray {
        val input = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), longArrayOf(1, ids.size.toLong()))
        val lengths = OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(ids.size.toLong())), longArrayOf(1))
        val scaleTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(scales), longArrayOf(scales.size.toLong()))
        try {
            sess.run(mapOf("input" to input, "input_lengths" to lengths, "scales" to scaleTensor)).use { res ->
                // Piper output is [1, 1, 1, samples] float — unwrap.
                val raw = res.get(0).value
                @Suppress("UNCHECKED_CAST")
                val a = raw as Array<Array<Array<FloatArray>>>
                return a[0][0][0]
            }
        } finally {
            input.close()
            lengths.close()
            scaleTensor.close()
        }
    }

    private fun playPcm(audio: FloatArray, sampleRate: Int) {
        val pcm = ShortArray(audio.size) { (audio[it] * 32767f).coerceIn(-32768f, 32767f).toInt().toShort() }
        val bytes = ByteArray(pcm.size * 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm)
        val minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack(
            AudioManager.STREAM_MUSIC,
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBuf, bytes.size),
            AudioTrack.MODE_STATIC,
        )
        val playStart = System.currentTimeMillis()
        Log.i(TAG, "T_PLAY_START=$playStart")
        track.write(bytes, 0, bytes.size)
        track.play()
        // Block until playback drains. STATIC mode doesn't move the play
        // head past notification frames the way STREAM does, but for a
        // throwaway benchmark sleeping the audio length is good enough.
        Thread.sleep((audio.size * 1000L / sampleRate) + 200)
        val playDone = System.currentTimeMillis()
        Log.i(TAG, "T_PLAY_DONE=$playDone dt=${playDone - playStart}ms")
        track.release()
    }

    companion object {
        private const val TAG = "PiperBench"
    }
}
