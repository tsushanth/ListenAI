package com.listenai.systemtts

import android.app.Activity
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.text.SpannableString
import android.text.Spanned
import android.text.style.TtsSpan
import android.util.Log
import android.widget.TextView
import java.io.File
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Debug-only self-test of the system TTS engine, run through the public [TextToSpeech] client API: the
 * same path TalkBack, Maps and Kindle use. Each case synthesizes to a file (silent, no speaker) and checks
 * the language is accepted, synthesis finishes, and the audio is real (long enough and not silence).
 *
 * Launch: adb shell am start -n <applicationId>/com.listenai.systemtts.EngineSelfTestActivity
 * Results: adb logcat -s EngineTest:I   (one ENGINE_TEST line per case, then ENGINE_TEST_DONE)
 */
class EngineSelfTestActivity : Activity() {

    private var tts: TextToSpeech? = null
    private lateinit var status: TextView

    private class Case(
        val id: String,
        val tag: String,
        val text: CharSequence,
        val rate: Float = 1f,
        val voiceName: String? = null,
        /** True when the language is deliberately unsupported: pass means the engine says so. */
        val expectUnsupported: Boolean = false,
        val minDurMs: Int = 300,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { text = "TTS engine self-test running..."; textSize = 14f; setPadding(48, 48, 48, 48) }
        setContentView(status)
        tts = TextToSpeech(this, { rc ->
            if (rc != TextToSpeech.SUCCESS) {
                Log.e(TAG, "ENGINE_TEST_DONE init failed rc=$rc")
                return@TextToSpeech
            }
            thread(name = "EngineSelfTest") { runAll() }
        }, packageName)
    }

