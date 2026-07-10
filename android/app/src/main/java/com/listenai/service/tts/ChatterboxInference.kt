package com.listenai.service.tts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.util.Log
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Chatterbox inference helpers, port of the Python reference inference
 * code published at:
 *   https://huggingface.co/onnx-community/chatterbox-ONNX
 *
 * The model topology — verified against the upstream README + config.json:
 *
 *   ┌─ Reference audio (mono, 24 kHz, fp32) ─► speech_encoder.onnx ──┐
 *   │                                                                  │
 *   │   outputs (4):                                                   │
 *   │     cond_emb        [1, N, 1024]   - speaker conditioning        │
 *   │     prompt_token    [1, M] int64   - prepended to speech tokens  │
 *   │     ref_x_vector    [1, D] fp32    - speaker emb for decoder     │
 *   │     prompt_feat     [1, F] fp32    - speaker feats for decoder   │
 *   │                                                                  │
 *   ├─ Text + position_ids + exaggeration ─► embed_tokens.onnx ─►(embeds)│
 *   │                                                                  │
 *   ▼  iter 0: inputs_embeds = concat(cond_emb, embeds, axis=1)         │
 *  ─────────────────────────────────────────────────────────────────────┘
 *   language_model.onnx (Llama, 30 layers, KV-cache loop)
 *   inputs:  inputs_embeds, attention_mask, past_key_values.{layer}.{key,value}
 *   outputs: logits, present_key_values
 *   sample with repetition_penalty=1.2 ── greedy argmax ── stop at 6562
 *
 *   speech_tokens = [prompt_token, generated[1:-1]]  // drop START/STOP
 *
 *   conditional_decoder.onnx
 *   inputs:  speech_tokens, speaker_embeddings (=ref_x_vector), speaker_features (=prompt_feat)
 *   output:  wav   [1, samples] fp32 at 24 kHz
 */
object ChatterboxConfig {
    // From config.json text_config.
    const val HIDDEN_SIZE = 1024
    const val NUM_LAYERS = 30
    const val NUM_HEADS = 16
    const val NUM_KV_HEADS = 16
    const val HEAD_DIM = 64
    const val VOCAB_SIZE = 8194
    const val MAX_POSITION_EMBEDDINGS = 131_072

    // From README inference code + generation_config.json.
    const val BOS_TOKEN_ID = 1
    const val START_SPEECH_TOKEN = 6561
    const val STOP_SPEECH_TOKEN = 6562
    const val REPETITION_PENALTY = 1.2f
    const val DEFAULT_EXAGGERATION = 0.5f

    // From preprocessor_config.json.
    const val AUDIO_SAMPLE_RATE = 24_000

    // Practical caps. The chatterbox reference default is 256; we follow that
    // until we can profile longer values on a real device.
    const val MAX_NEW_SPEECH_TOKENS = 256
    const val MAX_INPUT_TEXT_TOKENS = 512
}

// ---------------------------------------------------------------------------
// KV cache. Past key/value tensors fed back into the LM on each step.
// Shape per tensor: [batch=1, num_kv_heads=16, past_seq, head_dim=64]
// ---------------------------------------------------------------------------

class KVCache(private val env: OrtEnvironment) {
    private val keys: Array<OnnxTensor?> = arrayOfNulls(ChatterboxConfig.NUM_LAYERS)
    private val values: Array<OnnxTensor?> = arrayOfNulls(ChatterboxConfig.NUM_LAYERS)

    /** Initialise with zero-length past — what the LM expects on iter 0. */
    fun initEmpty() {
        for (i in 0 until ChatterboxConfig.NUM_LAYERS) {
            runCatching { keys[i]?.close() }
            runCatching { values[i]?.close() }
            keys[i] = zeroPastTensor()
            values[i] = zeroPastTensor()
        }
    }

