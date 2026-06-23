package com.listenai.service.tts

import android.util.Log

/**
 * Per-call latency telemetry for on-device Kokoro synthesis.
 *
 * Why this exists: Warren's first install (2026-06-22) reported
 * "several seconds before TalkBack speaks what's under my finger" —
 * meaningfully worse than the 1.3s warm-path inference we measured on
 * our dev device. To know what to optimize without guessing, we need
 * the actual per-stage distribution on real-user devices:
 *
 *   tokenize_ms   — G2P + tokenizer wall-clock
 *   embedding_ms  — voice-pack slice (cheap, usually <1ms)
 *   sess_run_ms   — ONNX Runtime sess.run() itself (the model fwd)
 *   wav_pack_ms   — FP32 [-1,1] → Int16 PCM conversion
 *   total_ms      — sum of the above plus any overhead
 *   audio_ms      — produced audio length (sanity-check; rtf = total/audio)
 *
 * Plus per-call flags:
 *   nnapiAvailable — whether NNAPI EP successfully attached at session
 *                    create time (does NOT prove every op ran on NNAPI
 *                    — ONNX Runtime can silently fall back per-op — but
 *                    is the closest signal we get without an NCS dump)
 *   coldStart      — true on first call after onCreate, when session
 *                    creation cost is folded into this call's wall-clock
 *
 * Stored in a ring buffer of the last [BUFFER_SIZE] samples. Aggregate
 * computes p50/p95/max on demand. Logs each sample at INFO level so
 * `adb logcat -s KokoroLatency` gives an immediate stream.
 */
object LatencyTelemetry {

    private const val TAG = "KokoroLatency"
    private const val BUFFER_SIZE = 100

    data class Sample(
        val timestamp: Long,
        val chars: Int,
        val tokens: Int,
        val tokenizeMs: Long,
        val embeddingMs: Long,
        val sessRunMs: Long,
        val wavPackMs: Long,
        val totalMs: Long,
        val audioMs: Long,
        val nnapiAvailable: Boolean,
        val coldStart: Boolean,
    ) {
        /** Real-time factor — <1 means faster than real-time playback. */
        val rtf: Double get() = if (audioMs > 0) totalMs.toDouble() / audioMs else Double.POSITIVE_INFINITY
    }

    data class Aggregate(
        val n: Int,
        val p50Total: Long,
        val p95Total: Long,
        val maxTotal: Long,
        val p50SessRun: Long,
        val p95SessRun: Long,
        val p50Tokenize: Long,
        val p95Tokenize: Long,
        val p50WavPack: Long,
        val p95WavPack: Long,
        val nnapiRatePct: Int,
        val coldCalls: Int,
        val medianRtf: Double,
        val medianChars: Int,
    )

    private val samples = ArrayDeque<Sample>(BUFFER_SIZE)
    private val lock = Any()

    fun record(sample: Sample) {
        synchronized(lock) {
            if (samples.size >= BUFFER_SIZE) samples.removeFirst()
            samples.addLast(sample)
        }
        Log.i(
            TAG,
            "sample chars=${sample.chars} tokens=${sample.tokens} " +
                    "tokenize=${sample.tokenizeMs}ms embedding=${sample.embeddingMs}ms " +
                    "sess_run=${sample.sessRunMs}ms wav_pack=${sample.wavPackMs}ms " +
                    "total=${sample.totalMs}ms audio=${sample.audioMs}ms " +
                    "rtf=${"%.2f".format(sample.rtf)} " +
                    "nnapi=${sample.nnapiAvailable} cold=${sample.coldStart}"
        )
    }

    fun snapshot(): List<Sample> = synchronized(lock) { samples.toList() }

    fun clear() = synchronized(lock) { samples.clear() }

    fun aggregate(): Aggregate? {
        val s = synchronized(lock) { samples.toList() }
        if (s.isEmpty()) return null
        fun pct(values: List<Long>, p: Double): Long {
            val sorted = values.sorted()
            val idx = ((sorted.size - 1) * p).toInt().coerceIn(0, sorted.size - 1)
            return sorted[idx]
        }
        val totals = s.map { it.totalMs }
        val sess = s.map { it.sessRunMs }
        val tok = s.map { it.tokenizeMs }
        val wav = s.map { it.wavPackMs }
        return Aggregate(
            n = s.size,
            p50Total = pct(totals, 0.50),
            p95Total = pct(totals, 0.95),
            maxTotal = totals.max(),
            p50SessRun = pct(sess, 0.50),
            p95SessRun = pct(sess, 0.95),
            p50Tokenize = pct(tok, 0.50),
            p95Tokenize = pct(tok, 0.95),
            p50WavPack = pct(wav, 0.50),
            p95WavPack = pct(wav, 0.95),
            nnapiRatePct = (100.0 * s.count { it.nnapiAvailable } / s.size).toInt(),
            coldCalls = s.count { it.coldStart },
            medianRtf = s.map { it.rtf }.sorted().let { it[it.size / 2] },
            medianChars = s.map { it.chars }.sorted().let { it[it.size / 2] },
        )
    }
}