    private fun cases(): List<Case> {
        val en = "en-US"
        val hello = "Hello, this is a test of the speech engine."
        val list = mutableListOf(
            Case("en-default", en, hello),
            Case("en-espeak", en, hello, voiceName = "readaloud-espeak-en-us"),
            Case("en-espeak-3x", en, hello, rate = 3f, voiceName = "readaloud-espeak-en-us", minDurMs = 200),
            Case("en-espeak-6x", en, hello, rate = 6f, voiceName = "readaloud-espeak-en-us", minDurMs = 150),
            Case("en-letter-a", en, "a", minDurMs = 100),
            Case("en-symbol-dot", en, ".", minDurMs = 100),
            Case("en-ssml", en, "<speak>Hello <break time=\"300ms\"/> world</speak>", voiceName = "readaloud-espeak-en-us"),
            Case("en-span-verbatim", en, SpannableString("ab12").apply {
                setSpan(TtsSpan.VerbatimBuilder("ab12").build(), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }, voiceName = "readaloud-espeak-en-us"),
            Case("en-span-phone", en, SpannableString("5551234567").apply {
                setSpan(TtsSpan.TelephoneBuilder("5551234567").build(), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }, voiceName = "readaloud-espeak-en-us"),
            Case("en-long", en, "The lighthouse keeper climbed the spiral stairs every evening at dusk. He lit the great lamp, " +
                "wound the clockwork, and watched the ships pass in the dark. It was a quiet life, and he loved it."),
        )
        val langs = listOf(
            "es-ES" to "Hola, esto es una prueba de voz.", "es-MX" to "Hola, esto es una prueba de voz.",
            "fr-FR" to "Bonjour, ceci est un test vocal.", "de-DE" to "Hallo, das ist ein Sprachtest.",
            "it-IT" to "Ciao, questo è un test vocale.", "pt-BR" to "Olá, este é um teste de voz.",
            "ja-JP" to "こんにちは、これは音声テストです。", "ko-KR" to "안녕하세요, 음성 테스트입니다.",
            "zh-CN" to "你好，这是一个语音测试。", "hi-IN" to "नमस्ते, यह एक आवाज़ परीक्षण है।",
            "ar" to "مرحبا، هذا اختبار صوتي.", "nl-NL" to "Hallo, dit is een spraaktest.",
            "pl-PL" to "Cześć, to jest test głosu.", "tr-TR" to "Merhaba, bu bir ses testidir.",
            "sv-SE" to "Hej, det här är ett rösttest.", "ta-IN" to "வணக்கம், இது ஒரு குரல் சோதனை.",
            "vi-VN" to "Xin chào, đây là bài kiểm tra giọng nói.", "th-TH" to "สวัสดี นี่คือการทดสอบเสียง",
            "he-IL" to "שלום, זהו מבחן קול.", "id-ID" to "Halo, ini adalah tes suara.",
            "sw-KE" to "Habari, huu ni mtihani wa sauti.", "el-GR" to "Γεια σας, αυτό είναι ένα τεστ φωνής.",
            "uk-UA" to "Привіт, це тест голосу.",
        )
        for ((tag, text) in langs) list += Case("lang-$tag", tag, text)
        list += Case("lang-ru-unsupported", "ru-RU", "Привет", expectUnsupported = true)
        return list
    }

    private fun runAll() {
        val engine = tts ?: return
        val voices = runCatching { engine.voices?.map { it.name } ?: emptyList() }.getOrDefault(emptyList())
        Log.i(TAG, "ENGINE_INFO engine=$packageName voices=${voices.size} espeakVoices=${voices.count { it.startsWith(EspeakVoices.PREFIX) }}")
        var passed = 0
        var failed = 0
        for (case in cases()) {
            val result = runCase(engine, case)
            if (result) passed++ else failed++
        }
        Log.i(TAG, "ENGINE_TEST_DONE passed=$passed failed=$failed")
        runOnUiThread { status.text = "Done: $passed passed, $failed failed. See logcat -s EngineTest:I" ; window.decorView.postDelayed({ finish() }, 1500) }
    }

    private fun runCase(engine: TextToSpeech, case: Case): Boolean {
        val locale = Locale.forLanguageTag(case.tag)
        val avail = engine.isLanguageAvailable(locale)
        if (case.expectUnsupported) {
            val ok = avail < TextToSpeech.LANG_AVAILABLE
            Log.i(TAG, "ENGINE_TEST id=${case.id} lang=${case.tag} avail=$avail expectUnsupported ok=$ok")
            return ok
        }
        val setRc = engine.setLanguage(locale)
        if (case.voiceName != null) {
            engine.voices?.firstOrNull { it.name == case.voiceName }?.let { engine.voice = it }
        }
        engine.setSpeechRate(case.rate)

        val file = File(cacheDir, "enginetest-${case.id}.wav")
        file.delete()
        val done = CountDownLatch(1)
        var error = false
        var firstAudioAt = 0L
        var ranges = 0
        val startAt = System.currentTimeMillis()
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onAudioAvailable(utteranceId: String?, audio: ByteArray?) {
                if (firstAudioAt == 0L) firstAudioAt = System.currentTimeMillis()
            }
            override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) { ranges++ }
            override fun onDone(utteranceId: String?) { done.countDown() }
            @Suppress("OverridingDeprecatedMember")
            override fun onError(utteranceId: String?) { error = true; done.countDown() }
            override fun onError(utteranceId: String?, errorCode: Int) { error = true; done.countDown() }
        })
        val rc = engine.synthesizeToFile(case.text, Bundle(), file, case.id)
        val finished = rc == TextToSpeech.SUCCESS && done.await(40, TimeUnit.SECONDS)
        val totalMs = System.currentTimeMillis() - startAt
        val (durMs, rms) = analyse(file)
        val ok = finished && !error && durMs >= case.minDurMs && rms >= 100.0
        Log.i(TAG, "ENGINE_TEST id=${case.id} lang=${case.tag} avail=$avail set=$setRc voice=${engine.voice?.name} rate=${case.rate} " +
            "total_ms=$totalMs first_audio_ms=${if (firstAudioAt > 0) firstAudioAt - startAt else -1} dur_ms=$durMs rms=${"%.0f".format(rms)} ranges=$ranges error=$error ok=$ok")
        file.delete()
        return ok
    }

    /** Duration (ms) and RMS of a 16-bit PCM WAV file written by the framework. */
    private fun analyse(file: File): Pair<Int, Double> {
        if (!file.exists() || file.length() <= 44) return 0 to 0.0
        val bytes = file.readBytes()
        val sampleRate = (bytes[24].toInt() and 0xff) or ((bytes[25].toInt() and 0xff) shl 8) or
            ((bytes[26].toInt() and 0xff) shl 16) or ((bytes[27].toInt() and 0xff) shl 24)
        val samples = (bytes.size - 44) / 2
        if (samples <= 0 || sampleRate <= 0) return 0 to 0.0
        var sum = 0.0
        var i = 44
        while (i + 1 < bytes.size) {
            val v = ((bytes[i + 1].toInt() shl 8) or (bytes[i].toInt() and 0xff)).toShort().toInt()
            sum += v.toDouble() * v
            i += 2
        }
        return (samples * 1000L / sampleRate).toInt() to sqrt(sum / samples)
    }

    override fun onDestroy() {
        super.onDestroy()
        tts?.stop()
        tts?.shutdown()
        tts = null
    }

    companion object { private const val TAG = "EngineTest" }
}