    private fun zeroPastTensor(): OnnxTensor {
        val shape = longArrayOf(
            /* batch */ 1L,
            /* heads */ ChatterboxConfig.NUM_KV_HEADS.toLong(),
            /* past_seq */ 0L,
            /* head_dim */ ChatterboxConfig.HEAD_DIM.toLong(),
        )
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(FloatArray(0)), shape)
    }

    /**
     * Swap in the `present` tensors the LM just produced. Closes the previous
     * past tensors. Caller hands ownership of [presentKeys] / [presentValues]
     * to this cache.
     */
    fun update(presentKeys: Array<OnnxTensor>, presentValues: Array<OnnxTensor>) {
        require(presentKeys.size == ChatterboxConfig.NUM_LAYERS) {
            "expected ${ChatterboxConfig.NUM_LAYERS} present keys, got ${presentKeys.size}"
        }
        for (i in 0 until ChatterboxConfig.NUM_LAYERS) {
            runCatching { keys[i]?.close() }
            runCatching { values[i]?.close() }
            keys[i] = presentKeys[i]
            values[i] = presentValues[i]
        }
    }

    /** Past KV tensors keyed as the LM expects. */
    fun asInputMap(): Map<String, OnnxTensor> {
        val map = HashMap<String, OnnxTensor>(ChatterboxConfig.NUM_LAYERS * 2)
        for (i in 0 until ChatterboxConfig.NUM_LAYERS) {
            map["past_key_values.$i.key"] = keys[i]
                ?: throw IllegalStateException("KV slot $i not initialised — call initEmpty() first")
            map["past_key_values.$i.value"] = values[i]
                ?: throw IllegalStateException("KV slot $i not initialised — call initEmpty() first")
        }
        return map
    }

    fun close() {
        for (i in 0 until ChatterboxConfig.NUM_LAYERS) {
            runCatching { keys[i]?.close() }
            runCatching { values[i]?.close() }
            keys[i] = null
            values[i] = null
        }
    }
}

// ---------------------------------------------------------------------------
// Sampling. Greedy + repetition penalty matches the Python reference exactly.
// ---------------------------------------------------------------------------

object ChatterboxSampler {
    /**
     * From the Python reference's RepetitionPenaltyLogitsProcessor:
     *   score = where(score < 0, score * penalty, score / penalty)
     */
    fun applyRepetitionPenalty(
        logits: FloatArray,
        history: IntArray,
        penalty: Float = ChatterboxConfig.REPETITION_PENALTY,
    ) {
        if (penalty == 1.0f) return
        for (tok in history) {
            if (tok < 0 || tok >= logits.size) continue
            val l = logits[tok]
            logits[tok] = if (l < 0f) l * penalty else l / penalty
        }
    }

    fun greedy(logits: FloatArray): Int {
        var best = 0
        var bestScore = logits[0]
        for (i in 1 until logits.size) {
            if (logits[i] > bestScore) { bestScore = logits[i]; best = i }
        }
        return best
    }

    fun isStop(token: Int): Boolean = token == ChatterboxConfig.STOP_SPEECH_TOKEN
}

// ---------------------------------------------------------------------------
// Tokenizer interface. Still TODO — see the bottom of this file for options.
// ---------------------------------------------------------------------------

interface ChatterboxTokenizer {
    /** Text → token IDs. Returns int array per the Python reference. */
    fun encode(text: String): IntArray

