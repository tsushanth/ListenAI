package com.listenai.service.tts.chain

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentHashMap

/**
 * Speaks text through an ordered list of [TtsSource]s with one interface.
 *
 * - The text is cut into sentence groups. Up to [ChainConfig.prefetch] chunks are synthesized ahead of the one
 *   being consumed, so a player that drains the flow at playback speed never waits for the next chunk.
 * - A chunk is looked up in the [ChunkCache] first (works offline); API audio is stored there.
 * - Each chunk goes to the first source in the session's order that is not cooling down and reports itself usable.
 *   A failure moves the whole rest of the session to the next source (one voice, not a patchwork), and the failing
 *   source is skipped by later sessions for a while that depends on why it failed (429 honours Retry-After).
 * - When every source failed for a chunk, the flow throws [NoSourceAvailableException] carrying the action to offer.
 *
 * [order] is read at the start of every session, which is how the remote flag switches the default source.
 */
class TtsSourceChain(
    private val sources: Map<SourceId, TtsSource>,
    private val order: () -> List<SourceId>,
    private val cache: ChunkCache? = null,
    private val config: ChainConfig = ChainConfig(),
    private val telemetry: TtsTelemetry = TtsTelemetry.None,
    /** Monotonic milliseconds. Tests pass virtual time. */
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val cooldownUntil = ConcurrentHashMap<SourceId, Long>()

    /** Forget cooldowns, e.g. after the network comes back. */
    fun resetCooldowns() = cooldownUntil.clear()

    private class Session(val order: List<SourceId>, val request: TtsRequest) {
        @Volatile var minIndex = 0
        val reasons = java.util.Collections.synchronizedList(ArrayList<Pair<SourceId, FallbackReason>>())
        val lastReason = ConcurrentHashMap<SourceId, FallbackReason>()
        val bySource = ConcurrentHashMap<SourceId, Int>()
        @Volatile var cacheHits = 0
        // Availability of a source does not change within a session; ask once.
        val checked = ConcurrentHashMap<SourceId, CompletableDeferred<FallbackReason?>>()
        fun note(id: SourceId, r: FallbackReason) { reasons += id to r; lastReason[id] = r }
        fun demote(id: SourceId) {
            val i = order.indexOf(id)
            if (i >= minIndex) minIndex = i + 1
        }
    }

    fun speak(text: String, request: TtsRequest): Flow<SpokenChunk> = flow {
        val chunks = TextChunker.split(text, config.maxChunkChars, config.firstChunkChars)
        val session = Session(order(), request)
        val started = nowMs()
        var firstAudioAt: Long? = null
        var emitted = 0
        var audioMs = 0L
        var firstSource: SourceId? = null
        var finished = false
        try {
            if (chunks.isEmpty()) { finished = true; return@flow }
            supervisorScope {
                val window = ArrayDeque<Deferred<SpokenChunk>>()
                var next = 0
                fun fill() {
                    while (window.size < config.prefetch.coerceAtLeast(1) && next < chunks.size) {
                        val idx = next++
                        window.addLast(async { synthesizeChunk(idx, chunks.size, chunks[idx], session) })
                    }
                }
                fill()
                while (window.isNotEmpty()) {
                    val chunk = window.removeFirst().await()
                    if (firstAudioAt == null) { firstAudioAt = nowMs(); firstSource = chunk.source }
                    emitted++
                    audioMs += chunk.audio.durationMs
                    emit(chunk)
                    fill()
                }
            }
            finished = true
        } finally {
            if (emitted > 0 || session.reasons.isNotEmpty()) {
                telemetry.report(
                    SessionReport(
                        firstSource = firstSource,
                        chunksBySource = session.bySource.toMap(),
                        cacheHits = session.cacheHits,
                        chunks = chunks.size,
                        chars = text.length,
                        fallbackReasons = session.reasons.toList(),
                        timeToFirstAudioMs = firstAudioAt?.let { it - started },
                        totalMs = nowMs() - started,
                        audioMs = audioMs,
                        succeeded = finished,
                        language = request.language.substringBefore('-').lowercase(),
                    )
                )
            }
        }
    }

    private suspend fun synthesizeChunk(index: Int, total: Int, text: String, s: Session): SpokenChunk {
        val key = cache?.let { ChunkCache.key(s.request.voiceId, s.request.speed, text) }
        if (key != null) {
            cache?.get(key)?.let { hit ->
                s.cacheHits++
                s.bySource.merge(SourceId.API, 1, Int::plus)
                return SpokenChunk(index, total, Pcm.resample(hit, config.outputSampleRate), SourceId.API, true, text.length)
            }
        }
        val failures = LinkedHashMap<SourceId, FallbackReason>()
        var i = s.minIndex
        while (i < s.order.size) {
            val id = s.order[i]
            val src = sources[id]
            if (src == null) { i++; continue }
            val cooling = cooldownUntil[id]?.let { nowMs() < it } == true
            if (cooling) {
                val why = cooldownReasons[id] ?: FallbackReason.UNKNOWN
                failures[id] = why
                if (s.lastReason[id] == null) s.note(id, why)
                s.demote(id)
                i++; continue
            }
            val unavailable = checkOnce(s, src)
            if (unavailable != null) {
                failures[id] = unavailable
                s.note(id, unavailable)
                coolDown(id, SourceFailure(unavailable))
                s.demote(id)
                i++; continue
            }
            val attempts = if (id == SourceId.API) 1 + config.retries.coerceAtLeast(0) else 1
            var attempt = 0
            while (attempt < attempts) {
                attempt++
                val t0 = nowMs()
                try {
                    val deadline = (if (index == 0) config.firstChunkBaseTimeoutMs else config.chunkBaseTimeoutMs) +
                        config.perCharTimeoutMs * text.length
                    val pcm = withTimeout(deadline) { src.synthesize(text, s.request) }
                    if (pcm.pcm.isEmpty()) throw SourceFailure(FallbackReason.SERVER_ERROR, message = "empty audio")
                    src.onChunkMeasured(nowMs() - t0, pcm.durationMs)
                    if (key != null && id in config.cacheableSources) cache?.put(key, pcm)
                    s.bySource.merge(id, 1, Int::plus)
                    return SpokenChunk(index, total, Pcm.resample(pcm, config.outputSampleRate), id, false, text.length)
                } catch (e: TimeoutCancellationException) {
                    failures[id] = FallbackReason.TIMEOUT
                    if (attempt < attempts) { delay(config.retryBackoffMs); continue }
                    s.note(id, FallbackReason.TIMEOUT); coolDown(id, SourceFailure(FallbackReason.TIMEOUT))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: SourceFailure) {
                    failures[id] = e.reason
                    val transient = e.reason == FallbackReason.TIMEOUT || e.reason == FallbackReason.SERVER_ERROR
                    if (transient && attempt < attempts) { delay(config.retryBackoffMs); continue }
                    s.note(id, e.reason); coolDown(id, e)
                } catch (e: Exception) {
                    failures[id] = FallbackReason.UNKNOWN
                    s.note(id, FallbackReason.UNKNOWN); coolDown(id, SourceFailure(FallbackReason.UNKNOWN))
                }
                break
            }
            s.demote(id)
            i++
        }
        throw NoSourceAvailableException(failures, actionFor(failures, s.request))
    }

    private val cooldownReasons = ConcurrentHashMap<SourceId, FallbackReason>()

    private suspend fun checkOnce(s: Session, src: TtsSource): FallbackReason? {
        val mine = CompletableDeferred<FallbackReason?>()
        val existing = s.checked.putIfAbsent(src.id, mine)
        if (existing != null) return existing.await()
        return try {
            src.unavailableReason(s.request).also { mine.complete(it) }
        } catch (e: CancellationException) {
            mine.cancel(); throw e
        } catch (e: Exception) {
            FallbackReason.UNKNOWN.also { mine.complete(it) }
        }
    }

    private fun coolDown(id: SourceId, f: SourceFailure) {
        val ms = when (f.reason) {
            FallbackReason.OFFLINE -> config.cooldownOfflineMs
            FallbackReason.QUOTA -> f.retryAfterMs ?: config.cooldownQuotaMs
            FallbackReason.RATE_LIMITED -> f.retryAfterMs ?: config.cooldownRateLimitMs
            FallbackReason.TIMEOUT, FallbackReason.SERVER_ERROR, FallbackReason.UNKNOWN -> config.cooldownTransientMs
            // Missing engine, language data or model: not time-dependent, and the user may fix them any moment, so
            // do not remember it across sessions (the per-session check is cheap).
            else -> 0L
        }
        if (ms > 0) { cooldownUntil[id] = nowMs() + ms; cooldownReasons[id] = f.reason }
    }

    internal fun actionFor(failures: Map<SourceId, FallbackReason>, request: TtsRequest): UserAction {
        val all = failures.values
        val lang = request.language.substringBefore('-').lowercase()
        return when {
            FallbackReason.LANGUAGE_MISSING in all -> UserAction.InstallVoiceData(lang)
            failures[SourceId.SYSTEM] == FallbackReason.ENGINE_MISSING -> UserAction.InstallEngine
            FallbackReason.OFFLINE in all -> UserAction.CheckConnection
            else -> UserAction.TryLater
        }
    }
}
