package com.listenai.systemtts

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView

/**
 * Minimal smoke test for the eSpeak NG Android prebuilt .so files
 * (from HeyLetsLearnSomething, dated 2026-02-17). Validates ABI
 * compatibility with our AGP 8.x + minSdk 26 toolchain BEFORE
 * committing to the full Piper integration tomorrow.
 *
 * Does NOT phonemize anything yet — just loads the .so + its
 * `libc++_shared` dependency and reports success/failure to logcat.
 * If both libraries load without `UnsatisfiedLinkError`, the
 * integration path is real and tomorrow's work is JNI bridge +
 * espeak-ng-data assets.
 *
 * Launch:
 *   adb shell am start -n com.listenai/.systemtts.EspeakSmokeActivity
 *
 * Filter logs: `adb logcat -s EspeakSmoke:I EspeakSmoke:E`
 */
class EspeakSmokeActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val out = TextView(this).apply {
            textSize = 16f
            setPadding(48, 96, 48, 48)
        }
        setContentView(out)

        val lines = mutableListOf<String>()
        fun log(s: String) {
            Log.i(TAG, s)
            lines.add(s)
            out.text = lines.joinToString("\n")
        }
        fun logE(s: String, t: Throwable) {
            Log.e(TAG, s, t)
            lines.add("$s — ${t.javaClass.simpleName}: ${t.message}")
            out.text = lines.joinToString("\n")
        }

        log("EspeakSmoke starting…")
        try {
            val t0 = System.currentTimeMillis()
            System.loadLibrary("c++_shared")
            log("loaded libc++_shared in ${System.currentTimeMillis() - t0}ms")
        } catch (t: Throwable) {
            logE("libc++_shared FAILED to load", t)
            return
        }
        try {
            val t0 = System.currentTimeMillis()
            System.loadLibrary("espeak-ng")
            log("loaded libespeak-ng in ${System.currentTimeMillis() - t0}ms")
        } catch (t: Throwable) {
            logE("libespeak-ng FAILED to load", t)
            return
        }
        log("SMOKE TEST PASSED — both libraries loaded clean")
        log("next step (tomorrow): JNI bridge + espeak-ng-data assets")
    }

    companion object { private const val TAG = "EspeakSmoke" }
}