    companion object {
        /**
         * Stub that throws clearly so the system TTS engine returns a real
         * error instead of silently producing wrong audio.
         */
        fun stub(): ChatterboxTokenizer = object : ChatterboxTokenizer {
            override fun encode(text: String): IntArray {
                throw NotImplementedError(
                    "ChatterboxTokenizer not yet wired. Options: " +
                        "(1) ai.djl.huggingface:tokenizers Android variant, " +
                        "(2) onnxruntime-extensions which has HF BPE ops, " +
                        "(3) hand-port the BPE merges from downloader.tokenizerFile."
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Speech encoder — produces 4 tensors per voice. Run once per
// audio sample; cache the outputs per voice.
// ---------------------------------------------------------------------------

data class SpeakerConditioning(
    /** [1, N, 1024]  prepended to text embeddings on iter 0 of the LM loop. */
    val condEmb: OnnxTensor,
    /** [1, M] int64  prepended to the generated speech tokens before decoding. */
    val promptToken: OnnxTensor,
    /** [1, D] fp32   speaker embedding fed to conditional_decoder. */
    val refXVector: OnnxTensor,
    /** [1, F] fp32   speaker features fed to conditional_decoder. */
    val promptFeat: OnnxTensor,
) {
    fun close() {
        runCatching { condEmb.close() }
        runCatching { promptToken.close() }
        runCatching { refXVector.close() }
        runCatching { promptFeat.close() }
    }
}

class ChatterboxSpeechEncoder(
    private val env: OrtEnvironment,
    private val session: OrtSession,
) {
    private val tag = "ChatterboxSpeechEncoder"

    /**
     * Run speech_encoder on a 24 kHz mono float audio sample.
     *
     * @param audioMono24k float PCM samples normalised to [-1, 1]
     */
    fun encode(audioMono24k: FloatArray): SpeakerConditioning {
        val tensor = OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(audioMono24k),
            longArrayOf(1L, audioMono24k.size.toLong()),
        )
        try {
            val out = session.run(mapOf("audio_values" to tensor))
            // Output order from the Python reference:
            //   cond_emb, prompt_token, ref_x_vector, prompt_feat
            val condEmb = out[0] as OnnxTensor
            val promptToken = out[1] as OnnxTensor
            val refX = out[2] as OnnxTensor
            val promptFeat = out[3] as OnnxTensor
            Log.i(tag, "encode: speech_encoder produced 4 tensors")
            return SpeakerConditioning(condEmb, promptToken, refX, promptFeat)
        } finally {
            tensor.close()
        }
    }
}

// ---------------------------------------------------------------------------
// The autoregressive generation loop. Direct port of the Python reference.
// ---------------------------------------------------------------------------

class ChatterboxAutoregress(
    private val env: OrtEnvironment,
    private val embedTokens: OrtSession,
    private val languageModel: OrtSession,
    private val speechEncoder: ChatterboxSpeechEncoder,
    private val tokenizer: ChatterboxTokenizer = ChatterboxTokenizer.stub(),
    /**
     * If non-null, skip the speech_encoder pass entirely and use the
     * cached 4 speaker tensors. This is the dominant speedup on
     * subsequent synthesise() calls for the same voice.
     */
    private val cachedSpeaker: SpeakerConditioning? = null,
) {
    private val tag = "ChatterboxAutoregress"

    /**
     * The cond_emb tensor from the most recent generate() — exposed so
     * [com.listenai.service.tts.ChatterboxOnDeviceService] can persist it
     * to the SpeakerCache when this was a first-time encode.
     */
    var lastCondEmb: OnnxTensor? = null
        private set

    /**
     * Generate speech tokens for [text] conditioned on [audioMono24k].
     *
     * Returns the speech token sequence (with prompt_token prepended) plus the
     * two speaker tensors the conditional_decoder needs. Caller is responsible
     * for closing the returned tensors.
     */
    fun generate(
        text: String,
        audioMono24k: FloatArray,
        exaggeration: Float = ChatterboxConfig.DEFAULT_EXAGGERATION,
        maxNewTokens: Int = ChatterboxConfig.MAX_NEW_SPEECH_TOKENS,
    ): GenerationResult {
        // 1. Tokenize text → input_ids.
        val inputIds = tokenizer.encode(text)
        require(inputIds.size <= ChatterboxConfig.MAX_INPUT_TEXT_TOKENS) {
            "input too long (${inputIds.size} > ${ChatterboxConfig.MAX_INPUT_TEXT_TOKENS} tokens)"
        }
        Log.i(tag, "generate: ${inputIds.size} input tokens, maxNew=$maxNewTokens")

        // 2. Compute position_ids per the Python reference:
        //    speech tokens (>= START_SPEECH_TOKEN) → 0
        //    text tokens   → arange(seq) - 1
        val positionIds = IntArray(inputIds.size) { i ->
            if (inputIds[i] >= ChatterboxConfig.START_SPEECH_TOKEN) 0 else i - 1
        }

        // 3. Run speech_encoder on the reference audio (just once) — OR
        // reuse the cached 4 tensors from a previous run on the same voice.
        val speaker = if (cachedSpeaker != null) {
            Log.i(tag, "generate: using cached speaker tensors (skipped speech_encoder)")
            cachedSpeaker
        } else {
            speechEncoder.encode(audioMono24k)
        }
        lastCondEmb = speaker.condEmb

        val cache = KVCache(env)
        cache.initEmpty()
        val generated = ArrayList<Int>(maxNewTokens + 2)
        generated.add(ChatterboxConfig.START_SPEECH_TOKEN)

        try {
            // 4. iter 0 — embed prompt tokens, concat speaker prefix, prefill LM.
            val inputsEmbedsIter0 = embed(inputIds, positionIds, exaggeration)
            val condSeqLen = speaker.condEmb.info.shape[1].toInt()
            val initialSeqLen = inputsEmbedsIter0.seqLen + condSeqLen
            // Concat speaker cond_emb + text embeds along seq dim. Shape goes
            // from [1, seq, 1024] → [1, condSeq + seq, 1024].
            val combinedEmbeds = concatHidden(speaker.condEmb, inputsEmbedsIter0)

            // The attention mask accumulates across the whole autoregress —
            // each step adds one. Track its current length and rebuild the
            // mask tensor per step (mirrors the Python `np.concatenate`).
            var maskLen = initialSeqLen
            var attentionMask = onesAttentionMask(maskLen)
            val firstLogits = runLMStep(combinedEmbeds, attentionMask, cache, isFirstPass = true)
            combinedEmbeds.close()
            attentionMask.close()

            ChatterboxSampler.applyRepetitionPenalty(firstLogits, generated.toIntArray())
            var nextToken = ChatterboxSampler.greedy(firstLogits)
            if (ChatterboxSampler.isStop(nextToken)) {
                Log.i(tag, "generate: STOP at iter 0 (empty utterance)")
            } else {
                generated.add(nextToken)
            }

            // 5. Autoregressive loop with single-token steps. Each step's
            // attention_mask MUST span the entire history (prefix + every
            // generated token so far) — running with mask=[1] makes the LM
            // produce gibberish because it can't see prior context.
            var pos = 1
            while (generated.size - 1 < maxNewTokens && !ChatterboxSampler.isStop(nextToken)) {
                maskLen += 1
                val stepEmbeds = embed(intArrayOf(nextToken), intArrayOf(pos), exaggeration)
                attentionMask = onesAttentionMask(maskLen)
                val logits = runLMStep(stepEmbeds, attentionMask, cache, isFirstPass = false)
                stepEmbeds.close()
                attentionMask.close()

                ChatterboxSampler.applyRepetitionPenalty(logits, generated.toIntArray())
                nextToken = ChatterboxSampler.greedy(logits)
                generated.add(nextToken)
                pos += 1
            }

            // 6. Drop START + STOP, prepend prompt_token from the speaker.
            val core = generated.subList(1, generated.size - if (ChatterboxSampler.isStop(generated.last())) 1 else 0)
                .toIntArray()
            Log.i(tag, "generate: emitted ${core.size} speech tokens (pre-prompt-prepend)")
            return GenerationResult(
                speechTokensCore = core,
                promptToken = speaker.promptToken,
                refXVector = speaker.refXVector,
                promptFeat = speaker.promptFeat,
            )
        } catch (t: Throwable) {
            speaker.close()
            throw t
        } finally {
            cache.close()
        }
    }

    // ------------------------------------------------------------------
    // ONNX wrappers
    // ------------------------------------------------------------------

    /**
     * Run embed_tokens. Output is `[1, seq, HIDDEN_SIZE]` packed into an
     * OnnxTensor we hold onto so we can feed it back to the LM.
     */
    private fun embed(
        inputIds: IntArray,
        positionIds: IntArray,
        exaggeration: Float,
    ): EmbedsTensor {
        val ids = LongArray(inputIds.size) { inputIds[it].toLong() }
        val pos = LongArray(positionIds.size) { positionIds[it].toLong() }
        val idsTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), longArrayOf(1, inputIds.size.toLong()))
        val posTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(pos), longArrayOf(1, positionIds.size.toLong()))
        val exagTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(floatArrayOf(exaggeration)), longArrayOf(1))
        try {
            val out = embedTokens.run(mapOf(
                "input_ids" to idsTensor,
                "position_ids" to posTensor,
                "exaggeration" to exagTensor,
            ))
            // The Python reference uses [0] — first (and likely only) output
            // of embed_tokens. Tensor stays owned by ORT until we close it.
            val embedsTensor = out[0] as OnnxTensor
            return EmbedsTensor(embedsTensor, inputIds.size)
        } finally {
            idsTensor.close()
            posTensor.close()
            exagTensor.close()
        }
    }

