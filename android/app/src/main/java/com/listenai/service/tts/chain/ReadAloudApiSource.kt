package com.listenai.service.tts.chain

import android.util.Log
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Speech from the ReadAloud API: Piper on CPU (api.readaloudai.org gateway, `piper-tts-sjc`).
 *
 * Same wire protocol the app already used (RealtimeTTSService): POST /api/realtime-tts/authorize on the app's
 * backend (which holds the platform key) returns a 60 s token and the worker URL, then a WebSocket takes
 * `{"type":"synthesize", text, voice, speed}` and answers with binary PCM16/24 kHz frames, `chunk_meta`, `done`.
 *
 * What differs: one chunk per call, and sockets are reused. A socket carries many synthesize messages one after
 * the other (verified against the live worker), so only the first chunk of a read pays authorize + connect;
 * a second socket opens for the prefetched chunk. Idle sockets are dropped after [IDLE_MS].
 *
 * Word timings (alignment worker) are requested only when the request asks for them. That worker scales to zero, so the
 * first message gets [ALIGNMENT_FIRST_MESSAGE_MS] and after a miss alignment is skipped for [ALIGNMENT_BACKOFF_MS].
 */
class ReadAloudApiSource(
    private val http: OkHttpClient,
    private val backendBaseUrl: String,
    private val isOnline: () -> Boolean,
    /** App voice id -> Piper voice id on the platform. */
    private val voiceFor: (String) -> String,
    private val nowMs: () -> Long = System::currentTimeMillis,
) : TtsSource {

    override val id = SourceId.API

    private class Auth(val token: String, val url: String, val alignment: Boolean)

    private inner class Conn(val alignment: Boolean) {
        // Set by onOpen (or right after newWebSocket returns, whichever is first): the listener can run before newWebSocket returns.
        @Volatile lateinit var ws: WebSocket
        @Volatile var closed = false
        @Volatile var lastUsed = nowMs()
        @Volatile var pending: Pending? = null
        @Volatile var gotAnyFrame = false
        val opened = AtomicBoolean(false)
    }

    private inner class Pending(val cont: CancellableContinuation<PcmChunk>) {
        val pcm = ByteArrayOutputStream()
        val words = ArrayList<TimedWord>()
        var sampleRate = SAMPLE_RATE
        @Volatile var firstFrame = false
        val done = AtomicBoolean(false)
        fun finish(r: Result<PcmChunk>) {
            if (done.compareAndSet(false, true) && cont.isActive) {
                r.fold({ cont.resume(it) }, { cont.resumeWithException(it) })
            }
        }
    }

    private val idle = ConcurrentLinkedDeque<Conn>()
    @Volatile private var alignmentBlockedUntil = 0L
    private val watchdog: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "tts-api-watchdog").apply { isDaemon = true } }

    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = when {
        request.language.substringBefore('-').lowercase() != "en" -> FallbackReason.UNSUPPORTED_LANGUAGE
        !isOnline() -> FallbackReason.OFFLINE
        else -> null
    }

    /** Opens a socket ahead of the first chunk (authorize + connect), so the first synthesize pays neither. */
    suspend fun prewarm() {
        if (!isOnline()) return
        runCatching { release(connect(false)) }
    }

    fun close() {
        while (true) { val c = idle.pollFirst() ?: break; c.ws.close(1000, "bye") }
    }

    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
        val useWords = request.wantWords && nowMs() >= alignmentBlockedUntil
        return try {
            attempt(text, request, useWords)
        } catch (e: AlignmentSlow) {
            alignmentBlockedUntil = nowMs() + ALIGNMENT_BACKOFF_MS
            Log.i(TAG, "alignment worker slow; plain Piper for the next ${ALIGNMENT_BACKOFF_MS / 60000} min")
            attempt(text, request, false)
        }
    }

    private class AlignmentSlow : Exception()

    private suspend fun attempt(text: String, request: TtsRequest, alignment: Boolean): PcmChunk {
        // A reused socket may have been closed by the server while idle; if it fails before sending anything, redo once on a fresh one.
        val reused = takeIdle(alignment)
        if (reused != null) {
            try {
                return run(reused, text, request)
            } catch (e: SourceFailure) {
                if (!(reused.closed && !reused.gotAnyFrame)) throw e
                Log.i(TAG, "reused socket was dead; reconnecting")
            }
        }
        return run(connect(alignment), text, request)
    }

    private fun takeIdle(alignment: Boolean): Conn? {
        val now = nowMs()
        while (true) {
            val c = idle.pollFirst() ?: return null
            if (c.closed || now - c.lastUsed > IDLE_MS) { c.ws.close(1000, "idle"); continue }
            if (c.alignment != alignment) { idle.addLast(c); return null } // keep it for a matching request
            return c
        }
    }

    private fun release(c: Conn) {
        c.lastUsed = nowMs()
        if (c.closed) return
        idle.addFirst(c)
        while (idle.size > MAX_IDLE) idle.pollLast()?.ws?.close(1000, "trim")
    }

    private fun authorize(alignment: Boolean): Auth {
        val body = JSONObject().put("engine", "piper").apply { if (alignment) put("alignment", true) }
        val req = Request.Builder()
            .url("$backendBaseUrl/api/realtime-tts/authorize")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            // Same anonymous bearer the app has always sent here; the backend holds the platform key.
            .addHeader("Authorization", "Bearer ")
            .build()
        try {
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw ApiFailureMapping.fromHttp(resp.code, resp.header("Retry-After"), isOnline())
                val j = JSONObject(text)
                return Auth(j.getString("token"), j.getString("url"), alignment && j.optBoolean("alignment", false))
            }
        } catch (e: SourceFailure) {
            throw e
        } catch (e: IOException) {
            throw ApiFailureMapping.fromThrowable(e, isOnline())
        } catch (e: Exception) {
            throw SourceFailure(FallbackReason.SERVER_ERROR, null, e.message, e)
        }
    }

    private suspend fun connect(alignment: Boolean): Conn {
        // authorize() is a blocking OkHttp call; the chain runs sources on its caller's dispatcher, so hop to IO.
        val auth = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { authorize(alignment) }
        return suspendCancellableCoroutine { cont ->
            val conn = Conn(auth.alignment)
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    conn.ws = webSocket
                    conn.opened.set(true)
                    if (cont.isActive) cont.resume(conn)
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = handleBinary(conn, bytes)
                override fun onMessage(webSocket: WebSocket, text: String) = handleText(conn, text)
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    conn.closed = true
                    val failure = if (response != null && response.code != 101)
                        ApiFailureMapping.fromHttp(response.code, response.header("Retry-After"), isOnline())
                    else ApiFailureMapping.fromThrowable(t, isOnline())
                    if (!conn.opened.get() && cont.isActive) cont.resumeWithException(failure)
                    conn.pending?.finish(Result.failure(failure))
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    conn.closed = true
                    val f = if (code == 1013) SourceFailure(FallbackReason.SERVER_ERROR, null, "at capacity")
                    else SourceFailure(FallbackReason.SERVER_ERROR, null, "closed $code $reason")
                    conn.pending?.finish(Result.failure(f))
                }
            }
            val ws = http.newWebSocket(Request.Builder().url("${auth.url}?token=${auth.token}").build(), listener)
            conn.ws = ws
            cont.invokeOnCancellation { ws.cancel() }
        }
    }

    private suspend fun run(conn: Conn, text: String, request: TtsRequest): PcmChunk {
        val chunk = try {
            suspendCancellableCoroutine<PcmChunk> { cont ->
                val p = Pending(cont)
                conn.pending = p
                val msg = JSONObject()
                    .put("type", "synthesize")
                    .put("text", text)
                    .put("voice", voiceFor(request.voiceId))
                    .put("speed", request.speed.toDouble())
                if (conn.alignment) msg.put("alignment", true)
                if (!conn.ws.send(msg.toString())) {
                    conn.closed = true
                    p.finish(Result.failure(SourceFailure(FallbackReason.SERVER_ERROR, null, "send failed")))
                }
                if (conn.alignment) {
                    watchdog.schedule({
                        if (!p.firstFrame && !p.done.get()) {
                            conn.closed = true
                            conn.ws.cancel()
                            p.finish(Result.failure(AlignmentSlow()))
                        }
                    }, ALIGNMENT_FIRST_MESSAGE_MS, TimeUnit.MILLISECONDS)
                }
                // A cancelled synthesis leaves the server streaming into this socket: drop the socket.
                cont.invokeOnCancellation { conn.closed = true; conn.ws.cancel() }
            }
        } catch (e: Throwable) {
            // Failed, timed out or cancelled: the server may still be streaming into this socket, so it is not reusable.
            conn.closed = true
            conn.ws.cancel()
            throw e
        } finally {
            conn.pending = null
        }
        release(conn)
        return chunk
    }

    private fun handleBinary(conn: Conn, bytes: ByteString) {
        val p = conn.pending ?: return
        conn.gotAnyFrame = true
        p.firstFrame = true
        p.pcm.write(bytes.toByteArray())
    }

    private fun handleText(conn: Conn, text: String) {
        val p = conn.pending ?: return
        conn.gotAnyFrame = true
        p.firstFrame = true
        try {
            val j = JSONObject(text)
            when (j.optString("type")) {
                "chunk_meta" -> {
                    j.optInt("sample_rate", 0).takeIf { it > 0 }?.let { p.sampleRate = it }
                    collectWords(j, p)
                }
                "done" -> p.finish(Result.success(PcmChunk(p.pcm.toByteArray(), p.sampleRate, p.words.takeIf { it.isNotEmpty() })))
                "error" -> p.finish(Result.failure(ApiFailureMapping.fromWsError(j.optString("message", "synthesis error"))))
            }
        } catch (e: Exception) {
            p.finish(Result.failure(SourceFailure(FallbackReason.SERVER_ERROR, null, "bad frame: ${e.message}", e)))
        }
    }

    /** `chunk_meta.words` are relative to the chunk's own audio (t0 is relative to the whole message, which here is one chunk). */
    private fun collectWords(j: JSONObject, p: Pending) {
        val arr = j.optJSONArray("words") ?: return
        val t0 = j.optDouble("t0", 0.0).let { if (it.isNaN() || it < 0) 0.0 else it }
        for (i in 0 until arr.length()) {
            val w = arr.optJSONObject(i) ?: continue
            if (w.isNull("start") || w.isNull("end") || !w.has("start_char") || !w.has("end_char")) continue
            val s = w.optDouble("start", Double.NaN); val e = w.optDouble("end", Double.NaN)
            val cs = w.optInt("start_char", -1); val ce = w.optInt("end_char", -1)
            if (s.isNaN() || e.isNaN() || cs < 0 || ce <= cs || e < s) continue
            p.words += TimedWord(cs, ce, t0 + s, t0 + e)
        }
    }

    companion object {
        private const val TAG = "ReadAloudApiSource"
        const val SAMPLE_RATE = 24_000
        private const val IDLE_MS = 25_000L
        private const val MAX_IDLE = 2
        internal const val ALIGNMENT_FIRST_MESSAGE_MS = 2_500L
        internal const val ALIGNMENT_BACKOFF_MS = 10 * 60_000L
    }
}
