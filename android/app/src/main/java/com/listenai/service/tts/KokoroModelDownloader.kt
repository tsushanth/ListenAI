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
        object WaitingForWifi : State()
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

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(networkType)
            .setRequiresBatteryNotLow(true)
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
                    // Could be waiting on a network constraint.
                    val settings = SettingsManager.getInstance(context)
                    _state.value = if (!settings.allowCellularModelDownload.value && !isOnWifi(context)) {
                        State.WaitingForWifi
                    } else {
                        State.Idle
                    }
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
                    // Constraints unmet (e.g. no WiFi, battery low).
                    _state.value = State.WaitingForWifi
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
    }
}
