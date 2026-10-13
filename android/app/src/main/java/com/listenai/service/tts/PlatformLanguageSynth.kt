package com.listenai.service.tts

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume

/**
 * Reads an article in its own language through the phone's installed text-to-speech engine
 * (Android TextToSpeech API), fully offline when the engine has that language's voice data.
 * The app talks to the engine only through the public API, so it stays independent of whichever
 * engine the user has chosen, including the separate ReadAloud Voice app.
 */
object PlatformLanguageSynth {

    private const val INIT_TIMEOUT_MS = 5_000L
    private const val CHUNK_TIMEOUT_MS = 60_000L

    /** Sentence-aligned pieces no longer than [max] characters. */
    internal fun splitText(text: String, max: Int): List<String> {
        val out = ArrayList<String>()
        val sb = StringBuilder()
        fun flush() { if (sb.isNotBlank()) out += sb.toString().trim(); sb.clear() }
        for (sentence in text.split(Regex("(?<=[.!?।。！？])\\s+|\\n+"))) {
            val s = sentence.trim()
            if (s.isEmpty()) continue
            if (sb.length + s.length + 1 > max) flush()
            if (s.length > max) {
                s.chunked(max).forEach { sb.append(it); flush() }
            } else {
                if (sb.isNotEmpty()) sb.append(' ')
                sb.append(s)
            }
        }
        flush()
        return out
    }

    /**
     * Joins the PCM payloads of several 16-bit WAV files into one WAV. Returns null if any input is
     * not a PCM WAV. Header sizes are read from each file, not assumed to be 44 bytes.
     */
    internal fun concatWavs(files: List<File>, out: File): Pair<Int, Int>? {
        var rate = 0
        val pcm = ByteArrayOutputStream()
        for (f in files) {
            val b = f.readBytes()
            val fmt = findChunk(b, "fmt ") ?: return null
            val data = findChunk(b, "data") ?: return null
            val r = le32(b, fmt.first + 4)
            if (le16(b, fmt.first) != 1 || le16(b, fmt.first + 2) != 1 || le16(b, fmt.first + 14) != 16) return null
            if (rate == 0) rate = r else if (rate != r) return null
            pcm.write(b, data.first, data.second)
        }
        if (rate == 0) return null
        val bytes = pcm.toByteArray()
        out.outputStream().use { o ->
            fun w32(v: Int) { o.write(byteArrayOf(v.toByte(), (v shr 8).toByte(), (v shr 16).toByte(), (v shr 24).toByte())) }
            fun w16(v: Int) { o.write(byteArrayOf(v.toByte(), (v shr 8).toByte())) }
            o.write("RIFF".toByteArray()); w32(36 + bytes.size); o.write("WAVE".toByteArray())
            o.write("fmt ".toByteArray()); w32(16); w16(1); w16(1); w32(rate); w32(rate * 2); w16(2); w16(16)
            o.write("data".toByteArray()); w32(bytes.size); o.write(bytes)
        }
        return rate to bytes.size / 2
    }

    /** (offset, length) of a RIFF chunk's payload. */
    private fun findChunk(b: ByteArray, id: String): Pair<Int, Int>? {
        var p = 12
        while (p + 8 <= b.size) {
            val name = String(b, p, 4, Charsets.US_ASCII)
            val len = le32(b, p + 4)
            if (name == id) return (p + 8) to minOf(len, b.size - p - 8)
            p += 8 + len + (len and 1)
        }
        return null
    }

    private fun le16(b: ByteArray, o: Int) = (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8)
    private fun le32(b: ByteArray, o: Int) = le16(b, o) or (le16(b, o + 2) shl 16)

    private suspend fun initEngine(context: Context): TextToSpeech? = withTimeoutOrNull(INIT_TIMEOUT_MS) {
        suspendCancellableCoroutine { cont ->
            var engine: TextToSpeech? = null
            engine = TextToSpeech(context.applicationContext) { status ->
                if (cont.isActive) cont.resume(if (status == TextToSpeech.SUCCESS) engine else null)
            }
            cont.invokeOnCancellation { engine?.shutdown() }
        }
    }

    /** True when the installed engine can speak [language] with voice data already on the device. */
    suspend fun supports(context: Context, language: String): Boolean {
        val engine = initEngine(context) ?: return false
        return try {
            engine.isLanguageAvailable(Locale.forLanguageTag(language)) >= TextToSpeech.LANG_AVAILABLE &&
                engine.voices?.any { it.locale.language == Locale.forLanguageTag(language).language && !it.features.contains("notInstalled") } == true
        } finally {
            engine.shutdown()
        }
    }

    /** Returns null when the engine cannot speak the language or produces no audio. */
    suspend fun synthesize(
        context: Context,
        text: String,
        language: String,
        speed: Float,
        onProgress: (Float) -> Unit = {}
    ): SynthesisResult? {
        val started = System.currentTimeMillis()
        val engine = initEngine(context) ?: return null
        val parts = ArrayList<File>()
        try {
            val locale = Locale.forLanguageTag(language)
            if (engine.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) return null
            engine.setSpeechRate(speed.coerceIn(0.5f, 3.0f))
            val chunks = splitText(text, (TextToSpeech.getMaxSpeechInputLength() - 100).coerceIn(200, 3000))
            if (chunks.isEmpty()) return null
            chunks.forEachIndexed { i, chunk ->
                val file = File(context.cacheDir, "lang_${UUID.randomUUID()}.wav")
                val ok = withTimeoutOrNull(CHUNK_TIMEOUT_MS) { speakToFile(engine, chunk, file) } == true
                if (!ok || file.length() < 100) { file.delete(); return null }
                parts += file
                onProgress((i + 1).toFloat() / chunks.size)
            }
            val out = File(context.cacheDir, "lang_${UUID.randomUUID()}.wav")
            val (rate, samples) = concatWavs(parts, out) ?: return null
            return SynthesisResult(
                audioFile = out,
                duration = samples.toDouble() / rate,
                sectionTimestamps = emptyList(),
                fileSizeBytes = out.length(),
                metadata = SynthesisMetadata(
                    voiceId = "platform-$language",
                    voiceName = "System voice ($language)",
                    provider = "android-tts",
                    startedAt = started,
                    completedAt = System.currentTimeMillis(),
                    inputCharacterCount = text.length,
                    outputSampleRate = rate
                )
            )
        } finally {
            parts.forEach { it.delete() }
            engine.shutdown()
        }
    }

    private suspend fun speakToFile(engine: TextToSpeech, text: String, file: File): Boolean =
        suspendCancellableCoroutine { cont ->
            val id = UUID.randomUUID().toString()
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) { if (utteranceId == id && cont.isActive) cont.resume(true) }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) { if (utteranceId == id && cont.isActive) cont.resume(false) }
            })
            val rc = engine.synthesizeToFile(text, null, file, id)
            if (rc != TextToSpeech.SUCCESS && cont.isActive) cont.resume(false)
            cont.invokeOnCancellation { engine.stop() }
        }
}
