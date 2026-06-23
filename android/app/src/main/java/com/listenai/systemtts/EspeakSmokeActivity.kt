package com.listenai.systemtts

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView

/**
 * End-to-end eSpeak NG phonemizer smoke test.
 *
 * Loads libespeak-ng + bridge .so files, copies the English data
 * subset from APK assets to filesDir, calls `espeak_Initialize`,
 * selects en-us voice, phonemizes a small test corpus, and reports
 * the IPA output + per-call timings to logcat + on-screen.
 *
 * Pass criteria: all test phrases return non-empty IPA that looks
 * reasonable (e.g. "hello world" → "həlˈoʊ wˈɜːld").
 *
 * If this passes, the Piper integration path is fully validated and
 * we can wire up `PiperOnDeviceService` to use this bridge.
 *
 * Launch:
 *   adb shell am start -n com.listenai/.systemtts.EspeakSmokeActivity
 */
class EspeakSmokeActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val out = TextView(this).apply {
            textSize = 14f
            setPadding(48, 96, 48, 48)
        }
        setContentView(out)

        val lines = mutableListOf<String>()
        fun log(s: String) {
            Log.i(TAG, s)
            lines.add(s)
            out.text = lines.joinToString("\n")
        }

        log("Initializing…")
        val t0 = System.currentTimeMillis()
        val sr = EspeakBridge.ensureInitialized(applicationContext)
        val initMs = System.currentTimeMillis() - t0
        log("ensureInitialized → sampleRate=$sr in ${initMs}ms")
        if (sr <= 0) {
            log("INIT FAILED — bailing")
            return
        }

        val testCorpus = listOf(
            "hello world",
            "Wi-Fi",
            "Bluetooth",
            "Settings",
            "The quick brown fox jumps over the lazy dog.",
            "Quick settings expanded.",
        )
        for (text in testCorpus) {
            val t = System.currentTimeMillis()
            val ipa = EspeakBridge.phonemize(text)
            val dt = System.currentTimeMillis() - t
            log("[${dt}ms] '$text' → '$ipa'")
        }
        log("\nDONE. If 'hello world' shows 'həlˈoʊ wˈɜːld' or similar, full path works.")
    }

    companion object { private const val TAG = "EspeakSmoke" }
}
