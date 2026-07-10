package com.listenai.systemtts

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Orchestrator + state holder around [PerVoicePreWarmWorker]. Exposes
 * a [StateFlow] keyed by voiceKey that the UI can collect to render
 * progress + action buttons.
 *
 * Singleton — owns one WorkManager observer per voiceKey, lazy-started.
 * Safe to call from any thread; state writes happen on the main thread
 * because WorkManager LiveData is main-thread-only.
 */
class PerVoicePreWarmManager private constructor(private val context: Context) {

    /**
     * Per-voice status, exposed as StateFlow. Map key is voiceKey
     * (e.g. "am_michael" for Josh). Absent key means we haven't
     * looked up state yet — UI should observe + treat as Idle.
     */
    sealed class Status {
        object Idle : Status()                              // never optimized
        data class Running(val processed: Int, val total: Int) : Status()
        data class Done(val total: Int) : Status()          // completed at some point
        data class Failed(val message: String) : Status()
    }

    private val _states = MutableStateFlow<Map<String, Status>>(emptyMap())
    val states: StateFlow<Map<String, Status>> = _states.asStateFlow()

    /** Start (or no-op if already running) the pre-warm for [voiceKey]. */
    fun start(voiceKey: String) {
        if (voiceKey.isBlank()) return
        val constraints = Constraints.Builder()
            // No CHARGING constraint by design — user can use the phone
            // normally + battery doesn't have to be plugged in. We
            // pause if battery drops low.
            .setRequiresBatteryNotLow(true)
            .build()
        val request = OneTimeWorkRequestBuilder<PerVoicePreWarmWorker>()
            .setConstraints(constraints)
            .setInputData(Data.Builder().putString(PerVoicePreWarmWorker.KEY_VOICE_KEY, voiceKey).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            PerVoicePreWarmWorker.workName(voiceKey),
            ExistingWorkPolicy.KEEP,
            request,
        )
        startObserving(voiceKey)
    }

    /** Pause/cancel an in-flight pre-warm. Progress is preserved via PerVoiceCache hits on resume. */
    fun cancel(voiceKey: String) {
        WorkManager.getInstance(context).cancelUniqueWork(PerVoicePreWarmWorker.workName(voiceKey))
    }

    private val observing = mutableSetOf<String>()

    /**
     * Begin observing this voiceKey's WorkInfo state. Idempotent — calling
     * twice doesn't double-register. Updates [_states] whenever WorkManager
     * fires a state change.
     */
    fun startObserving(voiceKey: String) {
        if (voiceKey.isBlank()) return
        if (!observing.add(voiceKey)) return
        val liveData = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWorkLiveData(PerVoicePreWarmWorker.workName(voiceKey))
        liveData.observeForever { infos ->
            val info = infos?.firstOrNull() ?: return@observeForever
            val total = info.progress.getInt(PerVoicePreWarmWorker.KEY_TOTAL, 0)
                .takeIf { it > 0 }
                ?: info.outputData.getInt(PerVoicePreWarmWorker.KEY_TOTAL, 0)
            val processed = info.progress.getInt(PerVoicePreWarmWorker.KEY_PROCESSED, 0)
                .takeIf { it > 0 }
                ?: info.outputData.getInt(PerVoicePreWarmWorker.KEY_PROCESSED, 0)
            val newStatus = when (info.state) {
                WorkInfo.State.RUNNING, WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED ->
                    if (total > 0) Status.Running(processed, total) else Status.Running(0, 0)
                WorkInfo.State.SUCCEEDED -> {
                    // Silent-abort path: worker caught an OS-refusal (e.g.
                    // Samsung foreground-service denial or Kokoro session
                    // not ready) and returned success with a marker rather
                    // than failure. Show Idle so the Optimize button
                    // re-enables and a fresh foreground tap can retry.
                    val silent = info.outputData.getBoolean(PerVoicePreWarmWorker.KEY_SILENT_ABORT, false)
                    if (silent) {
                        val reason = info.outputData.getString(PerVoicePreWarmWorker.KEY_ABORT_REASON)
                        Log.i(TAG, "silent abort for $voiceKey (reason=$reason) -> Idle")
                        Status.Idle
                    } else {
                        Status.Done(total)
                    }
                }
                WorkInfo.State.FAILED ->
                    Status.Failed(info.outputData.getString(PerVoicePreWarmWorker.KEY_ERROR) ?: "Pre-warm failed")
                WorkInfo.State.CANCELLED ->
                    Status.Idle
            }
            val current = _states.value.toMutableMap()
            current[voiceKey] = newStatus
            _states.value = current
        }
    }

    companion object {
        private const val TAG = "PerVoicePreWarm"
        @Volatile private var INSTANCE: PerVoicePreWarmManager? = null

        fun getInstance(context: Context): PerVoicePreWarmManager {
            INSTANCE?.let { return it }
            synchronized(this) {
                INSTANCE?.let { return it }
                val created = PerVoicePreWarmManager(context.applicationContext)
                INSTANCE = created
                return created
            }
        }
    }
}
