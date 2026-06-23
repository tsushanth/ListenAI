package com.listenai.service.tts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.util.UUID

/**
 * Kokoro 82M TTS running locally via ONNX Runtime.
 *
 * Architecture (mirrors the kokoro-onnx Python reference):
 * 1. Text → phonemes via [KokoroG2P] (CMUdict + LTS, ARPAbet → IPA-ish).
 * 2. Phonemes → token IDs via the vocab map bundled with the model.
 * 3. Run the ONNX model with three inputs:
 *    - `tokens`: int64 tensor `[1, seq_len]`
 *    - `style`: float32 tensor `[1, 256]` (voice embedding)
 *    - `speed`: float32 scalar
 * 4. Output is `audio`: float32 PCM at 24 kHz — pack into WAV.
 *
 * **Engine status**: scaffolded but **not verified against a real model
 * file**. Tensor names + shapes are based on the canonical kokoro-onnx
 * export; if the user's chosen build differs, [synthesize] will throw
 * and the runtime factory will fall back to cloud — the picker UX stays
 * honest because we never tell the user it worked.
 */
class KokoroOnDeviceService(private val context: Context) : TTSService {

    override val provider = VoiceProvider.KOKORO_ON_DEVICE
    override val maxTextLength = 50_000
    override val supportsStreaming = false
    override val supportsSSML = false

    private var session: OrtSession? = null
    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private val g2p by lazy { KokoroG2P(context) }
    private val activeTasks = mutableSetOf<UUID>()

    @Volatile private var nnapiAvailable: Boolean = false

    override suspend fun isAvailable(): Boolean = withContext(Dispatchers.IO) {
        try {
            ensureSession() != null
        } catch (e: Exception) {
            Log.w(TAG, "isAvailable: session init failed — ${e.message}")
            false
        }
    }

    /**
     * Cheap, non-suspend check used by [TTSServiceFactory] to decide
     * whether to route here vs cloud. Returns true only when the session
     * is loaded — model must already be on disk.
     */
    fun isInferenceReady(): Boolean {
        return session != null
    }

    private fun ensureSession(): OrtSession? {
        session?.let { return it }
        val modelFile = KokoroModelDownloader.getInstance(context).modelFile
        if (!modelFile.exists()) {
            Log.i(TAG, "ensureSession: model file not present yet at ${modelFile.absolutePath}")
            return null
        }
        return try {
            // Use as many CPU threads as the big cluster has. Pixel 9 Pro
            // has 2 perf + 6 big cores; default ONNX guess of 2 leaves
            // 4-6x headroom unused. We log the actual count so we can see
            // what we got per device.
            val availableCpus = Runtime.getRuntime().availableProcessors()
            val intraOpThreads = (availableCpus - 2).coerceIn(2, 8)
            val opts = OrtSession.SessionOptions().apply {
                // Try NNAPI first. Log success / failure so we know whether
                // the device is actually getting accelerated inference or
                // silently fell back to CPU.
                try {
                    addNnapi()
                    nnapiAvailable = true
                    Log.i(TAG, "ensureSession: NNAPI execution provider added")
                } catch (t: Throwable) {
                    nnapiAvailable = false
                    Log.w(TAG, "ensureSession: NNAPI EP unavailable, falling back to CPU — ${t.message}")
                }
                setIntraOpNumThreads(intraOpThreads)
            }
            Log.i(TAG, "ensureSession: availableProcessors=$availableCpus, intraOpThreads=$intraOpThreads")
            val createStart = System.currentTimeMillis()
            val s = env.createSession(modelFile.absolutePath, opts)
            Log.i(TAG, "ensureSession: createSession took ${System.currentTimeMillis() - createStart}ms")
            session = s
            // Pre-warm the G2P side too — at 126K entries the lexicon JSON
            // parse is ~200-500ms on a Pixel, and doing it lazily on first
            // synth would push that latency onto the user's first tap.
            // `prewarm()` triggers the lazy load and returns quickly.
            g2p.prewarm()
            s
        } catch (e: Exception) {
            Log.e(TAG, "ensureSession: createSession failed", e)
            null
        }
    }