    /**
     * Run the LM. On first pass `inputs_embeds` is the speaker-prefixed
     * prompt embedding; on subsequent passes it's the single-token embed.
     * KV cache is fed in via [cache] and updated from the present_*
     * outputs.
     *
     * Returns the **last-row logits** ([VOCAB_SIZE] fp32) for sampling.
     */
    private fun runLMStep(
        embeds: EmbedsTensor,
        attentionMask: OnnxTensor,
        cache: KVCache,
        isFirstPass: Boolean,
    ): FloatArray {
        val inputs = HashMap<String, OnnxTensor>().apply {
            put("inputs_embeds", embeds.tensor)
            put("attention_mask", attentionMask)
            putAll(cache.asInputMap())
        }
        val out = languageModel.run(inputs)

        // Output 0 = logits, [1, seq, VOCAB_SIZE]. We want the LAST row.
        @Suppress("UNCHECKED_CAST")
        val logitsArr = out[0].value as Array<Array<FloatArray>>
        val seq = logitsArr[0].size
        val lastRow = logitsArr[0][seq - 1].copyOf()

        // Outputs 1..(2N+1) = present_key_values, alternating key/value per layer.
        val numLayers = ChatterboxConfig.NUM_LAYERS
        val presentKeys = Array(numLayers) { i -> out[1 + 2 * i] as OnnxTensor }
        val presentValues = Array(numLayers) { i -> out[1 + 2 * i + 1] as OnnxTensor }
        cache.update(presentKeys, presentValues)

        // Close the logits OnnxValue — we copied the row we need.
        runCatching { out[0].close() }

        return lastRow
    }

