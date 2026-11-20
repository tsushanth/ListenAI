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
 * Speech from the ReadAloud API (api.readaloudai.org gateway, CPU voices).
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
 *
 * Routes: a live voice is authorized with `{"engine":"piper"}`; a studio-tier voice (Beta, languages without a live voice) with
 * `{"engine":"studio","voice":"<public id>"}`, which returns the studio worker's URL. That worker scales to zero (the first call after
 * idle takes about 44 s), so the studio route gets [studioTimeoutMs] for authorize, connect and the WebSocket handshake, and its idle sockets
 * are closed after [STUDIO_IDLE_MS] so they do not keep the machine awake. A socket is only ever reused for the route it was authorized for.
 */
class ReadAloudApiSource(
    private val http: OkHttpClient,
    private val backendBaseUrl: String,
    private val isOnline: () -> Boolean,
    /** App voice id -> the API's voice id for English. */
    private val voiceFor: (String) -> String,
    /** The voices the API lists; non-English languages are accepted only when it lists a voice that speaks them (see [CloudVoicePolicy]). */
    private val catalog: CloudVoiceCatalog = CloudVoiceCatalog.Empty,
    private val nowMs: () -> Long = System::currentTimeMillis,
    /** Debug and test builds only: sent as `X-Tts-Test-Key` with every authorize call when not empty (the backend's tester bypass of the quota). Empty in every release build. */
    private val testKey: String = "",
    /** Connect and handshake budget of the studio route (a cold start is about 44 s). The live route keeps the app's usual client timeouts. */
    private val studioTimeoutMs: Long = STUDIO_TIMEOUT_MS,
    private val studioIdleMs: Long = STUDIO_IDLE_MS,
) : TtsSource {

    override val id = SourceId.API

    private class Auth(val token: String, val url: String, val alignment: Boolean)

    /** Which worker a socket is authorized for: [LIVE] (Piper), or one studio voice. Sockets are reused only within the same route. */
    internal class Route private constructor(val key: String, val studioVoice: String?) {
        val studio: Boolean get() = studioVoice != null
        companion object {
            val LIVE = Route("piper", null)
            fun studio(voiceId: String) = Route("studio:$voiceId", voiceId)
            fun of(voice: CloudVoice?) = if (voice?.studio == true) studio(voice.id) else LIVE
        }
    }

    private inner class Conn(val alignment: Boolean, val route: Route) {
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
        /** What `chunk_meta` said about the voice and language it spoke, when it says (see [AudioPlausibility.echoMismatch]). */
        @Volatile var echoedVoice: String? = null
        @Volatile var echoedLanguage: String? = null
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
    /** The client of the studio route: the app's client with the longer budget. */
    private val studioHttp: OkHttpClient by lazy {
        http.newBuilder().connectTimeout(studioTimeoutMs, TimeUnit.MILLISECONDS).readTimeout(studioTimeoutMs, TimeUnit.MILLISECONDS).build()
    }
    @Volatile private var alignmentBlockedUntil = 0L
    private val watchdog: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "tts-api-watchdog").apply { isDaemon = true } }

    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? = when {
        !isEnglish(request.language) && cloudVoiceFor(request) == null -> FallbackReason.UNSUPPORTED_LANGUAGE
        !isOnline() -> FallbackReason.OFFLINE
        else -> null
    }

    /** The app voice id for English (what the cache has always been keyed by); the catalog's voice id for other languages, or null when it is not listed now. */
    override suspend fun cacheVoice(request: TtsRequest): String? =
        if (isEnglish(request.language)) request.voiceId else cloudVoiceFor(request)?.id

    private fun isEnglish(language: String) = language.substringBefore('-').lowercase() == "en"

    /** The catalog voice for a non-English language (the user's pick when still offered, else the default), or null. Asks the catalog only for non-English text. */
    private suspend fun cloudVoiceFor(request: TtsRequest): CloudVoice? =
        request.cloudVoice ?: CloudVoicePolicy.voiceFor(request.language, catalog.voices(), request.cloudVoiceId)

    /** Fixes the voice for the whole read: later catalog changes (a reorder, a removal) do not move a read to another voice. */
    override suspend fun pin(request: TtsRequest): TtsRequest =
        if (isEnglish(request.language) || request.cloudVoice != null) request
        else cloudVoiceFor(request)?.let { request.copy(cloudVoice = it) } ?: request

    /** Opens a socket ahead of the first chunk (authorize + connect), so the first synthesize pays neither. */
    suspend fun prewarm() {
        if (!isOnline()) return
        runCatching { release(connect(false, Route.LIVE)) }
    }

    fun close() {
        while (true) { val c = idle.pollFirst() ?: break; c.ws.close(1000, "bye") }
    }

    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
        // Resolved once per chunk: the English app voice, or the catalog's voice for the language. A request that got past
        // unavailableReason always has one; the check keeps a catalog change mid-read from sending an unknown voice.
        val english = isEnglish(request.language)
        val cloud = if (english) null else cloudVoiceFor(request) ?: throw SourceFailure(FallbackReason.UNSUPPORTED_LANGUAGE)
        val voice = if (english) voiceFor(request.voiceId) else cloud!!.id
        val resolved = request.copy(voiceId = voice)
        val route = Route.of(cloud)
        // Every non-English chunk names its language: a multilingual voice told nothing speaks English phonemes.
        val languageCode = cloud?.let { CloudVoicePolicy.languageCode(it, request.language) }
        // Word timings come from an alignment worker that is only known to work for English text.
        val useWords = request.wantWords && isEnglish(request.language) && nowMs() >= alignmentBlockedUntil
        return try {
            try {
                attempt(text, resolved, useWords, languageCode, route)
            } catch (e: AlignmentSlow) {
                alignmentBlockedUntil = nowMs() + ALIGNMENT_BACKOFF_MS
                Log.i(TAG, "alignment worker slow; plain voice for the next ${ALIGNMENT_BACKOFF_MS / 60000} min")
                attempt(text, resolved, false, languageCode, route)
            }
        } catch (e: SourceFailure) {
            // "Language or voice not supported" is a per-language answer. English never has one: a refusal on an English read is an ordinary server error.
            if (english && e.reason == FallbackReason.UNSUPPORTED_LANGUAGE) throw SourceFailure(FallbackReason.SERVER_ERROR, null, e.message, e)
            throw e
        }
    }

    private class AlignmentSlow : Exception()

    private suspend fun attempt(text: String, request: TtsRequest, alignment: Boolean, languageCode: String?, route: Route): PcmChunk {
        // A reused socket may have been closed by the server while idle; if it fails before sending anything, redo once on a fresh one.
        val reused = takeIdle(alignment, route)
        if (reused != null) {
            try {
                return run(reused, text, request, languageCode)
            } catch (e: SourceFailure) {
                if (!(reused.closed && !reused.gotAnyFrame)) throw e
                Log.i(TAG, "reused socket was dead; reconnecting")
            }
        }
        val conn = try {
            connect(alignment, route)
        } catch (e: SourceFailure) {
            // The authorize call refused the voice its own list offered (400 UNKNOWN_VOICE): look at the list again soon.
            if (languageCode != null && e.reason == FallbackReason.UNSUPPORTED_LANGUAGE) catalog.invalidate()
            throw e
        }
        return run(conn, text, request, languageCode)
    }

    /** The idle socket for exactly this alignment mode and route, or null. Sockets for other routes stay where they are; stale or closed ones are dropped. */
    private fun takeIdle(alignment: Boolean, route: Route): Conn? {
        val now = nowMs()
        for (c in idle.toList()) {
            if (c.closed || now - c.lastUsed > (if (c.route.studio) studioIdleMs else IDLE_MS)) {
                if (idle.remove(c)) c.ws.close(1000, "idle")
                continue
            }
            if (c.alignment == alignment && c.route.key == route.key && idle.remove(c)) return c
        }
        return null
    }

    private fun release(c: Conn) {
        c.lastUsed = nowMs()
        if (c.closed) return
        idle.addFirst(c)
        while (idle.size > MAX_IDLE) idle.pollLast()?.ws?.close(1000, "trim")
        // A studio socket is not kept for the next read: an open socket keeps the studio machine from scaling down.
        if (c.route.studio) watchdog.schedule({
            if (!c.closed && nowMs() - c.lastUsed >= studioIdleMs && idle.remove(c)) c.ws.close(1000, "idle")
        }, studioIdleMs, TimeUnit.MILLISECONDS)
    }

    private fun authorize(alignment: Boolean, route: Route): Auth {
        val body = JSONObject().put("engine", if (route.studio) "studio" else "piper").apply {
            route.studioVoice?.let { put("voice", it) }
            if (alignment) put("alignment", true)
        }
        val req = Request.Builder()
            .url("$backendBaseUrl/api/realtime-tts/authorize")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            // Same anonymous bearer the app has always sent here; the backend holds the platform key.
            .addHeader("Authorization", "Bearer ")
            .apply { if (testKey.isNotEmpty()) addHeader(TEST_KEY_HEADER, testKey) }
            .build()
        try {
            (if (route.studio) studioHttp else http).newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw ApiFailureMapping.fromHttp(resp.code, resp.header("Retry-After"), isOnline(), text)
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

    private suspend fun connect(alignment: Boolean, route: Route): Conn {
        // authorize() is a blocking OkHttp call; the chain runs sources on its caller's dispatcher, so hop to IO.
        val auth = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { authorize(alignment, route) }
        return suspendCancellableCoroutine { cont ->
            val conn = Conn(auth.alignment, route)
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
                        ApiFailureMapping.fromHttp(response.code, response.header("Retry-After"), isOnline(), runCatching { response.peekBody(2048).string() }.getOrNull())
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
            val ws = (if (route.studio) studioHttp else http).newWebSocket(Request.Builder().url("${auth.url}?token=${auth.token}").build(), listener)
            conn.ws = ws
            cont.invokeOnCancellation { ws.cancel() }
        }
    }

    private suspend fun run(conn: Conn, text: String, request: TtsRequest, languageCode: String?): PcmChunk {
        var answered: Pending? = null
        val chunk = try {
            suspendCancellableCoroutine<PcmChunk> { cont ->
                val p = Pending(cont)
                answered = p
                conn.pending = p
                val msg = JSONObject()
                    .put("type", "synthesize")
                    .put("text", text)
                    .put("voice", request.voiceId)
                    .put("speed", request.speed.toDouble())
                languageCode?.let {
                    msg.put("language_code", it).put("format", "pcm_24000")
                    if (NumberNormalization.send(it, text)) msg.put("normalize", "numbers")
                }
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
            // The API refused the voice or language its own list offered: look at the list again soon.
            if (languageCode != null && e is SourceFailure && e.reason == FallbackReason.UNSUPPORTED_LANGUAGE) catalog.invalidate()
            throw e
        } finally {
            conn.pending = null
        }
        // Audio that cannot be the text read aloud (a runaway, a near-empty answer, another voice or language than asked for) is a failure of this source: the chain retries once, then the phone reads.
        if (audioIsChecked(conn.route)) {
            val problem = AudioPlausibility.problem(
                chars = text.codePointCount(0, text.length), audioSeconds = chunk.durationMs / 1000.0, speed = request.speed,
                language = languageCode ?: request.language, digits = text.codePoints().filter { Character.isDigit(it) }.count().toInt(),
            ) ?: AudioPlausibility.echoMismatch(request.voiceId, languageCode, answered?.echoedVoice, answered?.echoedLanguage)
            if (problem != null) {
                conn.closed = true
                conn.ws.cancel()
                Log.w(TAG, "implausible audio: $problem")
                throw SourceFailure(FallbackReason.BAD_AUDIO, null, problem)
            }
        }
        release(conn)
        return chunk
    }

    /** Which routes have their audio checked after `done`: the studio route only (the live languages are unchanged). */
    private fun audioIsChecked(route: Route): Boolean = route.studio

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
                    j.optString("voice", "").takeIf { it.isNotBlank() }?.let { p.echoedVoice = it }
                    j.optString("language", "").takeIf { it.isNotBlank() }?.let { p.echoedLanguage = it }
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
        /** The studio worker's cold start is about 44 s: connect and handshake may take up to this long. */
        internal const val STUDIO_TIMEOUT_MS = 75_000L
        /** A studio socket that has no work is closed after this long, so the studio machine can scale down. */
        internal const val STUDIO_IDLE_MS = 5_000L
        /** Header of the tester bypass (debug and test builds only). */
        internal const val TEST_KEY_HEADER = "X-Tts-Test-Key"
        internal const val ALIGNMENT_FIRST_MESSAGE_MS = 2_500L
        internal const val ALIGNMENT_BACKOFF_MS = 10 * 60_000L
    }
}
