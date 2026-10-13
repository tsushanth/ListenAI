package com.listenai.systemtts

import android.app.Activity
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.widget.TextView

/**
 * Headless-friendly benchmark for the system TTS path.
 *
 * Launch:
 *   adb shell am start -n com.listenai/.systemtts.BenchmarkActivity \
 *     --es text "your benchmark text here"
 *
 * Wires the Android TextToSpeech client API to our engine
 * (com.listenai) and logs precise millisecond timestamps for every
 * stage so the synthesis can be cross-referenced against an audio
 * recording from scrcpy --audio-source=playback to derive
 * speak()-to-first-audible-sound latency.
 *
 * Tagged logs (filter with `adb logcat -s TTSBench:I`):
 *   T_ACTIVITY_START      activity onCreate (clock start)
 *   T_TTS_INIT_DONE       client TextToSpeech ready
 *   T_SPEAK_CALL          tts.speak() invoked
 *   T_UTTERANCE_START     framework callback — synthesis began
 *   T_UTTERANCE_DONE      framework callback — synthesis + playback finished
 *   T_UTTERANCE_ERROR     framework callback — error
 *
 * Combined with the service-side log `T_FIRST_AUDIO_PUSH` in
 * ReadAloudTTSService, the full timeline of a single benchmark run is
 * recoverable from logcat alone.
 */
class BenchmarkActivity : Activity() {

    private var tts: TextToSpeech? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val benchText = intent.getStringExtra("text") ?: DEFAULT_TEXT
        val rate = intent.getFloatExtra("rate", 1.0f)
        // Allow caller to switch the Kokoro execution provider for this
        // benchmark run via `--es ep NNAPI_FP16` (etc). KokoroOnDeviceService
        // reads this pref inside ensureSession, so callers also need to
        // force-stop the app first so the session re-creates with the new EP.
        intent.getStringExtra("ep")?.let { epName ->
            getSharedPreferences("kokoro_ep", MODE_PRIVATE).edit().putString("ep", epName).apply()
            Log.i(TAG, "Set kokoro_ep.ep=$epName")
        }

        val status = TextView(this).apply {
            text = "Benchmark running…\nText (${benchText.length} chars):\n$benchText"
            textSize = 14f
            setPadding(48, 48, 48, 48)
        }
        setContentView(status)

        Log.i(TAG, "T_ACTIVITY_START=${System.currentTimeMillis()} chars=${benchText.length}")

        tts = TextToSpeech(this, { initStatus ->
            if (initStatus != TextToSpeech.SUCCESS) {
                Log.e(TAG, "TTS init failed: status=$initStatus")
                status.text = "TTS init failed: status=$initStatus"
                finishDelayed()
                return@TextToSpeech
            }
            Log.i(TAG, "T_TTS_INIT_DONE=${System.currentTimeMillis()} engine=${tts?.defaultEngine}")
            tts?.setSpeechRate(rate)
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    Log.i(TAG, "T_UTTERANCE_START=${System.currentTimeMillis()} id=$utteranceId")
                }
                override fun onDone(utteranceId: String?) {
                    Log.i(TAG, "T_UTTERANCE_DONE=${System.currentTimeMillis()} id=$utteranceId")
                    runOnUiThread {
                        status.text = "$benchText\n\n— done. See logcat -s TTSBench:I ReadAloudTTSService:I"
                    }
                    // Samsung framework-cache verification: if --es voice2
                    // is set, mutate SettingsManager mid-session and call
                    // speak() again on the SAME TTS client (same framework
                    // cache). This is the exact shape of the real bug:
                    // a long-lived TalkBack client whose cached voice goes
                    // stale because the framework doesn't re-query us when
                    // SettingsManager changes. The voiceResolved log on the
                    // second utterance proves whether our settingsPick
                    // override actually wins over the stale framework cache.
                    val voice2 = intent.getStringExtra("voice2")
                    val text2 = intent.getStringExtra("text2") ?: benchText
                    if (!voice2.isNullOrBlank() && utteranceId?.endsWith("-2") != true) {
                        Log.i(TAG, "T_VOICE_SWAP swap_to=$voice2")
                        com.listenai.service.settings.SettingsManager
                            .getInstance(applicationContext)
                            .setSelectedVoiceId(voice2)
                        val id2 = "bench-${System.currentTimeMillis()}-2"
                        Log.i(TAG, "T_SPEAK_CALL_2=${System.currentTimeMillis()} id=$id2")
                        tts?.speak(text2, TextToSpeech.QUEUE_ADD, null, id2)
                        return
                    }
                    finishDelayed()
                }
                @Suppress("OverridingDeprecatedMember")
                override fun onError(utteranceId: String?) {
                    Log.e(TAG, "T_UTTERANCE_ERROR=${System.currentTimeMillis()} id=$utteranceId")
                    finishDelayed()
                }
                override fun onError(utteranceId: String?, errorCode: Int) {
                    Log.e(TAG, "T_UTTERANCE_ERROR=${System.currentTimeMillis()} id=$utteranceId code=$errorCode")
                    finishDelayed()
                }
            })
            val utteranceId = "bench-${System.currentTimeMillis()}"
            val speakAt = System.currentTimeMillis()
            Log.i(TAG, "T_SPEAK_CALL=$speakAt id=$utteranceId")
            val speakRc = tts?.speak(benchText, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
            Log.i(TAG, "speak() returned $speakRc")
        }, ENGINE_PACKAGE)
    }

    private fun finishDelayed() {
        // Hold for 1.5s after onDone so the activity is still visible if a
        // human is watching, but auto-closes for scripted runs.
        window.decorView.postDelayed({ if (!isFinishing) finish() }, 1_500)
    }

    override fun onDestroy() {
        super.onDestroy()
        tts?.stop()
        tts?.shutdown()
        tts = null
    }

    companion object {
        private const val TAG = "TTSBench"
        // BuildConfig.APPLICATION_ID resolves to whichever flavor we're
        // running in (com.listenai for reader, com.listenai.voice for
        // standalone). Hardcoding "com.listenai" breaks under the voice
        // flavor when the reader isn't installed.
        private val ENGINE_PACKAGE = com.listenai.BuildConfig.APPLICATION_ID

        // Three sentences — should split into 2-3 chunks given the current
        // CHUNK_CHAR_CAP, exposing the streaming win. The text is
        // deliberately bland (no proper nouns or numbers) so G2P timing
        // is consistent run-to-run.
        private const val DEFAULT_TEXT =
            "The quick brown fox jumps over the lazy dog. " +
                    "Speech synthesis turns written words into spoken audio. " +
                    "This benchmark measures how quickly the first sound reaches your ear."
    }
}
