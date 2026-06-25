package com.listenai.systemtts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.listenai.service.tts.SynthesisOptions
import com.listenai.service.tts.TTSServiceFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Background WorkManager job that pre-renders the bundled TalkBack
 * label cache in a target voice and stores the resulting PCM in
 * [PerVoiceCache], so subsequent TalkBack utterances in that voice
 * hit the cache instead of falling through to live Kokoro synth.
 *
 * Solves the asymmetry Warren flagged: Dorothy (af_heart) has a
 * pre-shipped bundled cache so labels play instantly; other voices
 * have to synthesize each label live on first use, which is slow.
 * After this worker runs once per voice, the per-voice cache covers
 * the same label corpus and other voices feel as snappy as Dorothy.
 *
 * Properties:
 *   - Foreground service (dataSync) so the OS doesn't kill mid-batch.
 *   - Resumable: skips labels already present in PerVoiceCache, so a
 *     paused/killed run resumes from where it left off on retry.
 *   - Pausable via WorkManager cancelUniqueWork; user-visible
 *     progress notification.
 *   - Constraints: BATTERY_NOT_LOW (no CHARGING requirement — runs
 *     anytime as long as the user has enough battery).
 *   - Idempotent: re-enqueueing under the same unique work name is
 *     ExistingWorkPolicy.KEEP — second tap doesn't restart.
 *
 * Caller passes voiceKey via input data (e.g. "am_michael" for Josh).
 */
class PerVoicePreWarmWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val voiceKey = inputData.getString(KEY_VOICE_KEY)
            ?: return@withContext Result.failure(
                Data.Builder().putString(KEY_ERROR, "missing voice_key input").build()
            )
        val preset = VoiceCatalog.presets()
            .firstOrNull { it.providerVoiceId == voiceKey }
            ?: return@withContext Result.failure(
                Data.Builder().putString(KEY_ERROR, "no preset for voice_key=$voiceKey").build()
            )

        Log.i(TAG, "starting pre-warm for voiceKey=$voiceKey (preset=${preset.name})")

        val labelCache = TalkbackLabelCache.getInstance(applicationContext)
        val perVoice = PerVoiceCache.getInstance(applicationContext)
        val kokoro = TTSServiceFactory.getKokoroOnDeviceService(applicationContext)

        val allLabels = labelCache.allTexts()
        val total = allLabels.size
        Log.i(TAG, "pre-warm corpus: $total labels")

        setForeground(createForegroundInfo(preset.name, 0, total))

        var done = 0
        var skipped = 0
        var failed = 0
        val tStart = System.currentTimeMillis()

        for ((index, text) in allLabels.withIndex()) {
            // Honor WorkManager cancellation cleanly between labels.
            if (isStopped) {
                Log.i(TAG, "stopped at $index/$total (done=$done skipped=$skipped failed=$failed)")
                return@withContext Result.success(progressData(voiceKey, index, total, done, skipped, failed))
            }
            // Already cached? Skip — this is what makes the worker
            // resumable across pauses/kills/retries.
            if (perVoice.lookup(text, voiceKey) != null) {
                skipped++
            } else {
                try {
                    val chunks = ArrayList<ShortArray>(2)
                    var sampleRate = 0
                    val ok = kokoro.synthesizeChunkedPcm(text, preset, SynthesisOptions.DEFAULT) { pcm, sr ->
                        if (pcm.isNotEmpty()) { chunks.add(pcm); sampleRate = sr }
                        !isStopped
                    }
                    if (ok && chunks.isNotEmpty() && sampleRate > 0) {
                        val totalSamples = chunks.sumOf { it.size }
                        val merged = ShortArray(totalSamples)
                        var off = 0
                        for (c in chunks) {
                            System.arraycopy(c, 0, merged, off, c.size)
                            off += c.size
                        }
                        perVoice.store(text, voiceKey, merged, sampleRate)
                        done++
                    } else {
                        failed++
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "synth failed for '$text' (skipping): ${t.message}")
                    failed++
                }
            }

            // Update progress every label so the UI bar moves smoothly
            // and the notification stays informative. setProgress is
            // cheap (just a Bundle).
            val processed = index + 1
            setProgress(progressData(voiceKey, processed, total, done, skipped, failed))
            if (processed % 5 == 0 || processed == total) {
                setForeground(createForegroundInfo(preset.name, processed, total))
            }
        }

        val elapsedMs = System.currentTimeMillis() - tStart
        Log.i(TAG, "pre-warm done in ${elapsedMs}ms: done=$done skipped=$skipped failed=$failed of $total")
        Result.success(progressData(voiceKey, total, total, done, skipped, failed))
    }

    // ----------------------------------------------------------------
    // Foreground notification
    // ----------------------------------------------------------------
    private fun createForegroundInfo(voiceName: String, processed: Int, total: Int): ForegroundInfo {
        val mgr = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE)
            as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            mgr.getNotificationChannel(CHANNEL_ID) == null
        ) {
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Voice optimization",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Shown while ReadAloud Voice pre-renders TalkBack labels for a voice."
                    setShowBadge(false)
                }
            )
        }
        val openIntent = applicationContext.packageManager
            .getLaunchIntentForPackage(applicationContext.packageName)
            ?.let {
                PendingIntent.getActivity(
                    applicationContext,
                    0,
                    it,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            }

        val percent = if (total > 0) (processed * 100 / total).coerceIn(0, 100) else 0
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Optimizing $voiceName")
            .setContentText("$processed of $total phrases")
            .setProgress(total.coerceAtLeast(1), processed, total == 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .build()

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    private fun progressData(
        voiceKey: String, processed: Int, total: Int,
        done: Int, skipped: Int, failed: Int,
    ): Data = Data.Builder()
        .putString(KEY_VOICE_KEY, voiceKey)
        .putInt(KEY_PROCESSED, processed)
        .putInt(KEY_TOTAL, total)
        .putInt(KEY_DONE, done)
        .putInt(KEY_SKIPPED, skipped)
        .putInt(KEY_FAILED, failed)
        .build()

    companion object {
        private const val TAG = "PerVoicePreWarmWorker"
        const val CHANNEL_ID = "voice_pre_warm"
        const val NOTIFICATION_ID = 0x504F  // arbitrary

        const val KEY_VOICE_KEY = "voice_key"
        const val KEY_PROCESSED = "processed"
        const val KEY_TOTAL = "total"
        const val KEY_DONE = "done"
        const val KEY_SKIPPED = "skipped"
        const val KEY_FAILED = "failed"
        const val KEY_ERROR = "error"

        /** Unique work name per voice — pause/cancel one voice without affecting others. */
        fun workName(voiceKey: String): String = "voice_pre_warm_$voiceKey"
    }
}