    private fun onesAttentionMask(seqLen: Int): OnnxTensor {
        val data = LongArray(seqLen) { 1L }
        return OnnxTensor.createTensor(env, LongBuffer.wrap(data), longArrayOf(1, seqLen.toLong()))
    }

    /**
     * Concat two [1, seq, 1024] tensors along the seq axis. Both inputs
     * stay valid; output is a fresh OnnxTensor the caller closes.
     */
    private fun concatHidden(a: OnnxTensor, b: EmbedsTensor): EmbedsTensor {
        @Suppress("UNCHECKED_CAST")
        val aArr = a.value as Array<Array<FloatArray>>
        @Suppress("UNCHECKED_CAST")
        val bArr = b.tensor.value as Array<Array<FloatArray>>
        val seqA = aArr[0].size
        val seqB = bArr[0].size
        val hidden = ChatterboxConfig.HIDDEN_SIZE
        val combined = FloatArray((seqA + seqB) * hidden)
        for (i in 0 until seqA) {
            System.arraycopy(aArr[0][i], 0, combined, i * hidden, hidden)
        }
        for (i in 0 until seqB) {
            System.arraycopy(bArr[0][i], 0, combined, (seqA + i) * hidden, hidden)
        }
        val tensor = OnnxTensor.createTensor(
            env, FloatBuffer.wrap(combined),
            longArrayOf(1, (seqA + seqB).toLong(), hidden.toLong())
        )
        return EmbedsTensor(tensor, seqA + seqB)
    }
}

/** Result of one full generate() call. Caller closes the OnnxTensors. */
data class GenerationResult(
    val speechTokensCore: IntArray,
    val promptToken: OnnxTensor,
    val refXVector: OnnxTensor,
    val promptFeat: OnnxTensor,
) {
    fun close() {
        runCatching { promptToken.close() }
        runCatching { refXVector.close() }
        runCatching { promptFeat.close() }
    }
}

/** Carries the `[1, seq, 1024]` tensor + the seq length so we don't reparse. */
private data class EmbedsTensor(val tensor: OnnxTensor, val seqLen: Int) {
    fun close() = runCatching { tensor.close() }
}

// ---------------------------------------------------------------------------
// Conditional decoder. Takes the full speech-token sequence (with prompt
// prepended) + the two speaker tensors and returns 24 kHz PCM.
// ---------------------------------------------------------------------------

class ChatterboxDecoder(
    private val env: OrtEnvironment,
    private val conditionalDecoder: OrtSession,
) {
    private val tag = "ChatterboxDecoder"

    /**
     * @param speechTokensWithPrompt the FULL token sequence: prompt_token from
     *   the speaker prepended onto the LM's generated tokens (Python: line
     *   `speech_tokens = np.concatenate([prompt_token, speech_tokens], axis=1)`)
     */
    fun decode(
        speechTokensWithPrompt: OnnxTensor,
        refXVector: OnnxTensor,
        promptFeat: OnnxTensor,
    ): ShortArray {
        val out = conditionalDecoder.run(mapOf(
            "speech_tokens" to speechTokensWithPrompt,
            "speaker_embeddings" to refXVector,
            "speaker_features" to promptFeat,
        ))
        try {
            // Output 0 is the waveform. Python uses np.squeeze(wav, axis=0),
            // so the tensor is [1, samples] fp32.
            @Suppress("UNCHECKED_CAST")
            val raw = out[0].value as Array<FloatArray>
            val samples = raw[0]
            // Convert fp32 [-1..1] → int16 PCM for our WAV writer.
            val pcm = ShortArray(samples.size)
            for (i in samples.indices) {
                val s = (samples[i] * 32767f).coerceIn(-32768f, 32767f)
                pcm[i] = s.toInt().toShort()
            }
            Log.i(tag, "decode: produced ${pcm.size} samples (${pcm.size.toFloat() / ChatterboxConfig.AUDIO_SAMPLE_RATE}s)")
            return pcm
        } finally {
            runCatching { out[0].close() }
        }
    }
}