    override suspend fun synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
    ): SynthesisResult = synthesizeInternal(text, voice, options, onProgress = {})

    /**
     * Internal chunked Kokoro synthesis with optional per-chunk progress
     * callback. Kept private so the two `synthesize` overrides above can
     * both delegate here and we own a single chunk-loop implementation.
     */
    private suspend fun synthesizeInternal(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        onProgress: (SynthesisProgress) -> Unit,
    ): SynthesisResult = withContext(Dispatchers.IO) {
        val taskId = UUID.randomUUID()
        activeTasks.add(taskId)
        try {
            val startMs = System.currentTimeMillis()
            // Kokoro's token context is ~500. Split long text into chunks
            // that fit, synth each, and concatenate the resulting PCM.
            val chunks = chunkTextForModel(text)
            Log.i(TAG, "synthesize: split ${text.length} chars into ${chunks.size} chunks")
            val totalChunks = chunks.size
            val pcmChunks = ArrayList<ShortArray>(totalChunks)
            var totalSamples = 0
            for ((i, chunk) in chunks.withIndex()) {
                if (!activeTasks.contains(taskId)) {
                    Log.i(TAG, "synthesize: task cancelled at chunk $i/$totalChunks")
                    break
                }
                Log.i(TAG, "synthesize: chunk ${i + 1}/$totalChunks (${chunk.length} chars)")
                // Emit before-inference progress so the UI moves as soon as
                // a chunk starts. Per-chunk latency on CPU can be 30+s and
                // the UI needs to show that something is happening.
                val charsBeforeChunk = chunks.subList(0, i).sumOf { it.length }
                val totalChars = chunks.sumOf { it.length }
                onProgress(
                    SynthesisProgress(
                        overallProgress = i.toFloat() / totalChunks,
                        currentSectionIndex = i,
                        sectionsCompleted = i,
                        totalSections = totalChunks,
                        statusMessage = "Generating audio (${i + 1}/$totalChunks)",
                        charactersProcessed = charsBeforeChunk,
                        totalCharacters = totalChars,
                    )
                )
                val chunkPcm = runInference(chunk, voice, options.speed)
                pcmChunks.add(chunkPcm)
                totalSamples += chunkPcm.size
                onProgress(
                    SynthesisProgress(
                        overallProgress = (i + 1).toFloat() / totalChunks,
                        currentSectionIndex = i,
                        sectionsCompleted = i + 1,
                        totalSections = totalChunks,
                        statusMessage = "Generating audio (${i + 1}/$totalChunks)",
                        charactersProcessed = charsBeforeChunk + chunk.length,
                        totalCharacters = totalChars,
                    )
                )
            }
            val pcm = ShortArray(totalSamples)
            var offset = 0
            for (c in pcmChunks) {
                System.arraycopy(c, 0, pcm, offset, c.size)
                offset += c.size
            }
            val outFile = writeWavToFile(pcm, sampleRate = 24_000)
            val duration = pcm.size.toDouble() / 24_000.0
            Log.i(TAG, "synthesize: complete — ${duration}s of audio in ${System.currentTimeMillis() - startMs}ms")
            SynthesisResult(
                audioFile = outFile,
                duration = duration,
                sectionTimestamps = listOf(
                    SectionTimestamp(sectionIndex = 0, startTime = 0.0, endTime = duration)
                ),
                fileSizeBytes = outFile.length(),
                metadata = SynthesisMetadata(
                    voiceId = voice.providerVoiceId ?: voice.id.toString(),
                    voiceName = voice.name,
                    provider = provider.displayName,
                    startedAt = startMs,
                    completedAt = System.currentTimeMillis(),
                    inputCharacterCount = text.length,
                    outputSampleRate = 24_000,
                ),
            )
        } finally {
            activeTasks.remove(taskId)
        }
    }

    /**
     * Break long text into pieces small enough to fit Kokoro's ~500-token
     * context. We prefer to split on sentence boundaries; if a single
     * sentence overflows, we further split on commas, then by hard
     * character cap as a final fallback.
     *
     * The character cap (`CHUNK_CHAR_CAP`) is intentionally conservative —
     * worse to break mid-clause than to overflow the model and lose the
     * tail of a sentence.
     */
    private fun chunkTextForModel(text: String, charCap: Int = CHUNK_CHAR_CAP): List<String> {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return emptyList()
        val sentences = SENTENCE_SPLIT.split(trimmed).map { it.trim() }.filter { it.isNotEmpty() }
        val chunks = ArrayList<String>()
        val current = StringBuilder()
        fun flushCurrent() {
            if (current.isNotEmpty()) {
                chunks.add(current.toString().trim())
                current.clear()
            }
        }
        for (s in sentences) {
            // Sentence itself too long? Split further by comma or hard cap.
            val pieces = if (s.length > charCap) splitOverlongSentence(s, charCap) else listOf(s)
            for (piece in pieces) {
                val pieceLen = piece.length
                if (current.length + pieceLen + 1 > charCap) {
                    flushCurrent()
                }
                if (current.isNotEmpty()) current.append(' ')
                current.append(piece)
            }
        }
        flushCurrent()
        return chunks
    }

    private fun splitOverlongSentence(s: String, charCap: Int = CHUNK_CHAR_CAP): List<String> {
        val byComma = s.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        val out = ArrayList<String>()
        val cur = StringBuilder()
        for (part in byComma) {
            if (cur.length + part.length + 2 > charCap) {
                if (cur.isNotEmpty()) {
                    out.add(cur.toString().trim())
                    cur.clear()
                }
                if (part.length > charCap) {
                    // Truly pathological — hard cap.
                    var i = 0
                    while (i < part.length) {
                        val end = minOf(i + charCap, part.length)
                        out.add(part.substring(i, end))
                        i = end
                    }
                    continue
                }
            }
            if (cur.isNotEmpty()) cur.append(", ")
            cur.append(part)
        }
        if (cur.isNotEmpty()) out.add(cur.toString().trim())
        return out
    }

    override suspend fun synthesize(
        sections: List<TextSection>,
        voice: VoicePreset,
        options: SynthesisOptions,
        onProgress: (SynthesisProgress) -> Unit,
    ): SynthesisResult {
        val text = sections.joinToString(" ") { it.text }
        return synthesizeInternal(text, voice, options, onProgress)
    }

    override fun synthesizeStreaming(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
    ): Flow<AudioChunk> = flow {
        // No mid-utterance streaming for v1 — we synth the whole thing then
        // emit one chunk.
        val result = synthesize(text, voice, options)
        emit(
            AudioChunk(
                data = result.audioFile.readBytes(),
                timestamp = 0.0,
                isFinal = true,
                chunkIndex = 0,
            )
        )
    }

    /**
     * Chunk-by-chunk synthesis that pushes 16-bit PCM directly to a
     * caller-supplied sink — no WAV header, no disk round-trip.
     *
     * Why this exists: the system TTS path (TalkBack, Maps, Kindle) doesn't
     * need a file on disk — it owns its own AudioTrack and just wants raw
     * PCM frames as fast as we can produce them. The old path here was
     * "synthesize all chunks → write WAV to disk → read it back → stream
     * to callback", which serialized every chunk behind the slowest one
     * and added 50-150ms of disk round-trip on top.
     *
     * For long input (book paragraphs, N chunks), the user now hears audio
     * after the FIRST chunk completes instead of after the LAST. Per the
     * 2026-06-22 dev-device telemetry, single-chunk Kokoro inference is
     * ~1.9s p50 / ~6.6s p95 on Pixel 9 Pro, so cutting the
     * wait-for-everything pattern is the largest UX lever we have without
     * touching the model itself.
     *
     * For single-chunk input (typical TalkBack utterance), this still
     * saves the ~50-100ms disk round-trip but won't move the needle on
     * Warren's "several seconds before TalkBack speaks" — that needs the
     * sess.run fix (NNAPI/XNNPACK debugging) next session.
     *
     * @param onChunk receives `(pcm, sampleRate)` for each chunk in order.
     *   Return `false` to stop synthesis (e.g., the framework signaled
     *   stop). Synthesis aborts cleanly without writing further chunks.
     * @return true if all chunks completed, false if cancelled.
     */
    suspend fun synthesizeChunkedPcm(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        onChunk: (ShortArray, Int) -> Boolean,
    ): Boolean = withContext(Dispatchers.IO) {
        val taskId = UUID.randomUUID()
        activeTasks.add(taskId)
        try {
            val startMs = System.currentTimeMillis()
            // Use a smaller cap for the streaming path — first audio reaches
            // the ear after only one chunk of compute, so making chunks
            // smaller directly cuts first-audio latency. Trade-off is more
            // total compute due to per-call fixed overhead, but the system
            // TTS path optimizes for time-to-first-audio over total time.
            val chunks = chunkTextForModel(text, charCap = STREAMING_CHUNK_CHAR_CAP)
            Log.i(TAG, "synthesizeChunkedPcm: split ${text.length} chars into ${chunks.size} chunks (cap=$STREAMING_CHUNK_CHAR_CAP)")
            for ((i, chunk) in chunks.withIndex()) {
                if (!activeTasks.contains(taskId)) {
                    Log.i(TAG, "synthesizeChunkedPcm: task cancelled at chunk $i/${chunks.size}")
                    return@withContext false
                }
                val chunkStart = System.currentTimeMillis()
                val pcm = runInference(chunk, voice, options.speed)
                val chunkMs = System.currentTimeMillis() - chunkStart
                Log.i(TAG, "synthesizeChunkedPcm: chunk ${i + 1}/${chunks.size} (${chunk.length} chars) → ${pcm.size} samples in ${chunkMs}ms")
                if (pcm.isNotEmpty()) {
                    val keepGoing = onChunk(pcm, 24_000)
                    if (!keepGoing) {
                        Log.i(TAG, "synthesizeChunkedPcm: sink signalled stop after chunk ${i + 1}")
                        return@withContext false
                    }
                }
            }
            Log.i(TAG, "synthesizeChunkedPcm: all ${chunks.size} chunks done in ${System.currentTimeMillis() - startMs}ms")
            true
        } finally {
            activeTasks.remove(taskId)
        }
    }

    override suspend fun cancelSynthesis(taskId: UUID) {
        activeTasks.remove(taskId)
    }

    override suspend fun cancelAllSynthesis() {
        activeTasks.clear()
    }

    override suspend fun isVoiceAvailable(voice: VoicePreset): Boolean = isAvailable()

    override suspend fun availableVoices(): List<VoicePreset> {
        // For v1, expose the same Kokoro voice presets the cloud worker
        // exposes — the model file ships with the matching embeddings.
        return emptyList() // TODO: surface the bundled voice list once embeddings are bundled
    }

    override suspend fun downloadVoice(voice: VoicePreset) {
        // Voice embeddings ship with the model file — no per-voice download.
    }

    override fun estimate(text: String, voice: VoicePreset): SynthesisEstimate {
        // ~50 chars/sec synth rate is a reasonable mid-range Android guess
        // for INT8 Kokoro. Real numbers come from on-device profiling.
        return SynthesisEstimate(
            estimatedDuration = text.length.toDouble() / 150.0,
            estimatedProcessingTime = text.length.toDouble() / 50.0,
            characterCount = text.length,
            estimatedCostUSD = 0.0,
            quotaImpact = null,
        )
    }

    // ---- Inference internals ------------------------------------------------

    private fun runInference(text: String, voice: VoicePreset, speed: Float): ShortArray {
        val callStartMs = System.currentTimeMillis()
        // Detect cold-start BEFORE ensureSession() materializes the session
        // — once it's loaded the next call won't pay createSession cost.
        val wasCold = session == null
        val sess = ensureSession()
            ?: throw IllegalStateException("Kokoro model not loaded — callers should check isInferenceReady()")

        // 1. Text → token IDs (G2P + tokenizer)
        val tokenizeStartMs = System.currentTimeMillis()
        val tokens = g2p.tokenize(text)
        val tokenizeMs = System.currentTimeMillis() - tokenizeStartMs
        if (tokens.isEmpty()) {
            return ShortArray(0)
        }
        Log.i(TAG, "runInference: tokens.size=${tokens.size} speed=$speed text.len=${text.length}")

        // 2. Voice embedding (256-dim fp32) — kokoro-onnx indexes the voice
        // pack by `len(tokens) - 1`, i.e. leading $ + phonemes, excluding
        // the trailing $. Picking the wrong slice produces silence or noise.
        val embeddingStartMs = System.currentTimeMillis()
        val phonemeCount = tokens.size - 1
        val styleVec = g2p.voiceEmbedding(voice.providerVoiceId ?: "af_heart", phonemeCount)
        val embeddingMs = System.currentTimeMillis() - embeddingStartMs

        // 3. Build tensors. The kokoro-onnx export uses these input names;
        // if the user's specific model variant differs we throw and fall
        // back to cloud at the factory level.
        val tokenTensor = OnnxTensor.createTensor(
            env,
            LongBuffer.wrap(tokens.map { it.toLong() }.toLongArray()),
            longArrayOf(1, tokens.size.toLong()),
        )
        val styleTensor = OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(styleVec),
            longArrayOf(1, styleVec.size.toLong()),
        )
        val speedTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(floatArrayOf(speed)), longArrayOf(1))

        // Input names from the kokoro-onnx export: `input_ids`, `style`,
        // `speed` (observed empirically: 1.20 onnx-community export uses
        // `input_ids` rather than the `tokens` name some other variants use).
        val inputs = mapOf(
            "input_ids" to tokenTensor,
            "style" to styleTensor,
            "speed" to speedTensor,
        )

        try {
            val sessRunStartMs = System.currentTimeMillis()
            sess.run(inputs).use { result ->
                val sessRunMs = System.currentTimeMillis() - sessRunStartMs
                Log.i(TAG, "runInference: sess.run completed in ${sessRunMs}ms, outputs=${result.size()}")
                val audioTensor = result.get(0)
                val raw = when (val v = audioTensor.value) {
                    is FloatArray -> v
                    is Array<*> -> {
                        // Some exports return `[1, samples]` rather than a flat
                        // float array; unwrap one batch dim if so.
                        @Suppress("UNCHECKED_CAST")
                        (v[0] as FloatArray)
                    }
                    else -> throw IllegalStateException("Unexpected audio tensor type: ${v?.javaClass}")
                }
                Log.i(TAG, "runInference: audio samples=${raw.size} (~${"%.2f".format(raw.size / 24_000.0)}s)")
                // Convert FP32 [-1.0, 1.0] PCM → Int16 PCM.
                val wavPackStartMs = System.currentTimeMillis()
                val out = ShortArray(raw.size)
                for (i in raw.indices) {
                    val v = (raw[i] * 32_767f).coerceIn(-32_768f, 32_767f)
                    out[i] = v.toInt().toShort()
                }
                val wavPackMs = System.currentTimeMillis() - wavPackStartMs
                LatencyTelemetry.record(
                    LatencyTelemetry.Sample(
                        timestamp = callStartMs,
                        chars = text.length,
                        tokens = tokens.size,
                        tokenizeMs = tokenizeMs,
                        embeddingMs = embeddingMs,
                        sessRunMs = sessRunMs,
                        wavPackMs = wavPackMs,
                        totalMs = System.currentTimeMillis() - callStartMs,
                        audioMs = (raw.size * 1000L) / 24_000L,
                        nnapiAvailable = nnapiAvailable,
                        coldStart = wasCold,
                    )
                )
                return out
            }
        } finally {
            tokenTensor.close()
            styleTensor.close()
            speedTensor.close()
        }
    }

    private fun writeWavToFile(pcm: ShortArray, sampleRate: Int): File {
        val outFile = File.createTempFile("kokoro_", ".wav", context.cacheDir)
        val byteBuffer = ByteArrayOutputStream()
        val numSamples = pcm.size
        val dataSize = numSamples * 2

        // RIFF/WAVE header — 44 bytes
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray())
            putInt(36 + dataSize)
            put("WAVE".toByteArray())
            put("fmt ".toByteArray())
            putInt(16)             // PCM fmt chunk size
            putShort(1.toShort())  // PCM format
            putShort(1.toShort())  // mono
            putInt(sampleRate)
            putInt(sampleRate * 2) // byte rate
            putShort(2.toShort())  // block align
            putShort(16.toShort()) // bits/sample
            put("data".toByteArray())
            putInt(dataSize)
        }.array()
        byteBuffer.write(header)

        val pcmBytes = ByteBuffer.allocate(dataSize).order(ByteOrder.LITTLE_ENDIAN)
        pcm.forEach { pcmBytes.putShort(it) }
        byteBuffer.write(pcmBytes.array())

        FileOutputStream(outFile).use { it.write(byteBuffer.toByteArray()) }
        return outFile
    }

    companion object {
        private const val TAG = "KokoroOnDeviceTTS"

        // Conservative char cap per chunk. Kokoro's hard limit is ~500
        // tokens; English averages ~1.2 tokens/char with our crude G2P, so
        // 350 chars keeps us comfortably under the limit even on
        // phoneme-dense passages.
        private const val CHUNK_CHAR_CAP = 350

        // System TTS streaming path uses a much smaller cap so the FIRST
        // audio reaches the ear after only one chunk of compute. 2026-06-22
        // benchmark: a single 170-char chunk took 23.9s on Pixel 9 Pro;
        // splitting into ~6 chunks of ~30 chars each is expected to bring
        // first-audio under 5s. Trade-off: more total compute due to
        // per-chunk fixed overhead — but for TalkBack / Maps / Kindle the
        // user-perceived latency is what matters.
        private const val STREAMING_CHUNK_CHAR_CAP = 60

        private val SENTENCE_SPLIT = Regex("(?<=[.!?])\\s+")

        // Approximate on-disk download size for the Kokoro ONNX bundle.
        // Used by the onboarding screen and Settings to set user
        // expectations before the download fires. Matches iOS's
        // KokoroModelManager.estimatedDownloadBytes for cross-platform
        // consistency.
        const val ESTIMATED_DOWNLOAD_BYTES: Long = 250L * 1024L * 1024L

        // Minimum supported Android SDK for on-device Kokoro inference.
        // ONNX Runtime 1.22 requires API 26+, and the OOM headroom for
        // the 82M ONNX model gets uncomfortable below ~3 GB total RAM.
        private const val MIN_SDK_FOR_ONDEVICE = 26
        private const val MIN_TOTAL_RAM_BYTES: Long = 3L * 1024L * 1024L * 1024L

        /**
         * Whether this device can reasonably run Kokoro on-device. Used to
         * gate the Settings "Offline AI" row: ineligible devices see the
         * toggle disabled with an explanatory subtitle, so we don't burn
         * the user's data on a 250 MB download that won't actually run.
         *
         * Mirrors `KokoroModelManager.isDeviceEligible` on iOS.
         */
        fun isDeviceEligible(context: Context): Boolean {
            if (android.os.Build.VERSION.SDK_INT < MIN_SDK_FOR_ONDEVICE) return false
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
                ?: return true
            val info = android.app.ActivityManager.MemoryInfo()
            am.getMemoryInfo(info)
            return info.totalMem >= MIN_TOTAL_RAM_BYTES
        }
    }
}
