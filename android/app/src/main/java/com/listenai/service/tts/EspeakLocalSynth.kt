package com.listenai.service.tts

import android.content.Context
import com.listenai.systemtts.EspeakBridge
import com.listenai.systemtts.EspeakVoices
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/**
 * Renders a whole article with the bundled eSpeak NG voices, fully offline and with no cloud quota.
 * Used for articles whose detected language has no natural voice in the app.
 */
object EspeakLocalSynth {

    private const val MAX_CHUNK = 400

    /** The eSpeak voice for [language] (ISO-2, optionally "es-MX"), or null when we have none. */
    fun voiceFor(language: String?): EspeakVoices.Entry? {
        if (language.isNullOrBlank()) return null
        val tag = java.util.Locale.forLanguageTag(language)
        return EspeakVoices.forLocale(tag.language, tag.country.ifBlank { null })
    }

    /** True for a language the app can read with eSpeak and is not English (English keeps the normal voices). */
    fun shouldUse(language: String?): Boolean {
        val lang = language?.substringBefore('-')?.lowercase()
        return !lang.isNullOrBlank() && lang != "en" && voiceFor(lang) != null
    }

    fun synthesize(
        context: Context,
        text: String,
        language: String,
        speed: Float,
        onProgress: (Float) -> Unit = {}
    ): SynthesisResult {
        val started = System.currentTimeMillis()
        val entry = voiceFor(language) ?: throw TTSError.InvalidConfiguration("No offline voice for $language")
        val rate = EspeakBridge.ensureInitialized(context)
        if (rate <= 0) throw TTSError.InvalidConfiguration("Offline voice engine is unavailable")

        val rateWpm = EspeakVoices.rateToWpm((100 * speed).toInt())
        val chunks = splitForSynthesis(text)
        val pcm = ArrayList<ShortArray>(chunks.size)
        var samples = 0
        chunks.forEachIndexed { i, chunk ->
            EspeakBridge.synthesize(chunk, entry.espeakVoice, rateWpm)?.let {
                pcm += it
                samples += it.size
            }
            onProgress((i + 1).toFloat() / chunks.size)
        }
        if (samples == 0) throw TTSError.InvalidConfiguration("Offline voice produced no audio")

        val file = writeWav(context, pcm, samples, rate)
        return SynthesisResult(
            audioFile = file,
            duration = samples.toDouble() / rate,
            sectionTimestamps = emptyList(),
            fileSizeBytes = file.length(),
            metadata = SynthesisMetadata(
                voiceId = entry.id,
                voiceName = entry.displayName,
                provider = "espeak-ng",
                startedAt = started,
                completedAt = System.currentTimeMillis(),
                inputCharacterCount = text.length,
                outputSampleRate = rate
            )
        )
    }

    /** Sentence-aligned chunks of at most [MAX_CHUNK] characters, so a cancel or error loses little. */
    internal fun splitForSynthesis(text: String): List<String> {
        val out = ArrayList<String>()
        val sb = StringBuilder()
        fun flush() { if (sb.isNotBlank()) out += sb.toString().trim(); sb.clear() }
        for (sentence in text.split(Regex("(?<=[.!?।。！？])\\s+|\\n+"))) {
            val s = sentence.trim()
            if (s.isEmpty()) continue
            if (sb.length + s.length + 1 > MAX_CHUNK) flush()
            if (s.length > MAX_CHUNK) {
                s.chunked(MAX_CHUNK).forEach { sb.append(it); flush() }
            } else {
                if (sb.isNotEmpty()) sb.append(' ')
                sb.append(s)
            }
        }
        flush()
        return out
    }

    private fun writeWav(context: Context, parts: List<ShortArray>, samples: Int, rate: Int): File {
        val file = File(context.cacheDir, "espeak_${UUID.randomUUID()}.wav")
        val bytes = samples * 2
        RandomAccessFile(file, "rw").use { raf ->
            val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            h.put("RIFF".toByteArray()).putInt(36 + bytes).put("WAVE".toByteArray())
            h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
            h.putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
            h.put("data".toByteArray()).putInt(bytes)
            raf.write(h.array())
            for (p in parts) {
                val b = ByteBuffer.allocate(p.size * 2).order(ByteOrder.LITTLE_ENDIAN)
                p.forEach { b.putShort(it) }
                raf.write(b.array())
            }
        }
        return file
    }
}
