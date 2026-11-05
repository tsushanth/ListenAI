package com.listenai.systemtts

import android.app.Activity
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.widget.TextView
import com.listenai.service.tts.chain.ChainConfig
import com.listenai.service.tts.chain.ConnectivityCheck
import com.listenai.service.tts.chain.ReadAloudApiSource
import com.listenai.service.tts.chain.SourceId
import com.listenai.service.tts.chain.SystemTtsSource
import com.listenai.service.tts.chain.TtsChainProvider
import com.listenai.service.tts.chain.TtsRequest
import com.listenai.service.tts.chain.TtsSource
import com.listenai.service.tts.chain.TtsSourceChain
import com.listenai.service.tts.chain.TtsSourceFlags
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Debug-only benchmark of the speech sources on the same three paragraphs: time to first audio (TTFA) and
 * real-time factor (RTF = synthesis time / audio duration; below 1 is faster than playback).
 *
 *   adb shell am start -n <applicationId>/com.listenai.systemtts.TtsSourceBenchActivity -e run api,google,samsung,ondevice,engine,chain
 *
 * Optional: -z cold true (skip the warm-up pass), -e engineFlag on|off (engine run: API first or the engine's own path).
 * Results: logcat tag TTSBENCH (one JSON line per measurement, then TTSBENCH_DONE) and files/tts_bench.json.
 * Nothing here speaks aloud; audio is synthesized and discarded. Paragraph text is fixed public-domain-style filler.
 */
class TtsSourceBenchActivity : Activity() {

    private var variant = ""
    private val paragraphs get() = baseParagraphs.map { it + variant }

    private val baseParagraphs = listOf(
        "The quick brown fox jumps over the lazy dog near the quiet river bank. It was a calm morning, and the mist had not yet lifted from the valley. Somewhere far away a bell rang twice, and the village slowly began to wake.",
        "Reading aloud is one of the oldest ways to share a story. A good voice makes the words feel close, even when the listener is far away. Many people now listen while they walk, cook, or drive, and the pages turn themselves.",
        "In the afternoon the clouds gathered, and by evening a soft rain was falling on the roofs of the town. People hurried home with their umbrellas, and the streetlights came on one by one along the wet and shining road."
    )

    private val results = JSONArray()
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { text = "TTS source bench running..."; textSize = 14f; setPadding(48, 48, 48, 48) }
        setContentView(status)
        val run = (intent.getStringExtra("run") ?: "api,google,samsung,ondevice,engine,chain").split(',')
        val warmPass = !intent.getBooleanExtra("cold", false)
        val engineFlag = intent.getStringExtra("engineFlag")
        // Appended to every paragraph so a run can avoid (or force) chunk-cache hits.
        variant = intent.getStringExtra("variant") ?: ""
        thread(name = "tts-bench") {
            try {
                if ("api" in run) benchSource("api", TtsChainProvider.get(this).api, warmPass)
                if ("google" in run) benchSource("system:google", SystemTtsSource(this, { ConnectivityCheck.isOnline(this) }, "com.google.android.tts"), warmPass)
                if ("samsung" in run) benchSource("system:samsung", SystemTtsSource(this, { ConnectivityCheck.isOnline(this) }, "com.samsung.SMT"), warmPass)
                if ("ondevice" in run) benchOnDevice(warmPass)
                if ("engine" in run) benchEngine(engineFlag)
                if ("chain" in run) benchChain()
            } catch (t: Throwable) {
                Log.e(TAG, "bench failed", t)
                emit(JSONObject().put("error", t.toString()))
            }
            File(filesDir, "tts_bench.json").writeText(results.toString(2))
            Log.i(TAG, "TTSBENCH_DONE")
            runOnUiThread { status.text = "done"; finish() }
        }
    }

    private fun emit(o: JSONObject) {
        results.put(o)
        Log.i(TAG, "TTSBENCH $o")
    }

    /** One source on its own, paragraph by paragraph. Pass 1 is "first" (cold socket / engine init), pass 2 "warm". */
    private fun benchSource(name: String, src: TtsSource, warmPass: Boolean) {
        // Deadlines are the app's own, except for the on-device model where the point is to measure how slow it is.
        val cfg = if (src.id == SourceId.ON_DEVICE) ChainConfig(prefetch = 1, firstChunkBaseTimeoutMs = 120_000, chunkBaseTimeoutMs = 120_000) else ChainConfig()
        val chain = TtsSourceChain(mapOf(src.id to src), { listOf(src.id) }, cache = null, config = cfg)
        for (pass in (if (warmPass) listOf("first", "warm") else listOf("first"))) {
            paragraphs.forEachIndexed { i, text -> measureChain(name, pass, i + 1, text, chain) }
        }
    }

    private fun measureChain(name: String, pass: String, para: Int, text: String, chain: TtsSourceChain) {
        val t0 = System.nanoTime()
        var first = -1L
        var audioMs = 0L
        var chunks = 0
        var err: String? = null
        try {
            runBlocking {
                chain.speak(text, TtsRequest("bella", "en-US")).collect { c ->
                    if (first < 0) first = (System.nanoTime() - t0) / 1_000_000
                    audioMs += c.audio.durationMs
                    chunks++
                }
            }
        } catch (e: Throwable) { err = e.toString() }
        val total = (System.nanoTime() - t0) / 1_000_000
        emit(JSONObject().put("source", name).put("pass", pass).put("para", para).put("chars", text.length)
            .put("ttfa_ms", first).put("total_ms", total).put("audio_ms", audioMs).put("chunks", chunks)
            .put("rtf", if (audioMs > 0) total.toDouble() / audioMs else JSONObject.NULL).apply { if (err != null) put("error", err) })
    }

    private fun benchOnDevice(warmPass: Boolean) {
        getSharedPreferences("tts_chain_ondevice", MODE_PRIVATE).edit().clear().apply() // re-measure the verdict
        val od = TtsChainProvider.get(this).onDevice
        val reason = runBlocking { od.unavailableReason(TtsRequest("bella", "en-US")) }
        if (reason != null) { emit(JSONObject().put("source", "ondevice").put("unavailable", reason.name)); return }
        // Warm-up (session load) is its own measurement.
        benchSource("ondevice", od, warmPass)
        emit(JSONObject().put("source", "ondevice").put("verdict_prefs", getSharedPreferences("tts_chain_ondevice", MODE_PRIVATE).all.toString()))
    }

    /**
     * The ReadAloud engine itself, called the way another app does: a TextToSpeech client bound to our own engine package.
     * TTFA = speak() to the first audio buffer (onAudioAvailable); RTF from synthesizeToFile-less onDone timing.
     */
    private fun benchEngine(engineFlag: String?) {
        val saved = TtsSourceFlags.engineApiEnabled(this)
        if (engineFlag != null) TtsSourceFlags.setOverride(this, null, engineFlag == "on")
        val init = CountDownLatch(1)
        var ok = false
        val tts = TextToSpeech(this, { ok = it == TextToSpeech.SUCCESS; init.countDown() }, packageName)
        init.await(15, TimeUnit.SECONDS)
        if (!ok) { emit(JSONObject().put("source", "engine").put("error", "init failed")); return }
        tts.language = Locale.US
        for (pass in listOf("first", "warm")) paragraphs.forEachIndexed { i, text ->
            val utt = UUID.randomUUID().toString()
            val done = CountDownLatch(1)
            val t0 = System.nanoTime()
            var firstAudio = -1L
            var bytes = 0L
            var rate = 24000
            tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onBeginSynthesis(utteranceId: String?, sampleRateInHz: Int, audioFormat: Int, channelCount: Int) { rate = sampleRateInHz }
                override fun onAudioAvailable(utteranceId: String?, audio: ByteArray?) {
                    if (firstAudio < 0) firstAudio = (System.nanoTime() - t0) / 1_000_000
                    bytes += audio?.size ?: 0
                }
                override fun onDone(utteranceId: String?) { done.countDown() }
                @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) { done.countDown() }
            })
            val f = File(cacheDir, "bench_$utt.wav")
            tts.synthesizeToFile(text, null, f, utt)
            done.await(90, TimeUnit.SECONDS)
            val total = (System.nanoTime() - t0) / 1_000_000
            val audioMs = if (f.length() > 44) (f.length() - 44) * 1000 / (rate * 2) else 0
            f.delete()
            emit(JSONObject().put("source", "engine").put("engineApi", TtsSourceFlags.engineApiEnabled(this)).put("pass", pass).put("para", i + 1)
                .put("chars", text.length).put("ttfa_ms", firstAudio).put("total_ms", total).put("audio_ms", audioMs)
                .put("rtf", if (audioMs > 0) total.toDouble() / audioMs else JSONObject.NULL))
        }
        tts.shutdown()
        TtsSourceFlags.setOverride(this, null, null)
        Log.i(TAG, "engine api flag restored (was $saved)")
    }

    /** The real in-app chain with the flags as they are now; the per-read report lines are in logcat tag TTS_CHAIN. */
    private fun benchChain() {
        val holder = TtsChainProvider.get(this)
        paragraphs.forEachIndexed { i, text -> measureChain("chain(api=${TtsSourceFlags.apiEnabled(this)})", "run", i + 1, text, holder.inApp) }
    }

    companion object { private const val TAG = "TTSBENCH" }
}
