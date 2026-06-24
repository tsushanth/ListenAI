package com.listenai.service.tts

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.listenai.service.settings.SettingsManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/**
 * Thin orchestrator around [KokoroDownloadWorker].
 *
 * The actual download is done by a WorkManager Worker so it survives
 * app backgrounding / process death / network changes. This class just
 * exposes the state of that work (idle, downloading, ready, failed) as a
 * StateFlow for the UI to observe and offers a single `startIfPossible()`
 * entry point matching the v1 API surface.
 */
class KokoroModelDownloader private constructor(
    private val context: Context,
) {
    sealed class State {
        object Idle : State()
        /**
         * The WorkManager job is enqueued/blocked but not running. [reason]
         * is the best-guess human-readable explanation of why — it can be
         * network ("Waiting for Wi-Fi"), device state ("Battery is low",
         * "Device is overheating"), or a generic "system scheduler" hint
         * when no specific cause can be detected.
         *
         * Naming kept verbose ("Battery low — connect to a charger" rather
         * than just "BATTERY_LOW") because this string surfaces directly in
         * the UI banner, no further formatting.
         */
        data class Waiting(val reason: String) : State()
        data class Downloading(val percent: Int, val downloadedMb: Int, val totalMb: Int) : State()
        object Ready : State()
        data class Failed(val message: String) : State()
    }

    private val _state = MutableStateFlow<State>(if (isModelOnDisk()) State.Ready else State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    val modelFile: File
        get() = File(context.filesDir, KokoroDownloadWorker.MODEL_FILE_NAME)

    fun isModelOnDisk(): Boolean {
        val f = modelFile
        return f.exists() &&
            f.length() in KokoroDownloadWorker.MIN_VALID_SIZE..KokoroDownloadWorker.MAX_VALID_SIZE
    }

    /**
     * Enqueue the WorkManager download. Idempotent — if a job is already
     * queued under the same unique name, WorkManager keeps the existing
     * one (ExistingWorkPolicy.KEEP) so multiple taps don't pile up.
     *
     * Network constraint is set from the user's cellular preference:
     * `UNMETERED` = WiFi only; `CONNECTED` = any network.
     */
    fun startIfPossible() {
        if (isModelOnDisk()) {
            Log.i(TAG, "startIfPossible: model already on disk at ${modelFile.absolutePath}")
            _state.value = State.Ready
            return
        }

        val settings = SettingsManager.getInstance(context)
        val allowCellular = settings.allowCellularModelDownload.value
        val networkType = if (allowCellular) NetworkType.CONNECTED else NetworkType.UNMETERED

        Log.i(TAG, "startIfPossible: enqueuing worker (network=$networkType, allowCellular=$allowCellular)")

        // No setRequiresBatteryNotLow(true) — this is a one-time 80 MB
        // download triggered by an explicit user tap (or by the auto-start
        // when an external app first asks our engine to speak and has
        // nothing to play yet). Either way, the user has consented and
        // they want a working TTS engine. Letting Samsung's "battery low"
        // or "thermal throttled" device state block this for hours is
        // worse for the user than the marginal extra battery use of an
        // 80 MB download. The unmetered/cellular gate already handles
        // the real cost concern (mobile data).
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(networkType)
            .build()

        val request = OneTimeWorkRequestBuilder<KokoroDownloadWorker>()
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            KokoroDownloadWorker.WORK_NAME,
            ExistingWorkPolicy.KEEP,
            request,
        )

        startObservingWorkState()
    }

    /**
     * Cancel any in-flight download. Partial file is preserved so a
     * future `startIfPossible()` resumes from there.
     */
    fun cancel() {
        WorkManager.getInstance(context).cancelUniqueWork(KokoroDownloadWorker.WORK_NAME)
        _state.value = if (isModelOnDisk()) State.Ready else State.Idle
    }

    private var observing = false

    private fun startObservingWorkState() {
        if (observing) return
        observing = true

        // Use main-thread LiveData → callback because WorkManager's flow
        // adapter isn't included in `work-runtime-ktx` (we'd need
        // `work-runtime-ktx` ≥ 2.10 for getWorkInfosByUniqueWorkNameFlow).
        // Polling LiveData via observeForever from a non-lifecycle scope
        // is fine here because the downloader is process-lived.
        val liveData = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWorkLiveData(KokoroDownloadWorker.WORK_NAME)

        liveData.observeForever { infos ->
            val info = infos?.firstOrNull() ?: return@observeForever
            when (info.state) {
                WorkInfo.State.RUNNING -> {
                    val progress = info.progress
                    val pct = progress.getInt(KokoroDownloadWorker.KEY_PERCENT, -1)
                    if (pct >= 0) {
                        _state.value = State.Downloading(
                            percent = pct,
                            downloadedMb = progress.getInt(KokoroDownloadWorker.KEY_DOWNLOADED_MB, 0),
                            totalMb = progress.getInt(KokoroDownloadWorker.KEY_TOTAL_MB, KokoroDownloadWorker.ESTIMATED_TOTAL_MB),
                        )
                    }
                }
                WorkInfo.State.ENQUEUED -> {
                    // Enqueued but not running yet. Figure out the actual
                    // reason — could be network, battery, thermal, doze,
                    // or just the system scheduler being slow.
                    _state.value = State.Waiting(currentWaitReason(context))
                }
                WorkInfo.State.SUCCEEDED -> {
                    _state.value = State.Ready
                }
                WorkInfo.State.FAILED -> {
                    val msg = info.outputData.getString(KokoroDownloadWorker.KEY_ERROR)
                        ?: "Download failed"
                    _state.value = State.Failed(msg)
                }
                WorkInfo.State.CANCELLED -> {
                    _state.value = if (isModelOnDisk()) State.Ready else State.Idle
                }
                WorkInfo.State.BLOCKED -> {
                    // Constraints unmet (e.g. no WiFi, battery low). Same
                    // best-effort reason detection as ENQUEUED above.
                    _state.value = State.Waiting(currentWaitReason(context))
                }
            }
        }
    }

    companion object {
        private const val TAG = "KokoroModelDownloader"

        const val estimatedSizeMB = KokoroDownloadWorker.ESTIMATED_TOTAL_MB

        @Volatile
        private var instance: KokoroModelDownloader? = null

        fun getInstance(context: Context): KokoroModelDownloader {
            return instance ?: synchronized(this) {
                instance ?: KokoroModelDownloader(context.applicationContext)
                    .also { instance = it }
            }
        }

        private fun isOnWifi(context: Context): Boolean {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
                as android.net.ConnectivityManager
            val net = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(net) ?: return false
            return caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
        }

        /**
         * Best-effort device-state inspection: when WorkManager parks our
         * download in ENQUEUED/BLOCKED but our network constraint is met,
         * the actual cause is usually battery, thermal, or OEM background
         * restriction. Surface what we can detect; fall back to a generic
         * "system queued" message if nothing specific matches.
         */
        private fun currentWaitReason(context: Context): String {
            val settings = SettingsManager.getInstance(context)
            val allowCellular = settings.allowCellularModelDownload.value

            // Network is the most common cause when cellular is disabled.
            if (!allowCellular && !isOnWifi(context)) {
                return "Waiting for Wi-Fi — voice model will download as soon as you connect."
            }
            if (allowCellular && !hasAnyNetwork(context)) {
                return "Waiting for network — voice model will download when you reconnect."
            }

            // Battery / power state.
            val bm = context.getSystemService(Context.BATTERY_SERVICE)
                as? android.os.BatteryManager
            val pct = bm?.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            if (pct in 0..15) {
                return "Battery low ($pct%) — connect to a charger to start the download."
            }

            // Thermal throttling (API 29+ — Pixel/Samsung both report this).
            val pm = context.getSystemService(Context.POWER_SERVICE)
                as? android.os.PowerManager
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q && pm != null) {
                val thermal = pm.currentThermalStatus
                if (thermal >= android.os.PowerManager.THERMAL_STATUS_SEVERE) {
                    return "Device is overheating — download will start once it cools down."
                }
                if (thermal >= android.os.PowerManager.THERMAL_STATUS_MODERATE) {
                    return "Device is warm — download may take a moment to start."
                }
            }
            if (pm?.isPowerSaveMode == true) {
                return "Power-saving mode is on — turn it off to start the download."
            }

            // Background restricted (typically OEM-set, e.g. Samsung's
            // Optimize battery usage).
            val am = context.getSystemService(Context.ACTIVITY_SERVICE)
                as? android.app.ActivityManager
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P &&
                am?.isBackgroundRestricted == true
            ) {
                return "Background activity restricted — allow ReadAloud Voice to run in the background in your Battery settings."
            }

            // Fallback: device is fine, system just hasn't dispatched yet.
            return "System is queueing the download — should start in a few seconds."
        }

        private fun hasAnyNetwork(context: Context): Boolean {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
                as android.net.ConnectivityManager
            val net = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(net) ?: return false
            return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }
    }
}
