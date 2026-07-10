package com.listenai.service.tts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.io.File
import java.util.UUID

/**
 * On-device Chatterbox synthesis for cloned voices.
 *
 * Mirrors the shape of [KokoroOnDeviceService] so the same routing patterns
 * used by [TTSServiceFactory] and our system TTS engine ([com.listenai
 * .systemtts.ReadAloudTTSService]) work without special-casing.
 *
 * ## What ships in this skeleton (2026-06-13)
 *
 * - The interface (TTSService) + service singleton lifecycle
 * - ONNX session lifecycle scaffolding (lazy load, dispose on close)
 * - Per-voice embedding cache + on-disk persistence
 * - Model-disk gate that integrates with [ChatterboxModelDownloader]
 *
 * ## What is explicitly NOT implemented yet (the 3-4 week sprint)
 *
 * Each TODO(M2.6-N) marks one of the inference subtasks. Filling them in
 * gives us on-device cloned voices in TalkBack, Maps, Kindle, etc.
 *
 *   TODO(M2.6-1)  Load `language_model_q4.onnx` (350 MB Q4-quantized LM)
 *   TODO(M2.6-2)  Load `s3_token.onnx` (text→speech-token converter)
 *   TODO(M2.6-3)  Load `voice_encoder.onnx` (audio sample→256-dim embedding)
 *   TODO(M2.6-4)  Load `vocoder.onnx` (speech tokens→24 kHz PCM)
 *   TODO(M2.6-5)  Run S3 tokenizer + LM autoregression for text
 *   TODO(M2.6-6)  Run vocoder, write WAV
 *   TODO(M2.6-7)  Embedding extraction at clone-creation time
 *   TODO(M2.6-8)  Memory pressure + NNAPI fallback + battery profile
 *
 * References:
 *   - https://huggingface.co/onnx-community/chatterbox-ONNX  (official ONNX)
 *   - https://github.com/resemble-ai/chatterbox/issues/437   (mobile guidance)
 *   - "Chinny" iOS app for the existing on-device precedent
 */
