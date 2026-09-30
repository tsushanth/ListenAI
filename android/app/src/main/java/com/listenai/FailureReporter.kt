package com.listenai

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Sends crashes and handled failures to the unified app-failure-reporter Worker,
 * which dedupes and emails them. No third-party dependencies.
 *
 *   FailureReporter.init(this, "scribeai", KEY, BuildConfig.VERSION_NAME)   // Application.onCreate
 *   FailureReporter.failure("Upload PDF", exception)                        // handled failure
 *
 * Never put user content (note text, transcripts, emails) in message or context.
 */
object FailureReporter {
    private const val ENDPOINT = "https://app-failure-reporter.t-sushanth.workers.dev/v1/report"
    private const val PREFS = "failure_reporter"
    private const val PENDING = "pending_crash"
    private const val MAX_PER_MINUTE = 10

    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "failure-reporter").apply { isDaemon = true } }
    private val sentThisMinute = AtomicInteger(0)
    @Volatile private var windowStart = 0L
    @Volatile private var appCtx: Context? = null
    @Volatile private var app = ""
    @Volatile private var key = ""
    @Volatile private var version = ""

    fun init(context: Context, appName: String, ingestKey: String, versionName: String) {
        appCtx = context.applicationContext
        app = appName; key = ingestKey; version = versionName
        flushPendingCrash()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, t ->
            try {
                val body = build("crash", "uncaught", t.toString(), t.stackTraceToString(), mapOf("thread" to thread.name))
                // Persist first: the process is about to die and the network may be down.
                prefs()?.edit()?.putString(PENDING, body)?.commit()
                if (post(body, timeoutMs = 3000)) prefs()?.edit()?.remove(PENDING)?.commit()
            } catch (_: Throwable) {
            } finally {
                previous?.uncaughtException(thread, t)
            }
        }
    }

    /** A handled failure: a user-facing flow broke but the app did not crash. */
    fun failure(flow: String, t: Throwable? = null, message: String? = null, context: Map<String, String> = emptyMap()) {
        send("failure", flow, message ?: t?.toString() ?: "failure", t?.stackTraceToString().orEmpty(), context)
    }

    /** A backend call returned 5xx. Used by the OkHttp interceptor. */
    fun backendError(flow: String, message: String, context: Map<String, String> = emptyMap()) {
        send("backend_error", flow, message, "", context)
    }

    private fun send(kind: String, flow: String, message: String, stack: String, ctx: Map<String, String>) {
        if (appCtx == null || rateLimited()) return
        val body = build(kind, flow, message, stack, ctx)
        io.execute { try { post(body, 8000) } catch (_: Throwable) {} }
    }

    // Client-side cap so a failure loop cannot hammer the network or the battery.
    private fun rateLimited(): Boolean {
        val now = System.currentTimeMillis()
        if (now - windowStart > 60_000) { windowStart = now; sentThisMinute.set(0) }
        return sentThisMinute.incrementAndGet() > MAX_PER_MINUTE
    }

    private fun build(kind: String, flow: String, message: String, stack: String, ctx: Map<String, String>): String {
        val c = JSONObject(ctx + mapOf("device" to "${Build.MANUFACTURER} ${Build.MODEL}", "android" to Build.VERSION.RELEASE))
        return JSONObject()
            .put("kind", kind).put("platform", "android").put("version", version)
            .put("flow", flow).put("message", message).put("stack", stack).put("context", c)
            .toString()
    }

    private fun post(body: String, timeoutMs: Int): Boolean {
        val conn = URL(ENDPOINT).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"; conn.doOutput = true
            conn.connectTimeout = timeoutMs; conn.readTimeout = timeoutMs
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Report-Key", key)
            conn.outputStream.use { it.write(body.toByteArray()) }
            conn.responseCode in 200..299
        } finally { conn.disconnect() }
    }

    private fun prefs() = appCtx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun flushPendingCrash() {
        val pending = prefs()?.getString(PENDING, null) ?: return
        io.execute { try { if (post(pending, 8000)) prefs()?.edit()?.remove(PENDING)?.apply() } catch (_: Throwable) {} }
    }
}
