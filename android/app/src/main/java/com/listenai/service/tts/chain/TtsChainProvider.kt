package com.listenai.service.tts.chain

import android.content.Context
import android.util.Log
import com.listenai.ListenAIApplication
import com.listenai.data.models.VoicePreset
import com.listenai.service.FirebaseAnalyticsHelper
import com.listenai.service.tts.PiperVoiceMapping
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** Builds and holds the process-wide source chains and their shared pieces (API sockets, chunk cache). */
object TtsChainProvider {
    private const val TAG = "TTS_CHAIN"
    /** 150 MB is about 52 minutes of 24 kHz audio. */
    private const val CACHE_BYTES = 150L * 1024 * 1024
    /** The ReadAloud API's public voice and language list (no key, no text; the same host the speech itself goes to). */
    internal const val CATALOG_URL = "https://api.readaloudai.org/v1/catalog"

    class Holder(
        /** The app's own reader: API, then the phone's engine, then the on-device model. */
        val inApp: TtsSourceChain,
        /** The ReadAloud system TTS engine: API only; on a miss the engine uses its own on-device path. */
        val engine: TtsSourceChain,
        val api: ReadAloudApiSource,
        val system: SystemTtsSource,
        val onDevice: OnDeviceModelSource,
        /** The cloud voices the ReadAloud API lists; the app reads a non-English language in the cloud only if this list has a voice for it (see CloudVoicePolicy). */
        val catalog: CloudVoiceCatalog,
    )

    @Volatile private var holder: Holder? = null

    fun get(context: Context): Holder = holder ?: synchronized(this) { holder ?: build(context.applicationContext).also { holder = it } }

    internal fun voiceFor(appVoiceId: String): String =
        VoicePreset.builtInVoices.firstOrNull { it.id == appVoiceId }?.let { PiperVoiceMapping.resolve(it) } ?: PiperVoiceMapping.FALLBACK_VOICE_ID

    private fun build(app: Context): Holder {
        val http = OkHttpClient.Builder()
            .addInterceptor(com.listenai.FailureReporterInterceptor())
            .addInterceptor(com.listenai.data.remote.AcceptLanguageInterceptor())
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .build()
        val online = { ConnectivityCheck.isOnline(app) }
        val catalog = HttpCloudVoiceCatalog(http, CATALOG_URL)
        val api = ReadAloudApiSource(
            http = http,
            backendBaseUrl = ListenAIApplication.BACKEND_URL,
            isOnline = online,
            voiceFor = ::voiceFor,
            catalog = catalog,
        )
        val system = SystemTtsSource(app, online)
        val onDevice = OnDeviceModelSource(app)
        val cache = DiskChunkCache(File(app.cacheDir, "tts_chunks"), CACHE_BYTES)
        val telemetry = AndroidTtsTelemetry()
        val sources = mapOf(SourceId.API to api, SourceId.SYSTEM to system, SourceId.ON_DEVICE to onDevice)
        val inApp = TtsSourceChain(
            sources = sources,
            order = { req -> TtsFlagLogic.inAppOrder(TtsSourceFlags.apiEnabled(app), req.language, req.preferSystem) },
            cache = cache,
            telemetry = telemetry,
        )
        val engine = TtsSourceChain(
            sources = mapOf(SourceId.API to api),
            order = { req -> if (TtsSourceFlags.engineApiEnabled(app) && req.language.startsWith("en", true)) listOf(SourceId.API) else emptyList() },
            cache = cache,
            // The engine path has no use for word timings and must answer fast: no alignment worker there.
            config = ChainConfig(prefetch = 2, firstChunkBaseTimeoutMs = 3_500, retries = 1),
            telemetry = telemetry,
        )
        return Holder(inApp, engine, api, system, onDevice, catalog)
    }

    /** Logs one line per read to logcat (tag TTS_CHAIN; no text) and sends a funnel event when analytics is allowed. */
    private class AndroidTtsTelemetry : TtsTelemetry {
        override fun report(report: SessionReport) {
            val first = report.fallbackReasons.firstOrNull()
            Log.i(
                TAG,
                "first=${report.firstSource} ttfa_ms=${report.timeToFirstAudioMs} total_ms=${report.totalMs} audio_ms=${report.audioMs} " +
                    "chunks=${report.chunks} chars=${report.chars} cache_hits=${report.cacheHits} mix=${report.chunksBySource} " +
                    "fallback=${first?.first}:${first?.second} ok=${report.succeeded} lang=${report.language}"
            )
            runCatching { FirebaseAnalyticsHelper.logTtsSession(report) }
            TtsFailureSignals.apiFallback(report)?.let { com.listenai.FailureReporter.failure(it.flow, message = it.code, context = it.context) }
        }
    }
}