class ChatterboxOnDeviceService private constructor(
    private val context: Context,
) : TTSService {

    private val tag = "ChatterboxOnDeviceService"

    override val provider = VoiceProvider.SELF_HOSTED
    override val maxTextLength = 50_000
    override val supportsStreaming = false
    override val supportsSSML = false

    // Active synthesis IDs for cancellation tracking — mirrors Kokoro pattern.
    private val activeTasks = mutableSetOf<UUID>()

    // ------------------------------------------------------------------
    // ONNX session lifecycle. All four sessions are lazy-loaded on first
    // synthesize() call to keep cold-start cheap.
    // ------------------------------------------------------------------

    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }

    /** ~350 MB Q4-quantized Llama-3.2-1B backbone. Autoregressive token gen. */
    private var languageModelSession: OrtSession? = null

    /** Text → speech-token encoder (S3). */
    private var tokenSession: OrtSession? = null

    /** Voice encoder — audio sample → 256-dim speaker embedding. */
    private var voiceEncoderSession: OrtSession? = null

    /** Vocoder — speech tokens → 24 kHz PCM. */
    private var vocoderSession: OrtSession? = null

    /** BPE tokenizer loaded from `tokenizer.json` on first synthesis. */
    @Volatile
    private var tokenizer: ChatterboxBpeTokenizer? = null

    // ------------------------------------------------------------------
    // Embedding cache. One 256-dim fp32 vector per cloned voice. Stored on
    // disk so re-cloning isn't required after app restart.
    // ------------------------------------------------------------------

    private val embeddingCache = mutableMapOf<String, FloatArray>()

    private val embeddingsDir: File
        get() = File(context.filesDir, "chatterbox/embeddings").apply { mkdirs() }

    // ------------------------------------------------------------------
    // TTSService overrides
    // ------------------------------------------------------------------

    override suspend fun isAvailable(): Boolean {
        // True when the model bundle is on disk AND we can load the LM
        // session. Lazy-loads on first call.
        val downloader = ChatterboxModelDownloader.getInstance(context)
        if (!downloader.isReady()) return false
        return ensureSessions()
    }

    /** Cheap, non-suspend check parallel to [KokoroOnDeviceService.isInferenceReady]. */
    fun isInferenceReady(): Boolean {
        return languageModelSession != null && vocoderSession != null
    }

    override suspend fun synthesize(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
    ): SynthesisResult {
        return synthesizeInternal(text, voice, options) {}
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

    override fun estimate(text: String, voice: VoicePreset): SynthesisEstimate {
        // Empirical numbers from Chinny on iPhone 15 Pro extrapolated to
        // Pixel 9 Pro. Will need to recalibrate after first real synthesis.
        // Roughly 1-3x real-time on NPU; 5-10x real-time on CPU.
        val audioSeconds = text.length / 15.0
        return SynthesisEstimate(
            estimatedDuration = audioSeconds,
            estimatedProcessingTime = audioSeconds * 2.0,  // 2x real-time
            characterCount = text.length,
        )
    }

    override suspend fun cancelSynthesis(taskId: UUID) {
        activeTasks.remove(taskId)
    }

    override suspend fun cancelAllSynthesis() {
        activeTasks.clear()
    }

    override suspend fun isVoiceAvailable(voice: VoicePreset): Boolean {
        // Available when:
        //  - models are on disk, AND
        //  - an embedding is cached on disk for this voice
        val voiceId = voice.providerVoiceId ?: voice.id
        return ChatterboxModelDownloader.getInstance(context).isReady() &&
            (embeddingCache.containsKey(voiceId) ||
                File(embeddingsDir, "$voiceId.bin").exists())
    }

    override suspend fun availableVoices(): List<VoicePreset> {
        // We don't author voices ourselves — the VoiceCloningService /
        // VoiceCatalog own that list. Return empty; callers can ask the
        // catalog directly.
        return emptyList()
    }

    override suspend fun downloadVoice(voice: VoicePreset) {
        // Pull the speaker embedding for this cloned voice onto disk so
        // the next synthesize() call can use it. Three-step:
        //   1. Locate the source audio (the user's original sample)
        //   2. Decode to 16 kHz mono PCM
        //   3. Run speech_encoder.onnx to produce a 256-dim embedding
        //   4. Persist via storeEmbedding()
        val voiceId = voice.providerVoiceId ?: voice.id
        if (embeddingCache.containsKey(voiceId) ||
            File(embeddingsDir, "$voiceId.bin").exists()
        ) {
            Log.i(tag, "downloadVoice: embedding for $voiceId already on disk")
            return
        }
        if (!ensureSessions()) {
            Log.w(tag, "downloadVoice: ONNX sessions not loaded; cannot extract embedding")
            return
        }

        // Step 1 — locate the audio file. VoiceCloningService is the source
        // of truth for user-recorded samples; it handles the auth + signed
        // URL flow that backend storage requires.
        val cloningService = com.listenai.service.voice.VoiceCloningService.getInstance(context)
        val audioFile: File = try {
            cloningService.downloadPreviewAudio(voiceId)
        } catch (t: Throwable) {
            Log.w(tag, "downloadVoice: audio download failed for $voiceId — ${t.message}")
            return
        }

        // Steps 2-3 — decode to mono PCM at 16 kHz (the typical speaker-
        // encoder rate). AudioDecoder uses MediaExtractor + MediaCodec so
        // it handles M4A / MP3 / AAC / WAV / OPUS uniformly.
        val pcm = AudioDecoder.decodeToMonoPcm(audioFile, targetSampleRate = 16_000)
        if (pcm == null || pcm.isEmpty()) {
            Log.w(tag, "downloadVoice: audio decode failed for $voiceId")
            return
        }
        val floatPcm = AudioDecoder.pcmToFloat(pcm)
        Log.i(tag, "downloadVoice: decoded ${pcm.size} samples (${floatPcm.size / 16000f}s) for $voiceId")

        // Step 4 — run speech_encoder.onnx to produce the 256-dim embedding.
        //
        // TODO(M2.6-7): the speech_encoder export's exact input/output
        // tensor names need verification. Common patterns:
        //
        //   Path A — raw audio in, embedding out:
        //     inputs:  "input_features" or "audio" : [1, samples]  fp32
        //              "attention_mask"            : [1, samples]  int64 (all 1s)
        //     output:  "embeddings" / "pooler_output" : [1, 256] fp32
        //
        //   Path B — pre-computed mel spectrogram in:
        //     inputs:  "input_features" : [1, n_mels=80, frames] fp32
        //     output:  "embeddings"     : [1, 256] fp32
        //
        // For Path B we'd need to compute the mel-spectrogram here using
        // the same FFT/n_mels/window/hop_length as the chatterbox
        // ChatterboxFeatureExtractor on the server. Until that's verified
        // this remains the last TODO before clones synthesize on-device.
        //
        // val encoder = voiceEncoderSession!!
        // val audioTensor = OnnxTensor.createTensor(
        //     env, FloatBuffer.wrap(floatPcm), longArrayOf(1, floatPcm.size.toLong())
        // )
        // try {
        //     val out = encoder.run(mapOf("input_features" to audioTensor))
        //     val embedding = out[0].value as Array<FloatArray>
        //     storeEmbedding(voiceId, embedding[0])
        //     Log.i(tag, "downloadVoice: embedding stored for $voiceId")
        // } finally {
        //     audioTensor.close()
        // }
        Log.w(tag, "downloadVoice: PCM ready (${floatPcm.size} samples); ONNX speech_encoder pass still TODO (M2.6-7)")
    }

    // ------------------------------------------------------------------
    // The synthesis pipeline (stubbed — see TODOs above)
    // ------------------------------------------------------------------

    private suspend fun synthesizeInternal(
        text: String,
        voice: VoicePreset,
        options: SynthesisOptions,
        onProgress: (SynthesisProgress) -> Unit,
    ): SynthesisResult {
        val taskId = UUID.randomUUID()
        activeTasks.add(taskId)
        try {
            // Gate 1: model files on disk
            val downloader = ChatterboxModelDownloader.getInstance(context)
            if (!downloader.isReady()) {
                throw TTSError.VoiceDownloadRequired(
                    voiceName = voice.name,
                    sizeBytes = ChatterboxModelDownloader.TOTAL_DOWNLOAD_BYTES,
                )
            }

            // Gate 2: small ONNX sessions loaded (embed_tokens + LM)
            if (!ensureSessions()) {
                throw TTSError.InvalidConfiguration(
                    "Chatterbox small ONNX sessions could not be loaded"
                )
            }
            // Gate 2b: big sessions loaded (conditional_decoder + speech_encoder).
            // Lazy on first synthesise() because they hang ORT for minutes
            // when loaded at warmup. We pay the cost once here on the IO
            // dispatcher.
            synchronized(sessionLoadLock) {
                if (vocoderSession == null || voiceEncoderSession == null) {
                    val availableCpus = Runtime.getRuntime().availableProcessors()
                    val intraOpThreads = (availableCpus - 2).coerceIn(2, 8)
                    val opts = OrtSession.SessionOptions().apply {
                        setIntraOpNumThreads(intraOpThreads)
                    }
                    if (!ensureBigSessionsLocked(opts)) {
                        throw TTSError.InvalidConfiguration(
                            "Chatterbox big ONNX sessions could not be loaded"
                        )
                    }
                }
            }

            // (No separate embedding cache gate — the speech_encoder ONNX
            // is run on every synthesize() against the user's reference
            // audio file, which gives us the 4 speaker tensors directly.
            // The on-disk `chatterbox/embeddings/*.bin` cache is a future
            // optimisation; not required for correctness.)

            Log.i(tag, "synthesize: voice=${voice.name} chars=${text.length}")

            // Pipeline mirrors the Python reference inference exactly:
            //   1. Load the user's reference audio at 24 kHz mono float
            //   2. ChatterboxAutoregress: tokenize text → speech_encoder
            //      runs once → embed_tokens → concat speaker prefix → LM loop
            //      with KV cache → speech tokens
            //   3. Prepend prompt_token to speech tokens
            //   4. ChatterboxDecoder: speech tokens + speaker tensors → 24 kHz PCM
            val audioFile = locateReferenceAudio(voice)
                ?: throw TTSError.VoiceNotAvailable(voice.name)
            val pcm16k = AudioDecoder.decodeToMonoPcm(audioFile, targetSampleRate = ChatterboxConfig.AUDIO_SAMPLE_RATE)
                ?: throw TTSError.InvalidConfiguration("Couldn't decode reference audio for ${voice.name}")
            val audioFloat = AudioDecoder.pcmToFloat(pcm16k)

            val onnxEnv = env
            val tk = tokenizer ?: synchronized(this) {
                tokenizer ?: run {
                    val tkFile = ChatterboxModelDownloader.getInstance(context).tokenizerFile
                    val loaded = ChatterboxBpeTokenizer.loadFromFile(tkFile)
                    tokenizer = loaded
                    loaded
                }
            }

            // Persistent speaker-tensor cache. Skip the (huge) speech_encoder
            // pass when we've already computed it for this voice + audio
            // sample. Invalidated on audio mtime change.
            val cache = SpeakerCache.getInstance(context)
            val voiceId = voice.providerVoiceId ?: voice.id
            val mtime = audioFile.lastModified()
            val cached = cache.load(onnxEnv, voiceId, mtime)

            val speechEncoder = ChatterboxSpeechEncoder(onnxEnv, voiceEncoderSession!!)
            val autoregress = ChatterboxAutoregress(
                env = onnxEnv,
                embedTokens = tokenSession!!,
                languageModel = languageModelSession!!,
                speechEncoder = speechEncoder,
                tokenizer = tk,
                cachedSpeaker = cached,
            )
            val gen = autoregress.generate(text, audioFloat, exaggeration = ChatterboxConfig.DEFAULT_EXAGGERATION)
            // Save the speaker tensors on the FIRST run for this voice so
            // subsequent calls skip the speech_encoder entirely.
            if (cached == null) {
                cache.store(voiceId, mtime, SpeakerConditioning(
                    condEmb = autoregress.lastCondEmb!!,
                    promptToken = gen.promptToken,
                    refXVector = gen.refXVector,
                    promptFeat = gen.promptFeat,
                ))
            }
            Log.i(tag, "synthesize: LM emitted ${gen.speechTokensCore.size} speech tokens")

            // Build the full speech-token sequence: prompt_token + generated.
            val fullTokens = buildSpeechTokensTensor(onnxEnv, gen.promptToken, gen.speechTokensCore)
            val decoder = ChatterboxDecoder(onnxEnv, vocoderSession!!)
            val pcm = try {
                decoder.decode(fullTokens, gen.refXVector, gen.promptFeat)
            } finally {
                runCatching { fullTokens.close() }
                gen.close()
            }

            val outFile = writeWavToFile(pcm, sampleRate = ChatterboxConfig.AUDIO_SAMPLE_RATE)
            val duration = pcm.size.toDouble() / ChatterboxConfig.AUDIO_SAMPLE_RATE.toDouble()
            return SynthesisResult(
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
                    startedAt = System.currentTimeMillis(),
                    completedAt = System.currentTimeMillis(),
                    inputCharacterCount = text.length,
                    outputSampleRate = ChatterboxConfig.AUDIO_SAMPLE_RATE,
                ),
            )
        } finally {
            activeTasks.remove(taskId)
        }
    }

    /**
     * Find the reference audio for this voice on disk. For cloned voices,
     * that's whatever VoiceCloningService previously downloaded; for the
     * default voice, fall back to the bundled `default_voice.wav` that
     * the model downloader puts on disk.
     */
    private fun locateReferenceAudio(voice: VoicePreset): File? {
        val voiceId = voice.providerVoiceId ?: voice.id
        // VoiceCloningService.downloadPreviewAudio(...) caches into the
        // app's cache dir. The exact name depends on its implementation —
        // safest path: re-call it (it short-circuits when the file exists).
        return try {
            kotlinx.coroutines.runBlocking {
                com.listenai.service.voice.VoiceCloningService
                    .getInstance(context)
                    .downloadPreviewAudio(voiceId)
            }
        } catch (t: Throwable) {
            Log.w(tag, "locateReferenceAudio: couldn't fetch reference for $voiceId — falling back to default voice (${t.message})")
            val defaultVoice = ChatterboxModelDownloader.getInstance(context).defaultVoiceFile
            if (defaultVoice.exists()) defaultVoice else null
        }
    }

    /**
     * Build a [1, M+G] int64 OnnxTensor from prompt_token tensor + the LM-
     * generated speech tokens. Mirrors the Python:
     *   speech_tokens = np.concatenate([prompt_token, speech_tokens], axis=1)
     */
    private fun buildSpeechTokensTensor(
        env: OrtEnvironment,
        promptToken: OnnxTensor,
        generated: IntArray,
    ): OnnxTensor {
        @Suppress("UNCHECKED_CAST")
        val promptArr = promptToken.value as Array<LongArray>
        val promptLen = promptArr[0].size
        val total = LongArray(promptLen + generated.size)
        System.arraycopy(promptArr[0], 0, total, 0, promptLen)
        for (i in generated.indices) total[promptLen + i] = generated[i].toLong()
        return OnnxTensor.createTensor(env,
            java.nio.LongBuffer.wrap(total),
            longArrayOf(1, total.size.toLong()))
    }

    /**
     * Write a 16-bit PCM mono WAV file to the cache dir. Same little-endian
     * RIFF layout that [com.listenai.systemtts.ReadAloudTTSService] knows
     * how to stream.
     */
    private fun writeWavToFile(pcm: ShortArray, sampleRate: Int): File {
        val outFile = File.createTempFile("chatterbox_", ".wav", context.cacheDir)
        val byteLen = pcm.size * 2
        val totalLen = 36 + byteLen
        java.io.RandomAccessFile(outFile, "rw").use { raf ->
            raf.writeBytes("RIFF")
            raf.writeIntLE(totalLen)
            raf.writeBytes("WAVE")
            raf.writeBytes("fmt ")
            raf.writeIntLE(16)            // fmt chunk size
            raf.writeShortLE(1)           // PCM
            raf.writeShortLE(1)           // mono
            raf.writeIntLE(sampleRate)
            raf.writeIntLE(sampleRate * 2)  // byte rate (sampleRate * channels * bytesPerSample)
            raf.writeShortLE(2)           // block align
            raf.writeShortLE(16)          // bits per sample
            raf.writeBytes("data")
            raf.writeIntLE(byteLen)
            val buf = java.nio.ByteBuffer.allocate(byteLen)
                .order(java.nio.ByteOrder.LITTLE_ENDIAN)
            for (s in pcm) buf.putShort(s)
            raf.write(buf.array())
        }
        return outFile
    }

    private fun java.io.RandomAccessFile.writeIntLE(v: Int) {
        write(v and 0xff)
        write((v ushr 8) and 0xff)
        write((v ushr 16) and 0xff)
        write((v ushr 24) and 0xff)
    }

    private fun java.io.RandomAccessFile.writeShortLE(v: Int) {
        write(v and 0xff)
        write((v ushr 8) and 0xff)
    }

    // ------------------------------------------------------------------
    // Session and embedding helpers
    // ------------------------------------------------------------------

    /** Lock for ensureSessions() so warmup + user-tap don't double-load. */
    private val sessionLoadLock = Any()

    /** Sessions required at warmup — keeps app launch fast. */
    private fun sessionsReady(): Boolean =
        languageModelSession != null && tokenSession != null

    /**
     * Load the large sessions (conditional_decoder + speech_encoder) on
     * demand. Called from the synthesis path on first run.
     */
    private fun ensureBigSessionsLocked(sessionOpts: OrtSession.SessionOptions): Boolean {
        val downloader = ChatterboxModelDownloader.getInstance(context)
        if (vocoderSession == null) {
            val t = System.currentTimeMillis()
            Log.i(tag, "ensureBigSessions: loading conditional_decoder…")
            vocoderSession = env.createSession(downloader.conditionalDecoderFile.absolutePath, sessionOpts)
            Log.i(tag, "  conditional_decoder loaded in ${System.currentTimeMillis() - t}ms")
        }
        if (voiceEncoderSession == null) {
            val t = System.currentTimeMillis()
            Log.i(tag, "ensureBigSessions: loading speech_encoder…")
            voiceEncoderSession = env.createSession(downloader.speechEncoderFile.absolutePath, sessionOpts)
            Log.i(tag, "  speech_encoder loaded in ${System.currentTimeMillis() - t}ms")
        }
        return vocoderSession != null && voiceEncoderSession != null
    }

    /**
     * Lazy-load all four ONNX sessions. Idempotent and **thread-safe** —
     * two concurrent callers (e.g. app-launch warmup + user flask tap)
     * will not race; the second one waits on the monitor and returns the
     * cached result.
     */
    private fun ensureSessions(): Boolean {
        if (sessionsReady()) return true
        synchronized(sessionLoadLock) {
            if (sessionsReady()) return true
            return loadSessionsLocked()
        }
    }

    private fun loadSessionsLocked(): Boolean {
        val downloader = ChatterboxModelDownloader.getInstance(context)
        if (!downloader.isReady()) {
            Log.w(tag, "ensureSessions: model files not on disk yet")
            return false
        }
        return try {
            val availableCpus = Runtime.getRuntime().availableProcessors()
            val intraOpThreads = (availableCpus - 2).coerceIn(2, 8)

            // Bare-minimum options. This is the config that worked end-to-end
            // (produced garbled audio in ~135s total). Any "optimization"
            // beyond this hangs conditional_decoder loading.
            val sessionOpts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(intraOpThreads)
            }
            Log.i(tag, "ensureSessions: bare-minimum SessionOptions (intraOpThreads=$intraOpThreads)")

            Log.i(tag, "ensureSessions: loading SMALL sessions (intraOpThreads=$intraOpThreads)")
            val createStart = System.currentTimeMillis()

            // Load embed_tokens + language_model_q4 only at warmup.
            // conditional_decoder + speech_encoder are deferred to lazy load
            // because they hang ORT's session creation for many minutes
            // (cause unknown — may be ORT's allocator on large external
            // data files; needs upstream investigation). Lazy loading
            // shifts the cost to first synthesis without freezing app launch.
            var t = System.currentTimeMillis()
            tokenSession = env.createSession(downloader.embedTokensFile.absolutePath, sessionOpts)
            Log.i(tag, "  embed_tokens loaded in ${System.currentTimeMillis() - t}ms")
            t = System.currentTimeMillis()
            languageModelSession = env.createSession(downloader.lmFile.absolutePath, sessionOpts)
            Log.i(tag, "  language_model_q4 loaded in ${System.currentTimeMillis() - t}ms")

            val elapsed = System.currentTimeMillis() - createStart
            Log.i(tag, "ensureSessions: SMALL sessions ready in ${elapsed}ms. " +
                "Decoder + encoder will lazy-load on first synthesise().")
            true
        } catch (t: Throwable) {
            Log.e(tag, "ensureSessions: failed to load Chatterbox ONNX sessions", t)
            // Release any partially-loaded sessions so a retry starts clean.
            runCatching { voiceEncoderSession?.close() }
            runCatching { tokenSession?.close() }
            runCatching { vocoderSession?.close() }
            runCatching { languageModelSession?.close() }
            voiceEncoderSession = null
            tokenSession = null
            vocoderSession = null
            languageModelSession = null
            false
        }
    }

    /**
     * Release every ONNX session. Call from process teardown if your
     * lifecycle is wired for it. The sessions will lazy-reload on the next
     * synthesize() call.
     */
    fun closeSessions() {
        runCatching { voiceEncoderSession?.close() }
        runCatching { tokenSession?.close() }
        runCatching { vocoderSession?.close() }
        runCatching { languageModelSession?.close() }
        voiceEncoderSession = null
        tokenSession = null
        vocoderSession = null
        languageModelSession = null
    }

    /**
     * Load (or compute) the 256-dim speaker embedding for [voice].
     *
     * - First checks the in-memory cache
     * - Then checks the on-disk cache at `chatterbox/embeddings/<voiceId>.bin`
     * - Falls back to nothing — embedding extraction at clone time is a
     *   separate flow (TODO M2.6-7).
     */
    private fun ensureEmbeddingFor(voice: VoicePreset): FloatArray? {
        val voiceId = voice.providerVoiceId ?: voice.id
        embeddingCache[voiceId]?.let { return it }
        val file = File(embeddingsDir, "$voiceId.bin")
        if (file.exists()) {
            return try {
                val bytes = file.readBytes()
                val floats = FloatArray(bytes.size / 4)
                java.nio.ByteBuffer.wrap(bytes)
                    .order(java.nio.ByteOrder.LITTLE_ENDIAN)
                    .asFloatBuffer()
                    .get(floats)
                embeddingCache[voiceId] = floats
                floats
            } catch (t: Throwable) {
                Log.w(tag, "ensureEmbeddingFor: corrupt embedding $voiceId — ${t.message}")
                null
            }
        }
        // TODO(M2.6-7): trigger backend → embedding download for known clones.
        Log.w(tag, "ensureEmbeddingFor: no cached embedding for $voiceId")
        return null
    }

    /** Persist a 256-dim embedding to disk so it survives restart. */
    fun storeEmbedding(voiceId: String, embedding: FloatArray) {
        embeddingCache[voiceId] = embedding
        val bytes = java.nio.ByteBuffer.allocate(embedding.size * 4)
            .order(java.nio.ByteOrder.LITTLE_ENDIAN)
        embedding.forEach { bytes.putFloat(it) }
        File(embeddingsDir, "$voiceId.bin").writeBytes(bytes.array())
    }

    companion object {
        private const val TAG = "ChatterboxOnDeviceService"

        @Volatile
        private var instance: ChatterboxOnDeviceService? = null

        fun getInstance(context: Context): ChatterboxOnDeviceService {
            return instance ?: synchronized(this) {
                instance ?: ChatterboxOnDeviceService(context.applicationContext)
                    .also { instance = it }
            }
        }
    }
}
