package com.listenai.service.tts

import android.content.Context
import com.listenai.data.models.VoicePreset
import com.listenai.service.tts.chain.NoSourceAvailableException
import com.listenai.service.tts.chain.Pcm
import com.listenai.service.tts.chain.SourceId
import com.listenai.service.tts.chain.TimedWord
import com.listenai.service.tts.chain.TtsChainProvider
import com.listenai.service.tts.chain.TtsRequest
import com.listenai.service.tts.chain.UserAction
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.Dispatchers
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

/**
 * Runs the source chain and writes the result as one WAV file, which is the contract the reader and the job tracker
 * already use (a file on disk plus its duration). Audio is appended to the file as chunks arrive, not held in memory.
 * Word timings from the API's alignment worker, when present, are saved in the same sidecar the reader loads.
 */
object ChainSynthesizer {

    suspend fun synthesize(
        context: Context,
        text: String,
        voice: VoicePreset,
        language: String,
        speed: Float,
        onProgress: (SynthesisProgress) -> Unit,
    ): SynthesisResult {
        val started = System.currentTimeMillis()
        val chain = TtsChainProvider.get(context).inApp
        val request = TtsRequest(voiceId = voice.id, language = language, speed = speed, wantWords = true)
        val file = File(context.cacheDir, "tts_${UUID.randomUUID()}.wav")

        var rate = 0
        var pcmBytes = 0L
        var sourceUsed: SourceId? = null
        val words = ArrayList<WordTimings.Word>()
        val spoken = StringBuilder()
        var charsDone = 0
        val total = text.length

        try {
            RandomAccessFile(file, "rw").use { raf ->
                raf.write(ByteArray(44)) // header, patched at the end
                // Chunk text is not kept by the chain, so rebuild the spoken text from the same splitter for word offsets.
                val pieces = com.listenai.service.tts.chain.TextChunker.split(text, 280, 140)
                chain.speak(text, request).flowOn(Dispatchers.IO).collect { c ->
                    if (rate == 0) rate = c.audio.sampleRate
                    raf.write(c.audio.pcm)
                    c.audio.words?.let { ws -> addWords(words, ws, spoken.length + (if (spoken.isEmpty()) 0 else 1), pcmBytes, rate) }
                    val piece = pieces.getOrNull(c.index).orEmpty()
                    if (spoken.isNotEmpty()) spoken.append(' ')
                    spoken.append(piece)
                    pcmBytes += c.audio.pcm.size
                    sourceUsed = sourceUsed ?: c.source
                    charsDone += c.chars
                    onProgress(
                        SynthesisProgress.INITIAL.copy(
                            overallProgress = (charsDone.toFloat() / total.coerceAtLeast(1)).coerceAtMost(0.99f),
                            sectionsCompleted = c.index + 1,
                            totalSections = c.total,
                            statusMessage = "Generating audio...",
                            charactersProcessed = charsDone,
                            totalCharacters = total,
                        )
                    )
                }
                if (pcmBytes == 0L) throw TTSError.AudioEncodingFailed("no audio produced")
                raf.seek(0)
                raf.write(Pcm.toWav(ByteArray(0), rate).copyOf(44).also {
                    putLe32(it, 4, (36 + pcmBytes).toInt()); putLe32(it, 40, pcmBytes.toInt())
                })
            }
        } catch (e: NoSourceAvailableException) {
            file.delete()
            throw speechUnavailable(e)
        } catch (e: Throwable) {
            file.delete()
            throw e
        }

        if (words.isNotEmpty()) WordTimings(spoken.toString(), words).let { WordTimings.save(file, it) }
        val durationSec = pcmBytes / 2.0 / rate
        val ended = System.currentTimeMillis()
        val providerLabel = "ReadAloud ${sourceUsed?.name ?: "chain"}"
        return SynthesisResult(
            audioFile = file,
            duration = durationSec,
            sectionTimestamps = listOf(SectionTimestamp(0, 0.0, durationSec)),
            wordTimestamps = null,
            fileSizeBytes = file.length(),
            cost = SynthesisCost(charactersUsed = text.length, costUSD = 0.0, quotaUsed = text.length, provider = providerLabel),
            metadata = SynthesisMetadata(
                voiceId = voice.id, voiceName = voice.name, provider = providerLabel,
                startedAt = started, completedAt = ended, inputCharacterCount = text.length, outputSampleRate = rate,
            ),
        )
    }

    /** Chunk-relative word offsets become offsets into the spoken text, and chunk-relative seconds become absolute. */
    private fun addWords(out: MutableList<WordTimings.Word>, ws: List<TimedWord>, textOffset: Int, pcmBytesBefore: Long, rate: Int) {
        val t0 = pcmBytesBefore / 2.0 / rate
        for (w in ws) out += WordTimings.Word(textOffset + w.startChar, textOffset + w.endChar, t0 + w.start, t0 + w.end)
    }

    private fun putLe32(b: ByteArray, o: Int, v: Int) {
        b[o] = v.toByte(); b[o + 1] = (v shr 8).toByte(); b[o + 2] = (v shr 16).toByte(); b[o + 3] = (v shr 24).toByte()
    }

    internal fun speechUnavailable(e: NoSourceAvailableException): TTSError.SpeechUnavailable = when (val a = e.action) {
        is UserAction.InstallVoiceData -> TTSError.SpeechUnavailable(
            "This device has no offline voice data for this language. Install it to listen without a connection.", installVoiceLanguage = a.language)
        UserAction.InstallEngine -> TTSError.SpeechUnavailable(
            "No text-to-speech engine is installed on this device. Install Speech Services by Google to listen offline.", installEngine = true)
        UserAction.CheckConnection -> TTSError.SpeechUnavailable("You are offline and this device has no offline voice ready. Connect to the internet and try again.")
        UserAction.TryLater -> TTSError.SpeechUnavailable("The voice service is busy right now. Please try again in a moment.")
    }
}
